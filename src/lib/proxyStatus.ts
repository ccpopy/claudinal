import type { ProxyStatusEvent } from "@/types/events"

// 第三方本地代理的上游状态归并。
// CLI 在 stream-json 模式下对 429/5xx 静默退避重试（无 stderr、无事件），
// 代理把每次上游失败上报为 proxy-status 事件；这里把事件流归并成单条可展示状态：
// 同类错误累计计数，recovered 清空。

export interface UpstreamStatusState {
  kind: "upstream-error" | "network-error"
  status: number | null
  message: string
  model: string | null
  count: number
  lastAt: number
}

export function reduceProxyStatus(
  current: UpstreamStatusState | null,
  ev: ProxyStatusEvent,
  now: number
): UpstreamStatusState | null {
  if (ev.kind === "recovered") return null
  if (ev.kind !== "upstream-error" && ev.kind !== "network-error") return current
  const status = typeof ev.status === "number" ? ev.status : null
  const sameTopic =
    current !== null && current.kind === ev.kind && current.status === status
  return {
    kind: ev.kind,
    status,
    message: (ev.message ?? "").trim(),
    model: (ev.model ?? "").trim() || null,
    count: sameTopic ? current.count + 1 : 1,
    lastAt: now
  }
}

export function describeUpstreamStatus(state: UpstreamStatusState): string {
  const target = state.model ? `（${state.model}）` : ""
  const head =
    state.kind === "upstream-error"
      ? `上游返回 ${state.status ?? "错误"}${target}`
      : `上游连接失败${target}`
  return `${head}，Claude CLI 正在退避重试 · 已观察到 ${state.count} 次`
}

/** 拼出 networkErrorHints.detectNetworkError 能识别的文本（含 "HTTP status <code>"）。 */
export function proxyStatusErrorText(ev: ProxyStatusEvent): string {
  const parts: string[] = []
  if (typeof ev.status === "number") parts.push(`HTTP status ${ev.status}`)
  if (ev.model) parts.push(`model ${ev.model}`)
  if (ev.message?.trim()) parts.push(ev.message.trim())
  return parts.join(" · ")
}
