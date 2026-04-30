import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode
} from "react"
import {
  ArrowUp,
  Blocks,
  ChevronRight,
  FileText,
  Gauge,
  Image as ImageIcon,
  ListPlus,
  ListTodo,
  Paperclip,
  Plus,
  Square,
  X
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { listFiles } from "@/lib/ipc"
import { loadSettings } from "@/lib/settings"
import type { ContextUsage, ImagePayload } from "@/types/ui"
import {
  SuggestionPanel,
  type SuggestionItem
} from "./SuggestionPanel"
import { ImageLightbox } from "./ImageLightbox"

interface Props {
  onSend: (text: string, images: ImagePayload[]) => void | Promise<void>
  onStop: () => void | Promise<void>
  streaming: boolean
  disabled?: boolean
  centered?: boolean
  externalText?: string
  onExternalTextConsumed?: () => void
  cwd?: string | null
  slashCommands?: string[]
  planMode?: boolean
  onPlanModeChange?: (enabled: boolean) => void
  onOpenPlugins?: () => void
  contextUsage?: ContextUsage | null
}

interface TriggerInfo {
  kind: "@" | "/"
  start: number // 触发字符位置
  query: string
}

function parseTrigger(text: string, caret: number): TriggerInfo | null {
  // 从光标向前找最近的 @ 或 /，遇到空白或越界则停。
  let i = caret - 1
  while (i >= 0) {
    const c = text[i]
    if (c === "@" || c === "/") {
      // 触发符前必须是行首或空白（避免 a/b 触发）
      const prev = i > 0 ? text[i - 1] : "\n"
      if (prev === " " || prev === "\n" || prev === "\t" || i === 0) {
        return {
          kind: c as "@" | "/",
          start: i,
          query: text.slice(i + 1, caret)
        }
      }
      return null
    }
    if (c === " " || c === "\n") return null
    i--
  }
  return null
}

const MAX_TEXT_FILE_BYTES = 1024 * 1024
const TEXT_EXTENSIONS = new Set([
  "css",
  "csv",
  "env",
  "go",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "properties",
  "py",
  "rs",
  "scss",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml"
])

type Thumb = ImagePayload & { id: string; name: string; size: number }

interface TextAttachment {
  id: string
  name: string
  mime: string
  size: number
  text: string
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatTokens(tokens: number) {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}m`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

function isTextFile(file: File) {
  if (file.type.startsWith("text/")) return true
  if (
    file.type.includes("json") ||
    file.type.includes("xml") ||
    file.type.includes("yaml") ||
    file.type.includes("javascript") ||
    file.type.includes("typescript")
  ) {
    return true
  }
  const ext = file.name.split(".").pop()?.toLowerCase()
  return !!ext && TEXT_EXTENSIONS.has(ext)
}

function readAsDataUrlPayload(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const result = reader.result as string
      const idx = result.indexOf("base64,")
      resolve(idx >= 0 ? result.slice(idx + 7) : result)
    }
    reader.readAsDataURL(file)
  })
}

function readAsTextPayload(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.readAsText(file)
  })
}

function escapeAttr(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
}

function buildOutgoingText(text: string, files: TextAttachment[]) {
  const parts = [text.trim()].filter(Boolean)
  for (const file of files) {
    parts.push(
      [
        `<uploaded_file name="${escapeAttr(file.name)}" mime="${escapeAttr(file.mime || "text/plain")}" size="${file.size}">`,
        file.text,
        "</uploaded_file>"
      ].join("\n")
    )
  }
  return parts.join("\n\n")
}

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  centered,
  externalText,
  onExternalTextConsumed,
  cwd,
  slashCommands,
  planMode = false,
  onPlanModeChange,
  onOpenPlugins,
  contextUsage
}: Props) {
  const [text, setText] = useState("")
  const [images, setImages] = useState<Thumb[]>([])
  const [textFiles, setTextFiles] = useState<TextAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [trigger, setTrigger] = useState<TriggerInfo | null>(null)
  const [items, setItems] = useState<SuggestionItem[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const fileReqRef = useRef(0)

  const refreshSuggestions = useCallback(
    async (info: TriggerInfo) => {
      if (info.kind === "/") {
        const all = (slashCommands ?? []).filter((c) => c)
        const pinned = new Set(loadSettings().pinnedSlash)
        const filtered = info.query
          ? all.filter((c) =>
              c.toLowerCase().includes(info.query.toLowerCase())
            )
          : all
        const pinnedList: SuggestionItem[] = []
        const restList: SuggestionItem[] = []
        for (const c of filtered) {
          if (pinned.has(c)) {
            pinnedList.push({
              key: `pin:${c}`,
              primary: `/${c}`,
              pinned: true,
              group: "置顶"
            })
          } else {
            restList.push({
              key: c,
              primary: `/${c}`,
              group: pinnedList.length > 0 ? "全部命令" : undefined
            })
          }
        }
        const merged = [...pinnedList, ...restList].slice(0, 60)
        setItems(merged)
        setActiveIdx(0)
        return
      }
      // @ 文件补全
      if (!cwd) {
        setItems([])
        return
      }
      const seq = ++fileReqRef.current
      try {
        const matches = await listFiles(cwd, info.query)
        if (seq !== fileReqRef.current) return
        setItems(
          matches.slice(0, 60).map((m) => ({
            key: m.rel,
            primary: m.rel,
            secondary: m.is_dir ? "目录" : undefined
          }))
        )
        setActiveIdx(0)
      } catch {
        if (seq === fileReqRef.current) setItems([])
      }
    },
    [cwd, slashCommands]
  )

  const updateTrigger = useCallback(
    (next: string, caret: number) => {
      const t = parseTrigger(next, caret)
      setTrigger(t)
      if (t) refreshSuggestions(t)
      else setItems([])
    },
    [refreshSuggestions]
  )

  const applySuggestion = useCallback(
    (idx: number) => {
      if (!trigger) return
      const it = items[idx]
      if (!it) return
      const insert = trigger.kind === "/" ? it.primary : `@${it.primary}`
      const before = text.slice(0, trigger.start)
      const caret = ref.current?.selectionStart ?? trigger.start + 1 + trigger.query.length
      const after = text.slice(caret)
      const next = `${before}${insert} ${after}`
      setText(next)
      setTrigger(null)
      setItems([])
      requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        const pos = before.length + insert.length + 1
        el.setSelectionRange(pos, pos)
        el.focus()
      })
    },
    [trigger, items, text]
  )

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 240) + "px"
  }, [text])

  useEffect(() => {
    if (externalText !== undefined && externalText !== "") {
      setText(externalText)
      onExternalTextConsumed?.()
      requestAnimationFrame(() => ref.current?.focus())
    }
  }, [externalText, onExternalTextConsumed])

  const send = () => {
    const t = text.trim()
    const outgoingText = buildOutgoingText(t, textFiles)
    if (!outgoingText && images.length === 0) return
    onSend(
      outgoingText,
      images.map((i) => ({ data: i.data, mime: i.mime }))
    )
    setText("")
    setImages([])
    setTextFiles([])
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setActiveIdx((i) => (i + 1) % items.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIdx((i) => (i - 1 + items.length) % items.length)
        return
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault()
        applySuggestion(activeIdx)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setTrigger(null)
        setItems([])
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === "Escape" && streaming) {
      e.preventDefault()
      onStop()
    }
  }

  const handleFiles = async (files: FileList | File[]) => {
    const nextImages: Thumb[] = []
    const nextTextFiles: TextAttachment[] = []
    let skipped = 0

    for (const file of Array.from(files)) {
      try {
        if (file.type.startsWith("image/")) {
          const data = await readAsDataUrlPayload(file)
          nextImages.push({
            id: makeId(),
            data,
            mime: file.type,
            name: file.name || "image",
            size: file.size
          })
          continue
        }

        if (!isTextFile(file) || file.size > MAX_TEXT_FILE_BYTES) {
          skipped += 1
          continue
        }

        const body = await readAsTextPayload(file)
        nextTextFiles.push({
          id: makeId(),
          name: file.name || "file.txt",
          mime: file.type || "text/plain",
          size: file.size,
          text: body
        })
      } catch {
        skipped += 1
      }
    }

    if (nextImages.length) setImages((cur) => [...cur, ...nextImages])
    if (nextTextFiles.length) {
      setTextFiles((cur) => [...cur, ...nextTextFiles])
    }
    if (skipped > 0) {
      toast.warning(
        `已跳过 ${skipped} 个文件：仅支持图片或 ${formatBytes(MAX_TEXT_FILE_BYTES)} 内文本文件`
      )
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const it of Array.from(items)) {
      if (it.kind === "file") {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length) {
      e.preventDefault()
      handleFiles(files)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (files && files.length) handleFiles(files)
  }

  const canSend = !!text.trim() || images.length > 0 || textFiles.length > 0

  return (
    <div
      className={cn(
        "shrink-0 transition-colors",
        centered ? "w-full" : "bg-background px-6 pb-4 pt-2"
      )}
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
    >
      <div className={cn("relative", !centered && "mx-auto max-w-4xl")}>
        <SuggestionPanel
          open={!!trigger}
          items={items}
          activeIdx={activeIdx}
          onPick={applySuggestion}
          onHover={setActiveIdx}
          emptyHint={
            trigger?.kind === "/" ? "无匹配命令" : "无匹配文件"
          }
        />
        <div
          className={cn(
            "rounded-[24px] border bg-card p-3 shadow-sm transition-colors",
            dragOver && "bg-accent/40 ring-2 ring-inset ring-ring/50"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => {
              const files = e.currentTarget.files
              if (files?.length) handleFiles(files)
              e.currentTarget.value = ""
            }}
          />

          {(images.length > 0 || textFiles.length > 0) && (
            <div className="mb-2 flex flex-wrap gap-2">
              {images.map((img, i) => (
                <AttachmentChip
                  key={img.id}
                  icon={<ImageIcon className="size-3.5" />}
                  label={img.name}
                  meta={formatBytes(img.size)}
                  onClick={() => setPreviewIdx(i)}
                  onRemove={() =>
                    setImages((cur) => cur.filter((item) => item.id !== img.id))
                  }
                />
              ))}
              {textFiles.map((file) => (
                <AttachmentChip
                  key={file.id}
                  icon={<FileText className="size-3.5" />}
                  label={file.name}
                  meta={formatBytes(file.size)}
                  onRemove={() =>
                    setTextFiles((cur) =>
                      cur.filter((item) => item.id !== file.id)
                    )
                  }
                />
              ))}
            </div>
          )}

          <Textarea
            ref={ref}
            value={text}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
              const v = e.target.value
              setText(v)
              const caret = e.target.selectionStart ?? v.length
              updateTrigger(v, caret)
            }}
            onKeyUp={(e) => {
              const el = e.currentTarget
              updateTrigger(el.value, el.selectionStart ?? 0)
            }}
            onClick={(e) => {
              const el = e.currentTarget
              updateTrigger(el.value, el.selectionStart ?? 0)
            }}
            onBlur={() => {
              // 延迟关闭：让点击 SuggestionPanel 项的 onClick 先触发
              setTimeout(() => setTrigger(null), 100)
            }}
            onKeyDown={onKey}
            onPaste={onPaste}
            placeholder={
              streaming
                ? "Enter 排队，发送将在当前回合后投递"
                : "要求后续变更"
            }
            disabled={disabled}
            rows={1}
            className="min-h-[56px] max-h-60 border-0 bg-transparent px-1 py-1 text-base shadow-none focus-visible:ring-0"
          />

          <div className="mt-3 flex items-center justify-between gap-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label="添加附件和插件"
                  title="添加附件和插件"
                  className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Plus className="size-5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                side="top"
                className="w-48 rounded-2xl p-1.5"
              >
                <DropdownMenuItem
                  className="h-10 rounded-xl"
                  onSelect={() => inputRef.current?.click()}
                >
                  <Paperclip className="size-4" />
                  <span>添加照片和文件</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="h-10 rounded-xl"
                  onSelect={(e) => {
                    e.preventDefault()
                    onPlanModeChange?.(!planMode)
                  }}
                >
                  <ListTodo className="size-4" />
                  <span className="flex-1">计划模式</span>
                  <span
                    aria-hidden
                    className={cn(
                      "inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors",
                      planMode ? "bg-primary" : "bg-input"
                    )}
                  >
                    <span
                      className={cn(
                        "block size-4 rounded-full bg-background shadow-sm transition-transform",
                        planMode ? "translate-x-4" : "translate-x-0"
                      )}
                    />
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="h-10 rounded-xl"
                  onSelect={() => onOpenPlugins?.()}
                >
                  <Blocks className="size-4" />
                  <span className="flex-1">插件</span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-1">
              <ContextUsageIndicator usage={contextUsage ?? null} />
              {streaming && (
                <Button
                  onClick={() => onStop()}
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label="中断当前回合"
                  title="中断当前回合 (Esc)"
                  className="rounded-full"
                >
                  <Square fill="currentColor" className="size-3" />
                </Button>
              )}
              <Button
                onClick={send}
                disabled={disabled || !canSend}
                variant={streaming ? "secondary" : "default"}
                size="icon"
                aria-label={streaming ? "排队发送" : "发送"}
                title={streaming ? "排队发送" : "发送"}
                className="rounded-full"
              >
                {streaming ? (
                  <ListPlus className="size-4" />
                ) : (
                  <ArrowUp className="size-5" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
      {previewIdx !== null && images[previewIdx] && (
        <ImageLightbox
          open
          src={`data:${images[previewIdx].mime};base64,${images[previewIdx].data}`}
          alt={images[previewIdx].name || `待发送图片 ${previewIdx + 1}`}
          onClose={() => setPreviewIdx(null)}
        />
      )}
    </div>
  )
}

function AttachmentChip({
  icon,
  label,
  meta,
  onClick,
  onRemove
}: {
  icon: ReactNode
  label: string
  meta: string
  onClick?: () => void
  onRemove: () => void
}) {
  const body = (
    <>
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block max-w-40 truncate text-xs font-medium">
          {label}
        </span>
        <span className="block text-[10px] leading-none text-muted-foreground">
          {meta}
        </span>
      </span>
    </>
  )

  return (
    <span className="group/chip inline-flex max-w-full items-center gap-2 rounded-full border bg-muted/60 py-1 pl-1 pr-1.5">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="inline-flex min-w-0 items-center gap-2 rounded-full text-left"
          title={label}
        >
          {body}
        </button>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-2" title={label}>
          {body}
        </span>
      )}
      <button
        type="button"
        aria-label={`移除 ${label}`}
        onClick={onRemove}
        className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function ContextUsageIndicator({ usage }: { usage: ContextUsage | null }) {
  const percent = usage?.percent
  const used = usage?.usedTokens ?? 0
  const total = usage?.contextWindow
  const label =
    usage && total
      ? `${percent ?? 0}% 上下文`
      : usage
        ? `${formatTokens(used)} tokens`
        : "暂无上下文数据"
  const progress =
    typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            !usage && "opacity-60"
          )}
          aria-label={label}
        >
          <span
            className="grid size-4 place-items-center rounded-full"
            style={
              usage && total
                ? {
                    background: `conic-gradient(var(--primary) ${progress}%, var(--border) 0)`
                  }
                : undefined
            }
          >
            <span className="grid size-3 place-items-center rounded-full bg-card">
              <Gauge className="size-3" />
            </span>
          </span>
          {usage && total && <span>{progress}%</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 rounded-xl px-4 py-3">
        <div className="space-y-1.5 text-center">
          <div className="text-xs text-muted-foreground">背景信息窗口：</div>
          {usage ? (
            <>
              {total ? (
                <>
                  <div className="text-sm font-semibold">
                    {progress}% 已用
                  </div>
                  <div className="text-xs">
                    已用 {formatTokens(used)} 标记，共 {formatTokens(total)}
                  </div>
                </>
              ) : (
                <div className="text-xs">
                  已用 {formatTokens(used)} 标记
                </div>
              )}
              <div className="pt-1 text-xs font-semibold">
                Claude 会在需要时自动压缩背景信息
              </div>
              {usage.model && (
                <div className="truncate pt-1 font-mono text-[10px] text-muted-foreground">
                  {usage.model}
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-muted-foreground">
              首轮回复结束后显示上下文使用量。
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
