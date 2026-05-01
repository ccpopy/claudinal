import {
  Archive,
  ArchiveRestore,
  Copy,
  FileText,
  FolderOpen,
  GitCompareArrows,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { openPath } from "@/lib/ipc"
import { isPinned, togglePin } from "@/lib/pinned"
import type { Project } from "@/lib/projects"

interface Props {
  project: Project
  resumeSessionId: string | null
  jsonlSessionId: string | null
  title: string
  archived?: boolean
  onPinChange?: () => void
  onRename?: () => void
  onArchive?: () => void
  onDelete?: () => void
  onShowDiff?: () => void
  diffCount?: number
}

export function ChatHeader({
  project,
  resumeSessionId,
  jsonlSessionId,
  title,
  archived = false,
  onPinChange,
  onRename,
  onArchive,
  onDelete,
  onShowDiff,
  diffCount = 0
}: Props) {
  const pinTarget = resumeSessionId ?? jsonlSessionId
  const pinned = pinTarget ? isPinned(project.id, pinTarget) : false

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label}已复制`)
    } catch (e) {
      toast.error(`复制失败: ${String(e)}`)
    }
  }

  const handleOpen = () =>
    openPath(project.cwd).catch((e) => toast.error(`打开失败: ${String(e)}`))

  const handleTogglePin = () => {
    if (!pinTarget) {
      toast.error("当前还没有 session id，等首次对话或恢复后再置顶")
      return
    }
    togglePin(project.id, pinTarget)
    onPinChange?.()
  }

  const resumeCmd = pinTarget
    ? `claude --resume ${pinTarget}`
    : null

  return (
    <header className="px-3 py-2 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="text-sm font-medium truncate min-w-0 max-w-[28ch]"
          title={title}
        >
          {title}
        </span>
        {archived && (
          <span
            title="此会话已归档；可在侧边栏「设置 - 已归档对话」中恢复"
            className="shrink-0 rounded border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
          >
            已归档
          </span>
        )}
        <span className="text-xs text-muted-foreground/70 shrink-0">·</span>
        <span
          className="text-xs text-muted-foreground truncate min-w-0 max-w-[16ch] font-mono"
          title={project.cwd}
        >
          {project.name}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="更多操作"
              title="更多"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            <DropdownMenuItem onSelect={handleTogglePin}>
              {pinned ? <PinOff /> : <Pin />}
              <span>{pinned ? "取消置顶" : "置顶会话"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onRename?.()}
              disabled={!onRename}
            >
              <Pencil />
              <span>重命名会话</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleOpen}>
              <FolderOpen />
              <span>打开项目目录</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                pinTarget
                  ? copy(pinTarget, "会话 ID")
                  : toast.error("当前没有 session id")
              }
            >
              <Copy />
              <span>复制会话 ID</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                resumeCmd
                  ? copy(resumeCmd, "继续会话命令")
                  : toast.error("当前没有 session id")
              }
            >
              <FileText />
              <span>复制 resume 命令</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onArchive?.()}
              disabled={!onArchive}
            >
              {archived ? <ArchiveRestore /> : <Archive />}
              <span>{archived ? "取消归档" : "归档会话"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onDelete?.()}
              disabled={!onDelete}
              className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
            >
              <Trash2 />
              <span>删除会话</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground relative"
                aria-label="文件 diff"
                onClick={() => onShowDiff?.()}
                disabled={!onShowDiff || diffCount === 0}
              >
                <GitCompareArrows className="size-4" />
                {diffCount > 0 && (
                  <span className="absolute -top-1 -right-1 size-4 rounded-full bg-primary text-primary-foreground text-[9px] font-medium inline-flex items-center justify-center">
                    {diffCount > 9 ? "9+" : diffCount}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {diffCount > 0 ? `文件 diff（${diffCount}）` : "暂无文件变更"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  )
}
