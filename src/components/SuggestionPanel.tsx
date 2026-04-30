import { useEffect, useRef } from "react"
import { Pin } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SuggestionItem {
  key: string
  primary: string
  secondary?: string
  /** 显示置顶图标，并在条目最左侧叠加视觉权重 */
  pinned?: boolean
  /** 在条目顶部画分组分隔符 */
  group?: string
}

interface Props {
  open: boolean
  items: SuggestionItem[]
  activeIdx: number
  onPick: (idx: number) => void
  onHover: (idx: number) => void
  emptyHint?: string
}

export function SuggestionPanel({
  open,
  items,
  activeIdx,
  onPick,
  onHover,
  emptyHint
}: Props) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx='${activeIdx}']`
    )
    el?.scrollIntoView({ block: "nearest" })
  }, [open, activeIdx])

  if (!open) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1.5 max-h-60 overflow-auto scrollbar-thin rounded-md border bg-popover shadow-lg z-30 text-sm"
      role="listbox"
    >
      {items.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {emptyHint ?? "无匹配项"}
        </div>
      ) : (
        items.map((it, i) => {
          const prevGroup = i > 0 ? items[i - 1].group : undefined
          const showHeader = it.group && it.group !== prevGroup
          return (
            <div key={it.key}>
              {showHeader && (
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  {it.group}
                </div>
              )}
              <button
                data-idx={i}
                type="button"
                onMouseEnter={() => onHover(i)}
                onMouseDown={(e) => {
                  // 阻止 textarea blur 导致面板提前关闭吞掉 onClick
                  e.preventDefault()
                }}
                onClick={() => onPick(i)}
                role="option"
                aria-selected={i === activeIdx}
                className={cn(
                  "w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors",
                  i === activeIdx
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/60"
                )}
              >
                {it.pinned ? (
                  <Pin className="size-3 text-primary shrink-0" />
                ) : (
                  <span className="size-3 shrink-0" />
                )}
                <span className="font-mono text-xs shrink-0">{it.primary}</span>
                {it.secondary && (
                  <span className="text-[11px] text-muted-foreground truncate">
                    {it.secondary}
                  </span>
                )}
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}
