import {
  ArrowLeft,
  ArrowRight,
  FolderPlus,
  Maximize2,
  MessageSquarePlus,
  Minus,
  PanelLeft,
  Settings,
  X
} from "lucide-react"
import type * as React from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { toast } from "sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import claudinalIconUrl from "@/assets/claudinal-icon.png"

interface Props {
  sidebarVisible: boolean
  inSettings?: boolean
  onToggleSidebar: () => void
  onBack?: () => void
  onNewConversation: () => void
  onAddProject: () => void
  onOpenSettings: () => void
}

const MENU_GROUPS = [
  { label: "文件", key: "file" },
  { label: "编辑", key: "edit" },
  { label: "查看", key: "view" },
  { label: "窗口", key: "window" },
  { label: "帮助", key: "help" }
] as const

export function AppChrome({
  sidebarVisible,
  inSettings = false,
  onToggleSidebar,
  onBack,
  onNewConversation,
  onAddProject,
  onOpenSettings
}: Props) {
  const win = getCurrentWindow()
  const minimize = () => win.minimize().catch((e) => toast.error(String(e)))
  const toggleMaximize = () =>
    win.toggleMaximize().catch((e) => toast.error(String(e)))
  const close = () => win.close().catch((e) => toast.error(String(e)))
  const startDragging = (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (
      target.closest(
        "button, a, input, textarea, select, [role=menu], [role=menuitem], [role=dialog], [data-radix-popper-content-wrapper]"
      )
    )
      return
    win.startDragging().catch(() => undefined)
  }

  return (
    <header
      data-tauri-drag-region
      onMouseDown={startDragging}
      className="h-9 shrink-0 select-none border-b border-border bg-background text-foreground"
    >
      <div
        data-tauri-drag-region
        className="flex h-full items-center justify-between"
      >
        <div className="flex h-full min-w-0 items-center gap-1 px-2">
          <ChromeIconButton
            active={sidebarVisible}
            aria-label={sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"}
            onClick={onToggleSidebar}
          >
            <PanelLeft className="size-4" />
          </ChromeIconButton>
          <ChromeIconButton
            aria-label={inSettings ? "返回对话" : "后退"}
            disabled={!inSettings}
            onClick={inSettings ? onBack : undefined}
          >
            <ArrowLeft className="size-4" />
          </ChromeIconButton>
          <ChromeIconButton aria-label="前进" disabled>
            <ArrowRight className="size-4" />
          </ChromeIconButton>

          <nav className="ml-3 flex h-full items-center gap-1">
            {MENU_GROUPS.map((item) => (
              <ChromeMenu
                key={item.key}
                group={item.key}
                label={item.label}
                disabled={inSettings && item.key === "file"}
                sidebarVisible={sidebarVisible}
                onToggleSidebar={onToggleSidebar}
                onNewConversation={onNewConversation}
                onAddProject={onAddProject}
                onOpenSettings={onOpenSettings}
                onMinimize={minimize}
                onToggleMaximize={toggleMaximize}
                onClose={close}
              />
            ))}
          </nav>
        </div>

        <div
          data-tauri-drag-region
          className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 text-xs font-medium text-foreground/75"
        >
          <img
            src={claudinalIconUrl}
            alt=""
            aria-hidden="true"
            className="size-4 shrink-0"
          />
          <span>Claudinal</span>
        </div>

        <div className="flex h-full items-center">
          <ChromeWindowButton aria-label="最小化" onClick={minimize}>
            <Minus className="size-4" />
          </ChromeWindowButton>
          <ChromeWindowButton aria-label="最大化" onClick={toggleMaximize}>
            <Maximize2 className="size-3.5" />
          </ChromeWindowButton>
          <ChromeWindowButton
            aria-label="关闭"
            danger
            onClick={close}
          >
            <X className="size-4" />
          </ChromeWindowButton>
        </div>
      </div>
    </header>
  )
}

function ChromeMenu({
  group,
  label,
  disabled = false,
  sidebarVisible,
  onToggleSidebar,
  onNewConversation,
  onAddProject,
  onOpenSettings,
  onMinimize,
  onToggleMaximize,
  onClose
}: {
  group: (typeof MENU_GROUPS)[number]["key"]
  label: string
  disabled?: boolean
  sidebarVisible: boolean
  onToggleSidebar: () => void
  onNewConversation: () => void
  onAddProject: () => void
  onOpenSettings: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="h-7 rounded px-2 text-sm text-foreground/75 outline-none transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35 data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[190px]">
        {group === "file" && (
          <>
            <DropdownMenuItem onSelect={onNewConversation}>
              <MessageSquarePlus />
              <span>新对话</span>
              <DropdownMenuShortcut>Ctrl N</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onAddProject}>
              <FolderPlus />
              <span>添加项目</span>
              <DropdownMenuShortcut>Ctrl O</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onOpenSettings()}>
              <Settings />
              <span>设置</span>
            </DropdownMenuItem>
          </>
        )}
        {group === "edit" && (
          <>
            <DropdownMenuItem disabled>撤销</DropdownMenuItem>
            <DropdownMenuItem disabled>重做</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>复制</DropdownMenuItem>
            <DropdownMenuItem disabled>粘贴</DropdownMenuItem>
          </>
        )}
        {group === "view" && (
          <>
            <DropdownMenuItem onSelect={onToggleSidebar}>
              <PanelLeft />
              <span>{sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled>重新加载</DropdownMenuItem>
          </>
        )}
        {group === "window" && (
          <>
            <DropdownMenuItem onSelect={onMinimize}>最小化</DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleMaximize}>
              最大化/还原
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClose}>关闭窗口</DropdownMenuItem>
          </>
        )}
        {group === "help" && (
          <DropdownMenuItem
            onSelect={() => toast.info("Claudinal · Claude Code 桌面外壳")}
          >
            关于 Claudinal
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChromeIconButton({
  className,
  active,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-7 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35",
        active && "bg-primary/10 text-primary",
        className
      )}
      {...props}
    />
  )
}

function ChromeWindowButton({
  className,
  danger,
  ...props
}: React.ComponentProps<"button"> & { danger?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 w-11 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground",
        danger && "hover:bg-destructive hover:text-white",
        className
      )}
      {...props}
    />
  )
}
