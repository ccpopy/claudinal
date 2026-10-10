import { useEffect, useState } from "react"
import { runtimePhaseLabel, type LiveRuntimeSummary } from "@/lib/runtimeStatus"

export function RuntimeStatus({ summary }: { summary: LiveRuntimeSummary }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (summary.phase.kind === "completed") return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [summary.phase.kind])
  const elapsed = Math.max(0, Math.floor((now - summary.phase.since) / 1000))
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1 text-xs text-muted-foreground">
    <span role="status" aria-live="polite" title={summary.phase.detail}>{runtimePhaseLabel[summary.phase.kind]}{summary.phase.kind !== "completed" && elapsed > 0 ? ` · ${elapsed}s` : ""}{summary.phase.detail ? " · 状态待确认" : ""}</span>
    <span title="当前进程实际启动或经 CLI 确认的配置">{summary.provider} · {summary.model || "CLI 默认模型"} · effort {summary.effort || "待确认"}</span>
    <span title={summary.reviewReason ?? undefined}>审查：{({ pending: "准备中", ready: "可用", partial: "部分覆盖", unavailable: "不可用" } as Record<string, string>)[summary.reviewState] ?? "待确认"}</span>
  </div>
}
