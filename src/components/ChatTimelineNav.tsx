import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  chatTimelineMarkerWidth,
  chatTimelineRailLeft
} from "@/lib/chatTimeline"
import { cn } from "@/lib/utils"

const MARKER_HEIGHT = 2
const MARKER_GAP = 8
const MARKER_PITCH = MARKER_HEIGHT + MARKER_GAP

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
  visibleIds: ReadonlySet<string>
  onSelect: (id: string) => void
}

export function ChatTimelineNav({
  items,
  activeId,
  visibleIds,
  onSelect
}: Props) {
  const hasItems = items.length > 0
  const boundaryRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const pointerFrameRef = useRef<number | null>(null)
  const pendingPointerYRef = useRef<number | null>(null)
  const pointerInsideRef = useRef(false)
  const pointerSessionRef = useRef(0)
  const [railHeight, setRailHeight] = useState<number | null>(null)
  const [railLeft, setRailLeft] = useState<number | null>(null)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)

  useEffect(() => {
    const boundary = boundaryRef.current
    const container = boundary?.closest<HTMLElement>("[data-slot='scroll-area']")
    const messageColumn = container?.querySelector<HTMLElement>(
      "[data-message-stream-content]"
    )
    if (!container || !messageColumn) return

    const measure = () => {
      const containerRect = container.getBoundingClientRect()
      const messageColumnRect = messageColumn.getBoundingClientRect()
      const next = chatTimelineRailLeft(messageColumnRect.left - containerRect.left)
      setRailLeft((current) => (current === next ? current : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(messageColumn)
    return () => {
      observer.disconnect()
    }
  }, [hasItems])

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
  }, [items, railLeft])

  useEffect(
    () => () => {
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current)
      }
      pointerInsideRef.current = false
      pointerSessionRef.current += 1
      pendingPointerYRef.current = null
    },
    []
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const content = contentRef.current
      if (!content) return
      pointerInsideRef.current = true
      pendingPointerYRef.current = event.clientY - content.getBoundingClientRect().top
      if (pointerFrameRef.current !== null) return
      const session = pointerSessionRef.current
      pointerFrameRef.current = window.requestAnimationFrame(() => {
        pointerFrameRef.current = null
        if (
          !pointerInsideRef.current ||
          session !== pointerSessionRef.current ||
          pendingPointerYRef.current === null
        ) {
          return
        }
        setPointerY(pendingPointerYRef.current)
      })
    },
    []
  )

  const resetPointerInteraction = useCallback(() => {
    pointerInsideRef.current = false
    pointerSessionRef.current += 1
    pendingPointerYRef.current = null
    if (pointerFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerFrameRef.current)
      pointerFrameRef.current = null
    }
    setPointerY(null)
  }, [])

  if (!hasItems) return null
  return (
    <nav
      ref={boundaryRef}
      aria-label="对话时间线导航"
      // 宽屏固定贴近主面板左缘；空间变窄时跟随消息列左缘，放不下完整 rail 就隐藏。
      className="pointer-events-none absolute bottom-6 top-6 z-20 hidden w-10 items-center lg:flex"
      style={{
        display: railLeft === null ? "none" : undefined,
        left: railLeft ?? undefined
      }}
    >
      <div
        className="pointer-events-auto relative w-full"
        style={railHeight ? { height: railHeight } : undefined}
      >
        <ScrollArea className="h-full w-full">
          <div
            ref={contentRef}
            className="flex cursor-pointer flex-col gap-2 pr-2.5"
            onPointerEnter={() => {
              pointerInsideRef.current = true
            }}
            onPointerMove={handlePointerMove}
            onPointerLeave={resetPointerInteraction}
            onPointerCancel={resetPointerInteraction}
          >
            {items.map((item, index) => {
              const active = item.id === activeId
              const visible = visibleIds.has(item.id)
              const focused = item.id === focusedId
              const markerCenterY = index * MARKER_PITCH + MARKER_HEIGHT / 2
              const markerWidth = chatTimelineMarkerWidth(
                focused ? markerCenterY : pointerY,
                markerCenterY
              )
              return (
                <Tooltip
                  key={item.id}
                  delayDuration={0}
                  disableHoverableContent
                >
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`跳转到${item.label}`}
                      aria-current={active ? "location" : undefined}
                      onClick={() => onSelect(item.id)}
                      onFocus={(event) =>
                        setFocusedId(
                          event.currentTarget.matches(":focus-visible")
                            ? item.id
                            : null
                        )
                      }
                      onBlur={() => setFocusedId((id) =>
                        id === item.id ? null : id
                      )}
                      className={cn(
                        "group/timeline-marker relative flex h-0.5 w-full shrink-0 items-center justify-start rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        item.queued && "opacity-60"
                      )}
                    >
                      <span aria-hidden className="absolute -inset-y-1 inset-x-0" />
                      <span
                        className={cn(
                          "h-full rounded-full transition-[width,background-color,opacity] duration-100 ease-out motion-reduce:transition-none",
                          visible || active
                            ? "bg-foreground/70"
                            : "bg-muted-foreground/30",
                          "group-hover/timeline-marker:bg-foreground/90",
                          focused && "bg-foreground/90"
                        )}
                        style={{ width: markerWidth }}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    align="center"
                    sideOffset={10}
                    className="pointer-events-none w-72 rounded-xl p-3 shadow-lg data-[state=closed]:hidden [animation-duration:0ms] sm:w-80"
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span>{item.label}</span>
                        {item.time && (
                          <span className="font-mono">{item.time}</span>
                        )}
                      </div>
                      <div className="min-w-0 overflow-hidden">
                        <div className="line-clamp-4 min-w-0 whitespace-normal break-words text-sm leading-relaxed text-card-foreground [overflow-wrap:anywhere]">
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
