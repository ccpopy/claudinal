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
  if (items.length === 0) return null
  return (
    <nav
      aria-label="对话时间线导航"
      className="pointer-events-none absolute right-[max(1rem,calc(50%-26rem))] top-1/2 z-20 hidden max-h-[min(60vh,360px)] w-7 -translate-y-1/2 lg:flex"
    >
      <div className="pointer-events-auto flex max-h-[inherit] w-full flex-col items-stretch gap-1 overflow-y-auto scrollbar-thin">
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
                    "group ml-auto flex h-3 w-full items-center justify-end rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                    item.queued && "opacity-60"
                  )}
                >
                  <span
                    className={cn(
                      "h-0.5 rounded-full transition-all duration-150 ease-out",
                      isUser
                        ? "w-6 bg-muted-foreground/55 group-hover:w-7 group-hover:bg-foreground/70"
                        : "w-3.5 bg-muted-foreground/35 group-hover:w-6 group-hover:bg-foreground/70",
                      active && "w-7 bg-foreground/85 group-hover:bg-foreground/85"
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
                    {item.time && <span className="font-mono">{item.time}</span>}
                  </div>
                  <ScrollArea className="h-20 overflow-hidden">
                    <div className="min-w-0 pr-3 whitespace-normal text-justify text-sm leading-relaxed text-card-foreground break-words [overflow-wrap:anywhere]">
                      {item.preview}
                    </div>
                  </ScrollArea>
                </div>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </nav>
  )
}
