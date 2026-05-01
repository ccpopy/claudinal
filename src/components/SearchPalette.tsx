import { useEffect, useMemo, useRef, useState } from "react"
import {
  FolderOpen,
  MessageSquare,
  MessageSquarePlus,
  Puzzle,
  Search,
  Settings
} from "lucide-react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { listRecentSessionsAll, type SessionMeta } from "@/lib/ipc"
import type { Project } from "@/lib/projects"
import { sessionDisplayTitle } from "@/lib/sessionDisplayTitle"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"

type IndexedSession = {
  project: Project
  session: SessionMeta
  title: string
  haystack: string
  /** 用于显示的项目标签（注册项目则用 name，否则用 cwd 的最后一级） */
  projectLabel: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  onSelectSession: (project: Project, session: SessionMeta) => void
  onSelectProject: (project: Project) => void
  onNewConversation: () => void
  onAddProject: () => void
  onOpenSettings: () => void
  onOpenPlugins: () => void
}

const RECENT_LIMIT = 9
const SHORTCUTS_PER_LIST = 9
const GLOBAL_POOL_SIZE = 200

type CommandAction = {
  id: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  keywords: string
  shortcutHint?: string
  onRun: () => void
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function normalizeCwd(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "")
}

export function SearchPalette({
  open,
  onOpenChange,
  projects,
  onSelectSession,
  onSelectProject,
  onNewConversation,
  onAddProject,
  onOpenSettings,
  onOpenPlugins
}: Props) {
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState<IndexedSession[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  useEffect(() => {
    if (!open) {
      setQuery("")
      return
    }
    const handle = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(handle)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    const projByCwd = new Map<string, Project>()
    for (const p of projectsRef.current) {
      projByCwd.set(normalizeCwd(p.cwd), p)
    }
    listRecentSessionsAll(GLOBAL_POOL_SIZE)
      .then((items) => {
        if (cancelled) return
        const built: IndexedSession[] = []
        for (const item of items) {
          const cwd = item.cwd ? normalizeCwd(item.cwd) : null
          let project: Project | null = null
          let projectLabel = item.dirLabel
          if (cwd) {
            const registered = projByCwd.get(cwd)
            if (registered) {
              project = registered
              projectLabel = registered.name
            } else {
              project = {
                id: `global::${cwd}`,
                cwd,
                name: basename(cwd) || cwd,
                lastUsedAt: 0
              }
              projectLabel = project.name
            }
          }
          if (!project) continue
          const session: SessionMeta = {
            id: item.id,
            file_path: item.file_path,
            modified_ts: item.modified_ts,
            size_bytes: item.size_bytes,
            msg_count: item.msg_count,
            ai_title: item.ai_title,
            first_user_text: item.first_user_text
          }
          const title = sessionDisplayTitle(session)
          const haystack = [
            title,
            session.first_user_text ?? "",
            project.name,
            project.cwd
          ]
            .join("\n")
            .toLowerCase()
          built.push({ project, session, title, haystack, projectLabel })
        }
        built.sort((a, b) => b.session.modified_ts - a.session.modified_ts)
        setIndex(built)
      })
      .catch(() => {
        if (cancelled) return
        // 全局 IPC 失败 → 退化到只索引已注册项目（不发起新调用，保持 index 不变）
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const trimmedQuery = query.trim()
  const lowerQuery = trimmedQuery.toLowerCase()

  const sessionMatches = useMemo(() => {
    if (!trimmedQuery) return index.slice(0, RECENT_LIMIT)
    return index
      .filter((entry) => entry.haystack.includes(lowerQuery))
      .slice(0, SHORTCUTS_PER_LIST)
  }, [index, trimmedQuery, lowerQuery])

  const projectMatches = useMemo(() => {
    if (!trimmedQuery) return []
    return projects
      .filter(
        (p) =>
          p.name.toLowerCase().includes(lowerQuery) ||
          p.cwd.toLowerCase().includes(lowerQuery)
      )
      .slice(0, 6)
  }, [projects, trimmedQuery, lowerQuery])

  const actions = useMemo<CommandAction[]>(
    () => [
      {
        id: "new-conversation",
        icon: MessageSquarePlus,
        label: "新对话",
        keywords: "新对话 new chat conversation",
        shortcutHint: "Ctrl N",
        onRun: () => {
          onOpenChange(false)
          onNewConversation()
        }
      },
      {
        id: "add-project",
        icon: FolderOpen,
        label: "添加项目",
        keywords: "添加项目 open project add",
        shortcutHint: "Ctrl O",
        onRun: () => {
          onOpenChange(false)
          onAddProject()
        }
      },
      {
        id: "open-plugins",
        icon: Puzzle,
        label: "插件",
        keywords: "插件 plugins extensions",
        onRun: () => {
          onOpenChange(false)
          onOpenPlugins()
        }
      },
      {
        id: "open-settings",
        icon: Settings,
        label: "设置",
        keywords: "设置 settings preferences",
        onRun: () => {
          onOpenChange(false)
          onOpenSettings()
        }
      }
    ],
    [onAddProject, onNewConversation, onOpenPlugins, onOpenSettings, onOpenChange]
  )

  const actionMatches = useMemo(() => {
    if (!trimmedQuery) return []
    return actions.filter((action) =>
      action.keywords.toLowerCase().includes(lowerQuery)
    )
  }, [actions, trimmedQuery, lowerQuery])

  const handleRunSession = (entry: IndexedSession) => {
    onOpenChange(false)
    onSelectSession(entry.project, entry.session)
  }

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      const num = Number(event.key)
      if (Number.isInteger(num) && num >= 1 && num <= 9) {
        const target = sessionMatches[num - 1]
        if (target) {
          event.preventDefault()
          handleRunSession(target)
        }
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionMatches])

  const showEmpty =
    !loading &&
    sessionMatches.length === 0 &&
    projectMatches.length === 0 &&
    actionMatches.length === 0

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[15%] z-50 w-[min(92vw,560px)] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">搜索</DialogPrimitive.Title>
          <div className="flex items-center gap-2 px-3 py-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索对话"
              className="h-7 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>
          <div className="max-h-[60vh] overflow-y-auto border-t border-border bg-popover px-1.5 py-2">
            {loading && index.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                正在索引会话…
              </div>
            ) : showEmpty ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                没有匹配项
              </div>
            ) : (
              <>
                <PaletteSection title={trimmedQuery ? "命中" : "近期对话"}>
                  {sessionMatches.length === 0 ? (
                    <PaletteEmpty text="无对话匹配" />
                  ) : (
                    sessionMatches.map((entry, idx) => (
                      <PaletteRow
                        key={`${entry.project.id}-${entry.session.id}`}
                        icon={MessageSquare}
                        label={entry.title}
                        meta={entry.projectLabel}
                        metaTitle={entry.project.cwd}
                        shortcut={
                          idx < SHORTCUTS_PER_LIST ? `Ctrl+${idx + 1}` : undefined
                        }
                        onSelect={() => handleRunSession(entry)}
                        highlight={lowerQuery}
                      />
                    ))
                  )}
                </PaletteSection>

                {projectMatches.length > 0 && (
                  <PaletteSection title="文件目录">
                    {projectMatches.map((p) => (
                      <PaletteRow
                        key={`proj-${p.id}`}
                        icon={FolderOpen}
                        label={p.name}
                        meta={p.cwd}
                        metaTitle={p.cwd}
                        onSelect={() => {
                          onOpenChange(false)
                          onSelectProject(p)
                        }}
                        highlight={lowerQuery}
                      />
                    ))}
                  </PaletteSection>
                )}

                {actionMatches.length > 0 && (
                  <PaletteSection title="快捷键">
                    {actionMatches.map((action) => (
                      <PaletteRow
                        key={action.id}
                        icon={action.icon}
                        label={action.label}
                        shortcut={action.shortcutHint}
                        onSelect={action.onRun}
                        highlight={lowerQuery}
                      />
                    ))}
                  </PaletteSection>
                )}
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function PaletteSection({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  )
}

function PaletteEmpty({ text }: { text: string }) {
  return (
    <div className="px-3 py-3 text-center text-xs text-muted-foreground">
      {text}
    </div>
  )
}

function PaletteRow({
  icon: Icon,
  label,
  meta,
  metaTitle,
  shortcut,
  onSelect,
  highlight
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  meta?: string
  metaTitle?: string
  shortcut?: string
  onSelect: () => void
  highlight?: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={[label, metaTitle].filter(Boolean).join("\n")}
      className={cn(
        "group flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm text-foreground/90 outline-none transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">
        <Highlighted text={label} query={highlight ?? ""} />
      </span>
      {meta && (
        <span className="hidden min-w-0 max-w-[35%] shrink truncate text-xs text-muted-foreground sm:inline">
          {meta}
        </span>
      )}
      {shortcut && (
        <KbdGroup className="ml-1 shrink-0">
          {shortcut.split(/\s+|\+/).map((part, i) => (
            <Kbd key={`${part}-${i}`}>{part}</Kbd>
          ))}
        </KbdGroup>
      )}
    </button>
  )
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const lower = text.toLowerCase()
  const idx = lower.indexOf(query)
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-primary/20 text-foreground rounded-sm px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}
