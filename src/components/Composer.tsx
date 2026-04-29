import {
  useState,
  useRef,
  useEffect,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent
} from "react"
import { Send, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

interface Props {
  onSend: (text: string, images: string[]) => void | Promise<void>
  onStop: () => void | Promise<void>
  streaming: boolean
  disabled?: boolean
  centered?: boolean
  externalText?: string
  onExternalTextConsumed?: () => void
}

interface Thumb {
  data: string
  mime: string
}

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  centered,
  externalText,
  onExternalTextConsumed
}: Props) {
  const [text, setText] = useState("")
  const [images, setImages] = useState<Thumb[]>([])
  const [dragOver, setDragOver] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

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
      images.map((i) => i.data)
    )
    setText("")
    setImages([])
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (streaming) onStop()
      else send()
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
            <div
              key={i}
              className="relative size-16 rounded-md border bg-cover bg-center"
              style={{
                backgroundImage: `url(data:${img.mime};base64,${img.data})`
              }}
            >
              <button
                type="button"
                aria-label="移除图片"
                onClick={() =>
                  setImages((cur) => cur.filter((_, j) => j !== i))
                }
                className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-foreground/90 text-background inline-flex items-center justify-center hover:bg-foreground"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          value={text}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder={
            streaming
              ? "运行中…按 Esc 或 Enter 中断"
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
        {streaming ? (
          <Button
            onClick={() => onStop()}
            variant="destructive"
            disabled={disabled}
          >
            <Square fill="currentColor" />
            停止
          </Button>
        ) : (
          <Button
            onClick={send}
            disabled={disabled || (!text.trim() && images.length === 0)}
          >
            <Send />
            发送
          </Button>
        )}
      </div>
      </div>
    </div>
  )
}
