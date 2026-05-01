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
  FileText,
  Image as ImageIcon,
  ListPlus,
  ListTodo,
  Package,
  Paperclip,
  Plus,
  Settings as SettingsIcon,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { listFiles, type OauthUsage, type OauthUsageWindow } from "@/lib/ipc"
import type { ComposerPrefs } from "@/lib/composerPrefs"
import { listInstalledPlugins, type InstalledPlugin } from "@/lib/plugins"
import { loadSettings } from "@/lib/settings"
import { shortResets, fiveHourPercent } from "@/lib/oauthUsage"
import type { ImagePayload } from "@/types/ui"
import {
  SuggestionPanel,
  type SuggestionItem
} from "./SuggestionPanel"
import { ImageLightbox } from "./ImageLightbox"
import { ModelEffortPicker } from "./composer/ModelEffortPicker"

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
  oauthUsage?: OauthUsage | null
  model?: string
  effort?: string
  onModelEffortChange?: (next: { model?: string; effort?: string }) => void
  extraModels?: { value: string; label?: string }[]
  globalDefault?: ComposerPrefs
  sessionPrefs?: ComposerPrefs | null
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
  oauthUsage,
  model = "",
  effort = "",
  onModelEffortChange,
  extraModels,
  globalDefault,
  sessionPrefs
}: Props) {
  const [text, setText] = useState("")
  const [images, setImages] = useState<Thumb[]>([])
  const [textFiles, setTextFiles] = useState<TextAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([])
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

  // 打开 + 菜单时再拉一次已安装插件，避免 GUI 启动时阻塞
  useEffect(() => {
    if (!plusOpen) return
    listInstalledPlugins()
      .then(setInstalledPlugins)
      .catch(() => setInstalledPlugins([]))
  }, [plusOpen])

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
      <div className={cn("relative", !centered && "mx-auto max-w-3xl")}>
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
                ? "当前回复进行中，按 Enter 交给 Claude 排队"
                : "要求后续变更"
            }
            disabled={disabled}
            rows={1}
            className="min-h-[56px] max-h-60 border-0 bg-transparent px-1 py-1 text-base shadow-none focus-visible:ring-0"
          />

          <div className="mt-3 flex items-center justify-between gap-3">
            <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
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
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="h-10 rounded-xl">
                    <Blocks className="size-4" />
                    <span className="flex-1">插件</span>
                    {installedPlugins.length > 0 && (
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {installedPlugins.length}
                      </span>
                    )}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    className="w-60 rounded-xl p-1"
                    sideOffset={6}
                  >
                    <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                      {installedPlugins.length > 0
                        ? `${installedPlugins.length} 个已安装插件`
                        : "未安装插件"}
                    </div>
                    {installedPlugins.length === 0 ? (
                      <div className="px-2 py-1 text-xs text-muted-foreground">
                        点击「管理插件」浏览 Marketplace
                      </div>
                    ) : (
                      <div className="max-h-72 overflow-y-auto">
                        {installedPlugins.map((p) => (
                          <DropdownMenuItem
                            key={`${p.id}-${p.scope}-${p.project_path ?? ""}`}
                            className="h-9 rounded-lg"
                            onSelect={(e) => {
                              e.preventDefault()
                              onOpenPlugins?.()
                            }}
                          >
                            <Package className="size-4 text-muted-foreground" />
                            <span className="flex-1 truncate">{p.name}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {p.scope === "user"
                                ? ""
                                : p.scope === "project"
                                  ? "项目"
                                  : "本地"}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </div>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="h-9 rounded-lg"
                      onSelect={() => onOpenPlugins?.()}
                    >
                      <SettingsIcon className="size-4" />
                      <span>管理插件</span>
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-1">
              {onModelEffortChange && (
                <ModelEffortPicker
                  model={model}
                  effort={effort}
                  onChange={onModelEffortChange}
                  extraModels={extraModels}
                  disabled={disabled}
                  globalDefault={globalDefault}
                  sessionPrefs={sessionPrefs}
                />
              )}
              <PlanUsageIndicator usage={oauthUsage ?? null} />
              {streaming && (
                <Button
                  onClick={() => onStop()}
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label="中断当前回合"
                  title="中断当前回合 (Esc)"
                  className="size-8 rounded-lg"
                >
                  <Square fill="currentColor" className="size-3" />
                </Button>
              )}
              <Button
                onClick={send}
                disabled={disabled || !canSend}
                variant={streaming ? "secondary" : "default"}
                size="icon"
                aria-label={streaming ? "交给 Claude 排队" : "发送"}
                title={streaming ? "交给 Claude 排队" : "发送"}
                className="size-8 rounded-lg shadow-sm"
              >
                {streaming ? (
                  <ListPlus className="size-4" />
                ) : (
                  <ArrowUp className="size-4" />
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

function PlanUsageIndicator({ usage }: { usage: OauthUsage | null }) {
  // 仅 Anthropic OAuth 登录用户能拿到 plan usage；第三方 API / 未登录返回 null。
  // 该控件的存在本身="官方账号已登录"。
  if (!usage) return null
  const percent = fiveHourPercent(usage)
  if (percent === null) return null

  const fiveHour = usage.five_hour
  const sevenDay = usage.seven_day
  const sevenDayOpus = usage.seven_day_opus ?? undefined
  const sevenDaySonnet = usage.seven_day_sonnet ?? undefined

  const fmtReset = (resetsAt: string | undefined) => {
    const t = shortResets(resetsAt)
    if (!t) return ""
    return t === "已重置" ? "已重置" : `${t}后重置`
  }

  const ringStyle = {
    background: `conic-gradient(var(--primary) ${percent}%, var(--border) 0)`
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-full transition-opacity hover:opacity-80"
          aria-label={`Plan ${percent}%`}
        >
          <span
            className="grid size-4 place-items-center rounded-full"
            style={ringStyle}
          >
            <span className="block size-2.5 rounded-full bg-card" />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-24px)] rounded-xl px-4 py-3"
      >
        <div className="space-y-2 text-left">
          <div className="text-xs font-medium text-muted-foreground">
            计划用量
          </div>
          {fiveHour && (
            <UsageRow
              label="5 小时限额"
              window={fiveHour}
              suffix={fmtReset(fiveHour.resets_at)}
            />
          )}
          {sevenDay && (
            <UsageRow
              label="每周 · 全部模型"
              window={sevenDay}
              suffix={fmtReset(sevenDay.resets_at)}
            />
          )}
          {sevenDaySonnet && (
            <UsageRow
              label="每周 · Sonnet"
              window={sevenDaySonnet}
              suffix={fmtReset(sevenDaySonnet.resets_at)}
            />
          )}
          {sevenDayOpus && (
            <UsageRow
              label="每周 · 仅 Opus"
              window={sevenDayOpus}
              suffix={fmtReset(sevenDayOpus.resets_at)}
            />
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function UsageRow({
  label,
  window: w,
  suffix
}: {
  label: string
  window: OauthUsageWindow
  suffix?: string
}) {
  const pct = Math.max(0, Math.min(100, Math.round(w.utilization)))
  const tone =
    pct >= 90 ? "bg-destructive" : pct >= 60 ? "bg-warn" : "bg-primary"
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {pct}%{suffix ? ` · ${suffix}` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full transition-[width]", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
