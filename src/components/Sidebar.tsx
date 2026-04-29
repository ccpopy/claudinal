import { useEffect, useState, useCallback } from "react"
import {
  ChevronRight,
  Folder,
  FolderPlus,
  MessageSquare,
  MessageSquarePlus,
  Search,
  Settings,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { listProjectSessions, type SessionMeta } from "@/lib/ipc"
import type { Project } from "@/lib/projects"

interface Props {
  projects: Project[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  onSelectProject: (p: Project) => void
  onSelectSession: (p: Project, s: SessionMeta) => void
  onAdd: () => void
  onRemove: (id: string) => void
  onNewConversation: () => void
  onOpenSettings: () => void
}

type SessionListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; items: SessionMeta[] }
  | { kind: "error"; message: string }

function fmtRelative(ts: number): string {
  if (!ts) return ""
  const now = Math.floor(Date.now() / 1000)
  const diff = now - ts
  if (diff < 60) return "刚刚"
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  return new Date(ts * 1000).toLocaleDateString()
}

export function Sidebar({
  projects,
  selectedProjectId,
  selectedSessionId,
  onSelectProject,
  onSelectSession,
  onAdd,
  onRemove,
  onNewConversation,
  onOpenSettings
}: Props) {
  const [filter, setFilter] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, SessionListState>
  >({})

  const filtered = filter
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(filter.toLowerCase()) ||
          p.cwd.toLowerCase().includes(filter.toLowerCase())
      )
    : projects

  const loadSessions = useCallback(async (p: Project) => {
    setSessionsByProject((cur) => ({ ...cur, [p.id]: { kind: "loading" } }))
    try {
      const items = await listProjectSessions(p.cwd)
      setSessionsByProject((cur) => ({
        ...cur,
        [p.id]: { kind: "ok", items }
      }))
    } catch (e) {
      setSessionsByProject((cur) => ({
        ...cur,
        [p.id]: { kind: "error", message: String(e) }
      }))
    }
  }, [])

  const toggleExpand = useCallback(
    (p: Project) => {
      setExpanded((cur) => {
        const next = new Set(cur)
        if (next.has(p.id)) {
          next.delete(p.id)
        } else {
          next.add(p.id)
        }
        return next
      })
      const state = sessionsByProject[p.id]
      if (!state || state.kind === "idle") {
        loadSessions(p)
      }
    },
    [sessionsByProject, loadSessions]
  )

  // 选中项目时自动展开 + 加载
  useEffect(() => {
    if (!selectedProjectId) return
    setExpanded((cur) => {
      if (cur.has(selectedProjectId)) return cur
      const next = new Set(cur)
      next.add(selectedProjectId)
      return next
    })
    const proj = projects.find((p) => p.id === selectedProjectId)
    if (proj && !sessionsByProject[proj.id]) {
      loadSessions(proj)
    }
  }, [selectedProjectId, projects, sessionsByProject, loadSessions])

  return (
    <aside className="w-64 shrink-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col">
      <div className="px-3 pt-3 flex flex-col gap-2">
        <Button
          variant="ghost"
          className="justify-start gap-2 h-8 px-2 hover:bg-sidebar-accent"
          onClick={onNewConversation}
        >
          <MessageSquarePlus />
          新对话
        </Button>
        <div className="relative">
          <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-sidebar-muted pointer-events-none" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索"
            className="w-full h-8 pl-8 pr-2 rounded-md text-sm bg-transparent border border-transparent hover:border-sidebar-border focus:border-sidebar-border focus:bg-card outline-none transition-colors"
          />
        </div>
      </div>

      <Separator className="bg-sidebar-border my-2" />

      <div className="flex items-center justify-between px-3 pb-1">
        <span className="text-xs uppercase tracking-wider text-sidebar-muted">
          项目
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 hover:bg-sidebar-accent"
              onClick={onAdd}
            >
              <FolderPlus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">添加项目 (Ctrl+O)</TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-2 pb-3 flex flex-col gap-0.5">
          {filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-sidebar-muted">
              {projects.length === 0 ? "暂无项目，点击 + 添加" : "无匹配"}
            </div>
          ) : (
            filtered.map((p) => {
              const isExpanded = expanded.has(p.id)
              const isProjectSelected =
                selectedProjectId === p.id && !selectedSessionId
              const sessionsState = sessionsByProject[p.id]
              return (
                <div key={p.id} className="flex flex-col">
                  <div
                    className={cn(
                      "group flex items-center gap-1 pl-1 pr-2 py-1.5 rounded-md text-sm transition-colors",
                      isProjectSelected
                        ? "bg-sidebar-accent text-sidebar-foreground"
                        : "hover:bg-sidebar-accent/60"
                    )}
                    title={p.cwd}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleExpand(p)
                      }}
                      className="size-5 inline-flex items-center justify-center text-sidebar-muted hover:text-sidebar-foreground"
                      aria-label={isExpanded ? "折叠" : "展开"}
                    >
                      <ChevronRight
                        className={cn(
                          "size-3 transition-transform",
                          isExpanded && "rotate-90"
                        )}
                      />
                    </button>
                    <Folder className="size-3.5 shrink-0 text-sidebar-muted" />
                    <button
                      type="button"
                      onClick={() => onSelectProject(p)}
                      className="truncate flex-1 text-left cursor-pointer"
                    >
                      {p.name}
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (
                              window.confirm(
                                `从列表移除「${p.name}」？（不会删除磁盘文件与历史会话）`
                              )
                            )
                              onRemove(p.id)
                          }}
                          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">从列表移除</TooltipContent>
                    </Tooltip>
                  </div>

                  {isExpanded && (
                    <div className="ml-6 mt-0.5 flex flex-col gap-0.5">
                      {!sessionsState || sessionsState.kind === "idle" ? null : sessionsState.kind === "loading" ? (
                        <div className="px-2 py-1 text-xs text-sidebar-muted">
                          加载中…
                        </div>
                      ) : sessionsState.kind === "error" ? (
                        <div className="px-2 py-1 text-xs text-destructive break-all">
                          {sessionsState.message}
                        </div>
                      ) : sessionsState.items.length === 0 ? (
                        <div className="px-2 py-1 text-xs text-sidebar-muted">
                          暂无历史会话
                        </div>
                      ) : (
                        sessionsState.items.map((s) => {
                          const active =
                            selectedProjectId === p.id &&
                            selectedSessionId === s.id
                          const title =
                            s.ai_title ||
                            s.first_user_text ||
                            s.id.slice(0, 8)
                          return (
                            <div
                              key={s.id}
                              onClick={() => onSelectSession(p, s)}
                              className={cn(
                                "group/session flex items-start gap-1.5 px-2 py-1 rounded text-xs cursor-pointer transition-colors",
                                active
                                  ? "bg-primary/15 text-primary"
                                  : "hover:bg-sidebar-accent/60 text-sidebar-foreground/80"
                              )}
                              title={`${title}\n${s.id}`}
                            >
                              <MessageSquare className="size-3 mt-0.5 shrink-0 opacity-70" />
                              <div className="flex-1 min-w-0">
                                <div className="truncate">{title}</div>
                                <div className="text-[10px] text-sidebar-muted opacity-80">
                                  {s.msg_count} msg · {fmtRelative(s.modified_ts)}
                                </div>
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </ScrollArea>

      <Separator className="bg-sidebar-border" />
      <div className="p-2">
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 h-8 px-2 hover:bg-sidebar-accent"
          onClick={onOpenSettings}
        >
          <Settings />
          设置
        </Button>
      </div>
    </aside>
  )
}
