import { Construction } from "lucide-react"

interface Props {
  title: string
  hint?: string
}

export function Placeholder({ title, hint }: Props) {
  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-xl font-semibold mb-4">{title}</h2>
      <div className="rounded-lg border bg-muted/40 p-6 flex items-start gap-3">
        <Construction className="size-5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground">
          <div className="font-medium text-foreground mb-1">即将推出</div>
          {hint ?? "此分类已写入排期，参见 plan.md §6 P3。"}
        </div>
      </div>
    </div>
  )
}
