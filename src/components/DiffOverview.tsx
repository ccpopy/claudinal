import { useEffect, useMemo, useState } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import {
  Check,
  Columns2,
  ClipboardCopy,
  FileEdit,
  FilePlus,
  FileText,
  FileX,
  MoreHorizontal,
  RefreshCcw,
  Text,
  X
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { GitWorktreeStatus, WorktreeDiff } from "@/lib/ipc"
import {
  collectChanges,
  formatHunksAsPatch,
  type FileChange,
  type ReviewRunDiff
} from "@/lib/diff"
import type { UIEntry } from "@/types/ui"
import { FileDiffPreview, type DiffViewMode } from "@/components/DiffPreview"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  entries: UIEntry[]
  gitStatus?: GitWorktreeStatus | null
  worktreeDiff?: WorktreeDiff | null
  snapshotDiffs?: WorktreeDiff[]
  worktreeDiffLoading?: boolean
  worktreeDiffError?: string | null
  cwd?: string | null
  initialFilePath?: string | null
  title?: string
  reviews?: ReviewRunDiff[]
  selectedReviewId?: string | null
  onSelectReview?: (id: string | null) => void
  onRefresh?: () => void
}

type SourceFilter = "all" | FileChange["source"]

const SOURCE_LABEL: Record<FileChange["source"], string> = {
  session: "本轮",
  git: "工作树",
  status: "状态",
  snapshot: "快照"
}

function reviewLabel(index: number, total: number): string {
  if (index === total - 1) return "上轮对话"
  return `第 ${index + 1} 轮对话`
}

async function copyToClipboard(text: string, kind: string) {
  if (!text) {
    toast.warning(`没有可复制的${kind}`)
    return false
  }
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`已复制${kind}`)
    return true
  } catch (e) {
    toast.error(`复制${kind}失败：${String(e)}`)
    return false
  }
}

