import { originKind } from "./messageOrigin"

/** UI registration transfers ownership, without claiming durability. */
export type SubmitOutcome =
  | { kind: "registered_in_ui"; messageId: string }
  | { kind: "local_action" }
  | { kind: "rejected"; reason: string }
  | { kind: "cancelled" }

export type LocalState = "saving" | "saved" | "save_failed"
export type RunState = "idle" | "running" | "cancelling" | "cancelled" | "done" | "failed"

/** Newer CLI results identify every input consumed by that turn, including guides. */
export function eventInputIds(event: unknown): string[] | undefined {
  if (!event || typeof event !== "object") return undefined
  const value = event as Record<string, unknown>
  const valid = (id: unknown): id is string => typeof id === "string" && id.length > 0
    && new TextEncoder().encode(id).length <= 256
  // The array is authoritative when present. Partial validation could settle
  // an input that the backend's conservative activity tracker keeps unresolved.
  // [] means no trusted attribution; undefined alone permits legacy FIFO fallback.
  if (Object.hasOwn(value, "user_message_uuids")) {
    const ids = value.user_message_uuids
    return Array.isArray(ids) && ids.length <= 64 && ids.every(valid) ? ids : []
  }
  if (Object.hasOwn(value, "user_message_uuid")) return valid(value.user_message_uuid) ? [value.user_message_uuid] : []
  const origin = originKind(value)
  return origin && origin !== "human" ? [] : undefined
}

/** Batched task notifications emit empty receipts before their shared reply's result. */
export function isBackgroundBatchReceipt(event: unknown): boolean {
  if (!event || typeof event !== "object") return false
  const value = event as Record<string, unknown>
  return value.type === "result" && originKind(value) === "task-notification"
    && value.subtype === "success" && value.is_error === false && value.num_turns === 0
    && typeof value.result === "string" && !value.result.trim()
    && (value.terminal_reason === undefined || value.terminal_reason === "completed")
    && eventInputIds(value)?.length === 0
}

export const GUIDE_READ_UNCONFIRMED = "本次结果未确认读取此引导（可能被 UserPromptSubmit hook 拦截，或回执尚未到达）"

export interface GuideResultOutcome {
  /** Queued or already received for a subsequent stage. */
  continued: string[]
  /** Not answered or queued in this snapshot; retain for receipt recovery or manual resend. */
  unconfirmed: string[]
}

/**
 * Classify written, running guides a successful CLI result did not answer.
 * `queued_turn_count` counts human-origin messages still waiting in the CLI
 * queue (guides are always human-origin). A hook-blocked guide appears in no
 * result's `user_message_uuids`, but a received guide may already be executing
 * in a later stage when this queue snapshot is empty. An absent count
 * proves neither, and a zero snapshot is not proof that bytes never arrived.
 */
export function guideResultOutcome(event: Record<string, unknown>, guides: readonly { id: string; attemptId: string; received?: boolean }[]): GuideResultOutcome {
  const none = { continued: [], unconfirmed: [] }
  if (event.type !== "result" || event.is_error === true || event.stop_reason === "max_tokens"
    || ["interrupted", "api_error", "max_tokens"].includes(String(event.terminal_reason))) return none
  const answered = eventInputIds(event)
  if (answered?.length === 0) return none
  const unanswered = guides.filter((guide) => !answered?.includes(guide.attemptId))
  const queued = event.queued_turn_count
  if (typeof queued !== "number") return none
  if (queued > 0) return { continued: unanswered.map((guide) => guide.id), unconfirmed: [] }
  if (queued !== 0) return none
  // Without per-input attribution an unanswered guide cannot be told apart.
  return { continued: unanswered.filter((guide) => guide.received).map((guide) => guide.id),
    unconfirmed: answered ? unanswered.filter((guide) => !guide.received).map((guide) => guide.id) : [] }
}
export type DeliveryState = "preparing" | "needs_confirmation" | "paused" | "cancelled" | "queued" | "writing" | "awaiting_ack" | "acknowledged" | "responded" | "failed" | "delivery_unknown"

export const deliveryLabel: Record<DeliveryState, string> = {
  preparing: "正在准备",
  needs_confirmation: "需要确认",
  paused: "等待处理上一条",
  cancelled: "已取消，尚未发送",
  queued: "排队中，等待本轮结束",
  writing: "正在提交",
  awaiting_ack: "已提交，等待响应",
  acknowledged: "CLI 已确认接收",
  responded: "已收到响应",
  failed: "未发送，内容已保留",
  delivery_unknown: "无法确认是否接收，请先检查会话记录"
}

export function canClearSubmittedDraft(
  submitted: { key?: string; revision: number },
  current: { key?: string; revision: number },
  outcome: SubmitOutcome
): boolean {
  return (outcome.kind === "registered_in_ui" || outcome.kind === "local_action") && submitted.key === current.key && submitted.revision === current.revision
}

export function deliveryAfterWriteError(error: unknown): DeliveryState {
  const detail = error as { deliveryCertainty?: string } | null
  return detail?.deliveryCertainty === "not_sent" ? "failed" : "delivery_unknown"
}
