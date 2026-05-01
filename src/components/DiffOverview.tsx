import { useMemo, useState } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { FileEdit, FilePlus, FileX, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { GitWorktreeStatus, WorktreeDiff } from "@/lib/ipc"
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
  oldPath?: string | null
  basename: string
  kind: "create" | "update" | "delete"
  source: "session" | "git" | "status"
  hunks: StructuredHunk[]
  content?: string
  binary?: boolean
  adds: number
  dels: number
}

function basename(p?: string): string {
  if (!p) return ""
  const m = p.replace(/\\/g, "/").split("/")
  return m[m.length - 1] || p
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

function relPath(path: string, cwd?: string | null): string {
  const normalized = normalizePath(path)
  const root = cwd ? normalizePath(cwd).replace(/\/+$/, "") : ""
  if (root && normalized.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return normalized.slice(root.length + 1)
  }
  return normalized
}

function keyPath(path: string): string {
  return normalizePath(path).toLowerCase()
}

function kindFromStatus(status: string): FileChange["kind"] {
  if (status.includes("D")) return "delete"
  if (status.includes("?") || status.includes("A")) return "create"
  return "update"
}

function collectChanges(
  entries: UIEntry[],
  gitStatus?: GitWorktreeStatus | null,
  worktreeDiff?: WorktreeDiff | null,
  cwd?: string | null
): FileChange[] {
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
      const displayPath = relPath(fp, cwd)
      const key = keyPath(displayPath)
      const existing = map.get(key)
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
          map.set(key, {
            path: displayPath,
            basename: basename(displayPath),
            kind: "update",
            source: "session",
            hunks: tur.structuredPatch,
            adds,
            dels
          })
        }
      } else if (tur.type === "create") {
        map.set(key, {
          path: displayPath,
          basename: basename(displayPath),
          kind: "create",
          source: "session",
          hunks: [],
          content: tur.content,
          adds: (tur.content ?? "").split("\n").length,
          dels: 0
        })
      }
    }
  }
  if (worktreeDiff?.isRepo) {
    for (const file of worktreeDiff.files) {
      const key = keyPath(file.path)
      map.set(key, {
        path: file.path,
        oldPath: file.oldPath,
        basename: basename(file.path),
        kind: kindFromStatus(file.status),
        source: "git",
        hunks: file.hunks,
        binary: file.binary,
        adds: file.additions,
        dels: file.deletions
      })
    }
  }
  if (gitStatus?.isRepo) {
    for (const file of gitStatus.files) {
      const key = keyPath(file.path)
      if (map.has(key)) continue
      map.set(key, {
        path: file.path,
        basename: basename(file.path),
        kind: kindFromStatus(file.status),
        source: "status",
        hunks: [],
        adds: file.additions,
        dels: file.deletions
      })
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.basename.localeCompare(b.basename)
  )
}

interface DiffRow {
  kind: "add" | "del" | "ctx" | "meta"
  oldLine: number | null
  newLine: number | null
  text: string
  sign: string
}

function hunkRows(hunk: StructuredHunk): DiffRow[] {
  let oldLine = hunk.oldStart ?? 0
  let newLine = hunk.newStart ?? 0
  return (hunk.lines ?? []).map((raw) => {
    const mark = raw.charAt(0)
    if (mark === "\\") {
      return {
        kind: "meta",
        oldLine: null,
        newLine: null,
        text: raw,
        sign: ""
      }
    }
    const text = mark === "+" || mark === "-" || mark === " " ? raw.slice(1) : raw
    if (mark === "+") {
      return {
        kind: "add",
        oldLine: null,
        newLine: newLine++,
        text,
        sign: "+"
      }
    }
    if (mark === "-") {
      return {
        kind: "del",
        oldLine: oldLine++,
        newLine: null,
        text,
        sign: "-"
      }
    }
    return {
      kind: "ctx",
      oldLine: oldLine++,
      newLine: newLine++,
      text,
      sign: ""
    }
  })
}

