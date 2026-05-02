import {
  useEffect,
  lazy,
  useMemo,
  useReducer,
  useRef,
  useState,
  useCallback,
  Suspense
} from "react"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { toast } from "sonner"
import {
  detectClaudeCli,
  gitWorktreeStatus,
  type GitWorktreeStatus,
  worktreeDiff,
  type WorktreeDiff,
  spawnSession,
  sendUserMessage,
  stopSession,
  listenSessionEvents,
  listenSessionErrors,
  listenPermissionRequests,
  readSessionTranscript,
  readSessionSidecar,
  writeSessionSidecar,
  deleteSessionJsonl,
  fetchOauthUsage,
  type OauthUsage,
  type PermissionRequestPayload,
  type SessionMeta
} from "@/lib/ipc"
import {
  buildProxyEnv,
  loadProxyAsync,
  migrateLegacyProxyPassword
} from "@/lib/proxy"
import { loadSettings, recordResultUsage } from "@/lib/settings"
import type { AppSettings } from "@/lib/settings"
import {
  EMPTY_COMPOSER_PREFS,
  isClaudeModelEntry,
  loadGlobalDefault,
  pickComposerFromSidecar,
  type ComposerPrefs
} from "@/lib/composerPrefs"
import { getProjectEnv, loadProjectEnvStore } from "@/lib/projectEnv"
import { saveMcpStatusCache } from "@/lib/mcp"
import { saveSlashCommandsCache } from "@/lib/slashCommands"
import {
  buildClaudeEnv,
  loadThirdPartyApiConfig,
  loadThirdPartyApiStore,
  OFFICIAL_PROVIDER_ID,
  providerModelOptions,
  trimApiUrl
} from "@/lib/thirdPartyApi"
import { isOfficialApi } from "@/lib/oauthUsage"
import {
  reduce,
  init as reducerInit,
  type Action as ReducerAction,
  type State as ReducerState
} from "@/lib/reducer"
import {
  listProjects,
  removeProject as removeProjectStore,
  type Project
} from "@/lib/projects"
import type { ImagePayload, UIBlock } from "@/types/ui"
import type { ClaudeEvent } from "@/types/events"
import { Welcome } from "@/components/Welcome"
import { BuddyLoader } from "@/components/BuddyLoader"
import { AppChrome } from "@/components/AppChrome"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { getSessionTitle, setSessionTitle } from "@/lib/sessionTitles"
import {
  cleanSessionTitleText,
  sessionGeneratedTitle
} from "@/lib/sessionDisplayTitle"
import {
  isArchived,
  toggleArchive,
  unarchive
} from "@/lib/archivedSessions"
import { unpin } from "@/lib/pinned"
import { subscribeSettingsBus } from "@/lib/settingsBus"

const SUGGESTIONS = [
  "帮我想个合适的入门任务，把它实现出来，再一步步给我讲解决方案",
  "给我讲讲这个项目",
  "扫一遍代码，列出潜在的 bug 与改进点"
]

const AddProjectDialog = lazy(() =>
  import("@/components/AddProjectDialog").then((m) => ({
    default: m.AddProjectDialog
  }))
)
const ChatHeader = lazy(() =>
  import("@/components/ChatHeader").then((m) => ({ default: m.ChatHeader }))
)
const Composer = lazy(() =>
  import("@/components/Composer").then((m) => ({ default: m.Composer }))
)
const ConfirmDialog = lazy(() =>
  import("@/components/ConfirmDialog").then((m) => ({
    default: m.ConfirmDialog
  }))
)
const MessageStream = lazy(() =>
  import("@/components/MessageStream").then((m) => ({
    default: m.MessageStream
  }))
)
const PluginsView = lazy(() =>
  import("@/components/PluginsView").then((m) => ({ default: m.PluginsView }))
)
const SettingsWorkspace = lazy(() =>
  import("@/components/Settings").then((m) => ({
    default: m.SettingsWorkspace
  }))
)
const DiffOverview = lazy(() =>
  import("@/components/DiffOverview").then((m) => ({
    default: m.DiffOverview
  }))
)
const PermissionDialog = lazy(() =>
  import("@/components/PermissionDialog").then((m) => ({
    default: m.PermissionDialog
  }))
)
const ProjectPicker = lazy(() =>
  import("@/components/ProjectPicker").then((m) => ({
    default: m.ProjectPicker
  }))
)
const ProjectActionsBar = lazy(() =>
  import("@/components/ProjectActionsBar").then((m) => ({
    default: m.ProjectActionsBar
  }))
)
const RenameSessionDialog = lazy(() =>
  import("@/components/RenameSessionDialog").then((m) => ({
    default: m.RenameSessionDialog
  }))
)
const Sidebar = lazy(() =>
  import("@/components/Sidebar").then((m) => ({ default: m.Sidebar }))
)

function PaneLoader({ label = "正在加载界面…" }: { label?: string }) {
  return (
    <div className="flex-1 min-h-0 grid place-items-center">
      <BuddyLoader label={label} />
    </div>
  )
}

function ComposerLoader() {
  return (
    <div className="shrink-0 px-6 pb-6">
      <div className="mx-auto max-w-3xl rounded-[24px] border bg-card p-4 shadow-sm">
        <div className="h-14 rounded-2xl bg-muted/60" />
      </div>
    </div>
  )
}

function SidebarLoader() {
  return (
    <aside className="w-64 shrink-0 overflow-hidden rounded-lg bg-sidebar p-3">
      <div className="mb-3 h-8 rounded-md bg-sidebar-accent/70" />
      <div className="mb-3 h-8 rounded-md border border-sidebar-border/60" />
      <div className="space-y-2">
        <div className="h-3 w-16 rounded bg-sidebar-accent/70" />
        <div className="h-8 rounded-md bg-sidebar-accent/50" />
        <div className="h-8 rounded-md bg-sidebar-accent/40" />
      </div>
    </aside>
  )
}

type QueuedInput = { localId: string }
type ReturnView = "chat" | "plugins"
type ChatReturnTarget =
  | { kind: "project"; project: Project }
  | { kind: "session"; project: Project; session: SessionMeta }

type RunningSession = {
  runtimeId: string
  project: Project
  jsonlSessionId: string | null
  apiProfileKey: string
  selectedSessionMeta: SessionMeta | null
  state: ReducerState
  streaming: boolean
  pendingPermissionRequestIds: Set<string>
  pendingActions: ReducerAction[]
  queuedInputs: QueuedInput[]
  unlisten: UnlistenFn[]
  composerPrefs: ComposerPrefs
  sessionComposer: ComposerPrefs | null
}

function buildCliBlocks(
  text: string,
  images: ImagePayload[]
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  if (text) blocks.push({ type: "text", text })
  for (const image of images) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: image.mime, data: image.data }
    })
  }
  return blocks
}

function currentApiProfileKey(): string {
  const store = loadThirdPartyApiStore()
  if (store.activeProviderId === OFFICIAL_PROVIDER_ID) return "official"
  const provider = store.providers.find((p) => p.id === store.activeProviderId)
  if (!provider) return "official"
  return [
    "third-party",
    provider.id,
    trimApiUrl(provider.requestUrl),
    provider.inputFormat
  ].join(":")
}

function sidecarApiProfileKey(sidecar: unknown): string | null {
  if (!sidecar || typeof sidecar !== "object") return null
  const raw = (sidecar as { apiProfileKey?: unknown }).apiProfileKey
  return typeof raw === "string" && raw.trim() ? raw.trim() : null
}

