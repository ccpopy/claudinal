import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ArchiveRestore, ChevronDown, CircleAlert, Trash2 } from "lucide-react"
import { listOutboxHeaders, readOutbox, removeOutboxAttempt, watchOutbox, type OutboxInput, type OutboxHeader } from "@/lib/outbox"
import { findSessionInputReceipts } from "@/lib/ipc"
import { isOrphanOutbox, reconcileOutboxHeaders, type OutboxRecoveryScope } from "@/lib/outboxRecovery"
import { deliveryLabel } from "@/lib/submission"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface RecoveryActionContext {
  isCurrent(): boolean
  scope(): OutboxRecoveryScope
  restore(input: OutboxInput): void
}

/** The clicked snapshot and conversation retain ownership across attachment IO. */
export async function restoreRecoveryInput(input: OutboxHeader, context: RecoveryActionContext,
  read: typeof readOutbox = readOutbox): Promise<boolean> {
  if (!context.isCurrent() || !isOrphanOutbox(input, context.scope())) return false
  const value = await read(input.id)
  if (!value || !context.isCurrent() || !isOrphanOutbox({ ...input, ...value }, context.scope())
    || value.id !== input.id || value.cwd !== input.cwd || value.attemptId !== input.attemptId
    || value.inputRevision !== input.inputRevision || value.createdAt !== input.createdAt
    || value.conversationId !== input.conversationId) return false
  context.restore(value)
  return true
}

export async function deleteRecoveryInput(input: OutboxHeader,
  remove: typeof removeOutboxAttempt = removeOutboxAttempt): Promise<boolean> {
  return remove(input.id, input.attemptId, input)
}

/**
 * 崩溃 / 旧会话遗留输入的辅助恢复入口。日常失败在原消息处处理，
 * 这里只是输入框上方一条安静的提示，与输入框同宽。
 */
export function InputRecovery({ cwd, activeRuntimeIds, liveMessageIds = [], centered = false, canRestore, onRestore }: {
  cwd?: string
  activeRuntimeIds: string[]
  liveMessageIds?: string[]
  /** 欢迎页居中布局：外层已限宽，无需再加边距 */
  centered?: boolean
  /** Captured App view generation: also reject switches before React renders. */
  canRestore: () => boolean
  onRestore: (input: OutboxInput) => void
}) {
  const [inputs, setInputs] = useState<OutboxHeader[]>([])
  const [error, setError] = useState("")
  const [unavailableReason, setUnavailableReason] = useState<string>()
  const [open, setOpen] = useState(false)
  const [restoringIds, setRestoringIds] = useState<ReadonlySet<string>>(new Set())
  const restoringRef = useRef(new Set<string>())
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  const scopeRef = useRef({ cwd, activeRuntimeIds, liveMessageIds })
  scopeRef.current = { cwd, activeRuntimeIds, liveMessageIds }
  const liveKey = JSON.stringify([...liveMessageIds].sort())
  const runtimeKey = JSON.stringify([...activeRuntimeIds].sort())
  useEffect(() => {
    let cancelled = false
    let refreshing = false
    let refreshAgain = false
    const refresh = () => {
      if (refreshing) { refreshAgain = true; return }
      refreshing = true
      void (async () => {
        do {
          refreshAgain = false
          const items = await listOutboxHeaders()
          if (cancelled) return
          const result = await reconcileOutboxHeaders(items, scopeRef.current, {
            find: findSessionInputReceipts, remove: removeOutboxAttempt,
            stillOrphan: (input) => !cancelled && isOrphanOutbox(input, scopeRef.current)
          })
          if (cancelled) return
          setInputs(result.headers); setError(""); setUnavailableReason(result.unavailableReason)
        } while (refreshAgain && !cancelled)
      })().catch(() => { if (!cancelled) setError("无法读取本地输入恢复区") })
        .finally(() => { refreshing = false })
    }
    refresh()
    const unwatch = watchOutbox(refresh)
    return () => { cancelled = true; unwatch() }
  }, [cwd, liveKey, runtimeKey])
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
        {unavailableReason && <li role="status" className="px-3 py-2 text-muted-foreground">{unavailableReason}</li>}
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
            disabled={restoringIds.has(input.id)}
            onClick={() => {
              if (restoringRef.current.has(input.id)) return
              restoringRef.current.add(input.id); setRestoringIds(new Set(restoringRef.current))
              void restoreRecoveryInput(input, {
                isCurrent: () => mountedRef.current && canRestore(),
                scope: () => scopeRef.current, restore: onRestore
              }).catch((error) => toast.error(String(error))).finally(() => {
                restoringRef.current.delete(input.id)
                if (mountedRef.current) setRestoringIds(new Set(restoringRef.current))
              })
            }}
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
            onClick={() => void deleteRecoveryInput(input).catch((error) => toast.error(String(error)))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </li>)}
      </ul>}
    </div>
  </div>
}
