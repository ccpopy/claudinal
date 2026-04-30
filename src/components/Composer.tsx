import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent
} from "react"
import { ListPlus, Send, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { listFiles } from "@/lib/ipc"
import { loadSettings } from "@/lib/settings"
import type { ImagePayload } from "@/types/ui"
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

type Thumb = ImagePayload

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  centered,
  externalText,
  onExternalTextConsumed,
  cwd,
  slashCommands
}: Props) {
  const [text, setText] = useState("")
  const [images, setImages] = useState<Thumb[]>([])
  const [dragOver, setDragOver] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
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
    if (!t && images.length === 0) return
    onSend(
      t,
      images.map((i) => ({ data: i.data, mime: i.mime }))
    )
    setText("")
    setImages([])
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
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"))
    const out: Thumb[] = []
    for (const f of arr) {
      const data = await new Promise<string>((res) => {
        const r = new FileReader()
        r.onload = () => {
          const result = r.result as string
          const idx = result.indexOf("base64,")
          res(idx >= 0 ? result.slice(idx + 7) : result)
        }
        r.readAsDataURL(f)
      })
      out.push({ data, mime: f.type })
    }
    if (out.length) setImages((cur) => [...cur, ...out])
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

  return (
    <div
      className={cn(
        "transition-colors",
        centered
          ? "p-3 rounded-2xl border bg-card shadow-sm"
          : "px-6 py-3 bg-background",
        dragOver && "ring-2 ring-ring/50 ring-inset bg-accent/40"
      )}
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
    >
      <div className={cn("space-y-2", !centered && "max-w-3xl mx-auto")}>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div key={i} className="relative size-16 group/thumb">
              <button
                type="button"
                aria-label="放大图片"
                title="点击放大"
                onClick={() => setPreviewIdx(i)}
                className="size-16 rounded-md border bg-cover bg-center cursor-zoom-in transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
                style={{
                  backgroundImage: `url(data:${img.mime};base64,${img.data})`
                }}
              />
              <button
                type="button"
                aria-label="移除图片"
                onClick={(e) => {
                  e.stopPropagation()
                  setImages((cur) => cur.filter((_, j) => j !== i))
                }}
                className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-foreground/90 text-background inline-flex items-center justify-center hover:bg-foreground"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {previewIdx !== null && images[previewIdx] && (
        <ImageLightbox
          open
          src={`data:${images[previewIdx].mime};base64,${images[previewIdx].data}`}
          alt={`待发送图片 ${previewIdx + 1}`}
          onClose={() => setPreviewIdx(null)}
        />
      )}
      <div className="flex items-end gap-2 relative">
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
              ? "Enter 排队，发送将在当前回合后投递；Esc 中断"
              : centered
                ? "问 Claude 任何事，输入 @ 引用文件…"
                : "输入消息，Enter 发送，Shift+Enter 换行，可粘贴/拖拽图片"
          }
          disabled={disabled}
          rows={1}
          className={cn(
            "flex-1 min-h-9 max-h-60 border-0 shadow-none focus-visible:ring-0",
            !centered && "border bg-background shadow-xs"
          )}
        />
        <div className="flex items-center gap-1">
          {streaming && (
            <Button
              onClick={() => onStop()}
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label="中断当前回合"
              title="中断当前回合 (Esc)"
            >
              <Square fill="currentColor" className="size-3" />
            </Button>
          )}
          <Button
            onClick={send}
            disabled={disabled || (!text.trim() && images.length === 0)}
            variant={streaming ? "secondary" : "default"}
          >
            {streaming ? <ListPlus /> : <Send />}
            {streaming ? "排队" : "发送"}
          </Button>
        </div>
      </div>
      </div>
    </div>
  )
}
