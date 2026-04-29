import { useEffect, useState, useCallback } from "react"
import {
  ChevronRight,
  Copy,
  FolderOpen,
  FolderPlus,
  Loader2,
  MessageSquarePlus,
  Pin,
  PinOff,
  Search,
  Settings,
  Trash2
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  listenSessionsChanged,
  listProjectSessions,
  openPath,
  unwatchSessions,
  watchSessions,
  type SessionMeta
} from "@/lib/ipc"
import type { Project } from "@/lib/projects"
import { listPinned, togglePin, type PinnedRef } from "@/lib/pinned"
import { getSessionTitle } from "@/lib/sessionTitles"

interface Props {
  projects: Project[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  streamingProjectId: string | null
  streamingSessionId: string | null
  onSelectProject: (p: Project) => void
  onSelectSession: (p: Project, s: SessionMeta) => void
  onAdd: () => void
  onRemove: (id: string) => void
  onNewConversation: () => void
  onOpenSettings: () => void
  refreshKey?: number
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
  streamingProjectId,
  streamingSessionId,
  onSelectProject,
  onSelectSession,
  onAdd,
  onRemove,
  onNewConversation,
  onOpenSettings,
  refreshKey = 0
}: Props) {
  const [filter, setFilter] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, SessionListState>
  >({})
  const [pinned, setPinned] = useState<PinnedRef[]>(() => listPinned())

  const refreshPinned = useCallback(() => setPinned(listPinned()), [])

  const copyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label}已复制`)
    } catch (e) {
      toast.error(`复制失败: ${String(e)}`)
    }
  }, [])

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

  // 提前加载所有项目的 sessions —— 置顶展示需要数据
  useEffect(() => {
    for (const p of projects) {
      if (!sessionsByProject[p.id]) loadSessions(p)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects])

  // notify watcher：监听 ~/.claude/projects/<cwd>/ 变化触发增量刷新
  useEffect(() => {
    const cleanups: Array<() => void> = []
    const cwds = projects.map((p) => p.cwd)
    for (const p of projects) {
      watchSessions(p.cwd).catch(() => undefined)
      listenSessionsChanged(p.cwd, () => {
        loadSessions(p)
      })
        .then((un) => cleanups.push(un))
        .catch(() => undefined)
    }
    return () => {
      cleanups.forEach((u) => u())
      for (const cwd of cwds) unwatchSessions(cwd).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects])

  // 主区触发的刷新（如发送消息后），把所有项目 sessions 重新拉一遍
  useEffect(() => {
    if (refreshKey === 0) return
    for (const p of projects) loadSessions(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // 计算置顶 + 过滤后的项目列表（项目里非置顶 session 数 > 0 才显示）
  const pinnedSet = new Set(
    pinned.map((p) => `${p.projectId}::${p.sessionId}`)
  )
  const pinnedItems = pinned
    .map((pr) => {
      const proj = projects.find((p) => p.id === pr.projectId)
      if (!proj) return null
      const stateP = sessionsByProject[proj.id]
      const sess =
        stateP?.kind === "ok"
          ? stateP.items.find((s) => s.id === pr.sessionId)
          : undefined
      if (!sess) return null
      return { project: proj, session: sess }
    })
    .filter((x): x is { project: Project; session: SessionMeta } => !!x)

  const togglePinAndRefresh = useCallback(
    (projectId: string, sessionId: string) => {
      const nowPinned = togglePin(projectId, sessionId)
      refreshPinned()
      toast.success(nowPinned ? "已置顶" : "已取消置顶")
    },
    [refreshPinned]
  )

  return (
    <aside className="w-64 shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground flex flex-col">
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

      <ScrollArea className="flex-1 min-h-0 min-w-0 mt-2">
        <div className="px-2 pb-3 flex flex-col gap-3 min-w-0 max-w-full overflow-hidden">
          {pinnedItems.length > 0 && (
            <div className="flex flex-col">
              <div className="px-1 pb-1 text-xs uppercase tracking-wider text-sidebar-muted">
                置顶
              </div>
              <div className="flex flex-col gap-0.5">
                {pinnedItems.map(({ project, session }) => (
                  <SessionRow
                    key={`pin-${project.id}-${session.id}`}
                    project={project}
                    session={session}
                    pinned
                    active={
                      selectedProjectId === project.id &&
                      selectedSessionId === session.id
                    }
                    streaming={
                      streamingProjectId === project.id &&
                      streamingSessionId === session.id
                    }
                    indented={false}
                    onSelect={() => onSelectSession(project, session)}
                    onCopyId={() => copyText(session.id, "会话 ID")}
                    onTogglePin={() =>
                      togglePinAndRefresh(project.id, session.id)
                    }
                  />
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col">
            <div className="flex items-center justify-between px-1 pb-1">
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
            <div className="flex flex-col gap-0.5">
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
                  const visibleSessions =
                    sessionsState?.kind === "ok"
                      ? sessionsState.items.filter(
                          (s) => !pinnedSet.has(`${p.id}::${s.id}`)
                        )
                      : []
                  // 当一个项目的会话全部被置顶后，从「项目」列表里隐藏
                  if (
                    sessionsState?.kind === "ok" &&
                    sessionsState.items.length > 0 &&
                    visibleSessions.length === 0
                  ) {
                    return null
                  }
                  return (
                    <div key={p.id} className="flex flex-col min-w-0">
                      <div
                        className={cn(
                          "group flex items-center gap-1 pl-1 pr-1 py-1.5 rounded-md text-sm transition-colors min-w-0",
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
                        <FolderOpen className="size-3.5 shrink-0 text-sidebar-muted" />
                        <button
                          type="button"
                          onClick={() => onSelectProject(p)}
                          className="truncate flex-1 min-w-0 text-left cursor-pointer"
                        >
                          {p.name}
                        </button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                openPath(p.cwd).catch((err) =>
                                  toast.error(`打开失败: ${String(err)}`)
                                )
                              }}
                              className="size-5 inline-flex items-center justify-center rounded text-sidebar-muted opacity-0 group-hover:opacity-100 hover:text-sidebar-foreground transition-opacity"
                              aria-label="在资源管理器中打开"
                            >
                              <FolderOpen className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right">在资源管理器中打开</TooltipContent>
                        </Tooltip>
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
                              className="size-5 inline-flex items-center justify-center rounded opacity-0 group-hover:opacity-100 text-destructive hover:bg-destructive/10 transition-opacity"
                              aria-label="移除项目"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right">从列表移除</TooltipContent>
                        </Tooltip>
                      </div>

                      {isExpanded && (
                        <div className="mt-0.5 flex flex-col gap-0.5 min-w-0 max-w-full overflow-hidden">
                          {!sessionsState ||
                          sessionsState.kind === "idle" ||
                          sessionsState.kind === "loading" ? (
                            <div className="px-2 py-1 text-xs text-sidebar-muted">
                              加载中…
                            </div>
                          ) : sessionsState.kind === "error" ? (
                            <div className="px-2 py-1 text-xs text-destructive break-all">
                              {sessionsState.message}
                            </div>
                          ) : visibleSessions.length === 0 ? (
                            <div className="px-2 py-1 text-xs text-sidebar-muted">
                              暂无历史会话
                            </div>
                          ) : (
                            visibleSessions.map((s) => (
                              <SessionRow
                                key={s.id}
                                project={p}
                                session={s}
                                pinned={false}
                                active={
                                  selectedProjectId === p.id &&
                                  selectedSessionId === s.id
                                }
                                streaming={
                                  streamingProjectId === p.id &&
                                  streamingSessionId === s.id
                                }
                                indented
                                onSelect={() => onSelectSession(p, s)}
                                onCopyId={() => copyText(s.id, "会话 ID")}
                                onTogglePin={() =>
                                  togglePinAndRefresh(p.id, s.id)
                                }
                              />
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
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

function SessionRow({
  project,
  session,
  pinned,
  active,
  streaming,
  indented,
  onSelect,
  onCopyId,
  onTogglePin
}: {
  project: Project
  session: SessionMeta
  pinned: boolean
  active: boolean
  streaming: boolean
  indented: boolean
  onSelect: () => void
  onCopyId: () => void
  onTogglePin: () => void
}) {
  const title =
    getSessionTitle(session.id) ||
    session.ai_title ||
    session.first_user_text ||
    session.id.slice(0, 8)
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group/session relative flex items-center gap-1.5 py-1 rounded-md text-xs cursor-pointer transition-colors min-w-0 max-w-full overflow-hidden",
        indented ? "pl-6 pr-1" : "pl-2 pr-1",
        active
          ? "bg-primary/15 text-primary"
          : "hover:bg-sidebar-accent/60 text-sidebar-foreground/90"
      )}
      title={`${title}\n${project.name} · ${session.id}`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin()
            }}
            className={cn(
              "size-5 inline-flex items-center justify-center rounded text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground shrink-0",
              pinned ? "opacity-100" : "opacity-0 group-hover/session:opacity-100"
            )}
            aria-label={pinned ? "取消置顶" : "置顶会话"}
          >
            {pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {pinned ? "取消置顶" : "置顶会话"}
        </TooltipContent>
      </Tooltip>
      <div className="flex-1 min-w-0 max-w-full overflow-hidden flex flex-col gap-1">
        <div className="max-w-full truncate leading-tight">{title}</div>
        <div className="flex items-center justify-between gap-2 text-[10px] text-sidebar-muted opacity-80">
          <span className="truncate">{session.msg_count} msg</span>
          <span className="shrink-0">{fmtRelative(session.modified_ts)}</span>
        </div>
      </div>
      <div className="relative size-5 shrink-0">
        {streaming && (
          <span
            aria-label="运行中"
            className="absolute inset-0 inline-flex items-center justify-center text-sidebar-muted group-hover/session:opacity-0 transition-opacity"
          >
            <Loader2 className="size-3 animate-spin" />
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="absolute inset-0 inline-flex items-center justify-center rounded text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground opacity-0 group-hover/session:opacity-100"
              aria-label="复制会话 ID"
              onClick={(e) => {
                e.stopPropagation()
                onCopyId()
              }}
            >
              <Copy className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">复制会话 ID</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
