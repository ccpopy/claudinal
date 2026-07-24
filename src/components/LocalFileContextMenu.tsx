import { useCallback, useEffect, useState, type ReactElement } from "react"
import {
  AppWindow,
  ClipboardCopy,
  Code2,
  FileText,
  FolderSearch,
  GitBranch,
  MousePointerClick,
  Sparkles,
  SquareTerminal,
  type LucideIcon
} from "lucide-react"
import { toast } from "sonner"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import {
  listAvailablePathOpenTargets,
  openPath,
  openPathWith,
  readTextFile,
  revealPath,
  type PathOpenTarget
} from "@/lib/ipc"
import { resolveOpenablePath } from "@/lib/localPath"

interface Props {
  path: string
  cwd?: string | null
  children: ReactElement
}

interface OpenWithOption {
  label: string
  actionLabel: string
  icon: LucideIcon
}

const OPEN_WITH_OPTIONS: Record<PathOpenTarget, OpenWithOption> = {
  vscode: {
    label: "VS Code",
    actionLabel: "使用 VS Code 打开",
    icon: Code2
  },
  visual_studio: {
    label: "Visual Studio",
    actionLabel: "使用 Visual Studio 打开",
    icon: AppWindow
  },
  antigravity: {
    label: "Antigravity",
    actionLabel: "使用 Antigravity 打开",
    icon: Sparkles
  },
  github_desktop: {
    label: "GitHub Desktop",
    actionLabel: "使用 GitHub Desktop 打开",
    icon: GitBranch
  },
  default_app: {
    label: "Default app",
    actionLabel: "使用默认应用打开",
    icon: MousePointerClick
  },
  file_explorer: {
    label: "File Explorer",
    actionLabel: "使用文件管理器打开",
    icon: FolderSearch
  },
  terminal: {
    label: "终端（所在目录）",
    actionLabel: "打开终端",
    icon: SquareTerminal
  },
  git_bash: {
    label: "Git Bash",
    actionLabel: "使用 Git Bash 打开",
    icon: GitBranch
  },
  wsl: {
    label: "WSL",
    actionLabel: "使用 WSL 打开",
    icon: SquareTerminal
  }
}

const OPEN_TARGET_CACHE_MS = 30_000
let openTargetCache: { targets: PathOpenTarget[]; loadedAt: number } | null = null
let openTargetRequest: Promise<PathOpenTarget[]> | null = null

function loadAvailableOpenTargets(): Promise<PathOpenTarget[]> {
  if (
    openTargetCache &&
    Date.now() - openTargetCache.loadedAt < OPEN_TARGET_CACHE_MS
  ) {
    return Promise.resolve(openTargetCache.targets)
  }
  if (openTargetRequest) return openTargetRequest

  openTargetRequest = listAvailablePathOpenTargets()
    .catch(() => [])
    .then((targets) => {
      openTargetCache = { targets, loadedAt: Date.now() }
      return targets
    })
    .finally(() => {
      openTargetRequest = null
    })
  return openTargetRequest
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`已复制${label}`)
  } catch (error) {
    toast.error(`复制${label}失败：${String(error)}`)
  }
}

async function runOpenAction(label: string, action: () => Promise<unknown>) {
  try {
    await action()
  } catch (error) {
    toast.error(`${label}失败：${String(error)}`)
  }
}

export function LocalFileContextMenu({ path, cwd, children }: Props) {
  const target = resolveOpenablePath(path, cwd)
  const [availableOpeners, setAvailableOpeners] = useState<PathOpenTarget[]>(
    () => openTargetCache?.targets ?? []
  )
  const refreshAvailableOpeners = useCallback(() => {
    void loadAvailableOpenTargets().then(setAvailableOpeners)
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadAvailableOpenTargets().then((targets) => {
      if (!cancelled) setAvailableOpeners(targets)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!target) return children

  const openWith = (opener: PathOpenTarget, label: string) =>
    runOpenAction(label, () => openPathWith(target, opener))
  const canOpenDefault = availableOpeners.includes("default_app")
  const canReveal = availableOpeners.includes("file_explorer")
  const openWithOptions = availableOpeners.flatMap((opener) => {
    const option = OPEN_WITH_OPTIONS[opener]
    return option ? [{ opener, ...option }] : []
  })
  const hasOpenActions = canOpenDefault || canReveal || openWithOptions.length > 0

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) refreshAvailableOpeners()
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[220px]">
        {canOpenDefault && (
          <ContextMenuItem
            onSelect={() =>
              void runOpenAction("打开文件", async () => {
                const result = await openPath(target)
                if (result.action === "revealed_parent") {
                  toast.warning("文件未能直接打开，已打开所在目录")
                }
              })
            }
          >
            <MousePointerClick />
            <span>打开文件</span>
          </ContextMenuItem>
        )}
        {canReveal && (
          <ContextMenuItem
            onSelect={() =>
              void runOpenAction("在文件管理器中显示", () => revealPath(target))
            }
          >
            <FolderSearch />
            <span>在文件管理器中显示</span>
          </ContextMenuItem>
        )}
        {openWithOptions.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <AppWindow />
              <span>打开方式</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {openWithOptions.map(({ opener, label, actionLabel, icon: Icon }) => (
                <ContextMenuItem
                  key={opener}
                  onSelect={() => void openWith(opener, actionLabel)}
                >
                  <Icon />
                  <span>{label}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {hasOpenActions && <ContextMenuSeparator />}
        <ContextMenuItem onSelect={() => void copyText(target, "文件路径")}>
          <ClipboardCopy />
          <span>复制路径</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void runOpenAction("复制文件内容", async () => {
              const content = await readTextFile(target)
              await copyText(content, "文件内容")
            })
          }
        >
          <FileText />
          <span>复制文件内容</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
