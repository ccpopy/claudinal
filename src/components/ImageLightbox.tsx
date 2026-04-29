import { useEffect, useState, type WheelEvent } from "react"
import { Maximize2, Minus, Plus, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props {
  open: boolean
  src: string | null
  alt?: string
  onClose: () => void
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 4
const ZOOM_STEP = 0.1

function clampZoom(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v))
}

export function ImageLightbox({ open, src, alt, onClose }: Props) {
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    if (!open) return
    setZoom(1)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      } else if (e.key === "+" || e.key === "=") {
        setZoom((z) => clampZoom(z + ZOOM_STEP))
      } else if (e.key === "-" || e.key === "_") {
        setZoom((z) => clampZoom(z - ZOOM_STEP))
      } else if (e.key === "0") {
        setZoom(1)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open || !src) return null

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    // 滚轮：向上放大、向下缩小；按比例缩放避免大尺度跳变
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    setZoom((z) => clampZoom(z * factor))
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? "图片预览"}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/85 backdrop-blur-sm p-6"
      onClick={onClose}
      onWheel={onWheel}
    >
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
          src={src}
          alt={alt ?? ""}
          title={alt}
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
          className="w-56 accent-primary"
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
    </div>
  )
}
