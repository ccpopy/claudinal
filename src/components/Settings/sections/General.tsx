import { Construction } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"

export function General() {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0">
        <h2 className="text-xl font-semibold">常规</h2>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 pb-8 max-w-3xl">
          <section className="rounded-lg border bg-muted/40 p-6 flex items-start gap-3">
            <Construction className="size-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-sm text-muted-foreground">
              <div className="font-medium text-foreground mb-1">待实现</div>
              启动行为 / 关闭确认 / 自动检查更新。
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}