function UnifiedDiff({ hunks }: { hunks: StructuredHunk[] }) {
  return (
    <div className="rounded-md border bg-muted/20 overflow-hidden">
      {hunks.map((h, hi) => (
        <div key={hi} className="font-mono text-[12px]">
          <div className="px-3 py-1 bg-muted/80 text-muted-foreground text-[11px]">
            @@ -{h.oldStart ?? 0},{h.oldLines ?? 0} +{h.newStart ?? 0},
            {h.newLines ?? 0} @@
          </div>
          {hunkRows(h).map((row, li) => (
            <div
              key={li}
              className={cn(
                "grid grid-cols-[3.25rem_3.25rem_1.25rem_minmax(0,1fr)] min-w-0",
                row.kind === "add" && "bg-connected/15",
                row.kind === "del" && "bg-destructive/15",
                row.kind === "meta" && "bg-muted/40 text-muted-foreground italic"
              )}
            >
              <div className="select-none border-r px-2 py-0.5 text-right text-muted-foreground/75">
                {row.oldLine ?? ""}
              </div>
              <div className="select-none border-r px-2 py-0.5 text-right text-muted-foreground/75">
                {row.newLine ?? ""}
              </div>
              <div
                className={cn(
                  "select-none px-1 py-0.5 text-center",
                  row.kind === "add" && "text-connected",
                  row.kind === "del" && "text-destructive"
                )}
              >
                {row.sign}
              </div>
              <div className="min-w-0 px-2 py-0.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {row.text || " "}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  entries: UIEntry[]
  gitStatus?: GitWorktreeStatus | null
  worktreeDiff?: WorktreeDiff | null
  worktreeDiffLoading?: boolean
  worktreeDiffError?: string | null
  cwd?: string | null
}

export function DiffOverview({
  open,
  onOpenChange,
  entries,
  gitStatus,
  worktreeDiff,
  worktreeDiffLoading,
  worktreeDiffError,
  cwd
}: Props) {
  const changes = useMemo(
    () => collectChanges(entries, gitStatus, worktreeDiff, cwd),
    [entries, gitStatus, worktreeDiff, cwd]
  )
  const [activeIdx, setActiveIdx] = useState(0)

  const safeActiveIdx = Math.min(activeIdx, Math.max(changes.length - 1, 0))
  const active = changes[safeActiveIdx]

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-x-0 bottom-0 top-9 z-40 bg-background/35 backdrop-blur-[2px] duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed bottom-1.5 right-1.5 top-10 z-50 flex w-[min(940px,calc(100vw-0.75rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-8 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-8"
        >
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <FileEdit className="size-4 text-muted-foreground" />
            <DialogPrimitive.Title className="text-sm font-medium">
              文件 diff
            </DialogPrimitive.Title>
            <Badge variant="outline" className="text-[10px]">
              {changes.length} 文件
            </Badge>
          </div>
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="关闭"
            >
              <X className="size-4" />
            </Button>
          </DialogPrimitive.Close>
        </div>

        {changes.length === 0 ? (
          <div className="flex-1 grid place-items-center px-6 text-center text-muted-foreground text-sm">
            {worktreeDiffLoading
              ? "正在读取文件 diff…"
              : worktreeDiffError
                ? `读取文件 diff 失败：${worktreeDiffError}`
                : gitStatus?.isRepo === false
                  ? "当前目录不是 Git 仓库；没有会话工具补丁时，缺少可比较基线，无法展示手工文件修改。"
                  : "当前会话没有文件变更"}
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
                      safeActiveIdx === i
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
                      <span className="text-muted-foreground">
                        {c.source === "git"
                          ? "Git"
                          : c.source === "session"
                            ? "会话"
                            : "状态"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
            <ScrollArea key={active?.path ?? "empty"} className="min-h-0">
              {active && (
                <div className="p-3 space-y-2">
                  {(worktreeDiffLoading || worktreeDiffError) && (
                    <div
                      className={cn(
                        "rounded-md border px-3 py-2 text-xs",
                        worktreeDiffError
                          ? "border-destructive/25 bg-destructive/5 text-destructive"
                          : "bg-muted/30 text-muted-foreground"
                      )}
                    >
                      {worktreeDiffError
                        ? `读取 Git patch 失败：${worktreeDiffError}`
                        : "正在读取最新文件 diff…"}
                    </div>
                  )}
                  <div className="text-xs font-mono text-muted-foreground break-all">
                    {active.path}
                    {active.oldPath && active.oldPath !== active.path && (
                      <span> ← {active.oldPath}</span>
                    )}
                  </div>
                  {active.binary ? (
                    <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                      二进制文件有变更，无法以内联文本 diff 展示。
                    </div>
                  ) : active.kind === "create" && active.content ? (
                    <pre className="p-2 rounded-md border bg-connected/5 border-connected/20 text-[12px] font-mono whitespace-pre-wrap break-words">
                      {active.content}
                    </pre>
                  ) : active.hunks.length > 0 ? (
                    <UnifiedDiff hunks={active.hunks} />
                  ) : (
                    <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                      {active.source === "status"
                        ? "此文件来自当前 Git 工作树状态。读取 patch 失败或尚未完成，但已检测到"
                        : "此文件没有可展示的结构化补丁，但已记录到"}{" "}
                      <span className="font-mono text-connected">+{active.adds}</span>{" "}
                      <span className="font-mono text-destructive">-{active.dels}</span>
                      。
                    </div>
                  )}
                </div>
              )}
            </ScrollArea>
          </div>
        )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
