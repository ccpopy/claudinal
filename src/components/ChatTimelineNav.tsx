import { useEffect, useRef, useState } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export interface ChatTimelineItem {
  id: string
  role: "user" | "assistant"
  label: string
  preview: string
  time: string
  queued?: boolean
}

interface Props {
  items: ChatTimelineItem[]
  activeId: string | null
  onSelect: (id: string) => void
}

export function ChatTimelineNav({ items, activeId, onSelect }: Props) {
  const boundaryRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [railHeight, setRailHeight] = useState<number | null>(null)

  useEffect(() => {
    const boundary = boundaryRef.current
    const content = contentRef.current
    if (!boundary || !content) return

    const measure = () => {
      const available = boundary.clientHeight
      const contentHeight = content.scrollHeight
      if (available <= 0 || contentHeight <= 0) return
      const next = Math.ceil(Math.min(contentHeight, available))
      setRailHeight((current) => (current === next ? current : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(boundary)
    observer.observe(content)
    return () => observer.disconnect()
  }, [items])

  if (items.length === 0) return null
  return (
    <nav
      ref={boundaryRef}
      aria-label="对话时间线导航"
      className="pointer-events-none absolute bottom-6 right-[max(1rem,calc(50%-26rem))] top-6 z-20 hidden w-10 items-center lg:flex"
    >
      <div
        className="pointer-events-auto relative w-full"
        style={railHeight ? { height: railHeight } : undefined}
      >
        <ScrollArea className="h-full w-full">
          <div ref={contentRef} className="flex flex-col gap-[13px] pr-2.5">
            {items.map((item) => {
              const active = item.id === activeId
              const isUser = item.role === "user"
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`跳转到${item.label}`}
                      aria-current={active ? "location" : undefined}
                      onClick={() => onSelect(item.id)}
                      className={cn(
                        "group ml-auto flex h-[3px] w-full shrink-0 items-center justify-end rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                        item.queued && "opacity-60"
                      )}
                    >
                      <span
                        className={cn(
                          "h-full rounded-full transition-all duration-150 ease-out",
                          isUser
                            ? "w-6 bg-muted-foreground/55 group-hover:w-7 group-hover:bg-foreground/70"
                            : "w-3.5 bg-muted-foreground/35 group-hover:w-6 group-hover:bg-foreground/70",
                          active &&
                            "w-7 bg-foreground/85 group-hover:bg-foreground/85"
                        )}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="left"
                    align="center"
                    sideOffset={10}
                    className="w-64 rounded-lg p-3"
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span>{item.label}</span>
                        {item.time && (
                          <span className="font-mono">{item.time}</span>
                        )}
                      </div>
                      <div className="max-h-20 overflow-y-auto pr-3">
                        <div className="min-w-0 whitespace-normal text-justify text-sm leading-relaxed text-card-foreground break-words [overflow-wrap:anywhere]">
                          {item.preview}
                        </div>
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </ScrollArea>
      </div>
    </nav>
  )
}
