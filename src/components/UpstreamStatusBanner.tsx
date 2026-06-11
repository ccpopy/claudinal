import { useState } from "react"
import { ChevronDown, ChevronRight, Copy, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { RollingNumber } from "@/components/RollingNumber"
import { cn } from "@/lib/utils"
import {
  describeUpstreamStatus,
  type UpstreamStatusState
} from "@/lib/proxyStatus"

/**
 * 第三方本地代理观测到上游 429/5xx/断连时的会话内状态条。
 * CLI 在 stream-json 模式下静默退避重试，这里是用户唯一能看到“正在重试”的地方。
 * 头行常驻摘要（重试次数滚动），message 可展开查看全文并复制
 * （展开形态复用 RunStatusStrip 的 grid-rows 过渡语言）。
 */
export function UpstreamStatusBanner({
  status
}: {
  status: UpstreamStatusState
}) {
  const [open, setOpen] = useState(false)
  const hasMessage = status.message.length > 0
  const expanded = hasMessage && open
  // describeUpstreamStatus 的结尾固定是 ` ${count} 次`；
  // 把次数剥出来交给 RollingNumber 滚动，函数本身保持不变。
  const summary = describeUpstreamStatus(status)
  const countSuffix = ` ${status.count} 次`
  const summaryHead = summary.endsWith(countSuffix)
    ? summary.slice(0, summary.length - countSuffix.length)
    : null

  const headRow = (
    <>
      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">
        {summaryHead === null ? (
          summary
        ) : (
          <>
            {summaryHead}
            {" "}
            <RollingNumber value={status.count} />
            {" 次"}
          </>
        )}
      </span>
      {hasMessage && (
        <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground/70 md:inline">
          {status.message}
        </span>
      )}
    </>
  )

  return (
    <div className="mx-auto max-w-3xl rounded-xl border bg-card/95 text-xs shadow-xs backdrop-blur-sm animate-in fade-in slide-in-from-bottom-1 duration-200 xl:max-w-4xl 2xl:max-w-5xl">
      {hasMessage ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={expanded}
          className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left"
        >
          {headRow}
          {expanded ? (
            <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
      ) : (
        <div className="flex h-8 items-center gap-2 px-3">{headRow}</div>
      )}
      {hasMessage && (
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200",
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="overflow-hidden">
            <div className="flex items-start gap-2 border-t px-3 py-2">
              <div className="max-h-40 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                {status.message}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                onClick={() => {
                  void navigator.clipboard.writeText(status.message).then(
                    () => toast.success("已复制"),
                    (error) => toast.error(`复制失败: ${String(error)}`)
                  )
                }}
              >
                <Copy className="size-3.5" />
                复制
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
