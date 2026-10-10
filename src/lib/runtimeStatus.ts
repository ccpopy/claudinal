import type { ClaudeEvent } from "@/types/events"

export type RuntimePhaseKind = "starting" | "hook" | "permission" | "retry" | "tool" | "thinking" | "responding" | "background" | "completed"
export interface RuntimePhase { kind: RuntimePhaseKind; since: number; activeHookIds?: string[]; detail?: string }
export const runtimePhaseLabel: Record<RuntimePhaseKind, string> = {
  starting: "启动中", hook: "等待 hook", permission: "等待权限", retry: "网络重试", tool: "工具运行",
  thinking: "正在思考", responding: "正在输出", background: "等待后台任务", completed: "已完成"
}
export function reduceRuntimePhase(current: RuntimePhase, event: ClaudeEvent, now = Date.now()): RuntimePhase {
  const record = event as Record<string, unknown>
  if (record.parent_tool_use_id || record.agent_id) return current
  if (record.type === "system" && (record.subtype === "hook_started" || record.subtype === "hook_progress")) {
    const id = typeof record.hook_id === "string" ? record.hook_id : "unidentified"
    return { kind: "hook", since: current.kind === "hook" ? current.since : now,
      activeHookIds: [...new Set([...(current.activeHookIds ?? []), id])] }
  }
  if (record.type === "system" && record.subtype === "hook_response") {
    const id = typeof record.hook_id === "string" ? record.hook_id : "unidentified"
    const activeHookIds = (current.activeHookIds ?? []).filter((hook) => hook !== id)
    if (activeHookIds.length) return { ...current, activeHookIds }
    return current.kind === "hook" ? { kind: "starting", since: now } : { ...current, activeHookIds, detail: undefined }
  }
  if (record.type === "system" && record.subtype === "init" && current.activeHookIds?.length) {
    return { kind: "starting", since: now, activeHookIds: current.activeHookIds, detail: "已收到初始化，部分 hook 结束状态未确认" }
  }
  let kind: RuntimePhaseKind | undefined
  if (record.type === "system") {
    if (record.subtype === "api_retry") kind = "retry"
    if (record.subtype === "tool_progress") kind = "tool"
  }
  if (record.type === "tool_progress") kind = "tool"
  if (record.type === "stream_event") {
    const inner = record.event as { type?: string; delta?: { type?: string } } | undefined
    if (inner?.type === "message_start") kind = "responding"
    if (inner?.delta?.type === "thinking_delta") kind = "thinking"
    if (inner?.delta?.type === "text_delta") kind = "responding"
    // content_block_stop describes tool INPUT completion, not execution completion.
  }
  if (record.type === "assistant") {
    const content = (record.message as { content?: { type?: string }[] } | undefined)?.content
    kind = Array.isArray(content) && content.some((block) => block.type === "tool_use") ? "tool" : "responding"
  }
  if (!kind || kind === current.kind) return current
  return { kind, since: now, ...(current.activeHookIds?.length ? { activeHookIds: current.activeHookIds,
    detail: "部分 hook 尚未观察到结束事件" } : {}) }
}

export interface RuntimeSelection { provider: string; model: string; effort: string; permissionMode: string; ultracode?: boolean; fastMode?: boolean }
export interface LiveRuntimeSummary {
  runtimeId: string; cwd: string; cliFingerprint: string; provider: string; model: string; effort: string;
  permissionMode: string; launchMode: "headless stream-json"; phase: RuntimePhase; reviewState: string; reviewReason?: string | null;
  fastModeState?: string; ultracode?: boolean; selected?: RuntimeSelection;
  timings?: Record<string, number | undefined>
}
let snapshot: LiveRuntimeSummary[] = []
const subscribers = new Set<() => void>()
export const liveRuntimeSnapshot = () => snapshot
export function publishLiveRuntimeSummaries(summaries: LiveRuntimeSummary[]) {
  snapshot = summaries.slice(-16)
  for (const subscribe of subscribers) subscribe()
}
export function subscribeLiveRuntimeSummaries(subscriber: () => void) {
  subscribers.add(subscriber)
  return () => { subscribers.delete(subscriber) }
}
