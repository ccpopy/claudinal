import {
  Clock3,
  CornerDownRight,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

export interface QueuedComposerBarItem {
  localId: string
  mode: "guide" | "followup"
  preview: string
}

interface QueuedComposerBarProps {
  items: QueuedComposerBarItem[]
  onPromoteGuide: (localId: string) => void | Promise<void>
  onRecall: (localId: string) => void
  onDelete: (localId: string) => void
}

export function QueuedComposerBar({
  items,
  onPromoteGuide,
  onRecall,
  onDelete
}: QueuedComposerBarProps) {
  if (items.length === 0) return null
  return (
    <div className="mx-auto max-w-3xl px-6 pt-2 empty:hidden">
      <div className="flex flex-col gap-1.5">
        {items.map((item) => (
          <QueuedRow
            key={item.localId}
            item={item}
            onPromoteGuide={onPromoteGuide}
            onRecall={onRecall}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  )
}

function QueuedRow({
  item,
  onPromoteGuide,
  onRecall,
  onDelete
}: {
  item: QueuedComposerBarItem
  onPromoteGuide: (localId: string) => void | Promise<void>
  onRecall: (localId: string) => void
  onDelete: (localId: string) => void
}) {
  const isFollowup = item.mode === "followup"
  return (
    <div className="flex items-center gap-2 rounded-xl border bg-card/95 px-2.5 py-1.5 shadow-xs backdrop-blur-sm">
      <GripVertical
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/60"
      />
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        {isFollowup ? (
          <Clock3 className="size-3" />
        ) : (
          <CornerDownRight className="size-3" />
        )}
        {isFollowup ? "跟进" : "引导 · 已送达"}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">
        {item.preview}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        {isFollowup && (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1 rounded-md px-2 text-xs"
              onClick={() => onPromoteGuide(item.localId)}
            >
              <CornerDownRight className="size-3.5" />
              引导
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 rounded-md"
              title="关闭排队"
              aria-label="关闭排队"
              onClick={() => onDelete(item.localId)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 rounded-md"
              aria-label="更多操作"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="min-w-[10rem]">
            {isFollowup ? (
              <>
                <DropdownMenuItem onSelect={() => onRecall(item.localId)}>
                  <Pencil className="size-3.5" />
                  编辑消息
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onDelete(item.localId)}>
                  <Trash2 className="size-3.5" />
                  关闭排队
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onSelect={() => onRecall(item.localId)}>
                <Pencil className="size-3.5" />
                复制文本到编辑器
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
