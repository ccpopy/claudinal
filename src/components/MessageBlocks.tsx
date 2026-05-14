import { useState } from "react"
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  FileEdit,
  FilePlus,
  FileText,
  Loader2,
  Search,
  Terminal,
  Wrench,
  type LucideIcon
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { formatAttachmentType, formatBytes } from "@/lib/fileAttachments"
import { cn } from "@/lib/utils"
import type { UIBlock } from "@/types/ui"
import { AssistantMarkdown } from "./AssistantMarkdown"
import { CopyButton } from "./CopyButton"
import { ImageLightbox } from "./ImageLightbox"

export function BlockView({
  role,
  block
}: {
  role: "user" | "assistant"
  block: UIBlock
}) {
  if (block.type === "text") return <TextBlock role={role} block={block} />
  if (block.type === "thinking") return <ThinkingBlock block={block} />
  if (block.type === "image") return <ImageBlock role={role} block={block} />
  if (block.type === "attachment") return <AttachmentBlock role={role} block={block} />
  if (block.type === "tool_use") return <ToolUseBlock block={block} />
  if (block.type === "tool_result") return <ToolResultBlock block={block} />
  return null
}

function stripImageMetaLines(s: string | undefined): string {
  if (!s) return ""
  // 1) CLI 注入的 <system-reminder>...</system-reminder> → 屏蔽
  // 2) CLI 内部本地命令 / 后台任务通知 → 屏蔽（reducer 已剥，兜底）
  // 3) `[Image: source: <path>]` 含本地路径 → 屏蔽（reducer 已剥，兜底）
  // 4) `[Image #N]` 保留：与下方缩略图右下角 #N 角标互相参照
  let cleaned = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
  cleaned = cleaned.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
  cleaned = cleaned.replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, "")
  cleaned = cleaned.replace(/\[Image\s*:\s*source\s*:\s*[^\]]+\]/gi, "")
  return cleaned.replace(/\n{3,}/g, "\n\n").trim()
}

function TextBlock({
  role,
  block
}: {
  role: "user" | "assistant"
  block: UIBlock
}) {
  if (!block.text && !block.partial) return null
  if (role === "user") {
    const cleaned = stripImageMetaLines(block.text)
    if (!cleaned) return null
    return (
      <div className="group/msg self-end max-w-[80%] min-w-0 flex flex-col items-end gap-0.5">
        <div className="max-w-full min-w-0 bg-muted text-foreground rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]">
          {cleaned}
        </div>
        <CopyButton
          text={cleaned}
          ariaLabel="复制消息"
          label="消息已复制"
          className="opacity-0 group-hover/msg:opacity-100 transition-opacity"
        />
      </div>
    )
  }
  return (
    <div className="self-start w-full flex flex-col gap-0.5">
      <AssistantMarkdown
        text={block.text ?? ""}
        partial={!!block.partial}
      />
      {!block.partial && block.text && (
        <CopyButton
          text={block.text}
          ariaLabel="复制消息"
          label="消息已复制"
          className="-ml-1.5 self-start"
        />
      )}
    </div>
  )
}

function ThinkingBlock({ block }: { block: UIBlock }) {
  const [open, setOpen] = useState(!!block.partial)
  if (!block.text && !block.partial) return null
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={Brain}
      label={block.partial ? "正在思考…" : "思考过程"}
    >
      <div className="text-[13px] text-muted-foreground italic whitespace-pre-wrap leading-relaxed break-words border-l-2 border-border pl-3">
        {block.text}
        {block.partial && <span className="caret">▍</span>}
      </div>
    </ExpandableRow>
  )
}

function ImageBlock({
  role,
  block
}: {
  role: "user" | "assistant"
  block: UIBlock
}) {
  const [open, setOpen] = useState(false)
  if (!block.imageData || !block.imageMediaType) return null
  const src = `data:${block.imageMediaType};base64,${block.imageData}`
  const alt = block.imageAlt ?? ""
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "group/img relative rounded-lg border overflow-hidden cursor-zoom-in transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring",
          role === "user" && "self-end"
        )}
        aria-label={alt ? `放大图片 ${alt}` : "放大图片"}
        title={alt || "点击放大"}
      >
        <img src={src} alt={alt} className="block max-h-60" />
        {block.imageAlt && (
          <span className="absolute right-1 bottom-1 rounded-md bg-background/85 text-foreground/90 text-[10px] font-mono px-1.5 py-0.5 border">
            {block.imageAlt}
          </span>
        )}
      </button>
      <ImageLightbox open={open} src={src} alt={alt} onClose={() => setOpen(false)} />
    </>
  )
}