function chatTitle(
  state: ReturnType<typeof reducerInit>,
  project: Project,
  jsonlSessionId: string | null,
  sessionMeta: SessionMeta | null
): string {
  if (jsonlSessionId) {
    const custom = getSessionTitle(jsonlSessionId)
    if (custom) return custom
    if (sessionMeta?.id === jsonlSessionId) {
      const generated = sessionGeneratedTitle(sessionMeta)
      if (generated) return generated
    }
  }
  for (const e of state.entries) {
    if (e.kind === "message" && e.role === "user") {
      for (const b of e.blocks) {
        if (b.type !== "text") continue
        const title = cleanSessionTitleText(b.text, 80)
        if (title) return title
      }
    }
  }
  return `${project.name} · 新对话`
}

function findInitSessionId(
  state: ReturnType<typeof reducerInit>
): string | null {
  for (const e of state.entries) {
    if (e.kind === "system_init" && e.sessionId) return e.sessionId
  }
  return null
}

const FALLBACK_SLASH = [
  "clear",
  "compact",
  "context",
  "init",
  "review",
  "security-review",
  "usage"
]

function findSlashCommands(
  state: ReturnType<typeof reducerInit>
): string[] {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i]
    if (e.kind === "system_init" && e.slashCommands?.length) {
      return e.slashCommands
    }
  }
  return FALLBACK_SLASH
}

function countDiffFiles(
  entries: ReturnType<typeof reducerInit>["entries"]
): number {
  const set = new Set<string>()
  for (const e of entries) {
    if (e.kind !== "message" || e.role !== "user") continue
    for (const b of e.blocks) {
      if (b.type !== "tool_result") continue
      const tur = b.toolUseResult as
        | { type?: string; filePath?: string }
        | undefined
      if (!tur || !tur.filePath) continue
      if (tur.type === "create" || tur.type === "update") set.add(tur.filePath)
    }
  }
  return set.size
}

