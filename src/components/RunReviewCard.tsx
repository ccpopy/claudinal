import { useMemo, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  FileEdit,
  FilePlus,
  FileX,
  GitCompareArrows
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  collectChanges,
  type FileChange,
  type ReviewRunDiff
} from "@/lib/diff"
import type { GitWorktreeStatus, WorktreeDiff } from "@/lib/ipc"
import { cn } from "@/lib/utils"
import type { UIEntry } from "@/types/ui"

export function RunStatusStrip({
  entries,
  cwd,
  gitStatus,
  worktreeDiff,
  reviews = [],
  diffOpen = false,
  onShowDiff
}: {
  entries: UIEntry[]
  streaming?: boolean
  cwd?: string | null
  gitStatus?: GitWorktreeStatus | null
  worktreeDiff?: WorktreeDiff | null
  reviews?: ReviewRunDiff[]
  diffOpen?: boolean
  onShowDiff?: (path?: string) => void
}) {
  const changes = useMemo(
    () =>
      collectChanges({
        entries,
        gitStatus,
        worktreeDiff,
        snapshotDiffs: reviews.map((review) => review.diff),
        cwd
      }),
    [entries, gitStatus, worktreeDiff, reviews, cwd]
  )
  const summary = useMemo(() => summarizeChanges(changes), [changes])
  const [open, setOpen] = useState(false)
  if (summary.files === 0) return null
  return (
    <div className="mx-auto max-w-3xl rounded-md border bg-background/95 text-xs shadow-sm">
      <div className="flex h-8 items-center justify-between gap-3 px-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0 text-muted-foreground">
            {summary.files} 个文件已更改
          </span>
          <span className="font-mono font-medium text-connected">
            +{summary.additions}
          </span>
          <span className="font-mono font-medium text-destructive">
            -{summary.deletions}
          </span>
          {summary.binary > 0 && (
            <span className="truncate text-muted-foreground">
              {summary.binary} 个二进制文件
            </span>
          )}
        </button>
        {!diffOpen && onShowDiff && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => onShowDiff()}
          >
            查看更改
          </Button>
        )}
      </div>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-0.5 border-t px-2 py-2">
            {changes.map((change) => (
              <FileChangeRow
                key={`${change.source}:${change.path}`}
                change={change}
                onClick={() => onShowDiff?.(change.path)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function FileChangeRow({
  change,
  onClick
}: {
  change: FileChange
  onClick: () => void
}) {
  const Icon =
    change.kind === "delete"
      ? FileX
      : change.kind === "create"
        ? FilePlus
        : FileEdit
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-accent/60"
      title={change.path}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
        {change.path}
      </span>
      {change.binary ? (
        <span className="shrink-0 text-muted-foreground">二进制</span>
      ) : (
        <>
          <span className="shrink-0 font-mono text-connected">
            +{change.adds}
          </span>
          <span className="shrink-0 font-mono text-destructive">
            -{change.dels}
          </span>
        </>
      )}
      <GitCompareArrows className="size-3.5 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

function summarizeChanges(changes: FileChange[]) {
  return changes.reduce(
    (summary, change) => {
      summary.files += 1
      summary.additions += change.adds
      summary.deletions += change.dels
      if (change.binary) summary.binary += 1
      return summary
    },
    { files: 0, additions: 0, deletions: 0, binary: 0 }
  )
}

export function RunReviewCard({
  review,
  onShowDiff
}: {
  review: ReviewRunDiff
  onShowDiff?: () => void
}) {
  const [open, setOpen] = useState(false)
  const files = review.diff.files
  if (files.length === 0) return null
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const sourceLabel = review.diff.isRepo ? "工作树" : "快照"
  return (
    <div className="mt-2 rounded-lg border bg-card text-xs">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 text-left"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          />
          <span className="font-medium">本轮 {files.length} 个文件已更改</span>
          <span className="font-mono text-connected">+{additions}</span>
          <span className="font-mono text-destructive">-{deletions}</span>
          {review.diff.patchError && (
            <span className="truncate text-muted-foreground">
              patch 不完整
            </span>
          )}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={onShowDiff}
        >
          <GitCompareArrows className="size-3.5" />
          审查
        </Button>
      </div>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-1 border-t px-3 py-2">
            {files.map((file) => {
              const Icon = file.status.includes("D")
                ? FileX
                : file.status.includes("A") || file.status.includes("?")
                  ? FilePlus
                  : FileEdit
              return (
                <div key={file.path} className="flex items-center gap-2">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {sourceLabel}
                  </span>
                  <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {statusLabel(file.status)}
                  </span>
                  {file.binary ? (
                    <span className="text-muted-foreground">二进制</span>
                  ) : (
                    <>
                      <span className="font-mono text-connected">+{file.additions}</span>
                      <span className="font-mono text-destructive">-{file.deletions}</span>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function statusLabel(status: string): string {
  if (status.includes("D")) return "删除"
  if (status.includes("A") || status.includes("?")) return "新增"
  if (status.includes("R")) return "重命名"
  if (status.includes("C")) return "复制"
  return "修改"
}
