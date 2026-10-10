import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { MessageStream } from "./MessageStream"
import { readSessionTranscript, readSessionSidecar } from "@/lib/ipc"
import { restoreInputMetadata, restoreTranscriptInputOrigins } from "@/lib/inputMetadata"
import { init, reduce } from "@/lib/reducer"
import { resolveTranscriptTarget, type TranscriptNavigationRequest } from "@/lib/transcriptNavigation"
import type { UIEntry } from "@/types/ui"

export interface TranscriptHistoryRequest extends TranscriptNavigationRequest {
  cwd: string
  sessionId: string
}

/** Original disk history is a read-only view, independent of a live runtime. */
export function TranscriptHistoryPreview({ request, onClose }: { request: TranscriptHistoryRequest; onClose: () => void }) {
  const [loaded, setLoaded] = useState<{ entries: UIEntry[]; navigation: TranscriptNavigationRequest | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [locationMissing, setLocationMissing] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoaded(null); setError(null); setLocationMissing(false)
    void Promise.all([readSessionTranscript(request.cwd, request.sessionId), readSessionSidecar(request.cwd, request.sessionId)])
      .then(([events, sidecar]) => {
        if (cancelled) return
        const prepared = restoreTranscriptInputOrigins(events, sidecar)
        const target = resolveTranscriptTarget(prepared, request.target)
        const restored = restoreInputMetadata(reduce(init(), { kind: "load_transcript", events: prepared }), sidecar)
        setLoaded({ entries: restored.entries, navigation: target ? { id: request.id, target } : null })
        setLocationMissing(!target)
      }, (reason) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [request])
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="flex h-[85vh] w-[min(1100px,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
      <DialogHeader className="shrink-0 border-b px-6 py-4">
        <DialogTitle>压缩前的原始记录</DialogTitle>
        <DialogDescription>{error ? "原始记录暂时无法读取。" : !loaded ? "正在查找压缩前的消息。"
          : locationMissing ? "已读取历史，原始边界位置已不可用。" : "已定位到压缩边界前的消息，可继续向前查看完整历史。"}</DialogDescription>
      </DialogHeader>
      {error ? <p role="alert" className="p-6 text-sm text-destructive">读取原始记录失败：{error}</p>
        : !loaded ? <p role="status" className="p-6 text-sm text-muted-foreground">正在读取原始记录…</p>
          : <>
            {locationMissing && <p role="status" className="shrink-0 border-b px-6 py-3 text-sm text-muted-foreground">原始记录中的边界位置已不可用，请在下方历史中查看。</p>}
            <MessageStream entries={loaded.entries} streaming={false} autoScroll={false} cwd={request.cwd}
              navigationRequest={loaded.navigation} onNavigationSettled={(id, found) => {
                setLocationMissing(!found)
                setLoaded((current) => current?.navigation?.id === id ? { ...current, navigation: null } : current)
              }} />
          </>}
    </DialogContent>
  </Dialog>
}
