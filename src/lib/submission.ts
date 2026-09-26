/** Local acceptance is distinct from CLI acknowledgement and execution. */
export type SubmitOutcome =
  | { kind: "accepted_local"; clientMessageId: string }
  | { kind: "rejected"; reason: string }
  | { kind: "cancelled" }

export type DeliveryState = "queued" | "writing" | "awaiting_ack" | "acknowledged" | "responded" | "failed" | "delivery_unknown"

export const deliveryLabel: Record<DeliveryState, string> = {
  queued: "等待下一轮",
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
  return outcome.kind === "accepted_local" && submitted.key === current.key && submitted.revision === current.revision
}

export function deliveryAfterWriteError(error: unknown): DeliveryState {
  const detail = error as { deliveryCertainty?: string } | null
  return detail?.deliveryCertainty === "not_sent" ? "failed" : "delivery_unknown"
}
