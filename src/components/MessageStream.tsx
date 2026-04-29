import { useEffect, useRef } from "react"
import { MessageSquareDashed } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { UIEntry } from "@/types/ui"
import { MessageCard } from "./MessageCard"

interface Props {
  entries: UIEntry[]
  streaming: boolean
}

export function MessageStream({ entries, streaming }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const viewport = el.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [entries, streaming])

  if (entries.length === 0) {
    return (
      <div className="flex-1 grid place-items-center text-muted-foreground p-8">
        <div className="flex flex-col items-center gap-2">
          <MessageSquareDashed className="size-12" strokeWidth={1.2} />
          <div className="text-foreground text-base font-medium">就绪</div>
          <div className="text-sm text-center max-w-md">
            选择工作目录后输入消息开始对话。会话以 stream-json 模式连接 claude CLI。
          </div>
        </div>
      </div>
    )
  }

  return (
    <ScrollArea ref={ref} className="flex-1 min-h-0">
      <div className="flex flex-col gap-3 p-4">
        {entries.map((e, i) => (
          <MessageCard key={`${e.kind}-${i}-${e.ts}`} entry={e} />
        ))}
      </div>
    </ScrollArea>
  )
}
