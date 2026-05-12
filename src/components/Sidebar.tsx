import { lazy, Suspense, useEffect, useMemo, useState, useCallback } from "react"
import {
  ChevronRight,
  Copy,
  FolderOpen,
  FolderPlus,
  History as HistoryIcon,
  Loader2,
  MessageSquarePlus,
  Pin,
  Puzzle,
  Search,
  Settings,
  Trash2
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
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
import { isEditableShortcutTarget } from "@/lib/keyboard"
import { listPinned, togglePin, type PinnedRef } from "@/lib/pinned"
import { listArchived, type ArchivedRef } from "@/lib/archivedSessions"
import { sessionDisplayTitle } from "@/lib/sessionDisplayTitle"
import {
  formatSessionCompactTime,
  formatSessionRelativeTime
} from "@/lib/sessionTime"

const SearchPalette = lazy(() =>
  import("@/components/SearchPalette").then((m) => ({ default: m.SearchPalette }))
)

interface Props {
  projects: Project[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  streamingProjectId: string | null
  streamingSessionId: string | null
  streamingSessionRefs?: Array<{ projectId: string; sessionId: string }>
  waitingSessionRefs?: Array<{ projectId: string; sessionId: string }>
  inPlugins?: boolean
  onSelectProject: (p: Project) => void
  onSelectSession: (p: Project, s: SessionMeta) => void
  onAdd: () => void
  onRemove: (id: string) => void
  onNewConversation: () => void
  onOpenSettings: () => void
  onOpenPlugins: () => void
  onOpenHistory?: () => void
  refreshKey?: number
}

type SessionListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; items: SessionMeta[] }
  | { kind: "error"; message: string }

function samePinnedRefs(a: PinnedRef[], b: PinnedRef[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (item, index) =>
      item.projectId === b[index]?.projectId &&
      item.sessionId === b[index]?.sessionId
  )
}

function sameArchivedRefs(a: ArchivedRef[], b: ArchivedRef[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (item, index) =>
      item.projectId === b[index]?.projectId &&
      item.sessionId === b[index]?.sessionId &&
      item.archivedAt === b[index]?.archivedAt
  )
}

export function Sidebar({
  projects,
  selectedProjectId,
  selectedSessionId,
  streamingProjectId,
  streamingSessionId,
  streamingSessionRefs = [],
  waitingSessionRefs = [],
  inPlugins = false,
  onSelectProject,
  onSelectSession,
  onAdd,
  onRemove,
  onNewConversation,
  onOpenSettings,
  onOpenPlugins,
  onOpenHistory,
  refreshKey = 0
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, SessionListState>
  >({})
  const [timeTick, setTimeTick] = useState(0)
  const [pinned, setPinned] = useState<PinnedRef[]>(() => listPinned())
  const [archived, setArchived] = useState<ArchivedRef[]>(() => listArchived())
  const pinnedProjectIds = useMemo(
    () => new Set(pinned.map((p) => p.projectId)),
    [pinned]
  )
  const streamingSet = useMemo(() => {
    const set = new Set<string>()
    if (streamingProjectId && streamingSessionId) {
      set.add(`${streamingProjectId}::${streamingSessionId}`)
    }
    for (const ref of streamingSessionRefs) {
      set.add(`${ref.projectId}::${ref.sessionId}`)
    }
    return set
  }, [streamingProjectId, streamingSessionId, streamingSessionRefs])
  const waitingSet = useMemo(() => {
    const set = new Set<string>()
    for (const ref of waitingSessionRefs) {
      set.add(`${ref.projectId}::${ref.sessionId}`)
    }
    return set
  }, [waitingSessionRefs])

  const refreshPinned = useCallback(() => {
    const next = listPinned()
    setPinned((cur) => (samePinnedRefs(cur, next) ? cur : next))
  }, [])
  const refreshArchived = useCallback(() => {
    const next = listArchived()
    setArchived((cur) => (sameArchivedRefs(cur, next) ? cur : next))
  }, [])

  const copyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label}已复制`)
    } catch (e) {
      toast.error(`复制失败: ${String(e)}`)
    }
  }, [])

  const filtered = projects

  const loadSessions = useCallback(async (p: Project) => {
    setSessionsByProject((cur) => {
      const existing = cur[p.id]
      if (existing?.kind === "ok") return cur
      return { ...cur, [p.id]: { kind: "loading" } }
    })
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

  const refreshVisibleSessions = useCallback(() => {
    for (const p of projects) {
      if (
        p.id === selectedProjectId ||
        expanded.has(p.id) ||
        pinnedProjectIds.has(p.id)
      ) {
        void loadSessions(p)
      }
    }
    refreshPinned()
    refreshArchived()
  }, [
    projects,
    selectedProjectId,
    expanded,
    pinnedProjectIds,
    loadSessions,
    refreshPinned,
    refreshArchived
  ])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTimeTick((tick) => tick + 1)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onFocus = () => refreshVisibleSessions()
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshVisibleSessions()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [refreshVisibleSessions])

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
    const selected = projects.find((p) => p.id === selectedProjectId)
    if (selected && !sessionsByProject[selected.id]) {
      loadSessions(selected)
    }
    for (const p of projects) {
      if (pinnedProjectIds.has(p.id) && !sessionsByProject[p.id]) {
        loadSessions(p)
      }
    }
  }, [
    selectedProjectId,
    projects,
    sessionsByProject,
    loadSessions,
    pinnedProjectIds
  ])

  // notify watcher：只监听当前可见 / 置顶相关项目，避免启动时扫描所有项目。
  useEffect(() => {
    const cleanups: Array<() => void> = []
    const watched = projects.filter(
      (p) =>
        p.id === selectedProjectId ||
        expanded.has(p.id) ||
        pinnedProjectIds.has(p.id)
    )
    const cwds = watched.map((p) => p.cwd)
    for (const p of watched) {
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
  }, [projects, selectedProjectId, expanded, pinnedProjectIds, loadSessions])

  // 主区触发的刷新（如发送消息后），只刷新当前可见 / 置顶相关项目；
  // 同时把 pinned / archived 重新读一次，确保 ChatHeader 改动后侧栏立即同步
  useEffect(() => {
    if (refreshKey === 0) return
    refreshVisibleSessions()
  }, [refreshKey, refreshVisibleSessions])

  // 计算置顶 + 过滤后的项目列表（项目里非置顶 session 数 > 0 才显示）
  const archivedSet = new Set(
    archived.map((a) => `${a.projectId}::${a.sessionId}`)
  )
  const pinnedSet = new Set(
    pinned.map((p) => `${p.projectId}::${p.sessionId}`)
  )
  const pinnedItems = pinned
    .map((pr) => {
      // 已归档不出现在置顶区
      if (archivedSet.has(`${pr.projectId}::${pr.sessionId}`)) return null
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

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isEditableShortcutTarget(event.target)) return
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() === "g") {
        event.preventDefault()
        setSearchOpen((cur) => !cur)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  void timeTick

  return (
    <aside className="w-64 shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground flex flex-col rounded-lg">
      <div className="px-3 pt-3 flex flex-col gap-2">
        <Button
          variant="ghost"
          className="justify-start gap-2 h-8 px-2 hover:bg-sidebar-accent"
          onClick={onNewConversation}
        >
          <MessageSquarePlus />
          新对话
        </Button>
        <Button
          variant="ghost"
          className="group justify-start gap-2 h-8 px-2 hover:bg-sidebar-accent"
          onClick={() => setSearchOpen(true)}
        >
          <Search />
          <span>搜索</span>
          <KbdGroup className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Kbd>Ctrl</Kbd>
            <Kbd>G</Kbd>
          </KbdGroup>
        </Button>
        <Button
          variant="ghost"
          className={cn(
            "justify-start gap-2 h-8 px-2 hover:bg-sidebar-accent",
            inPlugins && "bg-sidebar-accent text-sidebar-foreground"
          )}
          onClick={onOpenPlugins}
        >
          <Puzzle />
          插件
        </Button>
        {onOpenHistory && (
          <Button
            variant="ghost"
            className="justify-start gap-2 h-8 px-2 hover:bg-sidebar-accent"
            onClick={onOpenHistory}
          >
            <HistoryIcon />
            历史会话
          </Button>
        )}
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
                      streamingSet.has(`${project.id}::${session.id}`)
                    }
                    waiting={waitingSet.has(`${project.id}::${session.id}`)}
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
                          (s) =>
                            !pinnedSet.has(`${p.id}::${s.id}`) &&
                            !archivedSet.has(`${p.id}::${s.id}`)
                        )
                      : []
                  // 当一个项目的会话全部被置顶 / 归档后，从「项目」列表里隐藏
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
                          onClick={() => {
                            onSelectProject(p)
                            toggleExpand(p)
                          }}
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
                            <div className="pl-7 pr-2 py-1 text-xs text-sidebar-muted">
                              加载中…
                            </div>
                          ) : sessionsState.kind === "error" ? (
                            <div className="pl-7 pr-2 py-1 text-xs text-destructive break-all">
                              {sessionsState.message}
                            </div>
                          ) : visibleSessions.length === 0 ? (
                            <div className="pl-7 pr-2 py-1 text-xs text-sidebar-muted">
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
                                  streamingSet.has(`${p.id}::${s.id}`)
                                }
                                waiting={waitingSet.has(`${p.id}::${s.id}`)}
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
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchPalette
            open={searchOpen}
            onOpenChange={setSearchOpen}
            projects={projects}
            onSelectSession={onSelectSession}
            onSelectProject={onSelectProject}
            onNewConversation={onNewConversation}
            onAddProject={onAdd}
            onOpenSettings={onOpenSettings}
            onOpenPlugins={onOpenPlugins}
          />
        </Suspense>
      )}
    </aside>
  )
}

function SessionRow({
  project,
  session,
  pinned,
  active,
  streaming,
  waiting,
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
  waiting: boolean
  indented: boolean
  onSelect: () => void
  onCopyId: () => void
  onTogglePin: () => void
}) {
  const title = sessionDisplayTitle(session)
  const compactTime = formatSessionCompactTime(session.modified_ts)
  const fullTime = formatSessionRelativeTime(session.modified_ts)
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group/session relative flex h-7 items-center gap-1.5 rounded-md text-xs cursor-pointer transition-[padding,background-color,color] min-w-0 max-w-full overflow-hidden",
        pinned || indented ? "pl-7 pr-8" : "pl-2 pr-8 hover:pl-7",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "hover:bg-sidebar-accent/60 text-sidebar-foreground/90"
      )}
      title={`${title}\n${project.name} · ${session.msg_count} msg · ${fullTime}\n${session.id}`}
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
              "absolute top-1/2 z-10 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded bg-sidebar-accent text-sidebar-muted shadow-sm transition-opacity hover:text-sidebar-foreground",
              pinned ? "opacity-100" : "opacity-0 group-hover/session:opacity-100",
              indented ? "left-1.5" : "left-1"
            )}
            aria-label={pinned ? "取消置顶" : "置顶会话"}
          >
            <Pin className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {pinned ? "取消置顶" : "置顶会话"}
        </TooltipContent>
      </Tooltip>
      <span className="min-w-0 flex-1 truncate leading-5">{title}</span>
      {waiting ? (
        <span className="ml-1 shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary transition-opacity group-hover/session:opacity-0">
          等待中
        </span>
      ) : streaming ? (
        <Loader2
          aria-label="运行中"
          className="ml-1 size-3 shrink-0 animate-spin text-primary transition-opacity group-hover/session:opacity-0"
        />
      ) : (
        <span className="ml-1 w-12 shrink-0 text-right text-[11px] tabular-nums text-sidebar-muted transition-opacity group-hover/session:opacity-0">
          {compactTime}
        </span>
      )}
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/session:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
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
