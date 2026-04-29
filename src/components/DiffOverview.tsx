import { useMemo, useState } from "react"
import { FileEdit, FilePlus, FileX, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { UIEntry, UIMessage } from "@/types/ui"

interface StructuredHunk {
  oldStart?: number
  oldLines?: number
  newStart?: number
  newLines?: number
  lines?: string[]
}

interface FileChange {
  path: string
  basename: string
  kind: "create" | "update" | "delete"
  hunks: StructuredHunk[]
  content?: string
  adds: number
  dels: number
}

function basename(p?: string): string {
  if (!p) return ""
  const m = p.replace(/\\/g, "/").split("/")
  return m[m.length - 1] || p
}

function collectChanges(entries: UIEntry[]): FileChange[] {
  const map = new Map<string, FileChange>()
  for (const e of entries) {
    if (e.kind !== "message") continue
    const m = e as UIMessage
    if (m.role !== "user") continue
    for (const b of m.blocks) {
      if (b.type !== "tool_result") continue
      const tur = b.toolUseResult as
        | {
            type?: string
            filePath?: string
            content?: string
            structuredPatch?: StructuredHunk[]
          }
        | undefined
      if (!tur) continue
      const fp = tur.filePath
      if (!fp) continue
      const existing = map.get(fp)
      if (tur.type === "update" && tur.structuredPatch) {
        const adds = tur.structuredPatch.reduce(
          (acc, h) =>
            acc + (h.lines ?? []).filter((l) => l.startsWith("+")).length,
          0
        )
        const dels = tur.structuredPatch.reduce(
          (acc, h) =>
            acc + (h.lines ?? []).filter((l) => l.startsWith("-")).length,
          0
        )
        if (existing && existing.kind !== "create") {
          existing.hunks.push(...tur.structuredPatch)
          existing.adds += adds
          existing.dels += dels
        } else if (!existing) {
          map.set(fp, {
            path: fp,
            basename: basename(fp),
            kind: "update",
            hunks: tur.structuredPatch,
            adds,
            dels
          })
        }
      } else if (tur.type === "create") {
        map.set(fp, {
          path: fp,
          basename: basename(fp),
          kind: "create",
          hunks: [],
          content: tur.content,
          adds: (tur.content ?? "").split("\n").length,
          dels: 0
        })
      }
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.basename.localeCompare(b.basename)
  )
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  entries: UIEntry[]
}

export function DiffOverview({ open, onOpenChange, entries }: Props) {
  const changes = useMemo(() => collectChanges(entries), [entries])
  const [activeIdx, setActiveIdx] = useState(0)

  if (!open) return null
  const active = changes[activeIdx]

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="文件 diff 全景"
      className="fixed inset-0 z-40 bg-background/40 backdrop-blur-sm flex justify-end"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-4xl h-full bg-background border-l shadow-lg flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <FileEdit className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">文件 diff</span>
            <Badge variant="outline" className="text-[10px]">
              {changes.length} 文件
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onOpenChange(false)}
            aria-label="关闭"
          >
            <X className="size-4" />
          </Button>
        </div>

        {changes.length === 0 ? (
          <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
            当前会话没有文件变更
          </div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-[260px_1fr]">
            <ScrollArea className="border-r min-h-0">
              <div className="flex flex-col gap-0.5 p-2">
                {changes.map((c, i) => (
                  <button
                    key={c.path}
                    type="button"
                    onClick={() => setActiveIdx(i)}
                    className={cn(
                      "text-left px-2 py-1.5 rounded-md text-xs transition-colors",
                      activeIdx === i
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/60 text-muted-foreground"
                    )}
                    title={c.path}
                  >
                    <div className="flex items-center gap-1.5">
                      {c.kind === "create" ? (
                        <FilePlus className="size-3 text-connected shrink-0" />
                      ) : c.kind === "delete" ? (
                        <FileX className="size-3 text-destructive shrink-0" />
                      ) : (
                        <FileEdit className="size-3 shrink-0" />
                      )}
                      <span className="truncate font-mono">{c.basename}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] mt-0.5 ml-4 tabular-nums">
                      <span className="text-connected">+{c.adds}</span>
                      <span className="text-destructive">-{c.dels}</span>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
            <ScrollArea className="min-h-0">
              {active && (
                <div className="p-3 space-y-2">
                  <div className="text-xs font-mono text-muted-foreground break-all">
                    {active.path}
                  </div>
                  {active.kind === "create" && active.content ? (
                    <pre className="p-2 rounded-md border bg-connected/5 border-connected/20 text-[12px] font-mono whitespace-pre-wrap break-words">
                      {active.content}
                    </pre>
                  ) : (
                    <div className="rounded-md border bg-muted/30 overflow-hidden">
                      {active.hunks.map((h, hi) => (
                        <div key={hi} className="font-mono text-[12px]">
                          <div className="px-2 py-0.5 bg-muted/80 text-muted-foreground text-[11px]">
                            @@ -{h.oldStart ?? 0},{h.oldLines ?? 0} +
                            {h.newStart ?? 0},{h.newLines ?? 0} @@
                          </div>
                          {(h.lines ?? []).map((line, li) => {
                            const c = line.charAt(0)
                            const cls =
                              c === "+"
                                ? "bg-connected/15"
                                : c === "-"
                                  ? "bg-destructive/15"
                                  : ""
                            return (
                              <div
                                key={li}
                                className={cn(
                                  "px-2 py-0.5 whitespace-pre-wrap break-words",
                                  cls
                                )}
                              >
                                {line}
                              </div>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
  )
}
