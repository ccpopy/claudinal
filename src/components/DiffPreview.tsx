import type { ReactNode } from "react"
import { FileWarning } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AssistantMarkdown } from "@/components/AssistantMarkdown"
import type { FileChange, StructuredHunk } from "@/lib/diff"
import { cn } from "@/lib/utils"

export type DiffViewMode = "unified" | "split"

/** diff 横向滚动条常驻时使用的更醒目 thumb。 */
export const DIFF_SCROLL_THUMB = "bg-muted-foreground/30 hover:bg-muted-foreground/50"

interface DiffRow {
  kind: "add" | "del" | "ctx" | "meta"
  oldLine: number | null
  newLine: number | null
  text: string
  sign: string
}

interface SplitDiffRow {
  kind: "ctx" | "change" | "meta"
  oldLine: number | null
  newLine: number | null
  oldText: string
  newText: string
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

// 不换行模式下行号/符号列 sticky，背景必须不透明；以下颜色等价于
// 「行半透明底色 → 容器 muted/20 → card」逐层叠加后的结果。
const DIFF_SURFACE_BG = "bg-[color-mix(in_oklab,var(--muted)_20%,var(--card))]"
const STICKY_ROW_BG: Record<DiffRow["kind"], string> = {
  ctx: DIFF_SURFACE_BG,
  add: "bg-[color-mix(in_oklab,var(--connected)_15%,color-mix(in_oklab,var(--muted)_20%,var(--card)))]",
  del: "bg-[color-mix(in_oklab,var(--destructive)_15%,color-mix(in_oklab,var(--muted)_20%,var(--card)))]",
  meta: "bg-[color-mix(in_oklab,var(--muted)_40%,color-mix(in_oklab,var(--muted)_20%,var(--card)))]"
}
const CREATED_SURFACE_BG = "bg-[color-mix(in_oklab,var(--connected)_5%,var(--card))]"
const CREATED_STICKY_BG =
  "bg-[color-mix(in_oklab,var(--connected)_15%,color-mix(in_oklab,var(--connected)_5%,var(--card)))]"

export function UnifiedDiff({
  hunks,
  compact = false,
  wrapLines = true
}: {
  hunks: StructuredHunk[]
  compact?: boolean
  wrapLines?: boolean
}) {
  // overflow-clip 保留圆角裁剪但不形成滚动容器，sticky 才能相对外层滚动区生效。
  const sticky = !wrapLines
  return (
    <div
      className={cn(
        "overflow-clip rounded-md border",
        wrapLines ? "bg-muted/20" : cn("min-w-max", DIFF_SURFACE_BG)
      )}
    >
      {hunks.map((h, hi) => (
        <div key={hi} className={cn("font-mono", compact ? "text-[12px]" : "text-[12px]")}>
          <div className="bg-muted/80 px-3 py-1 text-[12px] text-muted-foreground">
            @@ -{h.oldStart ?? 0},{h.oldLines ?? 0} +{h.newStart ?? 0},
            {h.newLines ?? 0} @@
          </div>
          {hunkRows(h).map((row, li) => {
            const gutterBg = sticky ? STICKY_ROW_BG[row.kind] : undefined
            return (
            <div
              key={li}
              className={cn(
                "grid min-w-0",
                compact
                  ? "grid-cols-[2.5rem_2.5rem_1rem_minmax(0,1fr)]"
                  : "grid-cols-[3.25rem_3.25rem_1.25rem_minmax(0,1fr)]",
                row.kind === "add" && "bg-connected/15",
                row.kind === "del" && "bg-destructive/15",
                row.kind === "meta" && "bg-muted/40 text-muted-foreground italic"
              )}
            >
              <div
                className={cn(
                  "select-none border-r px-2 py-0.5 text-right text-muted-foreground/75",
                  sticky && "sticky left-0 z-[1]",
                  gutterBg
                )}
              >
                {row.oldLine ?? ""}
              </div>
              <div
                className={cn(
                  "select-none border-r px-2 py-0.5 text-right text-muted-foreground/75",
                  sticky &&
                    (compact
                      ? "sticky left-[2.5rem] z-[1]"
                      : "sticky left-[3.25rem] z-[1]"),
                  gutterBg
                )}
              >
                {row.newLine ?? ""}
              </div>
              <div
                className={cn(
                  "select-none px-1 py-0.5 text-center",
                  row.kind === "add" && "text-connected",
                  row.kind === "del" && "text-destructive",
                  sticky &&
                    (compact
                      ? "sticky left-[5rem] z-[1]"
                      : "sticky left-[6.5rem] z-[1]"),
                  gutterBg
                )}
              >
                {row.sign}
              </div>
              <div
                className={cn(
                  "min-w-0 px-2 py-0.5",
                  wrapLines
                    ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                    : "min-w-[32rem] whitespace-pre"
                )}
              >
                {row.text || " "}
              </div>
            </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function splitHunkRows(hunk: StructuredHunk): SplitDiffRow[] {
  let oldLine = hunk.oldStart ?? 0
  let newLine = hunk.newStart ?? 0
  const rows: SplitDiffRow[] = []
  let deletions: Array<{ line: number; text: string }> = []
  let additions: Array<{ line: number; text: string }> = []

  const flushChanges = () => {
    const length = Math.max(deletions.length, additions.length)
    for (let i = 0; i < length; i++) {
      const del = deletions[i]
      const add = additions[i]
      rows.push({
        kind: "change",
        oldLine: del?.line ?? null,
        newLine: add?.line ?? null,
        oldText: del?.text ?? "",
        newText: add?.text ?? ""
      })
    }
    deletions = []
    additions = []
  }

  for (const raw of hunk.lines ?? []) {
    const mark = raw.charAt(0)
    const text = mark === "+" || mark === "-" || mark === " " ? raw.slice(1) : raw
    if (mark === "-") {
      deletions.push({ line: oldLine++, text })
      continue
    }
    if (mark === "+") {
      additions.push({ line: newLine++, text })
      continue
    }
    flushChanges()
    if (mark === "\\") {
      rows.push({
        kind: "meta",
        oldLine: null,
        newLine: null,
        oldText: raw,
        newText: ""
      })
      continue
    }
    rows.push({
      kind: "ctx",
      oldLine: oldLine++,
      newLine: newLine++,
      oldText: text,
      newText: text
    })
  }
  flushChanges()
  return rows
}

function SplitDiff({
  hunks,
  compact = false,
  wrapLines = true
}: {
  hunks: StructuredHunk[]
  compact?: boolean
  wrapLines?: boolean
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border bg-muted/20", !wrapLines && "min-w-max")}>
      {hunks.map((h, hi) => (
        <div key={hi} className={cn("font-mono", compact ? "text-[12px]" : "text-[12px]")}>
          <div className="bg-muted/80 px-3 py-1 text-[12px] text-muted-foreground">
            @@ -{h.oldStart ?? 0},{h.oldLines ?? 0} +{h.newStart ?? 0},
            {h.newLines ?? 0} @@
          </div>
          {splitHunkRows(h).map((row, li) => (
            <div
              key={li}
              className={cn(
                "grid min-w-0",
                compact
                  ? "grid-cols-[2.5rem_minmax(10rem,1fr)_2.5rem_minmax(10rem,1fr)]"
                  : "grid-cols-[3.25rem_minmax(14rem,1fr)_3.25rem_minmax(14rem,1fr)]",
                row.kind === "meta" && "bg-muted/40 text-muted-foreground italic"
              )}
            >
              <div className="select-none border-r px-2 py-0.5 text-right text-muted-foreground/75">
                {row.oldLine ?? ""}
              </div>
              <div
                className={cn(
                  "min-w-0 border-r px-2 py-0.5",
                  row.kind === "change" && row.oldText && "bg-destructive/15",
                  wrapLines
                    ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                    : "min-w-[20rem] whitespace-pre"
                )}
              >
                {row.oldText || " "}
              </div>
              <div className="select-none border-r px-2 py-0.5 text-right text-muted-foreground/75">
                {row.newLine ?? ""}
              </div>
              <div
                className={cn(
                  "min-w-0 px-2 py-0.5",
                  row.kind === "change" && row.newText && "bg-connected/15",
                  wrapLines
                    ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                    : "min-w-[20rem] whitespace-pre"
                )}
              >
                {row.newText || " "}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function CreatedFilePreview({
  content,
  compact,
  wrapLines
}: {
  content: string
  compact: boolean
  wrapLines: boolean
}) {
  const sticky = !wrapLines
  return (
    <div
      className={cn(
        "overflow-clip rounded-md border border-connected/20",
        wrapLines ? "bg-connected/5" : cn("min-w-max", CREATED_SURFACE_BG)
      )}
    >
      {content.split("\n").map((line, index) => (
        <div
          key={index}
          className={cn(
            "grid min-w-0 bg-connected/15 font-mono",
            compact
              ? "grid-cols-[2.5rem_1rem_minmax(0,1fr)] text-[12px]"
              : "grid-cols-[3.25rem_1.25rem_minmax(0,1fr)] text-[12px]"
          )}
        >
          <div
            className={cn(
              "select-none border-r px-2 py-0.5 text-right text-muted-foreground/75",
              sticky && cn("sticky left-0 z-[1]", CREATED_STICKY_BG)
            )}
          >
            {index + 1}
          </div>
          <div
            className={cn(
              "select-none px-1 py-0.5 text-center text-connected",
              sticky &&
                cn(
                  compact
                    ? "sticky left-[2.5rem] z-[1]"
                    : "sticky left-[3.25rem] z-[1]",
                  CREATED_STICKY_BG
                )
            )}
          >
            +
          </div>
          <div
            className={cn(
              "min-w-0 px-2 py-0.5",
              wrapLines
                ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                : "min-w-[32rem] whitespace-pre"
            )}
          >
            {line || " "}
          </div>
        </div>
      ))}
    </div>
  )
}

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith(".md") || lower.endsWith(".markdown")
}

function MarkdownRichPreview({ change }: { change: FileChange }) {
  if (!isMarkdownPath(change.path)) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        富文本预览仅支持 Markdown 文件。
      </div>
    )
  }
  if (change.kind !== "create" || !change.content) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        当前 diff 只包含 patch 片段，没有完整 Markdown 文本，无法生成富文本预览。
      </div>
    )
  }
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <AssistantMarkdown text={change.content} />
    </div>
  )
}

/** 仅行尾符变化：内容没有差异，安静地说明即可。 */
function QuietNotice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-md border border-dashed bg-muted/20 px-4 py-3 text-xs text-muted-foreground", className)}>
      {children}
    </div>
  )
}

function fileBudgetNotice(notice: FileChange["notice"]): string | null {
  if (notice?.kind === "timed_out") return "审查计算超时，此文件未生成 diff"
  if (notice?.kind === "truncated") return `输出预算已用尽，仅显示前 ${notice.shownLines} 行，完整改动请在编辑器中查看`
  return null
}

/** patch 不可用时的结构化空态：说明原因、统计与后续操作。 */
function DiffFallbackNotice({
  change,
  canOpenFromList
}: {
  change: FileChange
  canOpenFromList: boolean
}) {
  const failed = change.source === "status"
  return (
    <div className="rounded-md border border-dashed bg-muted/20 px-4 py-5">
      <div className="flex items-start gap-3">
        <FileWarning className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1 text-xs">
          <div className="font-medium text-foreground">
            {failed
              ? "此文件的 patch 读取失败"
              : "此文件没有可展示的结构化 patch"}
          </div>
          <div className="leading-relaxed text-muted-foreground">
            {failed
              ? "git 只返回了变更统计，没有 diff 内容（文件过大或非文本格式时常见）。"
              : "变更记录只包含统计信息。"}
            检测到{" "}
            <span className="font-mono text-connected">+{change.adds}</span>{" "}
            <span className="font-mono text-destructive">-{change.dels}</span>
            {canOpenFromList
              ? "，可在左侧文件列表右键「打开」查看原文件。"
              : "，可通过文件行的上下文菜单打开原文件。"}
          </div>
        </div>
      </div>
    </div>
  )
}

export function FileDiffPreview({
  change,
  compact = false,
  bounded = false,
  maxHeightClassName = "max-h-72",
  viewMode = "unified",
  wrapLines = true,
  richMarkdown = false,
  className
}: {
  change: FileChange
  compact?: boolean
  bounded?: boolean
  maxHeightClassName?: string
  viewMode?: DiffViewMode
  wrapLines?: boolean
  richMarkdown?: boolean
  className?: string
}) {
  const showRichMarkdown = richMarkdown && isMarkdownPath(change.path)
  const budgetNotice = fileBudgetNotice(change.notice)
  const body = showRichMarkdown ? (
    <MarkdownRichPreview change={change} />
  ) : change.binary ? (
    <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
      二进制文件有变更，无法以内联文本 diff 展示。
    </div>
  ) : change.kind === "create" && change.content ? (
    <CreatedFilePreview
      content={change.content}
      compact={compact}
      wrapLines={wrapLines}
    />
  ) : change.eolOnly && change.hunks.length === 0 ? (
    <QuietNotice>仅行尾符变化（{change.eolOnly}），文件内容没有差异。</QuietNotice>
  ) : change.hunks.length > 0 ? (
    <>
      {viewMode === "split" ? (
        <SplitDiff hunks={change.hunks} compact={compact} wrapLines={wrapLines} />
      ) : (
        <UnifiedDiff hunks={change.hunks} compact={compact} wrapLines={wrapLines} />
      )}
      {budgetNotice && <QuietNotice className="mt-2">{budgetNotice}</QuietNotice>}
    </>
  ) : budgetNotice ? (
    <QuietNotice>{budgetNotice}</QuietNotice>
  ) : (
    <DiffFallbackNotice change={change} canOpenFromList={!bounded} />
  )

  if (!bounded) {
    return <div className={className}>{body}</div>
  }

  return (
    <ScrollArea
      className={cn(maxHeightClassName, className)}
      viewportClassName={maxHeightClassName}
      scrollbarOrientation={wrapLines ? "vertical" : "both"}
      type={wrapLines ? undefined : "auto"}
      thumbClassName={wrapLines ? undefined : DIFF_SCROLL_THUMB}
    >
      <div className="min-w-0 pr-2">{body}</div>
    </ScrollArea>
  )
}
