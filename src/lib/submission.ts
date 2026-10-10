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
  const value = event as { user_message_uuids?: unknown; user_message_uuid?: unknown }
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
  return undefined
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