function AttachmentBlock({
  role,
  block
}: {
  role: "user" | "assistant"
  block: UIBlock
}) {
  const name = block.attachmentName?.trim() || "未命名附件"
  const fileType = formatAttachmentType(name, block.attachmentMime)
  const size =
    typeof block.attachmentSize === "number" ? formatBytes(block.attachmentSize) : null
  const mode =
    block.attachmentContentMode === "metadata-only"
      ? "仅展示信息"
      : block.attachmentContentMode === "document"
        ? "PDF 已附加"
        : "文本已附加"
  return (
    <div
      className={cn(
        "group/file max-w-[80%] min-w-0 rounded-xl border bg-muted text-foreground px-3 py-2 shadow-xs",
        role === "user" ? "self-end" : "self-start bg-card"
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-background/80 text-muted-foreground">
          <FileText className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={name}>
            {name}
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>{fileType}</span>
            {size && <span className="font-mono">{size}</span>}
            <span>{mode}</span>
          </span>
        </span>
      </div>
    </div>
  )
}

function basename(p?: string): string {
  if (!p) return ""
  const m = p.replace(/\\/g, "/").split("/")
  return m[m.length - 1] || p
}

function trimText(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + "…"
}

function toolIcon(name?: string): LucideIcon {
  if (!name) return Wrench
  const n = name.toLowerCase()
  if (n === "read") return FileText
  if (n === "write") return FilePlus
  if (n === "edit" || n === "multiedit" || n === "notebookedit") return FileEdit
  if (n === "bash" || n === "powershell") return Terminal
  if (n === "grep" || n === "glob") return Search
  return Wrench
}

function toolLabel(
  name: string | undefined,
  input: Record<string, unknown>,
  partial: boolean | undefined
): string {
  const n = (name ?? "").toLowerCase()
  const fp = (input.file_path as string) ?? (input.path as string)
  const cmd = input.command as string
  const pat = input.pattern as string
  const verb = (done: string, doing: string) => (partial ? doing : done)
  if (n === "bash" || n === "powershell")
    return `${verb("已运行", "正在运行")} ${trimText((cmd ?? "命令").split("\n")[0], 80)}`
  if (n === "read") return `${verb("已读取", "正在读取")} ${basename(fp)}`
  if (n === "write") return `${verb("已创建", "正在创建")} ${basename(fp)}`
  if (n === "edit" || n === "multiedit" || n === "notebookedit")
    return `${verb("已编辑", "正在编辑")} ${basename(fp)}`
  if (n === "grep" || n === "glob")
    return `${verb("已搜索", "正在搜索")} ${trimText(pat ?? "", 60)}`
  if (n === "task") return `${verb("已派任务", "正在派任务")}`
  return `${verb("已运行", "正在运行")} ${name ?? "工具"}`
}

function ToolUseBlock({ block }: { block: UIBlock }) {
  const [open, setOpen] = useState(false)
  const input = (block.toolInput as Record<string, unknown>) ?? {}
  const Icon = toolIcon(block.toolName)
  const label = toolLabel(block.toolName, input, block.partial)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={Icon}
      label={label}
      labelClassName="font-mono"
      trailing={block.partial ? <Loader2 className="size-3 animate-spin" /> : null}
    >
      <ToolUseDetails name={block.toolName} input={input} />
    </ExpandableRow>
  )
}

function ToolUseDetails({
  name,
  input
}: {
  name: string | undefined
  input: Record<string, unknown>
}) {
  const n = (name ?? "").toLowerCase()
  const fp = (input.file_path as string) ?? (input.path as string)

  if (n === "bash" || n === "powershell") {
    const cmd = input.command as string | undefined
    const desc = input.description as string | undefined
    return (
      <div className="space-y-1.5">
        {desc && <div className="text-xs text-muted-foreground italic">{desc}</div>}
        <TerminalBlock prompt={n === "powershell" ? "PS>" : "$"}>
          {cmd ?? ""}
        </TerminalBlock>
      </div>
    )
  }

  if (n === "write") {
    const content = input.content as string | undefined
    return (
      <div className="space-y-1">
        {fp && <FileChip path={fp} />}
        <CodeBlock>{content ?? ""}</CodeBlock>
      </div>
    )
  }

  if (n === "edit") {
    const oldStr = input.old_string as string | undefined
    const newStr = input.new_string as string | undefined
    const replaceAll = input.replace_all as boolean | undefined
    return (
      <div className="space-y-2">
        {fp && <FileChip path={fp} />}
        {replaceAll && (
          <Badge variant="outline" className="text-[10px]">
            replace_all
          </Badge>
        )}
        {oldStr !== undefined && (
          <DiffSide tone="del" label="移除">
            {oldStr}
          </DiffSide>
        )}
        {newStr !== undefined && (
          <DiffSide tone="add" label="新增">
            {newStr}
          </DiffSide>
        )}
      </div>
    )
  }

  if (n === "multiedit") {
    const edits = (input.edits as Array<Record<string, unknown>>) ?? []
    return (
      <div className="space-y-2">
        {fp && <FileChip path={fp} />}
        {edits.map((e, i) => (
          <div key={i} className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              edit #{i + 1}
            </div>
            {(e.old_string as string) !== undefined && (
              <DiffSide tone="del" label="移除">
                {String(e.old_string ?? "")}
              </DiffSide>
            )}
            {(e.new_string as string) !== undefined && (
              <DiffSide tone="add" label="新增">
                {String(e.new_string ?? "")}
              </DiffSide>
            )}
          </div>
        ))}
      </div>
    )
  }

  if (n === "read") {
    const offset = input.offset as number | undefined
    const limit = input.limit as number | undefined
    return (
      <div className="space-y-1">
        {fp && <FileChip path={fp} />}
        {(offset !== undefined || limit !== undefined) && (
          <div className="text-xs text-muted-foreground">
            offset: {offset ?? 0} · limit: {limit ?? "默认"}
          </div>
        )}
      </div>
    )
  }

  if (n === "grep" || n === "glob") {
    return (
      <div className="space-y-1">
        {Object.entries(input).map(([k, v]) => (
          <div key={k} className="text-xs">
            <span className="text-muted-foreground">{k}: </span>
            <span className="font-mono break-all">{String(v ?? "")}</span>
          </div>
        ))}
      </div>
    )
  }

  return <CodeBlock>{JSON.stringify(input, null, 2)}</CodeBlock>
}

interface ToolUseResultFile {
  filePath?: string
  content?: string
  numLines?: number
  startLine?: number
  totalLines?: number
}
interface StructuredPatchHunk {
  oldStart?: number
  oldLines?: number
  newStart?: number
  newLines?: number
  lines?: string[]
}
interface ToolUseResult {
  type?: string
  file?: ToolUseResultFile
  filePath?: string
  content?: string
  originalFile?: string | null
  structuredPatch?: StructuredPatchHunk[]
  userModified?: boolean
}

function ToolResultBlock({ block }: { block: UIBlock }) {
  const [open, setOpen] = useState(false)
  const tur = block.toolUseResult as ToolUseResult | undefined
  const isError = !!block.isError
  const turType = tur?.type

  let Icon: LucideIcon = isError ? AlertTriangle : CheckCircle2
  let label: string
  if (isError) {
    label = "工具失败"
  } else if (turType === "text" && tur?.file) {
    const lines = tur.file.numLines ?? 0
    const total = tur.file.totalLines ?? 0
    label =
      total > lines
        ? `读取 ${lines}/${total} 行 ${basename(tur.file.filePath)}`
        : `读取 ${lines} 行 ${basename(tur.file.filePath)}`
    Icon = FileText
  } else if (turType === "create") {
    label = `已创建 ${basename(tur?.filePath)}`
    Icon = FilePlus
  } else if (turType === "update" && tur?.structuredPatch) {
    const adds = tur.structuredPatch.reduce(
      (acc, h) => acc + (h.lines ?? []).filter((l) => l.startsWith("+")).length,
      0
    )
    const dels = tur.structuredPatch.reduce(
      (acc, h) => acc + (h.lines ?? []).filter((l) => l.startsWith("-")).length,
      0
    )
    label = `更新 ${basename(tur?.filePath)} · +${adds} -${dels}`
    Icon = FileEdit
  } else {
    label = "工具完成"
  }

  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={Icon}
      label={label}
      tone={isError ? "error" : undefined}
    >
      {turType === "update" && tur?.structuredPatch ? (
        <DiffView patch={tur.structuredPatch} />
      ) : turType === "text" && tur?.file?.content ? (
        <CollapsedOutput text={tur.file.content} />
      ) : turType === "create" && tur?.content ? (
        <CollapsedOutput text={tur.content} />
      ) : (
        <CollapsedOutput
          text={renderToolResultContent(block.toolResultContent)}
        />
      )}
    </ExpandableRow>
  )
}

