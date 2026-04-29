import { useEffect } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props {
  open: boolean
  src: string | null
  alt?: string
  onClose: () => void
}

export function ImageLightbox({ open, src, alt, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open || !src) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? "图片预览"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-4 right-4 size-9 text-foreground/80 hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label="关闭"
      >
        <X className="size-5" />
      </Button>
      <img
        src={src}
        alt={alt ?? ""}
        title={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-md border bg-background shadow-lg"
      />
    </div>
  )
}
