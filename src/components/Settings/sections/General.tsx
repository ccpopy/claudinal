import { Construction } from "lucide-react"

export function General() {
  return (
    <div className="p-8 max-w-3xl space-y-6">
      <h2 className="text-xl font-semibold">常规</h2>

      <section className="space-y-2 rounded-lg border bg-muted/40 p-6 flex items-start gap-3">
        <Construction className="size-5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground">
          <div className="font-medium text-foreground mb-1">待实现</div>
          启动行为、关闭确认、自动检查更新等条目已写入 plan.md §6 P3.1。
        </div>
      </section>
    </div>
  )
}
