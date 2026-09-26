import { useEffect, useState } from "react"
import { toast } from "sonner"
import { listOutbox, removeOutbox, watchOutbox, type OutboxInput } from "@/lib/outbox"
import { deliveryLabel } from "@/lib/submission"

export function InputRecovery({ cwd, activeRuntimeIds, onRestore }: {
  cwd?: string
  activeRuntimeIds: string[]
  onRestore: (input: OutboxInput) => void
}) {
  const [inputs, setInputs] = useState<OutboxInput[]>([])
  const [error, setError] = useState("")
  useEffect(() => {
    let cancelled = false
    const refresh = () => { void listOutbox().then((items) => {
      if (!cancelled) { setInputs(items); setError("") }
    }).catch(() => { if (!cancelled) setError("无法读取本地输入恢复区") }) }
    refresh()
    const unwatch = watchOutbox(refresh)
    return () => { cancelled = true; unwatch() }
  }, [])
  const recoverable = inputs.filter((input) => input.cwd === cwd && (input.state === "failed" || input.state === "delivery_unknown" || !input.runtimeId || !activeRuntimeIds.includes(input.runtimeId)))
  if (!recoverable.length && !error) return null
  return <details className="mx-6 my-2 rounded-xl border px-3 py-2 text-sm">
    <summary className="cursor-pointer">{error || `本地保留的输入 · ${recoverable.length}`}</summary>
    <div className="max-h-48 space-y-3 overflow-auto pt-2">
      {recoverable.map((input) => <div key={input.id} className="space-y-1">
        <p className="line-clamp-2 whitespace-pre-wrap break-words">{input.text || "附件消息"}</p>
        <p className="text-xs text-muted-foreground">{deliveryLabel[input.state === "writing" || input.state === "awaiting_ack" ? "delivery_unknown" : input.state]} · {input.images.length + input.documents.length} 个附件</p>
        <div className="flex gap-3">
          <button type="button" className="text-primary underline" onClick={() => onRestore(input)}>恢复到输入框</button>
          <button type="button" className="text-muted-foreground" onClick={() => void removeOutbox(input.id).catch((e) => toast.error(String(e)))}>删除本地副本</button>
        </div>
      </div>)}
    </div>
  </details>
}