export default function App() {
  const [state, dispatch] = useReducer(reduce, undefined, reducerInit)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [cliPath, setCliPath] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedSessionMeta, setSelectedSessionMeta] =
    useState<SessionMeta | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const [chatReturnTarget, setChatReturnTarget] =
    useState<ChatReturnTarget | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [settingsSection, setSettingsSection] = useState("general")
  const [planMode, setPlanMode] = useState(false)
  const [sessionPermissionMode, setSessionPermissionMode] =
    useState<AppSettings["defaultPermissionMode"]>("default")
  const [composerPrefs, setComposerPrefs] = useState<ComposerPrefs>({
    model: "",
    effort: ""
  })
  // 启动时一次性读到的全局默认（settings.json + app settings），用于：
  // 1) 新会话的初始值
  // 2) Picker 显示"默认值"提示
  const [globalDefault, setGlobalDefault] = useState<ComposerPrefs>(
    EMPTY_COMPOSER_PREFS
  )
  // 当前会话的"已显式覆盖" composer prefs（来自 sidecar），用于 effortSource 判定
  const [sessionComposer, setSessionComposer] = useState<ComposerPrefs | null>(
    null
  )
  const [thirdPartyApiVersion, setThirdPartyApiVersion] = useState(0)
  const [oauthUsage, setOauthUsage] = useState<OauthUsage | null>(null)
  const [draft, setDraft] = useState("")
  const [pinTick, setPinTick] = useState(0)
  const [titleTick, setTitleTick] = useState(0)
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0)
  const [showRename, setShowRename] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [pendingRemoveProjectId, setPendingRemoveProjectId] = useState<
    string | null
  >(null)
  const [loadingSession, setLoadingSession] = useState(false)
  const [runningTick, setRunningTick] = useState(0)
  const [gitStatus, setGitStatus] = useState<GitWorktreeStatus | null>(null)
  const [diffPatch, setDiffPatch] = useState<WorktreeDiff | null>(null)
  const [diffPatchLoading, setDiffPatchLoading] = useState(false)
  const [diffPatchError, setDiffPatchError] = useState<string | null>(null)
  const [permissionRequests, setPermissionRequests] = useState<
    PermissionRequestPayload[]
  >([])
  // fork 功能已废弃，未来基于 CLI --fork-session 重做（plan.md §9.1.1）
  const stateRef = useRef<ReducerState>(reducerInit())
  const sessionIdRef = useRef<string | null>(null)
  const activeRuntimeIdRef = useRef<string | null>(null)
  const runningSessionsRef = useRef<Map<string, RunningSession>>(new Map())
  const sessionComposerRef = useRef<ComposerPrefs | null>(null)
  const apiProfileKeyRef = useRef(currentApiProfileKey())
  const permissionModeTouchedRef = useRef(false)
  const returnViewRef = useRef<ReturnView>("chat")
  const settingsEntryTargetRef = useRef<ChatReturnTarget | null>(null)
  const permissionUnlistenRef = useRef<UnlistenFn | null>(null)
  const switchTokenRef = useRef(0)
  const streamingRefsCacheRef = useRef<{
    key: string
    value: Array<{ projectId: string; sessionId: string }>
  }>({ key: "", value: [] })
  const waitingRefsCacheRef = useRef<{
    key: string
    value: Array<{ projectId: string; sessionId: string }>
  }>({ key: "", value: [] })

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    sessionComposerRef.current = sessionComposer
  }, [sessionComposer])

  const flushRunningActions = useCallback((run: RunningSession) => {
    if (run.pendingActions.length === 0) return
    let next = run.state
    for (const action of run.pendingActions) {
      next = reduce(next, action)
    }
    run.pendingActions = []
    run.state = next
    if (activeRuntimeIdRef.current === run.runtimeId) {
      dispatch({ kind: "replace_state", state: next })
      stateRef.current = next
    }
  }, [])

  const applyRunningAction = useCallback(
    (run: RunningSession, action: ReducerAction) => {
      if (activeRuntimeIdRef.current !== run.runtimeId) {
        run.pendingActions.push(action)
        return
      }
      run.state = reduce(run.state, action)
      dispatch(action)
    },
    []
  )

  const setRunningSessionStreaming = useCallback(
    (run: RunningSession, next: boolean) => {
      if (run.streaming === next) return
      run.streaming = next
      if (activeRuntimeIdRef.current === run.runtimeId) {
        setStreaming(next)
      }
      setRunningTick((tick) => tick + 1)
    },
    []
  )

  const closeRunningSession = useCallback(
    async (
      runtimeId: string,
      opts: { dropQueued?: boolean; stopProcess?: boolean } = {}
    ) => {
      const run = runningSessionsRef.current.get(runtimeId)
      if (!run) {
        setPermissionRequests((cur) =>
          cur.filter((request) => request.session_id !== runtimeId)
        )
        if (opts.stopProcess !== false) {
          await stopSession(runtimeId).catch((e) => console.error(e))
        }
        if (activeRuntimeIdRef.current === runtimeId) {
          activeRuntimeIdRef.current = null
          sessionIdRef.current = null
          setSessionId(null)
          setStreaming(false)
        }
        return
      }

      const isActive = activeRuntimeIdRef.current === runtimeId
      if (opts.dropQueued !== false && run.queuedInputs.length > 0) {
        for (const item of run.queuedInputs) {
          applyRunningAction(run, {
            kind: "drop_local",
            localId: item.localId
          })
        }
        run.queuedInputs = []
      }
      run.unlisten.forEach((unlisten) => unlisten())
      run.unlisten = []
      runningSessionsRef.current.delete(runtimeId)
      setPermissionRequests((cur) =>
        cur.filter((request) => request.session_id !== runtimeId)
      )
      if (opts.stopProcess !== false) {
        await stopSession(runtimeId).catch((e) => console.error(e))
      }
      if (isActive) {
        activeRuntimeIdRef.current = null
        sessionIdRef.current = null
        setSessionId(null)
        setStreaming(false)
      }
      setRunningTick((tick) => tick + 1)
    },
    [applyRunningAction]
  )

  const detachActiveSession = useCallback(async () => {
    const runtimeId = activeRuntimeIdRef.current
    activeRuntimeIdRef.current = null
    sessionIdRef.current = null
    setSessionId(null)
    setStreaming(false)
    if (!runtimeId) return
    const run = runningSessionsRef.current.get(runtimeId)
    if (
      run &&
      !run.streaming &&
      run.pendingPermissionRequestIds.size === 0
    ) {
      await closeRunningSession(runtimeId, { dropQueued: false })
    }
  }, [closeRunningSession])

  const stopActiveSession = useCallback(async () => {
    const runtimeId = activeRuntimeIdRef.current ?? sessionIdRef.current
    if (runtimeId) {
      await closeRunningSession(runtimeId)
      return
    }
    activeRuntimeIdRef.current = null
    sessionIdRef.current = null
    setSessionId(null)
    setStreaming(false)
  }, [closeRunningSession])

  const findRunningSession = useCallback(
    (p: Project, jsonlSessionId: string): RunningSession | null => {
      for (const run of runningSessionsRef.current.values()) {
        if (run.project.id !== p.id) continue
        const sid = run.jsonlSessionId ?? findInitSessionId(run.state)
        if (sid && !run.jsonlSessionId) run.jsonlSessionId = sid
        if (sid === jsonlSessionId) return run
      }
      return null
    },
    []
  )

  const stopRunningSessionForJsonl = useCallback(
    async (p: Project, jsonlSessionId: string) => {
      const targets: string[] = []
      for (const run of runningSessionsRef.current.values()) {
        if (run.project.id !== p.id) continue
        const sid = run.jsonlSessionId ?? findInitSessionId(run.state)
        if (sid === jsonlSessionId) targets.push(run.runtimeId)
      }
      await Promise.all(targets.map((runtimeId) => closeRunningSession(runtimeId)))
    },
    [closeRunningSession]
  )

  const stopRunningSessionsForProject = useCallback(
    async (projectId: string) => {
      const targets = Array.from(runningSessionsRef.current.values())
        .filter((run) => run.project.id === projectId)
        .map((run) => run.runtimeId)
      await Promise.all(targets.map((runtimeId) => closeRunningSession(runtimeId)))
    },
    [closeRunningSession]
  )

  const activateRunningSession = useCallback((run: RunningSession) => {
    flushRunningActions(run)
    activeRuntimeIdRef.current = run.runtimeId
    sessionIdRef.current = run.runtimeId
    setSessionId(run.runtimeId)
    setStreaming(run.streaming)
    dispatch({ kind: "replace_state", state: run.state })
    stateRef.current = run.state
    sessionComposerRef.current = run.sessionComposer
    setSessionComposer(run.sessionComposer)
    setComposerPrefs(run.composerPrefs)
  }, [flushRunningActions])

  const settlePermissionRequest = useCallback(
    (requestId: string) => {
      let changed = false
      for (const run of runningSessionsRef.current.values()) {
        if (run.pendingPermissionRequestIds.delete(requestId)) {
          changed = true
        }
      }
      setPermissionRequests((cur) =>
        cur.filter((request) => request.request_id !== requestId)
      )
      if (changed) {
        setSidebarRefreshKey((k) => k + 1)
        setRunningTick((k) => k + 1)
      }
    },
    []
  )

  useEffect(() => {
    detectClaudeCli()
      .then(setCliPath)
      .catch((e) => toast.error(`未找到 claude CLI: ${String(e)}`))
    // 一次性迁移：旧版 localStorage 里的明文代理密码 → keychain（keychain 可用时静默执行）
    void migrateLegacyProxyPassword()
    loadGlobalDefault()
      .then((p) => {
        setGlobalDefault(p)
        // 启动时 Composer 显示全局默认，作为新对话的起点
        setComposerPrefs(p)
      })
      .catch(() => {
        // 读 settings.json 失败不致命；保持默认 auto
      })
    const settings = loadSettings()
    setSessionPermissionMode(settings.defaultPermissionMode)
    setPlanMode(settings.defaultPermissionMode === "plan")
    if (isOfficialApi()) {
      fetchOauthUsage()
        .then((u) => setOauthUsage(u))
        .catch(() => setOauthUsage(null))
    }
    const list = listProjects()
    setProjects(list)
    if (list.length > 0) setProject((cur) => cur ?? list[0])
    listenPermissionRequests((payload) => {
      const run = runningSessionsRef.current.get(payload.session_id)
      if (run) {
        run.pendingPermissionRequestIds.add(payload.request_id)
      }
      setPermissionRequests((cur) =>
        cur.some((p) => p.request_id === payload.request_id)
          ? cur
          : [...cur, payload]
      )
      setSidebarRefreshKey((k) => k + 1)
      setRunningTick((k) => k + 1)
    })
      .then((u) => {
        permissionUnlistenRef.current = u
      })
      .catch((e) => toast.error(`权限监听启动失败: ${String(e)}`))
    return () => {
      for (const run of runningSessionsRef.current.values()) {
        run.unlisten.forEach((u) => u())
        stopSession(run.runtimeId).catch((e) => console.error(e))
      }
      runningSessionsRef.current.clear()
      permissionUnlistenRef.current?.()
      permissionUnlistenRef.current = null
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault()
        returnViewRef.current = "chat"
        settingsEntryTargetRef.current = null
        setShowSettings(false)
        setShowPlugins(false)
        setShowAdd(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Settings 里改 defaultModel/defaultEffort，或 syncEffortToGlobal 写回 ~/.claude/settings.json
  // 之后，App 缓存的 globalDefault 需要刷新；当前没有会话级覆盖时，Composer
  // 也要跟着新默认值走，否则新会话会继续使用旧的非空 composerPrefs。
  useEffect(() => {
    let refreshSeq = 0
    const applyDefaultComposer = (next: ComposerPrefs) => {
      setGlobalDefault(next)
      if (sessionComposerRef.current) return
      setComposerPrefs(next)
      const activeRuntimeId = activeRuntimeIdRef.current
      const activeRun = activeRuntimeId
        ? runningSessionsRef.current.get(activeRuntimeId)
        : null
      if (activeRun && !activeRun.sessionComposer) {
        activeRun.composerPrefs = next
      }
    }
    const refreshComposerDefaults = () => {
      const seq = ++refreshSeq
      loadGlobalDefault()
        .then((next) => {
          if (seq === refreshSeq) applyDefaultComposer(next)
        })
        .catch((error) => {
          console.error("刷新 Composer 默认配置失败:", error)
        })
    }
    const refreshAppSettings = () => {
      if (permissionModeTouchedRef.current) return
      const settings = loadSettings()
      setSessionPermissionMode(settings.defaultPermissionMode)
      setPlanMode(settings.defaultPermissionMode === "plan")
    }
    const refreshSettings = () => {
      refreshAppSettings()
      refreshComposerDefaults()
    }
    const refreshThirdPartyApi = () => {
      const previousProfileKey = apiProfileKeyRef.current
      const nextProfileKey = currentApiProfileKey()
      apiProfileKeyRef.current = nextProfileKey
      setThirdPartyApiVersion((version) => version + 1)
      refreshComposerDefaults()
      if (previousProfileKey !== nextProfileKey && !activeRuntimeIdRef.current) {
        dispatch({ kind: "reset" })
        setSelectedSessionId(null)
        setSelectedSessionMeta(null)
        sessionComposerRef.current = null
        setSessionComposer(null)
        toast.info("API 供应商已切换，已切到新会话入口以避免复用不兼容的历史 thinking 签名")
      }
      if (!isOfficialApi()) {
        setOauthUsage(null)
        return
      }
      fetchOauthUsage()
        .then((usage) => setOauthUsage(usage))
        .catch((error) => {
          console.error("刷新 OAuth 用量失败:", error)
          setOauthUsage(null)
        })
    }
    const off1 = subscribeSettingsBus("settings", refreshSettings)
    const off2 = subscribeSettingsBus("composerPrefs", refreshComposerDefaults)
    const off3 = subscribeSettingsBus("thirdPartyApi", refreshThirdPartyApi)
    return () => {
      off1()
      off2()
      off3()
    }
  }, [])

  const teardown = useCallback(async () => {
    await stopActiveSession()
  }, [stopActiveSession])

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (!project) {
      setShowAdd(true)
      return null
    }
    const activeSessionId = activeRuntimeIdRef.current ?? sessionIdRef.current
    if (activeSessionId) return activeSessionId
    let createdRuntimeId: string | null = null
    try {
      const proxyEnv = buildProxyEnv(await loadProxyAsync())
      const cfg = loadSettings()
      const thirdPartyApi = loadThirdPartyApiConfig()
      const thirdPartyReady =
        thirdPartyApi.enabled &&
        !!trimApiUrl(thirdPartyApi.requestUrl) &&
        !!thirdPartyApi.apiKey.trim()
      const thirdPartyEnv = thirdPartyReady
        ? buildClaudeEnv(thirdPartyApi)
        : {}
      const env = { ...thirdPartyEnv, ...proxyEnv }
      const apiProfileKey = currentApiProfileKey()
      let resumeSessionId = selectedSessionId
      if (resumeSessionId) {
        const sidecar = await readSessionSidecar(project.cwd, resumeSessionId)
        const storedProfileKey = sidecarApiProfileKey(sidecar)
        if (storedProfileKey && storedProfileKey !== apiProfileKey) {
          resumeSessionId = null
          dispatch({ kind: "reset" })
          setSelectedSessionId(null)
          setSelectedSessionMeta(null)
          sessionComposerRef.current = null
          setSessionComposer(null)
          toast.info("当前会话属于另一个 API 供应商，已新建会话以避免复用不兼容的 thinking 签名")
        }
      }
      const uiModel = composerPrefs.model.trim()
      const uiEffort = composerPrefs.effort.trim()
      const model = uiModel || cfg.defaultModel.trim() || null
      const id = await spawnSession({
        cwd: project.cwd,
        model,
        effort: uiEffort || cfg.defaultEffort.trim() || null,
        permissionMode: planMode
          ? "plan"
          : sessionPermissionMode || cfg.defaultPermissionMode || "default",
        resumeSessionId,
        env: Object.keys(env).length > 0 ? env : null,
        permissionMcpEnabled: cfg.permissionMcpEnabled,
        permissionPromptTool: cfg.permissionPromptTool.trim() || null,
        mcpConfig: cfg.permissionMcpConfig.trim() || null
      })
      createdRuntimeId = id
      const run: RunningSession = {
        runtimeId: id,
        project,
        jsonlSessionId: resumeSessionId,
        apiProfileKey,
        selectedSessionMeta: resumeSessionId ? selectedSessionMeta : null,
        state: resumeSessionId ? stateRef.current : reducerInit(),
        streaming: false,
        pendingPermissionRequestIds: new Set(),
        pendingActions: [],
        queuedInputs: [],
        unlisten: [],
        composerPrefs,
        sessionComposer
      }
      runningSessionsRef.current.set(id, run)
      activeRuntimeIdRef.current = id
      sessionIdRef.current = id
      setSessionId(id)
      setRunningTick((tick) => tick + 1)
      const u1 = await listenSessionEvents(id, (ev) => {
        applyRunningAction(run, { kind: "event", event: ev })
        const t = (ev as { type?: string }).type
        const evSessionId = (ev as { session_id?: string }).session_id
        if (evSessionId && run.jsonlSessionId !== evSessionId) {
          run.jsonlSessionId = evSessionId
          if (activeRuntimeIdRef.current === run.runtimeId) {
            setSelectedSessionId((cur) => cur ?? evSessionId)
          }
          setRunningTick((tick) => tick + 1)
        }
        if (
          t === "stream_event" &&
          (ev as { event?: { type?: string } }).event?.type === "message_start"
        ) {
          setRunningSessionStreaming(run, true)
        }
        if (t === "system") {
          const apiKeySource = (ev as { apiKeySource?: string }).apiKeySource
          if (apiKeySource) {
            try {
              localStorage.setItem("claudinal.api-key-source", apiKeySource)
            } catch {
              // ignore
            }
          }
          const slash = (ev as { slash_commands?: unknown }).slash_commands
          if (Array.isArray(slash)) {
            saveSlashCommandsCache(
              (slash as unknown[]).filter(
                (s): s is string => typeof s === "string"
              )
            )
          }
          const mcpServers = (ev as { mcp_servers?: unknown }).mcp_servers
          if (Array.isArray(mcpServers)) {
            saveMcpStatusCache(
              mcpServers.filter(
                (server): server is { name: string; status: string } =>
                  server &&
                  typeof server === "object" &&
                  typeof (server as { name?: unknown }).name === "string" &&
                  typeof (server as { status?: unknown }).status === "string"
              )
            )
          }
        }
        if (t === "result") {
          const queued = run.queuedInputs
          if (queued.length > 0) {
            for (const item of queued) {
              applyRunningAction(run, {
                kind: "unqueue_local",
                localId: item.localId
              })
            }
            run.queuedInputs = []
          }
          setRunningSessionStreaming(run, false)
          setSidebarRefreshKey((k) => k + 1)
          if (activeRuntimeIdRef.current === run.runtimeId) {
            gitWorktreeStatus(run.project.cwd)
              .then(setGitStatus)
              .catch(() => setGitStatus(null))
          }
          if (isOfficialApi()) {
            fetchOauthUsage()
              .then((u) => setOauthUsage(u))
              .catch(() => {
                // OAuth 拉取失败保留旧值
              })
          }
          recordResultUsage(
            ev as {
              total_cost_usd?: number
              modelUsage?: Record<string, never>
            }
          )
          const sid =
            (ev as { session_id?: string }).session_id ?? run.jsonlSessionId
          if (sid) {
            // 保留 sidecar 已有字段，更新 result；如果用户在 session id 分配前就
            // 改过 composer，这里把 sessionComposer 一并落地。
            readSessionSidecar(run.project.cwd, sid)
              .then((existing) => {
                const base = (existing && typeof existing === "object"
                  ? existing
                  : {}) as Record<string, unknown>
                const next: Record<string, unknown> = {
                  ...base,
                  result: ev,
                  apiProfileKey: run.apiProfileKey
                }
                if (run.sessionComposer && !base.composer) {
                  next.composer = run.sessionComposer
                }
                return writeSessionSidecar(run.project.cwd, sid, next)
              })
              .catch((e) => console.warn("sidecar write failed:", e))
          }
        }
      })
      const u2 = await listenSessionErrors(id, (line) => {
        const ev = { type: "stderr", line } as unknown as ClaudeEvent
        applyRunningAction(run, { kind: "event", event: ev })
      })
      run.unlisten = [u1, u2]
      return id
    } catch (e) {
      if (createdRuntimeId) {
        await closeRunningSession(createdRuntimeId).catch((err) =>
          console.error(err)
        )
      }
      toast.error(`启动会话失败: ${String(e)}`)
      return null
    }
  }, [
    planMode,
    project,
    selectedSessionId,
    selectedSessionMeta,
    composerPrefs,
    sessionComposer,
    sessionPermissionMode,
    applyRunningAction,
    setRunningSessionStreaming,
    closeRunningSession
  ])

  const refreshGitStatus = useCallback(async () => {
    if (!project) {
      setGitStatus(null)
      return
    }
    try {
      setGitStatus(await gitWorktreeStatus(project.cwd))
    } catch {
      setGitStatus(null)
    }
  }, [project])

  const refreshWorktreeDiff = useCallback(async () => {
    if (!project) {
      setDiffPatch(null)
      setDiffPatchError(null)
      return
    }
    setDiffPatchLoading(true)
    try {
      const patch = await worktreeDiff(project.cwd)
      setDiffPatch(patch)
      setDiffPatchError(null)
    } catch (e) {
      setDiffPatch(null)
      setDiffPatchError(String(e))
    } finally {
      setDiffPatchLoading(false)
    }
  }, [project])

  useEffect(() => {
    if (!project) {
      setGitStatus(null)
      setDiffPatch(null)
      setDiffPatchError(null)
      return
    }
    let cancelled = false
    gitWorktreeStatus(project.cwd)
      .then((status) => {
        if (!cancelled) setGitStatus(status)
      })
      .catch(() => {
        if (!cancelled) setGitStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [project?.cwd, selectedSessionId, sidebarRefreshKey])

  useEffect(() => {
    if (showDiff) {
      void refreshWorktreeDiff()
    }
  }, [showDiff, refreshWorktreeDiff, sidebarRefreshKey])

  const send = useCallback(
    async (text: string, images: ImagePayload[]) => {
      // 客户端可处理的斜杠命令直接拦截，不投递给 CLI
      const trimmed = text.trim()
      if (trimmed === "/clear" || trimmed === "/reset") {
        await teardown()
        dispatch({ kind: "reset" })
        setSelectedSessionId(null)
        setSelectedSessionMeta(null)
        toast.success("已清空当前会话")
        return
      }
      if (trimmed.startsWith("/") && images.length === 0) {
        // 其他斜杠命令是 TUI 专属（/usage、/permissions、/login 等），桌面端做不了
        // 仍把文本发给 CLI（CLI 会当普通文本处理），同时给一次性提醒
        toast.info("斜杠命令是 CLI TUI 专属，GUI 中作普通文本处理")
      }
      const uiBlocks: UIBlock[] = []
      if (text) uiBlocks.push({ type: "text", text })
      for (const image of images) {
        uiBlocks.push({
          type: "image",
          imageMediaType: image.mime,
          imageData: image.data
        })
      }
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const blocks = buildCliBlocks(text, images)

      if (streaming) {
        const id = sessionIdRef.current ?? (await ensureSession())
        const run = id ? runningSessionsRef.current.get(id) : null
        if (!id) {
          return
        }
        if (run) {
          applyRunningAction(run, {
            kind: "user_local",
            blocks: uiBlocks,
            queued: true,
            localId
          })
          run.queuedInputs = [...run.queuedInputs, { localId }]
        } else {
          dispatch({
            kind: "user_local",
            blocks: uiBlocks,
            queued: true,
            localId
          })
        }
        try {
          await sendUserMessage(id, blocks)
        } catch (e) {
          if (run) {
            run.queuedInputs = run.queuedInputs.filter(
              (item) => item.localId !== localId
            )
            applyRunningAction(run, { kind: "drop_local", localId })
          } else {
            dispatch({ kind: "drop_local", localId })
          }
          toast.error(`发送失败: ${String(e)}`)
        }
        return
      }

      const id = await ensureSession()
      if (!id) return
      const run = runningSessionsRef.current.get(id)
      if (run) {
        applyRunningAction(run, { kind: "user_local", blocks: uiBlocks, localId })
        setRunningSessionStreaming(run, true)
      } else {
        dispatch({ kind: "user_local", blocks: uiBlocks, localId })
        setStreaming(true)
      }
      try {
        await sendUserMessage(id, blocks)
      } catch (e) {
        toast.error(`发送失败: ${String(e)}`)
        if (run) {
          setRunningSessionStreaming(run, false)
        } else {
          setStreaming(false)
        }
      }
    },
    [
      streaming,
      ensureSession,
      teardown,
      applyRunningAction,
      setRunningSessionStreaming
    ]
  )

  const stop = useCallback(async () => {
    await teardown()
  }, [teardown])

  const handlePermissionModeChange = useCallback(
    (mode: AppSettings["defaultPermissionMode"]) => {
      permissionModeTouchedRef.current = true
      setSessionPermissionMode(mode)
      setPlanMode(mode === "plan")
    },
    []
  )

  const handlePlanModeChange = useCallback((enabled: boolean) => {
    permissionModeTouchedRef.current = true
    setPlanMode(enabled)
    setSessionPermissionMode(
      enabled ? "plan" : loadSettings().defaultPermissionMode
    )
  }, [])

  const switchProject = useCallback(
    async (next: Project) => {
      const token = ++switchTokenRef.current
      await detachActiveSession()
      if (token !== switchTokenRef.current) return
      dispatch({ kind: "reset" })
      setProject(next)
      setSelectedSessionId(null)
      setSelectedSessionMeta(null)
    },
    [detachActiveSession]
  )

  const switchSession = useCallback(
    async (p: Project, s: SessionMeta) => {
      const token = ++switchTokenRef.current
      await detachActiveSession()
      if (token !== switchTokenRef.current) return
      setLoadingSession(true)
      dispatch({ kind: "reset" })
      setProject(p)
      setSelectedSessionId(s.id)
      setSelectedSessionMeta(s)
      const runningSession = findRunningSession(p, s.id)
      if (runningSession) {
        runningSession.selectedSessionMeta = s
        activateRunningSession(runningSession)
        setLoadingSession(false)
        return
      }
      try {
        const events = (await readSessionTranscript(p.cwd, s.id)) as ClaudeEvent[]
        if (token !== switchTokenRef.current) return
        // sidecar 里持久化的 result 事件追加到末尾，恢复 ✓ 完成 chip
        const sidecar = (await readSessionSidecar(p.cwd, s.id)) as
          | { result?: ClaudeEvent; composer?: { model?: string; effort?: string } }
          | null
        if (token !== switchTokenRef.current) return
        const merged: ClaudeEvent[] =
          sidecar?.result ? [...events, sidecar.result] : events
        dispatch({ kind: "load_transcript", events: merged })
        // 还原会话级 composer 偏好；没有 sidecar.composer 就用全局默认
        const sessionPrefs = pickComposerFromSidecar(sidecar)
        sessionComposerRef.current = sessionPrefs
        setSessionComposer(sessionPrefs)
        setComposerPrefs(sessionPrefs ?? globalDefault)
      } catch (e) {
        if (token !== switchTokenRef.current) return
        toast.error(`加载会话失败: ${String(e)}`)
      } finally {
        if (token === switchTokenRef.current) setLoadingSession(false)
      }
    },
    [
      detachActiveSession,
      findRunningSession,
      activateRunningSession,
      globalDefault
    ]
  )

  const onProjectAdded = useCallback(
    async (p: Project) => {
      const token = ++switchTokenRef.current
      await detachActiveSession()
      if (token !== switchTokenRef.current) return
      dispatch({ kind: "reset" })
      setProject(p)
      setSelectedSessionId(null)
      setSelectedSessionMeta(null)
      setProjects(listProjects())
      returnViewRef.current = "chat"
      settingsEntryTargetRef.current = null
      setShowSettings(false)
      setShowPlugins(false)
      toast.success(`项目「${p.name}」已添加`)
    },
    [detachActiveSession]
  )

  const handleRemove = useCallback((id: string) => {
    setPendingRemoveProjectId(id)
  }, [])

  const performRemoveProject = useCallback(async () => {
    const id = pendingRemoveProjectId
    if (!id) return
    await stopRunningSessionsForProject(id)
    removeProjectStore(id)
    setProjects(listProjects())
    if (project?.id === id) {
      setProject(null)
      setSelectedSessionId(null)
      setSelectedSessionMeta(null)
      dispatch({ kind: "reset" })
    }
    setPendingRemoveProjectId(null)
    toast.success("项目已从列表移除")
  }, [pendingRemoveProjectId, project, stopRunningSessionsForProject])

  const pendingRemoveProject = useMemo(
    () =>
      pendingRemoveProjectId
        ? projects.find((p) => p.id === pendingRemoveProjectId)
        : null,
    [pendingRemoveProjectId, projects]
  )

  const newConversation = useCallback(async () => {
    const token = ++switchTokenRef.current
    await detachActiveSession()
    if (token !== switchTokenRef.current) return
    dispatch({ kind: "reset" })
    setSelectedSessionId(null)
    setSelectedSessionMeta(null)
    // 新对话清掉会话级覆盖，回到全局默认
    sessionComposerRef.current = null
    setSessionComposer(null)
    setComposerPrefs(globalDefault)
  }, [detachActiveSession, globalDefault])

  const openSettings = useCallback((section: string = "general") => {
    if (!showSettings) {
      returnViewRef.current = showPlugins ? "plugins" : "chat"
      settingsEntryTargetRef.current =
        !showPlugins && project && selectedSessionMeta
          ? { kind: "session", project, session: selectedSessionMeta }
          : null
    }
    setChatReturnTarget(null)
    setSidebarVisible(true)
    setShowPlugins(false)
    setSettingsSection(typeof section === "string" ? section : "general")
    setShowSettings(true)
  }, [project, selectedSessionMeta, showPlugins, showSettings])

  const openPlugins = useCallback(() => {
    returnViewRef.current = "chat"
    settingsEntryTargetRef.current = null
    setChatReturnTarget(null)
    setSidebarVisible(true)
    setShowSettings(false)
    setShowPlugins(true)
  }, [])

  const returnToChat = useCallback(() => {
    const target = chatReturnTarget ?? settingsEntryTargetRef.current
    const returnView: ReturnView = target ? "chat" : returnViewRef.current
    const currentProjectId = project?.id ?? null
    returnViewRef.current = "chat"
    settingsEntryTargetRef.current = null
    setChatReturnTarget(null)
    setShowSettings(false)
    setShowPlugins(returnView === "plugins")
    if (target?.kind === "session") {
      setShowPlugins(false)
      void switchSession(target.project, target.session)
    } else if (target?.kind === "project") {
      setShowPlugins(false)
      if (currentProjectId === target.project.id && selectedSessionId === null) {
        return
      }
      void switchProject(target.project)
    }
  }, [
    chatReturnTarget,
    project?.id,
    selectedSessionId,
    switchProject,
    switchSession
  ])

  const selectProjectFromSettings = useCallback(
    (p: Project) => {
      setChatReturnTarget({ kind: "project", project: p })
    },
    []
  )

  const selectSessionFromSettings = useCallback(
    (p: Project, s: SessionMeta) => {
      setChatReturnTarget({ kind: "session", project: p, session: s })
    },
    []
  )

  const newConversationFromChrome = useCallback(() => {
    returnViewRef.current = "chat"
    settingsEntryTargetRef.current = null
    setChatReturnTarget(null)
    setShowSettings(false)
    setShowPlugins(false)
    void newConversation()
  }, [newConversation])

  const addProjectFromChrome = useCallback(() => {
    returnViewRef.current = "chat"
    settingsEntryTargetRef.current = null
    setChatReturnTarget(null)
    setShowSettings(false)
    setShowPlugins(false)
    setShowAdd(true)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault()
        newConversationFromChrome()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [newConversationFromChrome])

  const clearProject = useCallback(async () => {
    const token = ++switchTokenRef.current
    await detachActiveSession()
    if (token !== switchTokenRef.current) return
    dispatch({ kind: "reset" })
    setProject(null)
    setSelectedSessionId(null)
    setSelectedSessionMeta(null)
  }, [detachActiveSession])

  const deleteCurrentSession = useCallback(() => {
    if (!project) return
    const target = selectedSessionId ?? findInitSessionId(state)
    if (!target) {
      toast.error("当前还没有 session id，无法删除")
      return
    }
    setShowDeleteConfirm(true)
  }, [project, selectedSessionId, state])

  const performDelete = useCallback(async () => {
    if (!project) return
    const target = selectedSessionId ?? findInitSessionId(state)
    if (!target) {
      setShowDeleteConfirm(false)
      return
    }
    await stopRunningSessionForJsonl(project, target)
    try {
      await deleteSessionJsonl(project.cwd, target)
      // 删除后顺手把残留的置顶 / 归档记录清掉，避免侧栏 / 归档页出现幽灵条目
      unpin(project.id, target)
      unarchive(project.id, target)
      setShowDeleteConfirm(false)
      activeRuntimeIdRef.current = null
      sessionIdRef.current = null
      setSessionId(null)
      setStreaming(false)
      dispatch({ kind: "reset" })
      setSelectedSessionId(null)
      setSelectedSessionMeta(null)
      setSidebarRefreshKey((k) => k + 1)
      toast.success("会话已删除")
    } catch (e) {
      toast.error(`删除失败: ${String(e)}`)
    }
  }, [project, selectedSessionId, state, stopRunningSessionForJsonl])

  const archiveCurrentSession = useCallback(async () => {
    if (!project) return
    const target = selectedSessionId ?? findInitSessionId(state)
    if (!target) {
      toast.error("当前还没有 session id，无法归档")
      return
    }
    const willArchive = !isArchived(project.id, target)
    toggleArchive(project.id, target)
    if (willArchive) {
      // 归档时自动取消置顶，避免置顶区出现一个其实已经隐藏的会话
      unpin(project.id, target)
      await stopRunningSessionForJsonl(project, target)
      dispatch({ kind: "reset" })
      setSelectedSessionId(null)
      setSelectedSessionMeta(null)
      toast.success("会话已归档")
    } else {
      toast.success("已取消归档")
    }
    setSidebarRefreshKey((k) => k + 1)
  }, [project, selectedSessionId, state, stopRunningSessionForJsonl])

  const empty = state.entries.length === 0
  const jsonlSessionId = selectedSessionId ?? findInitSessionId(state)
  const streamingJsonlId = streaming ? jsonlSessionId : null
  const streamingSessionRefs = useMemo(() => {
    const refs: Array<{ projectId: string; sessionId: string }> = []
    for (const run of runningSessionsRef.current.values()) {
      if (!run.streaming) continue
      const sid = run.jsonlSessionId ?? findInitSessionId(run.state)
      if (!sid) continue
      refs.push({ projectId: run.project.id, sessionId: sid })
    }
    const key = refs
      .map((r) => `${r.projectId}::${r.sessionId}`)
      .sort()
      .join("|")
    const cache = streamingRefsCacheRef.current
    if (cache.key === key) return cache.value
    streamingRefsCacheRef.current = { key, value: refs }
    return refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningTick])
  const permissionWaitingSessionRefs = useMemo(() => {
    const refs: Array<{ projectId: string; sessionId: string }> = []
    for (const run of runningSessionsRef.current.values()) {
      if (run.runtimeId === sessionId) continue
      if (run.pendingPermissionRequestIds.size === 0) continue
      const sid = run.jsonlSessionId ?? findInitSessionId(run.state)
      if (!sid) continue
      refs.push({ projectId: run.project.id, sessionId: sid })
    }
    const key = refs
      .map((r) => `${r.projectId}::${r.sessionId}`)
      .sort()
      .join("|")
    const cache = waitingRefsCacheRef.current
    if (cache.key === key) return cache.value
    waitingRefsCacheRef.current = { key, value: refs }
    return refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningTick, sessionId])
  const diffCount = countDiffFiles(state.entries)
  const visibleDiffCount = Math.max(
    diffCount,
    gitStatus?.changedFiles ?? 0,
    diffPatch?.files.length ?? 0
  )
  const slashCommands = findSlashCommands(state)
  const activePermissionRequest =
    permissionRequests.find((request) => request.session_id === sessionId) ??
    null
  void titleTick

  const handleModelEffortChange = useCallback(
    (next: { model?: string; effort?: string }) => {
      setComposerPrefs((cur) => {
        const updated: ComposerPrefs = {
          model: next.model !== undefined ? next.model : cur.model,
          effort: next.effort !== undefined ? next.effort : cur.effort
        }
        // 用户已显式覆盖：标记到 sessionComposer，并尝试写入当前会话的 sidecar。
        // sid 优先级：select 的会话 → reducer init 拿到的 jsonl id（spawn 后第一时间可用）。
        sessionComposerRef.current = updated
        setSessionComposer(updated)
        const activeRuntimeId = activeRuntimeIdRef.current
        const activeRun = activeRuntimeId
          ? runningSessionsRef.current.get(activeRuntimeId)
          : null
        if (activeRun) {
          activeRun.sessionComposer = updated
          activeRun.composerPrefs = updated
        }
        const sid = selectedSessionId ?? findInitSessionId(state)
        if (project && sid) {
          // 读 sidecar → merge composer → 写回，保留其它字段（如 result）
          readSessionSidecar(project.cwd, sid)
            .then((existing) => {
              const base = (existing && typeof existing === "object"
                ? existing
                : {}) as Record<string, unknown>
              const merged = { ...base, composer: updated }
              return writeSessionSidecar(project.cwd, sid, merged)
            })
            .catch((e) => console.warn("sidecar composer write failed:", e))
        }
        return updated
      })
    },
    [project, selectedSessionId, state]
  )

  const modelOptions = useMemo(() => {
    const cfg = loadThirdPartyApiConfig()
    if (!cfg.enabled) return [] as Array<{ value: string; label?: string }>
    return providerModelOptions(cfg).map((model) => ({
      value: model,
      label: model
    }))
  }, [thirdPartyApiVersion])

  const modelOptionValues = useMemo(
    () => new Set(modelOptions.map((option) => option.value)),
    [modelOptions]
  )

  useEffect(() => {
    const shouldKeepModel = (model: string) => {
      const trimmed = model.trim()
      return isClaudeModelEntry(trimmed) || modelOptionValues.has(trimmed)
    }

    setComposerPrefs((cur) =>
      shouldKeepModel(cur.model) ? cur : { ...cur, model: "" }
    )
    setSessionComposer((cur) => {
      if (!cur || shouldKeepModel(cur.model)) return cur
      const next = { ...cur, model: "" }
      return next.effort ? next : null
    })
  }, [modelOptionValues])

  const projectActions = useMemo(() => {
    if (!project) return []
    return getProjectEnv(loadProjectEnvStore(), project.id).actions ?? []
  }, [project?.id, showSettings])

  return (
    <TooltipProvider>
      <>
        <div className="flex h-screen flex-col bg-background text-foreground">
          <AppChrome
            sidebarVisible={sidebarVisible}
            inSettings={showSettings || showPlugins}
            onToggleSidebar={() => setSidebarVisible((v) => !v)}
            onBack={returnToChat}
            onNewConversation={newConversationFromChrome}
            onAddProject={addProjectFromChrome}
            onOpenSettings={openSettings}
          />
          {showSettings ? (
            <Suspense fallback={<PaneLoader label="正在加载设置…" />}>
              <SettingsWorkspace
	                currentCwd={project?.cwd ?? null}
	                sidebarVisible={sidebarVisible}
	                initialSection={settingsSection}
                  onSelectProject={selectProjectFromSettings}
                  onSelectSession={selectSessionFromSettings}
	              />
            </Suspense>
          ) : (
          <div className="flex min-h-0 flex-1 gap-1.5 bg-sidebar p-1.5 pt-1.5">
            {sidebarVisible && (
              <Suspense fallback={<SidebarLoader />}>
                <Sidebar
                  projects={projects}
                  selectedProjectId={project?.id ?? null}
                  selectedSessionId={selectedSessionId}
                  streamingProjectId={streaming ? project?.id ?? null : null}
                  streamingSessionId={streamingJsonlId}
                  streamingSessionRefs={streamingSessionRefs}
                  waitingSessionRefs={permissionWaitingSessionRefs}
                  inPlugins={showPlugins}
                  onSelectProject={(p) => {
                    setShowPlugins(false)
                    switchProject(p)
                  }}
                  onSelectSession={(p, s) => {
                    setShowPlugins(false)
                    switchSession(p, s)
                  }}
                  onAdd={() => setShowAdd(true)}
                  onRemove={handleRemove}
                  onNewConversation={() => {
                    setShowPlugins(false)
                    void newConversation()
                  }}
                  onOpenSettings={() => openSettings()}
                  onOpenPlugins={openPlugins}
                  refreshKey={sidebarRefreshKey}
                />
              </Suspense>
            )}

            <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-background rounded-lg border overflow-hidden">
            {showPlugins ? (
              <Suspense fallback={<PaneLoader label="正在加载插件…" />}>
                <PluginsView
                  cwd={project?.cwd ?? null}
                  onBack={returnToChat}
                />
              </Suspense>
            ) : (
              <>
            {project && !empty && (
              <Suspense fallback={null}>
                <ChatHeader
                  key={`hdr-${selectedSessionId ?? sessionId ?? "new"}-${pinTick}-${titleTick}`}
                  project={project}
                  resumeSessionId={selectedSessionId}
                  jsonlSessionId={jsonlSessionId}
                  title={chatTitle(
                    state,
                    project,
                    jsonlSessionId,
                    selectedSessionMeta
                  )}
                  archived={
                    !!jsonlSessionId && isArchived(project.id, jsonlSessionId)
                  }
                  onPinChange={() => setPinTick((t) => t + 1)}
                  onRename={
                    jsonlSessionId ? () => setShowRename(true) : undefined
                  }
                  onArchive={
                    jsonlSessionId ? archiveCurrentSession : undefined
                  }
                  onDelete={deleteCurrentSession}
                  onShowDiff={() => setShowDiff(true)}
                  diffCount={visibleDiffCount}
                />
              </Suspense>
            )}

            {loadingSession ? (
              <div className="flex-1 min-h-0 grid place-items-center">
                <BuddyLoader />
              </div>
            ) : empty ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
                  <Welcome
                    project={project}
                    onAddProject={() => setShowAdd(true)}
                    suggestions={project ? SUGGESTIONS : undefined}
                    onPickSuggestion={(s) => setDraft(s)}
                  />
                </div>
                {project && (
	                  <div className="shrink-0 px-6 pb-6">
	                    <div className="mx-auto max-w-3xl space-y-2">
                        {projectActions.length > 0 && (
                          <Suspense fallback={null}>
                            <ProjectActionsBar
                              cwd={project.cwd}
                              actions={projectActions}
                            />
                          </Suspense>
                        )}
		                      <Suspense fallback={<ComposerLoader />}>
		                        <Composer
	                          onSend={send}
	                          onStop={stop}
	                          streaming={streaming}
	                          disabled={!cliPath}
	                          centered
	                          externalText={draft}
	                          onExternalTextConsumed={() => setDraft("")}
	                          cwd={project.cwd}
	                          slashCommands={slashCommands}
	                          planMode={planMode}
	                          onPlanModeChange={handlePlanModeChange}
	                          permissionMode={sessionPermissionMode}
	                          onPermissionModeChange={handlePermissionModeChange}
	                          gitStatus={gitStatus}
	                          onGitStatusRefresh={refreshGitStatus}
	                          onOpenPlugins={openPlugins}
	                          oauthUsage={oauthUsage}
	                          model={composerPrefs.model}
	                          effort={composerPrefs.effort}
	                          onModelEffortChange={handleModelEffortChange}
	                          modelOptions={modelOptions}
	                          globalDefault={globalDefault}
	                          sessionPrefs={sessionComposer}
	                        />
	                      </Suspense>
	                      <div className="flex justify-start">
	                        <Suspense fallback={null}>
	                          <ProjectPicker
	                            projects={projects}
	                            current={project}
	                            onSelect={(p) => {
	                              if (p.id !== project.id) switchProject(p)
	                            }}
	                            onAdd={() => setShowAdd(true)}
	                            onClear={clearProject}
	                          />
	                        </Suspense>
	                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
	              <>
	                <Suspense fallback={<PaneLoader label="正在加载会话…" />}>
	                  <MessageStream
	                    key={`stream-${selectedSessionId ?? sessionId ?? "new"}`}
	                    entries={state.entries}
	                    streaming={streaming}
	                  />
	                </Suspense>
                {project && projectActions.length > 0 && (
                  <div className="shrink-0 bg-background px-6 pt-2">
                    <div className="mx-auto max-w-3xl">
                      <Suspense fallback={null}>
                        <ProjectActionsBar
                          cwd={project.cwd}
                          actions={projectActions}
                        />
                      </Suspense>
                    </div>
                  </div>
                )}
	                <Suspense fallback={<ComposerLoader />}>
	                  <Composer
                    onSend={send}
                    onStop={stop}
                    streaming={streaming}
                    disabled={!cliPath || !project}
                    externalText={draft}
                    onExternalTextConsumed={() => setDraft("")}
                    cwd={project?.cwd ?? null}
                    slashCommands={slashCommands}
                    planMode={planMode}
                    onPlanModeChange={handlePlanModeChange}
                    permissionMode={sessionPermissionMode}
                    onPermissionModeChange={handlePermissionModeChange}
                    gitStatus={gitStatus}
                    onGitStatusRefresh={refreshGitStatus}
                    onOpenPlugins={openPlugins}
                    oauthUsage={oauthUsage}
                    model={composerPrefs.model}
                    effort={composerPrefs.effort}
                    onModelEffortChange={handleModelEffortChange}
                    modelOptions={modelOptions}
                    globalDefault={globalDefault}
                    sessionPrefs={sessionComposer}
                  />
                </Suspense>
              </>
            )}
              </>
            )}
            </div>
          </div>
          )}
        </div>

        {showAdd && (
          <Suspense fallback={null}>
            <AddProjectDialog
              open={showAdd}
              onOpenChange={setShowAdd}
              onAdded={onProjectAdded}
            />
          </Suspense>
        )}
        {jsonlSessionId && (
          <Suspense fallback={null}>
            <RenameSessionDialog
              open={showRename}
              onOpenChange={setShowRename}
              initial={getSessionTitle(jsonlSessionId) ?? ""}
              onSubmit={(t) => {
                setSessionTitle(jsonlSessionId, t)
                setTitleTick((n) => n + 1)
                setSidebarRefreshKey((n) => n + 1)
                toast.success(t.trim() ? "标题已保存" : "已恢复默认标题")
              }}
            />
          </Suspense>
        )}
        {showDeleteConfirm && (
          <Suspense fallback={null}>
            <ConfirmDialog
              open={showDeleteConfirm}
              onOpenChange={setShowDeleteConfirm}
              title="删除会话"
              destructive
              confirmText="删除"
              description={
                <span>
                  将永久删除会话{" "}
                  <code className="font-mono text-xs">
                    {(jsonlSessionId ?? "").slice(0, 8)}
                  </code>{" "}
                  的 jsonl 文件，此操作不可恢复。
                </span>
              }
              onConfirm={performDelete}
            />
          </Suspense>
        )}
        {pendingRemoveProjectId && (
          <Suspense fallback={null}>
            <ConfirmDialog
              open={!!pendingRemoveProjectId}
              onOpenChange={(v) => !v && setPendingRemoveProjectId(null)}
              title="从列表移除项目"
              destructive
              confirmText="移除"
              description={
                pendingRemoveProject ? (
                  <span>
                    项目「
                    <span className="font-medium">{pendingRemoveProject.name}</span>
                    」会从侧边栏移除，但磁盘文件与历史会话不会删除。
                  </span>
                ) : null
              }
              onConfirm={performRemoveProject}
            />
          </Suspense>
        )}
        {showDiff && (
          <Suspense fallback={null}>
            <DiffOverview
              open={showDiff}
              onOpenChange={setShowDiff}
              entries={state.entries}
              gitStatus={gitStatus}
              worktreeDiff={diffPatch}
              worktreeDiffLoading={diffPatchLoading}
              worktreeDiffError={diffPatchError}
              cwd={project?.cwd ?? null}
            />
          </Suspense>
        )}
        {activePermissionRequest && (
          <Suspense fallback={null}>
            <PermissionDialog
              request={activePermissionRequest}
              onSettled={settlePermissionRequest}
            />
          </Suspense>
        )}
        <Toaster />
      </>
    </TooltipProvider>
  )
}
