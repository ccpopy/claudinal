import { Construction } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"

interface Props {
  title: string
  hint?: string
}

export function Placeholder({ title, hint }: Props) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0">
        <h2 className="text-xl font-semibold">{title}</h2>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 pb-8 max-w-3xl">
          <div className="rounded-lg border bg-muted/40 p-6 flex items-start gap-3">
            <Construction className="size-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-sm text-muted-foreground">
              <div className="font-medium text-foreground mb-1">即将推出</div>
              {hint ?? "敬请期待。"}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
