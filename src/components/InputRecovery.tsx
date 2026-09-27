import { useEffect, useState } from "react"
import { toast } from "sonner"
import { ArchiveRestore, ChevronDown, CircleAlert, Trash2 } from "lucide-react"
import { listOutboxHeaders, readOutbox, removeOutbox, watchOutbox, type OutboxInput, type OutboxHeader } from "@/lib/outbox"
import { deliveryLabel } from "@/lib/submission"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * 崩溃 / 旧会话遗留输入的辅助恢复入口。日常失败在原消息处处理，
 * 这里只是输入框上方一条安静的提示，与输入框同宽。
 */
export function InputRecovery({ cwd, activeRuntimeIds, liveMessageIds = [], centered = false, onRestore }: {
  cwd?: string
  activeRuntimeIds: string[]
  liveMessageIds?: string[]
  /** 欢迎页居中布局：外层已限宽，无需再加边距 */
  centered?: boolean
  onRestore: (input: OutboxInput) => void
}) {
  const [inputs, setInputs] = useState<OutboxHeader[]>([])
  const [error, setError] = useState("")
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    const refresh = () => { void listOutboxHeaders().then((items) => {
      if (!cancelled) { setInputs(items); setError("") }
    }).catch(() => { if (!cancelled) setError("无法读取本地输入恢复区") }) }
    refresh()
    const unwatch = watchOutbox(refresh)
    return () => { cancelled = true; unwatch() }
  }, [])
  const recoverable = inputs.filter((input) => !liveMessageIds.includes(input.id) && input.cwd === cwd && (input.state === "failed" || input.state === "delivery_unknown" || !input.runtimeId || !activeRuntimeIds.includes(input.runtimeId)))
  if (!recoverable.length && !error) return null
  return <div className={cn(!centered && "bg-background px-6 pt-2")}>
    <div className={cn(
      "overflow-hidden rounded-xl border bg-muted/30 text-xs",
      !centered && "mx-auto w-full max-w-3xl xl:max-w-4xl 2xl:max-w-5xl"
    )}>
      {error ? <div role="alert" className="flex items-center gap-2 px-3 py-2 text-destructive">
        <CircleAlert className="size-3.5 shrink-0" aria-hidden />{error}
      </div> : <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ArchiveRestore className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{recoverable.length} 条未完成的输入保留在本地</span>
        <span className="shrink-0">{open ? "收起" : "查看"}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>}
      {open && !error && <ul className="max-h-56 divide-y overflow-auto border-t bg-card">
        {recoverable.map((input) => <li key={input.id} className="flex items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground" title={input.preview}>{input.preview || "附件消息"}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {deliveryLabel[input.state === "writing" || input.state === "awaiting_ack" ? "delivery_unknown" : input.state]}
              {input.attachments ? ` · ${input.attachments} 个附件` : ""}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => void readOutbox(input.id).then((value) => { if (value) onRestore(value) }).catch((e) => toast.error(String(e)))}
          >
            恢复到输入框
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 px-0 text-muted-foreground hover:text-destructive"
            aria-label="删除本地副本"
            title="删除本地副本"
            onClick={() => void removeOutbox(input.id).catch((e) => toast.error(String(e)))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </li>)}
      </ul>}
    </div>
  </div>
}
