import { lazy, Suspense, useCallback, useEffect, useReducer, useState } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { ArchiveRestore, FolderOpen, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { readSessionSidecar, readSessionTranscript } from "@/lib/ipc"
import { unarchive } from "@/lib/archivedSessions"
import { reduce, init as initReducer, type State } from "@/lib/reducer"
import { sessionDisplayTitle } from "@/lib/sessionDisplayTitle"
import { getSessionTitle } from "@/lib/sessionTitles"
import type { ClaudeEvent } from "@/types/events"
import type { Project } from "@/lib/projects"
import type { SessionMeta } from "@/lib/ipc"

const MessageStream = lazy(() =>
  import("@/components/MessageStream").then((m) => ({
    default: m.MessageStream
  }))
)

interface PreviewTarget {
  project: Project
  session: SessionMeta
}

interface Props {
  target: PreviewTarget | null
  onOpenChange: (open: boolean) => void
  onUnarchived?: (target: PreviewTarget) => void
}

export function ArchivedSessionPreview({
  target,
  onOpenChange,
  onUnarchived
}: Props) {
  const [state, dispatch] = useReducer(reduce, undefined, initReducer)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = !!target

  useEffect(() => {
    if (!target) {
      dispatch({ kind: "reset" })
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    dispatch({ kind: "reset" })
    ;(async () => {
      try {
        const events = (await readSessionTranscript(
          target.project.cwd,
          target.session.id
        )) as ClaudeEvent[]
        const sidecar = (await readSessionSidecar(
          target.project.cwd,
          target.session.id
        ).catch(() => null)) as
          | { result?: ClaudeEvent }
          | null
        if (cancelled) return
        const merged: ClaudeEvent[] = sidecar?.result
          ? [...events, sidecar.result]
          : events
        dispatch({ kind: "load_transcript", events: merged })
      } catch (e) {
        if (cancelled) return
        setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target])

  const handleUnarchive = useCallback(() => {
    if (!target) return
    unarchive(target.project.id, target.session.id)
    toast.success("已取消归档")
    onUnarchived?.(target)
    onOpenChange(false)
  }, [target, onUnarchived, onOpenChange])

  const headerTitle = target
    ? getSessionTitle(target.session.id) ?? sessionDisplayTitle(target.session)
    : ""

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-x-0 bottom-0 top-9 z-40 bg-background/35 backdrop-blur-[2px] duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed bottom-1.5 right-1.5 top-10 z-50 flex w-[min(940px,calc(100vw-0.75rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-8 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-8"
        >
          <DialogPrimitive.Title className="sr-only">
            归档会话预览
          </DialogPrimitive.Title>
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
            <span
              className="truncate text-sm font-medium"
              title={headerTitle}
            >
              {headerTitle}
            </span>
            <span className="shrink-0 rounded border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              已归档
            </span>
            {target && (
              <span
                className="ml-2 flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground"
                title={target.project.cwd}
              >
                <FolderOpen className="size-3.5 shrink-0" />
                <span className="truncate">{target.project.name}</span>
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleUnarchive}
                disabled={!target}
              >
                <ArchiveRestore className="size-4" />
                取消归档
              </Button>
              <DialogPrimitive.Close asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="关闭"
                >
                  <X className="size-4" />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col">
            {loading ? (
              <div className="grid h-full place-items-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="grid h-full place-items-center px-6 text-center text-sm text-destructive">
                加载会话失败：{error}
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="grid h-full place-items-center">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                }
              >
                <PreviewBody state={state} />
              </Suspense>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function PreviewBody({ state }: { state: State }) {
  return (
    <MessageStream
      entries={state.entries}
      streaming={false}
      autoScroll={false}
    />
  )
}
