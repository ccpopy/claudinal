import { useState } from "react"
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  Cog,
  DollarSign,
  FileEdit,
  FilePlus,
  FileText,
  FileWarning,
  Gauge,
  Loader2,
  Search,
  Terminal,
  Timer,
  Wrench,
  type LucideIcon
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { UIBlock, UIEntry, UIMessage } from "@/types/ui"

interface Props {
  entry: UIEntry
}

export function MessageCard({ entry }: Props) {
  if (entry.kind === "message") return <MessageView msg={entry} />
  if (entry.kind === "system_init") return <SystemInitView e={entry} />
  if (entry.kind === "system_status") return null
  if (entry.kind === "result") return <ResultView e={entry} />
  if (entry.kind === "rate_limit") return null
  if (entry.kind === "stderr") {
    return (
      <SimpleRow icon={AlertTriangle} label="stderr" tone="error" content={entry.line} />
    )
  }
  if (entry.kind === "raw") {
    return <SimpleRow icon={FileWarning} label="raw" content={entry.line ?? ""} />
  }
  return null
}

function MessageView({ msg }: { msg: UIMessage }) {
  if (msg.blocks.length === 0 && msg.streaming) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>思考中…</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 items-stretch">
      {msg.blocks.map((b, i) => (
        <BlockView key={i} role={msg.role} block={b} />
      ))}
    </div>
  )
}

function BlockView({
  role,
  block
}: {
  role: "user" | "assistant"
  block: UIBlock
}) {
  if (block.type === "text") return <TextBlock role={role} block={block} />
  if (block.type === "thinking") return <ThinkingBlock block={block} />
  if (block.type === "image") return <ImageBlock role={role} block={block} />
  if (block.type === "tool_use") return <ToolUseBlock block={block} />
  if (block.type === "tool_result") return <ToolResultBlock block={block} />
  return null
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
    return (
      <div className="self-end max-w-[80%] bg-muted text-foreground rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap leading-relaxed break-words">
        {block.text}
      </div>
    )
  }
  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground">
      {block.text}
      {block.partial && <span className="caret">▍</span>}
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
  if (!block.imageData || !block.imageMediaType) return null
  return (
    <img
      src={`data:${block.imageMediaType};base64,${block.imageData}`}
      alt=""
      className={cn(
        "rounded-lg border max-h-60",
        role === "user" && "self-end"
      )}
    />
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
      <div className="space-y-1">
        {desc && <div className="text-xs text-muted-foreground italic">{desc}</div>}
        <CodeBlock>{cmd ?? ""}</CodeBlock>
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
        <CodeBlock>{tur.file.content}</CodeBlock>
      ) : turType === "create" && tur?.content ? (
        <CodeBlock>{tur.content}</CodeBlock>
      ) : (
        <CodeBlock>{renderToolResultContent(block.toolResultContent)}</CodeBlock>
      )}
    </ExpandableRow>
  )
}

function ExpandableRow({
  open,
  onToggle,
  icon: Icon,
  label,
  labelClassName,
  tone,
  trailing,
  children
}: {
  open: boolean
  onToggle: () => void
  icon: LucideIcon
  label: string
  labelClassName?: string
  tone?: "error"
  trailing?: React.ReactNode
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

function CodeBlock({ children }: { children: React.ReactNode }) {
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

function SimpleRow({
  icon: Icon,
  label,
  tone,
  content
}: {
  icon: LucideIcon
  label: string
  tone?: "error"
  content: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={Icon}
      label={label}
      tone={tone}
    >
      <CodeBlock>{content}</CodeBlock>
    </ExpandableRow>
  )
}

function fmtMs(ms?: number): string {
  if (typeof ms !== "number") return ""
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function SystemInitView({
  e
}: {
  e: Extract<UIEntry, { kind: "system_init" }>
}) {
  const [open, setOpen] = useState(false)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={Cog}
      label={`会话开始${e.model ? ` · ${e.model}` : ""}`}
    >
      <div className="flex flex-col gap-1.5 text-muted-foreground">
        {e.cwd && <div className="font-mono break-all text-[11px]">{e.cwd}</div>}
        <div className="flex flex-wrap gap-1">
          {e.permissionMode && (
            <Badge variant="outline" className="text-[10px]">
              perm: {e.permissionMode}
            </Badge>
          )}
          {e.outputStyle && (
            <Badge variant="outline" className="text-[10px]">
              style: {e.outputStyle}
            </Badge>
          )}
          {e.fastModeState && (
            <Badge variant="outline" className="text-[10px]">
              fast: {e.fastModeState}
            </Badge>
          )}
          {e.version && (
            <Badge variant="outline" className="text-[10px]">
              v{e.version}
            </Badge>
          )}
        </div>
        {e.mcpServers.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {e.mcpServers.map((m) => (
              <Badge
                key={m.name}
                variant={
                  m.status === "connected"
                    ? "success"
                    : m.status === "needs-auth"
                      ? "warn"
                      : "outline"
                }
                className="text-[10px]"
              >
                {m.name} · {m.status}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </ExpandableRow>
  )
}

function ResultView({ e }: { e: Extract<UIEntry, { kind: "result" }> }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 text-xs pt-1",
        e.isError ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {e.isError ? (
        <AlertTriangle className="size-3.5" />
      ) : (
        <CheckCircle2 className="size-3.5" />
      )}
      <span>{e.isError ? "失败" : "完成"}</span>
      {typeof e.totalCostUsd === "number" && (
        <span className="inline-flex items-center gap-1">
          <DollarSign className="size-3" />
          {e.totalCostUsd.toFixed(4)}
        </span>
      )}
      {typeof e.durationMs === "number" && (
        <span className="inline-flex items-center gap-1">
          <Timer className="size-3" />
          {fmtMs(e.durationMs)}
        </span>
      )}
      {typeof e.numTurns === "number" && (
        <span className="inline-flex items-center gap-1">
          <Gauge className="size-3" />
          {e.numTurns} turn{e.numTurns === 1 ? "" : "s"}
        </span>
      )}
    </div>
  )
}
