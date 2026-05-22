import { lazy, Suspense, useEffect, useMemo, useState, useCallback } from "react"
import {
  Copy,
  FolderOpen,
  FolderPlus,
  History as HistoryIcon,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Pin,
  PinOff,
  Puzzle,
  Search,
  Settings,
  SquarePen,
  Trash2
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import {
  listPinnedProjects,
  prunePinnedProjects,
  toggleProjectPin,
  type PinnedProjectRef
} from "@/lib/projectPins"
import { listArchived, type ArchivedRef } from "@/lib/archivedSessions"
import { sessionDisplayTitle } from "@/lib/sessionDisplayTitle"
import {
  formatSessionCompactTime,
  formatSessionRelativeTime
} from "@/lib/sessionTime"
import {
  listSidebarExpandedProjectIds,
  saveSidebarExpandedProjectIds
} from "@/lib/sidebarState"

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

function samePinnedProjectRefs(
  a: PinnedProjectRef[],
  b: PinnedProjectRef[]
): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (item, index) =>
      item.projectId === b[index]?.projectId &&
      item.pinnedAt === b[index]?.pinnedAt
  )
}

function sameStringSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
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
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(
    null
  )
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(listSidebarExpandedProjectIds())
  )
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, SessionListState>
  >({})
  const [timeTick, setTimeTick] = useState(0)
  const [pinned, setPinned] = useState<PinnedRef[]>(() => listPinned())
  const [pinnedProjects, setPinnedProjects] = useState<PinnedProjectRef[]>(
    () => listPinnedProjects()
  )
  const [archived, setArchived] = useState<ArchivedRef[]>(() => listArchived())
  const pinnedSessionProjectIds = useMemo(
    () => new Set(pinned.map((p) => p.projectId)),
    [pinned]
  )
  const pinnedProjectIds = useMemo(
    () => new Set(pinnedProjects.map((p) => p.projectId)),
    [pinnedProjects]
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
  const refreshPinnedProjects = useCallback(() => {
    const next = listPinnedProjects()
    setPinnedProjects((cur) =>
      samePinnedProjectRefs(cur, next) ? cur : next
    )
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

  const filtered = useMemo(() => {
    const pinOrder = new Map(
      pinnedProjects.map((ref, index) => [ref.projectId, index])
    )
    return [...projects].sort((a, b) => {
      const aPinned = pinnedProjectIds.has(a.id)
      const bPinned = pinnedProjectIds.has(b.id)
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      if (aPinned && bPinned) {
        return (pinOrder.get(a.id) ?? 0) - (pinOrder.get(b.id) ?? 0)
      }
      return 0
    })
  }, [projects, pinnedProjects, pinnedProjectIds])

  const pinnedProjectList = useMemo(
    () => filtered.filter((p) => pinnedProjectIds.has(p.id)),
    [filtered, pinnedProjectIds]
  )
  const unpinnedProjectList = useMemo(
    () => filtered.filter((p) => !pinnedProjectIds.has(p.id)),
    [filtered, pinnedProjectIds]
  )

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
        pinnedSessionProjectIds.has(p.id)
      ) {
        void loadSessions(p)
      }
    }
    refreshPinned()
    refreshPinnedProjects()
    refreshArchived()
  }, [
    projects,
    selectedProjectId,
    expanded,
    pinnedSessionProjectIds,
    loadSessions,
    refreshPinned,
    refreshPinnedProjects,
    refreshArchived
  ])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTimeTick((tick) => tick + 1)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    saveSidebarExpandedProjectIds(expanded)
  }, [expanded])

  useEffect(() => {
    const validProjectIds = new Set(projects.map((project) => project.id))
    setExpanded((cur) => {
      const next = new Set(
        [...cur].filter((projectId) => validProjectIds.has(projectId))
      )
      return sameStringSet(cur, next) ? cur : next
    })
    const nextPinnedProjects = prunePinnedProjects(validProjectIds)
    setPinnedProjects((cur) =>
      samePinnedProjectRefs(cur, nextPinnedProjects) ? cur : nextPinnedProjects
    )
  }, [projects])

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
    if (selectedProjectId) {
      const selected = projects.find((p) => p.id === selectedProjectId)
      if (selected && !sessionsByProject[selected.id]) {
        loadSessions(selected)
      }
    }
    for (const p of projects) {
      if (
        (expanded.has(p.id) || pinnedSessionProjectIds.has(p.id)) &&
        !sessionsByProject[p.id]
      ) {
        loadSessions(p)
      }
    }
  }, [
    selectedProjectId,
    projects,
    sessionsByProject,
    loadSessions,
    expanded,
    pinnedSessionProjectIds
  ])

  // notify watcher：只监听当前可见 / 置顶相关项目，避免启动时扫描所有项目。
  useEffect(() => {
    const cleanups: Array<() => void> = []
    const watched = projects.filter(
      (p) =>
        p.id === selectedProjectId ||
        expanded.has(p.id) ||
        pinnedSessionProjectIds.has(p.id)
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
  }, [
    projects,
    selectedProjectId,
    expanded,
    pinnedSessionProjectIds,
    loadSessions
  ])

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
  const computeVisibleSessions = (p: Project): SessionMeta[] => {
    const state = sessionsByProject[p.id]
    return state?.kind === "ok"
      ? state.items.filter(
          (s) =>
            !pinnedSet.has(`${p.id}::${s.id}`) &&
            !archivedSet.has(`${p.id}::${s.id}`)
        )
      : []
  }
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

  const toggleProjectPinAndRefresh = useCallback(
    (projectId: string) => {
      const nowPinned = toggleProjectPin(projectId)
      refreshPinnedProjects()
      toast.success(nowPinned ? "项目已置顶" : "已取消置顶")
    },
    [refreshPinnedProjects]
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
    <aside className="w-64 shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground flex flex-col">
      <div className="px-2 pt-2 flex flex-col">
        <div className="flex h-7 items-center px-2 text-xs font-medium text-sidebar-foreground/60">
          导航
        </div>
        <div className="flex flex-col gap-0.5">
          <Button
            variant="ghost"
            className="justify-start gap-2 h-8 px-2 text-sm font-medium hover:bg-sidebar-accent/50 hover:text-sidebar-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-foreground"
            onClick={onNewConversation}
          >
            <MessageSquarePlus />
            新对话
          </Button>
          <Button
            variant="ghost"
            className="group justify-start gap-2 h-8 px-2 text-sm font-medium hover:bg-sidebar-accent/50 hover:text-sidebar-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-foreground"
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
            data-active={inPlugins ? "true" : undefined}
            className="justify-start gap-2 h-8 px-2 text-sm font-medium hover:bg-sidebar-accent/50 hover:text-sidebar-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-foreground"
            onClick={onOpenPlugins}
          >
            <Puzzle />
            插件
          </Button>
          {onOpenHistory && (
            <Button
              variant="ghost"
              className="justify-start gap-2 h-8 px-2 text-sm font-medium hover:bg-sidebar-accent/50 hover:text-sidebar-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-foreground"
              onClick={onOpenHistory}
            >
              <HistoryIcon />
              历史会话
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0 min-w-0 mt-2">
        <div className="px-2 pb-2 flex flex-col gap-2 min-w-0 max-w-full overflow-hidden">
          {(pinnedItems.length > 0 || pinnedProjectList.length > 0) && (
            <div className="flex flex-col">
              <div className="flex h-7 items-center px-2 text-xs font-medium text-sidebar-foreground/60">
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
                    onSelect={() => onSelectSession(project, session)}
                    onCopyId={() => copyText(session.id, "会话 ID")}
                    onTogglePin={() =>
                      togglePinAndRefresh(project.id, session.id)
                    }
                  />
                ))}
                {pinnedProjectList.map((p) => (
                  <ProjectNode
                    key={p.id}
                    project={p}
                    isExpanded={expanded.has(p.id)}
                    isSelected={
                      selectedProjectId === p.id && !selectedSessionId
                    }
                    isPinned
                    menuOpen={openProjectMenuId === p.id}
                    sessionsState={sessionsByProject[p.id]}
                    visibleSessions={computeVisibleSessions(p)}
                    selectedProjectId={selectedProjectId}
                    selectedSessionId={selectedSessionId}
                    streamingSet={streamingSet}
                    waitingSet={waitingSet}
                    onMenuOpenChange={(open) =>
                      setOpenProjectMenuId(open ? p.id : null)
                    }
                    onToggleExpand={() => toggleExpand(p)}
                    onOpenProject={() => onSelectProject(p)}
                    onTogglePin={() => toggleProjectPinAndRefresh(p.id)}
                    onOpenInExplorer={() =>
                      openPath(p.cwd).catch((err) =>
                        toast.error(`打开失败: ${String(err)}`)
                      )
                    }
                    onRemove={() => onRemove(p.id)}
                    onSelectSession={(s) => onSelectSession(p, s)}
                    onCopySessionId={(s) => copyText(s.id, "会话 ID")}
                    onToggleSessionPin={(s) =>
                      togglePinAndRefresh(p.id, s.id)
                    }
                  />
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col">
            <div className="flex items-center justify-between">
              <div className="flex h-7 items-center px-2 text-xs font-medium text-sidebar-foreground/60">
                项目
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onAdd}
                    className="inline-flex size-5 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    aria-label="添加项目"
                  >
                    <FolderPlus className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">添加项目 (Ctrl+O)</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex flex-col gap-0.5">
              {unpinnedProjectList.length === 0 ? (
                projects.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-sidebar-foreground/60">
                    暂无项目，点击 + 添加
                  </div>
                ) : null
              ) : (
                unpinnedProjectList.map((p) => {
                  const sessionsState = sessionsByProject[p.id]
                  const visibleSessions = computeVisibleSessions(p)
                  // 当一个项目的会话全部被置顶 / 归档后，从「项目」列表里隐藏
                  if (
                    sessionsState?.kind === "ok" &&
                    sessionsState.items.length > 0 &&
                    visibleSessions.length === 0
                  ) {
                    return null
                  }
                  return (
                    <ProjectNode
                      key={p.id}
                      project={p}
                      isExpanded={expanded.has(p.id)}
                      isSelected={
                        selectedProjectId === p.id && !selectedSessionId
                      }
                      isPinned={false}
                      menuOpen={openProjectMenuId === p.id}
                      sessionsState={sessionsState}
                      visibleSessions={visibleSessions}
                      selectedProjectId={selectedProjectId}
                      selectedSessionId={selectedSessionId}
                      streamingSet={streamingSet}
                      waitingSet={waitingSet}
                      onMenuOpenChange={(open) =>
                        setOpenProjectMenuId(open ? p.id : null)
                      }
                      onToggleExpand={() => toggleExpand(p)}
                      onOpenProject={() => onSelectProject(p)}
                      onTogglePin={() => toggleProjectPinAndRefresh(p.id)}
                      onOpenInExplorer={() =>
                        openPath(p.cwd).catch((err) =>
                          toast.error(`打开失败: ${String(err)}`)
                        )
                      }
                      onRemove={() => onRemove(p.id)}
                      onSelectSession={(s) => onSelectSession(p, s)}
                      onCopySessionId={(s) => copyText(s.id, "会话 ID")}
                      onToggleSessionPin={(s) => togglePinAndRefresh(p.id, s.id)}
                    />
                  )
                })
              )}
            </div>
          </div>
        </div>
      </ScrollArea>

      <div className="border-t border-sidebar-border/60 mx-2 px-0 py-2">
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 h-8 px-2 text-sm font-medium hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
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
        "group/session relative flex h-8 items-center gap-1 rounded-md text-xs cursor-pointer transition-[background-color,color] min-w-0 max-w-full overflow-hidden pr-1.5",
        pinned ? "pl-2" : "pl-8",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "hover:bg-sidebar-accent/50 text-sidebar-foreground/90"
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
              "inline-flex size-5 items-center justify-center rounded text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-opacity",
              pinned
                ? "shrink-0 opacity-100"
                : "absolute left-2 top-1/2 -translate-y-1/2 z-10 opacity-0 group-hover/session:opacity-100"
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
        <span className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary transition-opacity group-hover/session:opacity-0">
          等待中
        </span>
      ) : streaming ? (
        <Loader2
          aria-label="运行中"
          className="size-3 shrink-0 animate-spin text-primary transition-opacity group-hover/session:opacity-0"
        />
      ) : (
        <span className="shrink-0 text-right text-[11px] tabular-nums text-sidebar-foreground/60 transition-opacity group-hover/session:opacity-0">
          {compactTime}
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 opacity-0 group-hover/session:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-opacity"
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
  )
}

function ProjectNode({
  project,
  isExpanded,
  isSelected,
  isPinned,
  menuOpen,
  sessionsState,
  visibleSessions,
  selectedProjectId,
  selectedSessionId,
  streamingSet,
  waitingSet,
  onMenuOpenChange,
  onToggleExpand,
  onOpenProject,
  onTogglePin,
  onOpenInExplorer,
  onRemove,
  onSelectSession,
  onCopySessionId,
  onToggleSessionPin
}: {
  project: Project
  isExpanded: boolean
  isSelected: boolean
  isPinned: boolean
  menuOpen: boolean
  sessionsState: SessionListState | undefined
  visibleSessions: SessionMeta[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  streamingSet: Set<string>
  waitingSet: Set<string>
  onMenuOpenChange: (open: boolean) => void
  onToggleExpand: () => void
  onOpenProject: () => void
  onTogglePin: () => void
  onOpenInExplorer: () => void
  onRemove: () => void
  onSelectSession: (session: SessionMeta) => void
  onCopySessionId: (session: SessionMeta) => void
  onToggleSessionPin: (session: SessionMeta) => void
}) {
  return (
    <Collapsible open={isExpanded} className="flex flex-col min-w-0">
      <div
        className={cn(
          "group relative flex items-center h-8 px-2 gap-1.5 rounded-md text-sm transition-colors min-w-0",
          isSelected
            ? "bg-sidebar-accent text-sidebar-foreground before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-r before:bg-primary before:content-['']"
            : "hover:bg-sidebar-accent/50"
        )}
        title={project.cwd}
      >
        <button
          type="button"
          onClick={onToggleExpand}
          className="inline-flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? "折叠" : "展开"}项目 ${project.name}`}
        >
          <FolderOpen className="size-3.5 shrink-0 text-sidebar-foreground/60" />
          <span className="truncate">{project.name}</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenProject()
          }}
          className={cn(
            "size-5 inline-flex items-center justify-center rounded text-sidebar-foreground/60 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 group-hover:opacity-100",
            menuOpen && "opacity-100"
          )}
          aria-label="在此项目新开会话"
        >
          <SquarePen className="size-3.5" />
        </button>
        <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "size-5 inline-flex items-center justify-center rounded text-sidebar-foreground/60 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 group-hover:opacity-100",
                menuOpen && "opacity-100"
              )}
              aria-label="更多项目操作"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="bottom"
            className="min-w-[180px]"
          >
            <DropdownMenuItem onSelect={onTogglePin}>
              {isPinned ? <PinOff /> : <Pin />}
              <span>{isPinned ? "取消置顶" : "置顶项目"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenInExplorer}>
              <FolderOpen />
              <span>在资源管理器中打开</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onRemove}
              className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
            >
              <Trash2 />
              <span>移除</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CollapsibleContent className="sidebar-project-sessions min-w-0 max-w-full">
        <div className="flex flex-col gap-0.5 pt-0.5 min-w-0 max-w-full overflow-hidden">
          {!sessionsState ||
          sessionsState.kind === "idle" ||
          sessionsState.kind === "loading" ? (
            <div className="px-2 py-1 text-xs text-sidebar-foreground/60">
              加载中…
            </div>
          ) : sessionsState.kind === "error" ? (
            <div className="px-2 py-1 text-xs text-destructive break-all">
              {sessionsState.message}
            </div>
          ) : visibleSessions.length === 0 ? (
            <div className="py-1 pl-8 pr-2 text-xs text-sidebar-foreground/60">
              暂无历史会话
            </div>
          ) : (
            visibleSessions.map((s) => (
              <SessionRow
                key={s.id}
                project={project}
                session={s}
                pinned={false}
                active={
                  selectedProjectId === project.id &&
                  selectedSessionId === s.id
                }
                streaming={streamingSet.has(`${project.id}::${s.id}`)}
                waiting={waitingSet.has(`${project.id}::${s.id}`)}
                onSelect={() => onSelectSession(s)}
                onCopyId={() => onCopySessionId(s)}
                onTogglePin={() => onToggleSessionPin(s)}
              />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