export function ExpandableRow({
  open,
  onToggle,
  icon: Icon,
  label,
  labelClassName,
  tone,
  trailing,
  meta,
  children
}: {
  open: boolean
  onToggle: () => void
  icon: LucideIcon
  label: string
  labelClassName?: string
  tone?: "error"
  trailing?: React.ReactNode
  meta?: string
  children: React.ReactNode
}) {
  return (
    <div className="text-xs self-start max-w-full">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "inline-flex items-center gap-1.5 transition-colors",
          tone === "error"
            ? "text-destructive hover:text-destructive/80"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <ChevronRight
          className={cn("size-3 transition-transform duration-150", open && "rotate-90")}
        />
        <Icon className="size-3.5" />
        <span className={cn("text-left break-all", labelClassName)}>{label}</span>
        {meta && <span className="text-[10px] tabular-nums opacity-70">· {meta}</span>}
        {trailing}
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr] mt-1.5" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="ml-5">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="p-2 rounded-md bg-muted/50 border text-[12px] font-mono whitespace-pre-wrap break-words max-h-80 overflow-auto scrollbar-thin">
      {children}
    </pre>
  )
}

function FileChip({ path }: { path: string }) {
  return (
    <div className="text-xs font-mono text-muted-foreground break-all">{path}</div>
  )
}

