import { lazy, Suspense, useEffect, useMemo, useState, useCallback, useRef, useId } from "react"
import {
  ChevronRight,
  Copy,
  FolderOpen,
  FolderPlus,
  History as HistoryIcon,
  Hourglass,
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
import type { TranscriptTarget } from "@/lib/transcriptNavigation"
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
import { isTransientSessionIndexLockError } from "@/lib/sessionIndexError"
import {
  formatSessionCompactTime,
  formatSessionRelativeTime
} from "@/lib/sessionTime"
import {
  listSidebarExpandedProjectIds,
  saveSidebarExpandedProjectIds,
  listSidebarCollapsedSections,
  saveSidebarCollapsedSections,
  type SidebarSection
} from "@/lib/sidebarState"
import { recentSidebarSessions, type SessionListState } from "@/lib/sidebarRecents"
import {
  deriveSidebarActivity,
  sidebarSessionKey,
  type SidebarSessionRef
} from "@/lib/sidebarActivity"

const SearchPalette = lazy(() =>
  import("@/components/SearchPalette").then((m) => ({ default: m.SearchPalette }))
)

interface Props {
  projects: Project[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  streamingProjectId: string | null
  streamingSessionId: string | null
  streamingSessionRefs?: SidebarSessionRef[]
  waitingSessionRefs?: SidebarSessionRef[]
  inPlugins?: boolean
  onSelectProject: (p: Project) => void
  onSelectSession: (p: Project, s: SessionMeta, target?: TranscriptTarget) => void
  onDeleteSession: (p: Project, s: SessionMeta) => void
  onAdd: () => void
  onRemove: (id: string) => void
  onNewConversation: () => void
  onOpenSettings: () => void
  onOpenPlugins: () => void
  onOpenHistory?: () => void
  refreshKey?: number
}

async function loadProjectBatch(projects: Project[], load: (project: Project) => Promise<void>, active = () => true) {
  const pending = [...projects]
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    let project: Project | undefined
    while (active() && (project = pending.shift())) await load(project)
  }))
}

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
  onDeleteSession,
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
  const [collapsedSections, setCollapsedSections] = useState<Set<SidebarSection>>(
    () => new Set(listSidebarCollapsedSections())
  )
  const projectsCollapsed = collapsedSections.has("projects")
  const recentCollapsed = collapsedSections.has("recent")
  const sectionId = useId()
  const projectsHeadingRef = useRef<HTMLButtonElement>(null)
  const previousProjectIds = useRef(new Set(projects.map((p) => p.id)))
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const sessionLoads = useRef(new Map<string, { again: boolean; promise: Promise<void> }>())
  const sessionLoadGeneration = useRef(0)
  useEffect(() => () => {
    sessionLoadGeneration.current += 1
    sessionLoads.current.clear()
  }, [])
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
  const {
    streamingSessionKeys: streamingSet,
    waitingSessionKeys: waitingSet,
    busyProjectIds
  } = useMemo(
    () =>
      deriveSidebarActivity({
        streamingProjectId,
        streamingSessionId,
        streamingSessionRefs,
        waitingSessionRefs
      }),
    [
      streamingProjectId,
      streamingSessionId,
      streamingSessionRefs,
      waitingSessionRefs
    ]
  )

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

  const loadSessions = useCallback((p: Pick<Project, "id" | "cwd">, refresh = false): Promise<void> => {
    const generation = sessionLoadGeneration.current
    const current = () => generation === sessionLoadGeneration.current
      && projectsRef.current.some((project) => project.id === p.id && project.cwd === p.cwd)
    if (!current()) return Promise.resolve()
    const pending = sessionLoads.current.get(p.id)
    if (pending) {
      if (refresh) pending.again = true
      return pending.promise
    }
    setSessionsByProject((cur) => {
      const existing = cur[p.id]
      if (existing?.kind === "ok") return cur
      return { ...cur, [p.id]: { kind: "loading" } }
    })
    const request = { again: false, promise: Promise.resolve() }
    request.promise = (async () => {
      do {
        request.again = false
        try {
          const items = await listProjectSessions(p.cwd)
          if (current() && !request.again) {
            setSessionsByProject((cur) => ({ ...cur, [p.id]: { kind: "ok", items } }))
          }
        } catch (e) {
          if (current() && !request.again) {
            const transientLock = isTransientSessionIndexLockError(e)
            setSessionsByProject((cur) => {
              if (transientLock && cur[p.id]?.kind === "ok") return cur
              return { ...cur, [p.id]: transientLock
                ? { kind: "loading" }
                : { kind: "error", message: String(e) } }
            })
          }
        }
      } while (request.again && current())
    })().finally(() => {
      if (sessionLoads.current.get(p.id) === request) sessionLoads.current.delete(p.id)
    })
    sessionLoads.current.set(p.id, request)
    return request.promise
  }, [])

  const refreshVisibleSessions = useCallback(() => {
    const generation = sessionLoadGeneration.current
    void loadProjectBatch(projects.filter((p) =>
        !recentCollapsed ||
        p.id === selectedProjectId ||
        (!projectsCollapsed && expanded.has(p.id)) ||
        (pinnedProjectIds.has(p.id) && expanded.has(p.id)) ||
        pinnedSessionProjectIds.has(p.id)
      ), (p) => loadSessions(p, true), () => generation === sessionLoadGeneration.current)
    refreshPinned()
    refreshPinnedProjects()
    refreshArchived()
  }, [
    projects,
    selectedProjectId,
    expanded,
    projectsCollapsed,
    recentCollapsed,
    pinnedProjectIds,
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

  useEffect(() => { saveSidebarCollapsedSections(collapsedSections) }, [collapsedSections])

  const toggleSection = (section: SidebarSection) => {
    setCollapsedSections((cur) => {
      const next = new Set(cur)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  useEffect(() => {
    const added = projects.some((p) => !previousProjectIds.current.has(p.id))
    previousProjectIds.current = new Set(projects.map((p) => p.id))
    if (!added) return
    setCollapsedSections((cur) => {
      if (!cur.has("projects")) return cur
      const next = new Set(cur)
      next.delete("projects")
      return next
    })
    const frame = requestAnimationFrame(() => projectsHeadingRef.current?.scrollIntoView({ block: "start" }))
    return () => cancelAnimationFrame(frame)
  }, [projects])

  useEffect(() => {
    let active = true
    if (!recentCollapsed) void loadProjectBatch(projects, loadSessions, () => active)
    return () => { active = false }
  }, [projects, recentCollapsed, loadSessions])

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

  const recentItems = useMemo(
    () => recentSidebarSessions(projects, sessionsByProject, archived),
    [projects, sessionsByProject, archived]
  )
  const recentProjectIds = new Set(recentItems.map((item) => item.project.id))
  const watchedProjectsKey = JSON.stringify(projects.filter((p) =>
    p.id === selectedProjectId ||
    ((!projectsCollapsed || pinnedProjectIds.has(p.id)) && expanded.has(p.id)) ||
    pinnedSessionProjectIds.has(p.id) || busyProjectIds.has(p.id) ||
    (!recentCollapsed && recentProjectIds.has(p.id))
  ).map(({ id, cwd }) => ({ id, cwd })))

  // 只监听展示中的、当前选中的或后台忙碌的项目；最近列表不创建全盘监听。
  useEffect(() => {
    let disposed = false
    const cleanups: Array<() => void> = []
    const watched: Array<Pick<Project, "id" | "cwd">> = JSON.parse(watchedProjectsKey)
    for (const p of watched) {
      let watching = false
      watchSessions(p.cwd).then(() => {
        watching = true
        if (disposed) void unwatchSessions(p.cwd).catch(() => undefined)
      }).catch(() => undefined)
      cleanups.push(() => {
        if (watching) void unwatchSessions(p.cwd).catch(() => undefined)
      })
      listenSessionsChanged(p.cwd, () => {
        if (!disposed) void loadSessions(p, true)
      })
        .then((un) => { if (disposed) un(); else cleanups.push(un) })
        .catch(() => undefined)
    }
    return () => {
      disposed = true
      cleanups.forEach((u) => u())
    }
  }, [watchedProjectsKey, loadSessions])

  // 主区触发的刷新（如发送消息后），只刷新当前可见 / 置顶相关项目；
  // 同时把 pinned / archived 重新读一次，确保 ChatHeader 改动后侧栏立即同步
  useEffect(() => {
    if (refreshKey === 0) return
    refreshVisibleSessions()
  }, [refreshKey, refreshVisibleSessions])

  // 置顶会话单独展示；项目节点保留，方便继续创建会话。
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
                      streamingSet.has(sidebarSessionKey(project.id, session.id))
                    }
                    waiting={waitingSet.has(
                      sidebarSessionKey(project.id, session.id)
                    )}
                    onSelect={() => onSelectSession(project, session)}
                    onDelete={() => onDeleteSession(project, session)}
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
                    busy={busyProjectIds.has(p.id)}
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
                    onDeleteSession={(s) => onDeleteSession(p, s)}
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
              <button
                ref={projectsHeadingRef}
                type="button"
                aria-expanded={!projectsCollapsed}
                aria-controls={`${sectionId}-projects`}
                onClick={() => toggleSection("projects")}
                className="flex h-7 flex-1 items-center gap-1 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              >
                项目
                <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", !projectsCollapsed && "rotate-90")} />
              </button>
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
            <div id={`${sectionId}-projects`} hidden={projectsCollapsed}>
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
                      busy={busyProjectIds.has(p.id)}
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
                      onDeleteSession={(s) => onDeleteSession(p, s)}
                      onCopySessionId={(s) => copyText(s.id, "会话 ID")}
                      onToggleSessionPin={(s) => togglePinAndRefresh(p.id, s.id)}
                    />
                  )
                })
              )}
            </div>
            </div>
          </div>

          <div className="flex flex-col">
            <button
              type="button"
              aria-expanded={!recentCollapsed}
              aria-controls={`${sectionId}-recent`}
              onClick={() => toggleSection("recent")}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              最近
              <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", !recentCollapsed && "rotate-90")} />
            </button>
            <div id={`${sectionId}-recent`} hidden={recentCollapsed}>
              <div className="flex flex-col gap-0.5">
                {recentItems.map(({ project, session }) => (
                  <SessionRow
                    key={`recent-${project.id}-${session.id}`}
                    project={project}
                    session={session}
                    pinned={pinnedSet.has(sidebarSessionKey(project.id, session.id))}
                    topLevel
                    active={selectedProjectId === project.id && selectedSessionId === session.id}
                    streaming={streamingSet.has(sidebarSessionKey(project.id, session.id))}
                    waiting={waitingSet.has(sidebarSessionKey(project.id, session.id))}
                    onSelect={() => onSelectSession(project, session)}
                    onDelete={() => onDeleteSession(project, session)}
                    onCopyId={() => copyText(session.id, "会话 ID")}
                    onTogglePin={() => togglePinAndRefresh(project.id, session.id)}
                  />
                ))}
                {recentItems.length === 0 && (
                  <div className="px-2 py-2 text-xs text-sidebar-foreground/60" role="status">
                    {projects.some((p) => !sessionsByProject[p.id] || sessionsByProject[p.id].kind === "loading")
                      ? "正在读取最近会话…"
                      : projects.some((p) => sessionsByProject[p.id]?.kind === "error")
                        ? "最近会话读取失败"
                        : "暂无最近会话"}
                    {projects.some((p) => sessionsByProject[p.id]?.kind === "error") && (
                      <button type="button" className="ml-2 underline underline-offset-2" onClick={refreshVisibleSessions}>重试</button>
                    )}
                  </div>
                )}
                {recentItems.length === 20 && onOpenHistory && (
                  <button type="button" onClick={onOpenHistory} className="h-7 rounded-md px-2 text-left text-xs text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground">查看全部会话</button>
                )}
              </div>
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
  topLevel = false,
  active,
  streaming,
  waiting,
  onSelect,
  onDelete,
  onCopyId,
  onTogglePin
}: {
  project: Project
  session: SessionMeta
  pinned: boolean
  topLevel?: boolean
  active: boolean
  streaming: boolean
  waiting: boolean
  onSelect: () => void
  onDelete: () => void
  onCopyId: () => void
  onTogglePin: () => void
}) {
  const title = sessionDisplayTitle(session, project.cwd)
  const compactTime = formatSessionCompactTime(session.modified_ts)
  const fullTime = formatSessionRelativeTime(session.modified_ts)
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group/session relative flex h-8 items-center gap-1 rounded-md text-xs cursor-pointer transition-[background-color,color] min-w-0 max-w-full overflow-hidden pr-1.5",
        pinned || topLevel ? "pl-2" : "pl-8",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "hover:bg-sidebar-accent/50 text-sidebar-foreground/90"
      )}
      title={`${title}\n${project.name} · ${session.msg_count} msg · ${fullTime}\n${session.id}`}
    >
      {/* Top-level unpinned rows keep pin with the hover actions so the title never shifts. */}
      {(pinned || !topLevel) && <Tooltip>
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
                : "absolute left-2 top-1/2 -translate-y-1/2 z-10 opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100"
            )}
            aria-label={pinned ? "取消置顶" : "置顶会话"}
          >
            <Pin className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {pinned ? "取消置顶" : "置顶会话"}
        </TooltipContent>
      </Tooltip>}
      <button type="button" className="h-full min-w-0 flex-1 truncate text-left leading-5 focus-visible:outline-none focus-visible:underline" aria-current={active ? "page" : undefined}>{title}</button>
      <div className={cn("relative flex h-5 shrink-0 items-center justify-end", topLevel && !pinned ? "w-[3.75rem]" : "w-10")}>
        {waiting ? (
          <span
            role="img"
            aria-label="等待处理"
            title="等待处理"
            className="inline-flex size-3 items-center justify-center text-primary transition-opacity group-hover/session:opacity-0 group-focus-within/session:opacity-0"
          >
            <Hourglass aria-hidden="true" className="size-3 animate-pulse" />
          </span>
        ) : streaming ? (
          <Loader2
            aria-label="运行中"
            className="size-3 animate-spin text-primary transition-opacity group-hover/session:opacity-0 group-focus-within/session:opacity-0"
          />
        ) : (
          <span className="text-right text-[11px] tabular-nums text-sidebar-foreground/60 transition-opacity group-hover/session:opacity-0 group-focus-within/session:opacity-0">
            {compactTime}
          </span>
        )}
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/session:opacity-100">
          {topLevel && !pinned && (
            <button
              type="button"
              title=""
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              aria-label="置顶会话"
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin()
              }}
            >
              <Pin className="size-3" />
            </button>
          )}
          <button
            type="button"
            title=""
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 hover:bg-destructive/10 hover:text-destructive"
            aria-label="删除会话"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            <Trash2 className="size-3" />
          </button>
          <button
            type="button"
            title=""
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            aria-label="复制会话 ID"
            onClick={(e) => {
              e.stopPropagation()
              onCopyId()
            }}
          >
            <Copy className="size-3" />
          </button>
        </div>
      </div>
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
  busy,
  streamingSet,
  waitingSet,
  onMenuOpenChange,
  onToggleExpand,
  onOpenProject,
  onTogglePin,
  onOpenInExplorer,
  onRemove,
  onSelectSession,
  onDeleteSession,
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
  busy: boolean
  streamingSet: Set<string>
  waitingSet: Set<string>
  onMenuOpenChange: (open: boolean) => void
  onToggleExpand: () => void
  onOpenProject: () => void
  onTogglePin: () => void
  onOpenInExplorer: () => void
  onRemove: () => void
  onSelectSession: (session: SessionMeta) => void
  onDeleteSession: (session: SessionMeta) => void
  onCopySessionId: (session: SessionMeta) => void
  onToggleSessionPin: (session: SessionMeta) => void
}) {
  return (
    <Collapsible open={isExpanded} className="flex flex-col min-w-0">
      <div
        className={cn(
          "group/project relative flex items-center h-8 px-2 gap-1.5 rounded-md text-sm transition-colors min-w-0",
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
        <div className="group/project-actions relative flex h-5 w-10 shrink-0 items-center justify-end">
          {!isExpanded && busy && (
            <Loader2
              aria-label="项目中有运行中的会话"
              className={cn(
                "size-3 animate-spin text-primary transition-opacity group-hover/project:opacity-0 group-focus-within/project-actions:opacity-0",
                menuOpen && "opacity-0"
              )}
            />
          )}
          <div
            className={cn(
              "pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 group-focus-within/project-actions:pointer-events-auto group-focus-within/project-actions:opacity-100",
              menuOpen && "pointer-events-auto opacity-100"
            )}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onOpenProject()
              }}
              className="size-5 inline-flex items-center justify-center rounded text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              aria-label="在此项目新开会话"
            >
              <SquarePen className="size-3.5" />
            </button>
            <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="size-5 inline-flex items-center justify-center rounded text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
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
        </div>
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
                streaming={streamingSet.has(sidebarSessionKey(project.id, s.id))}
                waiting={waitingSet.has(sidebarSessionKey(project.id, s.id))}
                onSelect={() => onSelectSession(s)}
                onDelete={() => onDeleteSession(s)}
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
