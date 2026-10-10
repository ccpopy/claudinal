import type { SessionRewindResult } from "./ipc"
import type { UIMessage } from "@/types/ui"

export type CheckpointRewindMode = "files" | "files_and_branch"

export interface CheckpointTarget {
  readonly runtimeId: string
  readonly conversationKey: string
  readonly generation: number
  readonly userMessageId: string
  readonly messageLabel: string
  readonly cwd: string
}

export interface CheckpointRewindState {
  phase: "closed" | "previewing" | "ready" | "refused" | "executing" | "complete" | "error" | "stale"
  target?: Readonly<CheckpointTarget>
  preview?: SessionRewindResult
  expiresAt?: number
  result?: SessionRewindResult
  mode?: CheckpointRewindMode
  branchCreated?: boolean
  branchError?: string
  error?: string
}

export interface CheckpointDependencies {
  preview(runtimeId: string, userMessageId: string): Promise<SessionRewindResult>
  rewind(runtimeId: string, userMessageId: string, previewId: string): Promise<SessionRewindResult>
  /** True only for this captured, idle runtime/conversation and accepted input. */
  isCurrent(target: Readonly<CheckpointTarget>): boolean
  /** Optional, capability-confirmed existing fork flow. Must not submit a prompt. */
  fork?(target: Readonly<CheckpointTarget>): Promise<void>
  canFork?(target: Readonly<CheckpointTarget>): boolean
  now?(): number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PREVIEW_TTL_MS = 5 * 60 * 1000

/** A local/attempt id is never evidence that a CLI checkpoint exists. */
export function checkpointMessageId(message: UIMessage): string | null {
  if (message.role !== "user" || !message.transcriptUuid || !UUID_PATTERN.test(message.transcriptUuid)) return null
  if (message.deliveryState && message.deliveryState !== "acknowledged" && message.deliveryState !== "responded") return null
  if (!message.blocks.some((block) => ["text", "image", "attachment"].includes(block.type))) return null
  return message.transcriptUuid
}

/** Single-use preview controller; neither failures nor stale replies replay mutation. */
export class CheckpointRewindController {
  private state: CheckpointRewindState = { phase: "closed" }
  private revision = 0
  private listeners = new Set<() => void>()
  private invalidatedDuringExecution: string | undefined

  constructor(private readonly dependencies: CheckpointDependencies) {}

  getSnapshot = (): CheckpointRewindState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  canFork = (): boolean => !!this.dependencies.fork && !!this.state.target
    && (this.dependencies.canFork?.(this.state.target) ?? true)
  private now(): number { return (this.dependencies.now ?? Date.now)() }
  private publish(state: CheckpointRewindState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  async open(target: CheckpointTarget): Promise<boolean> {
    if (this.state.phase === "executing") return false
    const captured = Object.freeze({ ...target })
    const revision = ++this.revision
    if (!UUID_PATTERN.test(captured.userMessageId)) {
      this.publish({ phase: "refused", target: captured, error: "未确认 CLI 用户消息 UUID，无法定位检查点" })
      return false
    }
    if (!this.dependencies.isCurrent(captured)) {
      this.publish({ phase: "stale", target: captured, error: "会话已变化或仍有任务运行，请回到原会话空闲时重新预览" })
      return false
    }
    const requestedAt = this.now()
    this.publish({ phase: "previewing", target: captured })
    try {
      const preview = await this.dependencies.preview(captured.runtimeId, captured.userMessageId)
      if (revision !== this.revision) return false
      if (!this.dependencies.isCurrent(captured)) {
        this.invalidate("会话或任务状态已变化，请重新预览")
        return false
      }
      if (!preview.canRewind || !preview.previewId) {
        this.publish({ phase: "refused", target: captured, preview,
          error: preview.error ?? (preview.canRewind ? "CLI 未返回可执行的预览凭据，请重新预览" : "该输入没有可回退的文件检查点") })
        return false
      }
      this.publish({ phase: "ready", target: captured, preview, expiresAt: requestedAt + PREVIEW_TTL_MS })
      return true
    } catch (reason) {
      if (revision !== this.revision) return false
      this.publish({ phase: "error", target: captured, error: `预览失败：${String(reason)}` })
      return false
    }
  }

  close(): boolean {
    if (this.state.phase === "executing") return false
    ++this.revision
    this.publish({ phase: "closed" })
    return true
  }

  invalidate(reason = "预览已过期或会话已变化，请重新预览"): void {
    if (this.state.phase === "closed" || this.state.phase === "complete") return
    ++this.revision
    if (this.state.phase === "executing") {
      // A written mutation cannot be cancelled or redirected to another session.
      this.invalidatedDuringExecution = reason
      this.publish({ ...this.state, error: reason })
    } else this.publish({ phase: "stale", target: this.state.target, error: reason })
  }

  async confirm(mode: CheckpointRewindMode): Promise<boolean> {
    const { phase, target, preview, expiresAt } = this.state
    if (phase !== "ready" || !target || !preview?.canRewind || !preview.previewId) return false
    if (!expiresAt || this.now() >= expiresAt || !this.dependencies.isCurrent(target)) {
      this.invalidate()
      return false
    }
    if (mode === "files_and_branch" && !this.canFork()) return false
    this.invalidatedDuringExecution = undefined
    this.publish({ ...this.state, phase: "executing", mode, error: undefined })
    try {
      const result = await this.dependencies.rewind(target.runtimeId, target.userMessageId, preview.previewId)
      if (!result.canRewind) {
        this.publish({ phase: "refused", target, result, mode, error: result.error ?? "CLI 拒绝执行回退，请检查文件状态并重新预览" })
        return false
      }
      let branchCreated = false
      let branchError: string | undefined
      if (mode === "files_and_branch") {
        if (this.invalidatedDuringExecution || !this.dependencies.isCurrent(target)) {
          branchError = "文件回退已返回，当前会话已变化，未新建会话分支"
        } else {
          try {
            await this.dependencies.fork!(target)
            branchCreated = true
          } catch (reason) { branchError = `文件回退已返回，但新建会话分支失败：${String(reason)}` }
        }
      }
      this.publish({ phase: "complete", target, result, mode, branchCreated, branchError,
        error: this.invalidatedDuringExecution ? "此结果属于所选原会话，请检查该工作目录的文件" : undefined })
      return true
    } catch (reason) {
      // A transport failure may arrive after execution; require a new preview and confirmation.
      this.publish({ phase: "error", target, mode,
        error: `回退请求失败，执行结果尚未确认。请检查文件后重新预览：${String(reason)}` })
      return false
    }
  }
}