function DiffSide({
  tone,
  label,
  children
}: {
  tone: "add" | "del"
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
        {label}
      </div>
      <pre
        className={cn(
          "p-2 rounded-md border text-[12px] font-mono whitespace-pre-wrap break-words max-h-60 overflow-auto scrollbar-thin",
          tone === "add"
            ? "bg-connected/10 border-connected/30"
            : "bg-destructive/10 border-destructive/30"
        )}
      >
        {children}
      </pre>
    </div>
  )
}

function DiffView({ patch }: { patch: StructuredPatchHunk[] }) {
  return (
    <div className="rounded-md border bg-muted/40 overflow-auto scrollbar-thin max-h-80">
      {patch.map((hunk, i) => (
        <div key={i} className="font-mono text-[12px]">
          <div className="px-2 py-0.5 bg-muted/80 text-muted-foreground text-[11px]">
            @@ -{hunk.oldStart ?? 0},{hunk.oldLines ?? 0} +{hunk.newStart ?? 0},{hunk.newLines ?? 0} @@
          </div>
          {(hunk.lines ?? []).map((line, j) => {
            const c = line.charAt(0)
            const cls =
              c === "+"
                ? "bg-connected/15"
                : c === "-"
                  ? "bg-destructive/15"
                  : ""
            return (
              <div
                key={j}
                className={cn("px-2 py-0.5 whitespace-pre-wrap break-words", cls)}
              >
                {line}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function TerminalBlock({
  prompt,
  children
}: {
  prompt: string
  children: string
}) {
  const lines = children.split("\n")
  return (
    <div className="rounded-md border bg-foreground/[0.06] dark:bg-black/40 overflow-hidden">
      <div className="px-2 py-1 border-b border-foreground/10 text-[10px] uppercase tracking-wider text-muted-foreground font-mono flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-destructive/60" />
        <span className="size-2 rounded-full bg-warn/60" />
        <span className="size-2 rounded-full bg-connected/60" />
        <span className="ml-1">terminal</span>
      </div>
      <pre className="px-2 py-1.5 text-[12px] font-mono whitespace-pre-wrap break-words max-h-80 overflow-auto scrollbar-thin">
        {lines.map((line, i) => (
          <div key={i} className="flex gap-2">
            {i === 0 && (
              <span className="text-primary shrink-0 select-none">
                {prompt}
              </span>
            )}
            {i > 0 && <span className="shrink-0 select-none w-4" />}
            <span className="break-all">{line}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

function CollapsedOutput({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const lines = text.split("\n")
  const PREVIEW = 8
  const truncated = lines.length > PREVIEW
  const shown = open || !truncated ? lines : lines.slice(0, PREVIEW)
  return (
    <div className="space-y-1">
      <pre className="p-2 rounded-md bg-muted/50 border text-[12px] font-mono whitespace-pre-wrap break-words max-h-80 overflow-auto scrollbar-thin">
        {shown.join("\n")}
        {truncated && !open && (
          <span className="block text-muted-foreground italic mt-1">
            … 还有 {lines.length - PREVIEW} 行
          </span>
        )}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          {open ? "收起" : "展开全部"}
        </button>
      )}
    </div>
  )
}

function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (c && typeof c === "object" && "text" in (c as Record<string, unknown>)) {
          return String((c as { text: unknown }).text)
        }
        return JSON.stringify(c)
      })
      .join("\n")
  }
  return JSON.stringify(content, null, 2)
}
