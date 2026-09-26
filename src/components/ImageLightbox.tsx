import * as Dialog from "@radix-ui/react-dialog"
import { useEffect, useRef, useState, type WheelEvent } from "react"
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props {
  open: boolean
  src: string | null
  alt?: string
  images?: Array<{ src: string; alt?: string }>
  onClose: () => void
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 4
const ZOOM_STEP = 0.1

function clampZoom(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v))
}

export function ImageLightbox({ open, src, alt, images, onClose }: Props) {
  const [zoom, setZoom] = useState(1)
  const [index, setIndex] = useState(0)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const callbacks = useRef({ onClose, count: images?.length ?? 1 })
  callbacks.current = { onClose, count: images?.length ?? 1 }
  useEffect(() => { if (open) { setIndex(Math.max(0, images?.findIndex((image) => image.src === src) ?? 0)); setZoom(1) } }, [open, src, images])
  useEffect(() => { setZoom(1) }, [index])
  const shown = images?.[index] ?? { src, alt }

  useEffect(() => {
    if (!open) return
    setZoom(1)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        callbacks.current.onClose()
        return
      }
      // 缩放键不抢修饰组合键（Ctrl+0 等留给系统/应用快捷键）
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault()
        e.stopPropagation()
        setIndex((index) => (index + (e.key === "ArrowRight" ? 1 : -1) + callbacks.current.count) % callbacks.current.count)
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault()
        e.stopPropagation()
        setZoom((z) => clampZoom(z + ZOOM_STEP))
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault()
        e.stopPropagation()
        setZoom((z) => clampZoom(z - ZOOM_STEP))
      } else if (e.key === "0") {
        e.preventDefault()
        e.stopPropagation()
        setZoom(1)
      }
    }
    // Consume modal shortcuts before the composer receives them.
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open])

  if (!open || !src) return null

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    // 滚轮：向上放大、向下缩小；按比例缩放避免大尺度跳变
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    setZoom((z) => clampZoom(z * factor))
  }

  return (
    <Dialog.Root open={open} onOpenChange={(value) => { if (!value) onClose() }}>
    <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-background/85" />
    <Dialog.Content
      aria-describedby={undefined}
      onOpenAutoFocus={() => { returnFocusRef.current = document.activeElement as HTMLElement | null }}
      onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus() }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/85 backdrop-blur-sm p-6"
      onClick={onClose}
      onWheel={onWheel}
    >
      <Dialog.Title className="sr-only">{shown.alt || "图片预览"}</Dialog.Title>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-4 right-4 size-9 text-foreground/80 hover:text-foreground z-10"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label="关闭"
      >
        <X className="size-5" />
      </Button>

      <div
        className="flex-1 min-h-0 w-full flex items-center justify-center overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={shown.src ?? ""}
          alt={shown.alt ?? ""}
          title={shown.alt}
          draggable={false}
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "center center",
            transition: "transform 80ms ease-out"
          }}
          className="max-w-[90vw] max-h-[80vh] object-contain rounded-md border bg-background shadow-lg select-none"
        />
      </div>

      {/* 底部缩放控制条 */}
      <div
        className="mt-4 flex items-center gap-3 rounded-full border bg-card/95 backdrop-blur px-4 py-2 shadow-md z-10"
        onClick={(e) => e.stopPropagation()}
      >
        {(images?.length ?? 0) > 1 && <>
          <Button variant="ghost" size="icon" aria-label="上一张" onClick={() => setIndex((i) => (i - 1 + images!.length) % images!.length)}><ChevronLeft /></Button>
          <span className="text-xs">{index + 1}/{images!.length}</span>
          <Button variant="ghost" size="icon" aria-label="下一张" onClick={() => setIndex((i) => (i + 1) % images!.length)}><ChevronRight /></Button>
        </>}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
          aria-label="缩小"
        >
          <Minus className="size-3.5" />
        </Button>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.05}
          value={zoom}
          onChange={(e) => setZoom(clampZoom(Number(e.target.value)))}
          className="w-24 sm:w-56 accent-primary"
          aria-label="缩放"
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
          aria-label="放大"
        >
          <Plus className="size-3.5" />
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground w-12 text-center">
          {(zoom * 100).toFixed(0)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setZoom(1)}
          aria-label="重置缩放"
          title="重置 (0)"
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setZoom(MAX_ZOOM)}
          aria-label="最大"
          title="放到最大 (4×)"
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>
    </Dialog.Content>
    </Dialog.Portal>
    </Dialog.Root>
  )
}
