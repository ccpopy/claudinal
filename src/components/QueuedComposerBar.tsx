import {
  Clock3,
  CornerDownRight,
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
    <div className="mx-auto max-w-3xl empty:hidden xl:max-w-4xl 2xl:max-w-5xl">
      <div className="flex flex-col gap-1.5">
        {items.map((item, index) => (
          <QueuedRow
            key={item.localId}
            item={item}
            index={index}
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
  index,
  onPromoteGuide,
  onRecall,
  onDelete
}: {
  item: QueuedComposerBarItem
  index: number
  onPromoteGuide: (localId: string) => void | Promise<void>
  onRecall: (localId: string) => void
  onDelete: (localId: string) => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border bg-card/95 px-2.5 py-1.5 shadow-xs backdrop-blur-sm">
      {/* 序号即发送顺序；不用 drag handle（不支持拖拽，避免误导）。 */}
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-md bg-muted text-[10px] font-medium tabular-nums text-muted-foreground"
      >
        {index + 1}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <Clock3 className="size-3" />
        排队
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">
        {item.preview || "(无文本内容)"}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 rounded-md px-2 text-xs"
          title="当前工具完成后立即送达，并中断后续未执行工具"
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
            <DropdownMenuItem onSelect={() => onRecall(item.localId)}>
              <Pencil className="size-3.5" />
              编辑消息
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDelete(item.localId)}>
              <Trash2 className="size-3.5" />
              关闭排队
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