export function DiffOverview({
  open,
  onOpenChange,
  entries,
  gitStatus,
  worktreeDiff,
  snapshotDiffs,
  worktreeDiffLoading,
  worktreeDiffError,
  cwd,
  initialFilePath,
  title = "文件 diff",
  reviews = [],
  selectedReviewId = null,
  onSelectReview,
  onRefresh
}: Props) {
  const allChanges = useMemo(
    () =>
      collectChanges({
        entries,
        gitStatus,
        worktreeDiff,
        snapshotDiffs,
        cwd
      }),
    [entries, gitStatus, worktreeDiff, snapshotDiffs, cwd]
  )
  const [activeIdx, setActiveIdx] = useState(0)
  const [filter, setFilter] = useState<SourceFilter>("all")
  const [copiedAllPatch, setCopiedAllPatch] = useState(false)
  const [viewMode, setViewMode] = useState<DiffViewMode>("unified")
  const [wrapLines, setWrapLines] = useState(false)
  const [richMarkdown, setRichMarkdown] = useState(false)
  const activeReviewIndex = selectedReviewId
    ? reviews.findIndex((review) => review.id === selectedReviewId)
    : -1
  const reviewScopeLabel =
    activeReviewIndex >= 0
      ? reviewLabel(activeReviewIndex, reviews.length)
      : "全部变更"

  useEffect(() => {
    if (!open) return
    setFilter("all")
    setActiveIdx(0)
  }, [open, selectedReviewId])

  useEffect(() => {
    if (!open || !initialFilePath) return
    const target = allChanges.findIndex((c) => c.path === initialFilePath)
    if (target >= 0) {
      setFilter("all")
      setActiveIdx(target)
    }
  }, [open, initialFilePath, allChanges])

  const sourceCounts = useMemo(() => {
    const counts = { session: 0, git: 0, status: 0, snapshot: 0 } as Record<
      FileChange["source"],
      number
    >
    for (const c of allChanges) counts[c.source] += 1
    return counts
  }, [allChanges])

  const changes = useMemo(
    () =>
      filter === "all"
        ? allChanges
        : allChanges.filter((c) => c.source === filter),
    [allChanges, filter]
  )

  const safeActiveIdx = Math.min(activeIdx, Math.max(changes.length - 1, 0))
  const active = changes[safeActiveIdx]
  const snapshotPatchError = snapshotDiffs?.find((diff) => diff.patchError)?.patchError
  const patchError = worktreeDiffError ?? snapshotPatchError ?? null

  const copyActivePath = () => {
    if (!active) return
    void copyToClipboard(active.path, "文件路径")
  }

  const copyActivePatch = () => {
    if (!active) return
    const patch = formatHunksAsPatch(active)
    if (!patch) {
      toast.warning("当前文件没有可复制的 patch")
      return
    }
    void copyToClipboard(patch, "patch")
  }

  const copyAllPatches = async () => {
    if (changes.length === 0) return
    const patches = changes
      .map((c) => formatHunksAsPatch(c))
      .filter((p) => !!p)
      .join("\n")
    const ok = await copyToClipboard(patches, "全部 patch")
    if (ok) {
      setCopiedAllPatch(true)
      window.setTimeout(() => setCopiedAllPatch(false), 1600)
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-30 bg-background/60 backdrop-blur-[1px] duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed bottom-0 right-0 top-9 z-40 flex w-[min(760px,calc(100vw-16px))] flex-col overflow-hidden border-l bg-background shadow-2xl outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-8 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-8"
        >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <FileEdit className="size-4 text-muted-foreground" />
            <DialogPrimitive.Title className="text-sm font-medium">
              {title}
            </DialogPrimitive.Title>
            <Badge variant="outline" className="text-[10px]">
              {changes.length} 文件
            </Badge>
            {onSelectReview && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 max-w-[150px] justify-start truncate px-2 text-xs"
                  >
                    <span className="truncate">{reviewScopeLabel}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[180px]">
                  <DropdownMenuItem onSelect={() => onSelectReview(null)}>
                    {selectedReviewId === null && <Check />}
                    <span>全部变更</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {reviews.map((review, index) => (
                    <DropdownMenuItem
                      key={review.id}
                      onSelect={() => onSelectReview(review.id)}
                    >
                      {selectedReviewId === review.id && <Check />}
                      <span>{reviewLabel(index, reviews.length)}</span>
                      <span className="ml-auto font-mono text-xs text-muted-foreground">
                        {review.diff.files.length}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <SourceFilterChips
              filter={filter}
              total={allChanges.length}
              counts={sourceCounts}
              onChange={(next) => {
                setFilter(next)
                setActiveIdx(0)
              }}
            />
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() =>
                setViewMode((current) =>
                  current === "unified" ? "split" : "unified"
                )
              }
            >
              <Columns2 className="size-3.5" />
              {viewMode === "unified" ? "切换到拆分差异视图" : "切换到统一差异视图"}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={copyAllPatches}
                  disabled={changes.length === 0}
                  className="h-7 gap-1 px-2 text-[11px]"
                >
                  {copiedAllPatch ? (
                    <Check className="size-3.5 text-connected" />
                  ) : (
                    <ClipboardCopy className="size-3.5" />
                  )}
                  复制全部 patch
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                把当前过滤后的 {changes.length} 个文件 patch 拼接复制
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="更多 diff 操作"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[190px]">
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    onRefresh?.()
                  }}
                  disabled={!onRefresh}
                >
                  <RefreshCcw />
                  <span>刷新</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    setWrapLines((value) => !value)
                  }}
                >
                  {wrapLines && <Check />}
                  <Text />
                  <span>{wrapLines ? "禁用自动换行" : "启用自动换行"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    setRichMarkdown((value) => !value)
                  }}
                >
                  {richMarkdown && <Check />}
                  <FileText />
                  <span>{richMarkdown ? "禁用富文本预览" : "启用富文本预览"}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
        </div>

        {changes.length === 0 ? (
          <div className="flex-1 grid place-items-center px-6 text-center text-muted-foreground text-sm">
            {worktreeDiffLoading
              ? "正在读取文件 diff…"
              : patchError
                ? `读取文件 diff 失败：${patchError}`
                : allChanges.length > 0
                  ? `当前过滤（${SOURCE_LABEL[filter as FileChange["source"]] ?? "全部"}）下没有文件变更`
                  : "当前会话没有文件变更"}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(170px,230px)_minmax(0,1fr)]">
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
                          ? SOURCE_LABEL.git
                          : c.source === "session"
                            ? SOURCE_LABEL.session
                            : c.source === "snapshot"
                              ? SOURCE_LABEL.snapshot
                              : SOURCE_LABEL.status}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
            <ScrollArea
              key={active?.path ?? "empty"}
              className="min-h-0"
              scrollbarOrientation={wrapLines ? "vertical" : "both"}
            >
              {active && (
                <div className="p-3 space-y-2">
                  {(worktreeDiffLoading || patchError) && (
                    <div
                      className={cn(
                        "rounded-md border px-3 py-2 text-xs",
                        patchError
                          ? "border-destructive/25 bg-destructive/5 text-destructive"
                          : "bg-muted/30 text-muted-foreground"
                      )}
                    >
                      {patchError
                        ? `读取 patch 失败：${patchError}`
                        : "正在读取最新文件 diff…"}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 text-xs font-mono text-muted-foreground break-all">
                      {active.path}
                      {active.oldPath && active.oldPath !== active.path && (
                        <span> ← {active.oldPath}</span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground"
                            onClick={copyActivePath}
                            aria-label="复制文件路径"
                          >
                            <FileText className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">复制文件路径</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground"
                            onClick={copyActivePatch}
                            aria-label="复制此文件的 patch"
                            disabled={
                              active.binary ||
                              (active.hunks.length === 0 &&
                                !(active.kind === "create" && active.content))
                            }
                          >
                            <ClipboardCopy className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          复制当前文件 patch
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <FileDiffPreview
                    change={active}
                    viewMode={viewMode}
                    wrapLines={wrapLines}
                    richMarkdown={richMarkdown}
                  />
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

function SourceFilterChips({
  filter,
  total,
  counts,
  onChange
}: {
  filter: SourceFilter
  total: number
  counts: Record<FileChange["source"], number>
  onChange: (next: SourceFilter) => void
}) {
  const chips: Array<{ value: SourceFilter; label: string; count: number }> = [
    { value: "all", label: "全部", count: total },
    { value: "session", label: SOURCE_LABEL.session, count: counts.session },
    { value: "git", label: SOURCE_LABEL.git, count: counts.git },
    { value: "snapshot", label: SOURCE_LABEL.snapshot, count: counts.snapshot },
    { value: "status", label: SOURCE_LABEL.status, count: counts.status }
  ]
  return (
    <div className="ml-1 flex items-center gap-1">
      {chips.map((chip) => {
        if (chip.value !== "all" && chip.count === 0) return null
        const active = filter === chip.value
        return (
          <button
            key={chip.value}
            type="button"
            onClick={() => onChange(chip.value)}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] transition-colors tabular-nums",
              active
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {chip.label}
            <span className="ml-1 text-[10px] opacity-70">{chip.count}</span>
          </button>
        )
      })}
    </div>
  )
}
