import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
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
      className="pointer-events-none absolute right-[max(1rem,calc(50%-26rem))] top-1/2 z-20 hidden max-h-[min(60vh,360px)] -translate-y-1/2 lg:flex"
    >
      <div className="pointer-events-auto flex max-h-[inherit] w-10 flex-col items-center gap-1 overflow-y-auto rounded-full border border-border/60 bg-background/75 px-1.5 py-2 shadow-sm backdrop-blur-md scrollbar-thin">
        {items.map((item) => {
          const active = item.id === activeId
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`跳转到${item.label}`}
                  aria-current={active ? "location" : undefined}
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    "h-1.5 rounded-full outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring/60",
                    item.role === "user"
                      ? "ml-auto w-5 bg-primary/55 hover:w-7 hover:bg-primary"
                      : "mr-auto w-4 bg-muted-foreground/35 hover:w-7 hover:bg-muted-foreground/70",
                    item.queued && "opacity-60",
                    active && "w-7 bg-primary ring-2 ring-primary/20"
                  )}
                />
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
                  <div className="max-h-20 overflow-hidden text-sm leading-relaxed text-card-foreground">
                    {item.preview}
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </nav>
  )
}
