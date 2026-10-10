import { ChevronRight, CircleAlert, Clock, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export type BackgroundConversationStatus = "running" | "queued" | "attention"

export interface BackgroundConversationItem {
  key: string
  title: string
  /** Shown only when the conversation belongs to another project. */
  projectName?: string
  status: BackgroundConversationStatus
}

const STATUS: Record<BackgroundConversationStatus, { label: string; className: string }> = {
  running: { label: "运行中", className: "text-connected" },
  queued: { label: "排队中", className: "text-muted-foreground" },
  attention: { label: "需处理", className: "text-warn" }
}

function StatusIcon({ status }: { status: BackgroundConversationStatus }) {
  const className = cn("size-3.5 shrink-0", STATUS[status].className)
  if (status === "running") return <Loader2 aria-hidden className={cn(className, "animate-spin")} />
  if (status === "attention") return <CircleAlert aria-hidden className={className} />
  return <Clock aria-hidden className={className} />
}

/** Other conversations still working in the background; click to switch to one. */
export function BackgroundConversationsBar({ items, onOpen }: {
  items: BackgroundConversationItem[]
  onOpen: (key: string) => void
}) {
  if (items.length === 0) return null
  return (
    <nav aria-label="后台会话" className="flex items-center gap-2 border-b bg-muted/30 px-6 py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">后台会话 · {items.length}</span>
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto scrollbar-thin">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onOpen(item.key)}
            title={`${item.projectName ? `${item.projectName} · ` : ""}${item.title}（${STATUS[item.status].label}，点击切换）`}
            className="group inline-flex h-7 max-w-72 shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 text-foreground shadow-xs transition-colors hover:border-primary/40 hover:bg-accent"
          >
            <StatusIcon status={item.status} />
            {item.projectName && <span className="shrink-0 text-muted-foreground">{item.projectName} ·</span>}
            <span className="min-w-0 truncate">{item.title}</span>
            <span className={cn("shrink-0", STATUS[item.status].className)}>{STATUS[item.status].label}</span>
            <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>
    </nav>
  )
}
