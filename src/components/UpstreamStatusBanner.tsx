import { Loader2 } from "lucide-react"
import {
  describeUpstreamStatus,
  type UpstreamStatusState
} from "@/lib/proxyStatus"

/**
 * 第三方本地代理观测到上游 429/5xx/断连时的会话内状态条。
 * CLI 在 stream-json 模式下静默退避重试，这里是用户唯一能看到“正在重试”的地方。
 */
export function UpstreamStatusBanner({
  status
}: {
  status: UpstreamStatusState
}) {
  return (
    <div className="mx-auto flex h-8 max-w-3xl items-center gap-2 rounded-xl border bg-card/95 px-3 text-xs shadow-xs backdrop-blur-sm xl:max-w-4xl 2xl:max-w-5xl">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">
        {describeUpstreamStatus(status)}
      </span>
      {status.message && (
        <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground/70 md:inline">
          {status.message}
        </span>
      )}
    </div>
  )
}
