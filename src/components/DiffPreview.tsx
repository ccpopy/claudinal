import { ScrollArea } from "@/components/ui/scroll-area"
import { AssistantMarkdown } from "@/components/AssistantMarkdown"
import type { FileChange, StructuredHunk } from "@/lib/diff"
import { cn } from "@/lib/utils"

export type DiffViewMode = "unified" | "split"

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

export function UnifiedDiff({
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
        <div key={hi} className={cn("font-mono", compact ? "text-[11px]" : "text-[12px]")}>
          <div className="bg-muted/80 px-3 py-1 text-[11px] text-muted-foreground">
            @@ -{h.oldStart ?? 0},{h.oldLines ?? 0} +{h.newStart ?? 0},
            {h.newLines ?? 0} @@
          </div>
          {hunkRows(h).map((row, li) => (
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
          ))}
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
        <div key={hi} className={cn("font-mono", compact ? "text-[11px]" : "text-[12px]")}>
          <div className="bg-muted/80 px-3 py-1 text-[11px] text-muted-foreground">
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
  return (
    <div className={cn("overflow-hidden rounded-md border border-connected/20 bg-connected/5", !wrapLines && "min-w-max")}>
      {content.split("\n").map((line, index) => (
        <div
          key={index}
          className={cn(
            "grid min-w-0 bg-connected/15 font-mono",
            compact
              ? "grid-cols-[2.5rem_1rem_minmax(0,1fr)] text-[11px]"
              : "grid-cols-[3.25rem_1.25rem_minmax(0,1fr)] text-[12px]"
          )}
        >
          <div className="select-none border-r px-2 py-0.5 text-right text-muted-foreground/75">
            {index + 1}
          </div>
          <div className="select-none px-1 py-0.5 text-center text-connected">+</div>
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
  ) : change.hunks.length > 0 ? (
    viewMode === "split" ? (
      <SplitDiff hunks={change.hunks} compact={compact} wrapLines={wrapLines} />
    ) : (
      <UnifiedDiff hunks={change.hunks} compact={compact} wrapLines={wrapLines} />
    )
  ) : (
    <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
      {change.source === "status"
        ? "此文件有工作树变更，patch 读取失败。检测到"
        : "此文件无可展示的结构化 patch，变更记录为"}{" "}
      <span className="font-mono text-connected">+{change.adds}</span>{" "}
      <span className="font-mono text-destructive">-{change.dels}</span>。
    </div>
  )

  if (!bounded) {
    return <div className={className}>{body}</div>
  }

  return (
    <ScrollArea
      className={cn(maxHeightClassName, className)}
      viewportClassName={maxHeightClassName}
      scrollbarOrientation={wrapLines ? "vertical" : "both"}
    >
      <div className="min-w-0 pr-2">{body}</div>
    </ScrollArea>
  )
}
