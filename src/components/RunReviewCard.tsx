import { useEffect, useMemo, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  FileEdit,
  FilePlus,
  FileX,
  GitCompareArrows
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { FileDiffPreview } from "@/components/DiffPreview"
import { RollingNumber } from "@/components/RollingNumber"
import {
  collectLatestRunToolChanges,
  fileChangeFromWorktreeFile,
  type FileChange,
  type ReviewRunDiff
} from "@/lib/diff"
import type { WorktreeFileDiff } from "@/lib/ipc"
import { cn } from "@/lib/utils"
import type { UIEntry } from "@/types/ui"

const REVIEW_FILE_COLLAPSE_LIMIT = 3

export function RunStatusStrip({
  entries,
  streaming,
  cwd,
  diffOpen = false,
  onShowDiff
}: {
  entries: UIEntry[]
  streaming: boolean
  cwd?: string | null
  diffOpen?: boolean
  onShowDiff?: (path?: string) => void
}) {
  const changes = useMemo(
    () => collectLatestRunToolChanges(entries, cwd),
    [entries, cwd]
  )
  const summary = useMemo(() => summarizeChanges(changes), [changes])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])
  if (!streaming || summary.files === 0) return null
  return (
    <div className="mx-auto max-w-3xl rounded-xl border bg-card/95 text-xs shadow-xs backdrop-blur-sm xl:max-w-4xl 2xl:max-w-5xl">
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
            <RollingNumber value={summary.files} /> 个文件已更改
          </span>
          <span className="font-mono font-medium text-connected tabular-nums">
            <RollingNumber value={summary.additions} prefix="+" />
          </span>
          <span className="font-mono font-medium text-destructive tabular-nums">
            <RollingNumber value={summary.deletions} prefix="-" />
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
            在此审查
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
  onShowDiff?: (path?: string) => void
}) {
  const [open, setOpen] = useState(true)
  const [expandedFileKey, setExpandedFileKey] = useState<string | null>(null)
  const [filesExpanded, setFilesExpanded] = useState(false)
  const files = review.diff.files
  const changes = useMemo(
    () => files.map((file) => fileChangeFromWorktreeFile(file, "snapshot")),
    [files]
  )
  if (files.length === 0) return null
  const hiddenFileCount = Math.max(files.length - REVIEW_FILE_COLLAPSE_LIMIT, 0)
  const canCollapseFiles = hiddenFileCount > 0
  const visibleFiles = filesExpanded
    ? files
    : files.slice(0, REVIEW_FILE_COLLAPSE_LIMIT)
  const visibleChanges = filesExpanded
    ? changes
    : changes.slice(0, REVIEW_FILE_COLLAPSE_LIMIT)
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const sourceLabel = review.diff.isRepo ? "工作树" : "快照"
  return (
    <div className="mt-2 overflow-hidden rounded-lg border bg-card text-xs shadow-xs">
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
          onClick={() => onShowDiff?.()}
        >
          <GitCompareArrows className="size-3.5" />
          审核
        </Button>
      </div>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-1 border-t px-2 py-2">
            {visibleFiles.map((file, index) => {
              const change = visibleChanges[index]
              const fileKey = `${file.path}:${file.status}:${index}`
              return (
                <ReviewFileRow
                  key={fileKey}
                  file={file}
                  change={change}
                  sourceLabel={sourceLabel}
                  expanded={expandedFileKey === fileKey}
                  onToggle={() =>
                    setExpandedFileKey((current) =>
                      current === fileKey ? null : fileKey
                    )
                  }
                  onOpenDiff={() => onShowDiff?.(file.path)}
                />
              )
            })}
            {canCollapseFiles && (
              <button
                type="button"
                className="flex h-7 w-full items-center justify-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                onClick={() => {
                  setFilesExpanded((current) => {
                    const next = !current
                    if (!next) setExpandedFileKey(null)
                    return next
                  })
                }}
                aria-expanded={filesExpanded}
              >
                {filesExpanded ? "收起" : `显示更多 ${hiddenFileCount} 个`}
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    filesExpanded && "rotate-180"
                  )}
                />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ReviewFileRow({
  file,
  change,
  sourceLabel,
  expanded,
  onToggle,
  onOpenDiff
}: {
  file: WorktreeFileDiff
  change: FileChange
  sourceLabel: string
  expanded: boolean
  onToggle: () => void
  onOpenDiff: () => void
}) {
  const Icon =
    change.kind === "delete"
      ? FileX
      : change.kind === "create"
        ? FilePlus
        : FileEdit
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border transition-colors",
        expanded ? "border-border bg-muted/20" : "border-transparent"
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          className="group flex h-8 min-w-0 flex-1 items-center gap-2 rounded px-2 text-left transition-colors hover:bg-accent/60"
          aria-expanded={expanded}
          title={file.path}
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90"
            )}
          />
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
            {file.path}
          </span>
          <span className="hidden shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-flex">
            {sourceLabel}
          </span>
          <span className="hidden shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-flex">
            {statusLabel(file.status)}
          </span>
          {file.binary ? (
            <span className="shrink-0 text-muted-foreground">二进制</span>
          ) : (
            <>
              <span className="shrink-0 font-mono text-connected">
                +{file.additions}
              </span>
              <span className="shrink-0 font-mono text-destructive">
                -{file.deletions}
              </span>
            </>
          )}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          onClick={onOpenDiff}
          aria-label={`在侧栏审核 ${file.path}`}
          title="在侧栏审核"
        >
          <GitCompareArrows className="size-3.5" />
        </Button>
      </div>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t px-2 py-2">
            <FileDiffPreview
              change={change}
              compact
              bounded
              maxHeightClassName="max-h-72"
            />
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
