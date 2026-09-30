import { RunStatusStrip } from "@/components/RunReviewCard"
import { MessageStream } from "@/components/MessageStream"
import { QueuedComposerBar } from "@/components/QueuedComposerBar"
import type { SubmissionActions } from "@/components/SubmittedInputActions"
import { SubmissionCoordinator, isActiveInput, type InputPayload, type SubmittedInput, type SubmissionAdapter } from "@/lib/submissionCoordinator"
import { retryInputFromTranscript } from "@/lib/retryInput"
import { cn } from "@/lib/utils"
import { compileUserInput, inputUiBlocks, validateInputSize } from "@/lib/compileUserInput"
import { inputMetadataPatch, restoreInputMetadata, restoreTranscriptInputOrigins } from "@/lib/inputMetadata"
import { isAuthoredUserMessage, markAuthoredEvent } from "@/lib/messageOrigin"
import { routeCommand } from "@/lib/commandRegistry"
import { saveOutbox, removeOutbox, updateOutboxState } from "@/lib/outbox"
import { InputRecovery } from "@/components/InputRecovery"
import { eventInputIds, type SubmitOutcome } from "@/lib/submission"
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
  detectEffortLevels,
  gitWorktreeStatus,
  type GitWorktreeStatus,
  worktreeDiff,
  type WorktreeDiff,
  reviewSnapshotStart,
  reviewSnapshotFinish,
  spawnSession,
  claudeWorkspaceTrustInfo,
  trustClaudeWorkspace,
  sendUserMessage,
  stopSession,
  interruptSession,
  listenSessionEvents,
  listenSessionLifecycle,
  claudeCapabilities,
  listenSessionErrors,
  listenSessionProxyStatus,
  listenPermissionRequests,
  resolvePermissionRequest,
  readSessionTranscript,
  readSessionSidecar,
  patchSessionSidecar,
  deleteSessionJsonl,
  fetchOauthUsage,
  type OauthUsage,
  type PermissionRequestPayload,
  type SessionMeta
} from "@/lib/ipc"
import type { ReviewRunDiff } from "@/lib/diff"
import {
  parseStoredReviewDiffs,
  shouldSyncRunReviewToConversation
} from "@/lib/reviewDiffs"
import { findPermissionMemoryMatch } from "@/lib/permissionMemory"
import {
  buildProxyEnv,
  loadProxyAsync,
  migrateLegacyProxyPassword
} from "@/lib/proxy"
import {
  proxyStatusErrorText,
  reduceProxyStatus,
  shouldTrackProxyStatus,
  type UpstreamStatusState
} from "@/lib/proxyStatus"
import { UpstreamStatusBanner } from "@/components/UpstreamStatusBanner"
import { loadSettings, recordResultUsage } from "@/lib/settings"
import type { AppSettings } from "@/lib/settings"
import {
  EMPTY_COMPOSER_PREFS,
  composerPrefsPatchFromCommandEvent,
  fallbackComposerPrefsForApiProfile,
  isComposerModelAllowed,
  loadGlobalDefault,
  mergeComposerPrefs,
  pickComposerFromSidecar,
  pickComposerFromTranscript,
  type ComposerPrefs
} from "@/lib/composerPrefs"
import {
  ComposerDraftStore,
  type ComposerDraft
} from "@/lib/composerDrafts"
import {
  enabledProviderList,
  loadCollabSettings,
  providerPathEnv
} from "@/lib/collabSettings"
import { getProjectEnv, loadProjectEnvStore } from "@/lib/projectEnv"
import { saveMcpStatusCache } from "@/lib/mcp"
import {
  mergeSlashCommands,
  saveSlashCommandsCache,
  slashCommandsFromSkills
} from "@/lib/slashCommands"
import {
  listSkills,
  type Skill,
  type SkillInvocation
} from "@/lib/plugins"
import {
  buildClaudeLaunchEnv,
  cleanupManagedGlobalClaudeSettings,
  loadThirdPartyApiConfig,
  loadThirdPartyApiConfigAsync,
  loadThirdPartyApiStore,
  migrateLegacyThirdPartyApiKeys,
  OFFICIAL_PROVIDER_ID,
  canUseApiProfileLaunchPrefs,
  providerComposerModelOptions,
  resolveThirdPartyComposerLaunchModel,
  resolveThirdPartyDefaultLaunchModel,
  thirdPartyApiConnectionProfileKey,
  thirdPartyApiRuntimeProfileKey,
  trimApiUrl
} from "@/lib/thirdPartyApi"
import { isOfficialApi } from "@/lib/oauthUsage"
import {
  markInterruptedResult,
  reduce,
  init as reducerInit,
  type Action as ReducerAction,
  type State as ReducerState
} from "@/lib/reducer"
import {
  reduceSubagentRegistry,
  runningSubagentCount,
  settleSubagentRegistryForResume,
  subagentRegistryBusy,
  type SubagentRegistry
} from "@/lib/subagents"
import {
  listProjects,
  removeProject as removeProjectStore,
  type Project
} from "@/lib/projects"
import type { DocumentPayload, ImagePayload } from "@/types/ui"
import type { ClaudeEvent } from "@/types/events"
import { Welcome } from "@/components/Welcome"
import { BuddyLoader } from "@/components/BuddyLoader"
import { AppChrome } from "@/components/AppChrome"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { getSessionTitle, setSessionTitle } from "@/lib/sessionTitles"
import {
  cleanSessionTitleText,
  sessionDisplayTitle,
  sessionGeneratedTitle
} from "@/lib/sessionDisplayTitle"
import {
  isArchived,
  toggleArchive,
  unarchive
} from "@/lib/archivedSessions"
import { unpin } from "@/lib/pinned"
import { subscribeSettingsBus } from "@/lib/settingsBus"
import { checkForAppUpdate } from "@/lib/updater"
import {
  detectNetworkError,
  type NetworkErrorTopic
} from "@/lib/networkErrorHints"
import {
  findFirstTurnFailedMessageId,
  hasResumableUiConversationContext
} from "@/lib/failedSessionCleanup"
import { isAskUserQuestionRequest } from "@/lib/askUserQuestion"
import { autoApprovePermissionRequest } from "@/lib/permissionPolicy"
import {
  pickPermissionModeFromSidecar,
  type SessionPermissionModeSource
} from "@/lib/sessionPermissionMode"
import { isEditableShortcutTarget } from "@/lib/keyboard"
import {
  shouldPromptClaudeWorkspaceTrust,
  type ClaudeWorkspaceTrustInfo
} from "@/lib/claudeWorkspaceTrust"

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
const ClaudeWorkspaceTrustDialog = lazy(() =>
  import("@/components/ClaudeWorkspaceTrustDialog").then((m) => ({
    default: m.ClaudeWorkspaceTrustDialog
  }))
)
const PluginsView = lazy(() =>
  import("@/components/PluginsView").then((m) => ({ default: m.PluginsView }))
)
const HistoryView = lazy(() =>
  import("@/components/HistoryView").then((m) => ({ default: m.HistoryView }))
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
const CollaborationFlow = lazy(() =>
  import("@/components/CollaborationFlow").then((m) => ({
    default: m.CollaborationFlow
  }))
)
const SubagentsPanel = lazy(() =>
  import("@/components/SubagentsPanel").then((m) => ({
    default: m.SubagentsPanel
  }))
)
const PermissionDialog = lazy(() =>
  import("@/components/PermissionDialog").then((m) => ({
    default: m.PermissionDialog
  }))
)
const UserInputDialog = lazy(() =>
  import("@/components/UserInputDialog").then((m) => ({
    default: m.UserInputDialog
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
      <div className="mx-auto max-w-3xl rounded-[24px] border bg-card p-4 shadow-sm xl:max-w-4xl 2xl:max-w-5xl">
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

type QueuedInputMode = "guide" | "followup"
type QueuedInput = {
  localId: string
  mode: QueuedInputMode
  text: string
  images: ImagePayload[]
  documents: DocumentPayload[]
  cliBlocks: Array<Record<string, unknown>>
  skillInvocation?: SkillInvocation | null
}
type SentInput = {
  localId: string
  text: string
  images: ImagePayload[]
  documents: DocumentPayload[]
  cliBlocks: Array<Record<string, unknown>>
  skillInvocation?: SkillInvocation | null
  ts: number
}
type SendOptions = {
  mode?: QueuedInputMode
  localId?: string
  cliBlocks?: Array<Record<string, unknown>>
  skillInvocation?: SkillInvocation | null
  sentAt?: number
  bypassPreprocess?: boolean
  sourceDraftRevision?: number
  draftKey?: string
  payload?: InputPayload
}
type PendingDeleteSession = {
  project: Project
  sessionId: string
  title: string
}
type PendingClaudeWorkspaceTrust = {
  cwd: string
  info: ClaudeWorkspaceTrustInfo
}
type ReturnView = "chat" | "plugins" | "history"
type ChatReturnTarget =
  | { kind: "project"; project: Project }
  | { kind: "session"; project: Project; session: SessionMeta }

type ConversationOwner = {
  key: string
  project: Project
  sessionId: string | null
  runtimeId: string | null
  state: ReducerState
  selectedSessionMeta: SessionMeta | null
  reviewDiffs: ReviewRunDiff[]
  composerPrefs: ComposerPrefs
  sessionComposer: ComposerPrefs | null
  permissionMode: AppSettings["defaultPermissionMode"]
  permissionModeSource: SessionPermissionModeSource
  profileRevision: string
  fork: { sourceId: string; resumeAt: string } | null
}
type InputContext = { approvedCommand?: string; authorizationRevision: string; composerPrefs: ComposerPrefs; sessionComposer: ComposerPrefs | null; permissionMode: AppSettings["defaultPermissionMode"]; owner: ConversationOwner; options: SendOptions; collaborationMode: boolean; cliBlocks?: Array<Record<string, unknown>> }

type RunningSession = {
  midTurnInput: boolean
  owner: ConversationOwner
  runtimeId: string
  project: Project
  jsonlSessionId: string | null
  launchModel: string | null
  apiProfileKey: string
  apiLaunchProfileKey: string
  selectedSessionMeta: SessionMeta | null
  state: ReducerState
  /** 当前前台 turn 已发出、尚未收到该 turn 的 result。 */
  activeInputId: string | null
  sendingQueued: boolean
  turnActive: boolean
  /** 主会话观察到的 Claude 异步 Agent 生命周期。 */
  subagents: SubagentRegistry
  /** 整体忙碌态：前台 turn 或异步 Agent 汇总周期仍在进行。 */
  streaming: boolean
  /** 软中断进行中：已写 interrupt control_request，等待 result 或兜底强杀 */
  interrupting: boolean
  /** 软中断超时强杀兜底定时器 id（清理点：result、兜底触发、closeRunningSession） */
  interruptTimer: number | null
  pendingPermissionRequestIds: Set<string>
  pendingActions: ReducerAction[]
  queuedInputs: QueuedInput[]
  unlisten: UnlistenFn[]
  permissionMode: AppSettings["defaultPermissionMode"]
  permissionModeSource: SessionPermissionModeSource
  composerPrefs: ComposerPrefs
  sessionComposer: ComposerPrefs | null
  collabMcpEnabled: boolean
  reviewSnapshotId: string | null
  reviewDiffs: ReviewRunDiff[]
  upstreamStatus: UpstreamStatusState | null
}

const ONE_MILLION_CONTEXT_SUFFIX = "[1m]"

function stripOneMillionContextSuffix(model: string): string {
  return model.endsWith(ONE_MILLION_CONTEXT_SUFFIX)
    ? model.slice(0, -ONE_MILLION_CONTEXT_SUFFIX.length)
    : model
}

function eventWithLaunchModelIntent(
  run: RunningSession,
  ev: ClaudeEvent
): ClaudeEvent {
  const launchModel = run.launchModel?.trim()
  if (!launchModel || !launchModel.endsWith(ONE_MILLION_CONTEXT_SUFFIX)) return ev
  if (
    (ev as { type?: string }).type !== "system" ||
    (ev as { subtype?: string }).subtype !== "init"
  ) {
    return ev
  }
  const eventModel = (ev as { model?: unknown }).model
  if (
    typeof eventModel !== "string" ||
    eventModel.trim() !== stripOneMillionContextSuffix(launchModel)
  ) {
    return ev
  }
  return { ...ev, requested_model: launchModel }
}

type DiffPanelScope =
  | { kind: "all" }
  | { kind: "review"; review: ReviewRunDiff }

async function sendCliInput(
  sessionId: string,
  blocks: Array<Record<string, unknown>>,
  _skillInvocation?: SkillInvocation | null,
  clientMessageId?: string,
  midTurn?: boolean
): Promise<void> {
  // Preserve raw command and every attachment in one native user input payload.
  await sendUserMessage(sessionId, blocks, clientMessageId, midTurn)
}

// The original input is restored by UUID sidecar metadata; literal markers are never stripped.
const COLLAB_PREFIX_TAG = "[Claudinal 协同模式]"
const COLLAB_PROMPT_SEPARATOR = "\n\n用户需求：\n"

function buildCollaborationPrompt(text: string, cfg: ReturnType<typeof loadCollabSettings>) {
  const enabledProviders = enabledProviderList(cfg)
  // 包装尽量短，避免污染 AI title 和侧栏会话标题；详细职责放在 collab_status 工具返回里，
  // Claude 自己第一次调用 collab_status 时获取。
  const header = [
    `${COLLAB_PREFIX_TAG} 请使用已加载的 claudinal_collab MCP 工具按线性步骤完成本任务。`,
    `规则：先 collab_start_flow，再 collab_delegate；写入步骤必须显式 writeAllowed=true 与 allowedPaths；下一步必须等上一步 approved 或 verified。`,
    `Agent：默认 ${cfg.defaultProvider}；已启用 ${enabledProviders.length ? enabledProviders.join("/") : "无"}；用户未指定时使用默认。`
  ].join("\n")
  return `${header}${COLLAB_PROMPT_SEPARATOR}${text}`
}

function currentAuthorizationRevision(): string {
  const cfg = loadSettings()
  return JSON.stringify([cfg.defaultPermissionMode, cfg.permissionMcpEnabled, cfg.permissionPromptTool, cfg.permissionMcpConfig])
}

function currentApiProfileKey(): string {
  const store = loadThirdPartyApiStore()
  if (store.activeProviderId === OFFICIAL_PROVIDER_ID) return "official"
  const provider = store.providers.find((p) => p.id === store.activeProviderId)
  if (!provider) return "official"
  return thirdPartyApiConnectionProfileKey({ ...provider, enabled: true })
}

function currentApiLaunchProfileKey(): string {
  const store = loadThirdPartyApiStore()
  if (store.activeProviderId === OFFICIAL_PROVIDER_ID) return "official"
  const provider = store.providers.find((p) => p.id === store.activeProviderId)
  if (!provider) return "official"
  return thirdPartyApiRuntimeProfileKey({ ...provider, enabled: true })
}

function currentComposerDefault(globalDefault: ComposerPrefs): ComposerPrefs {
  return fallbackComposerPrefsForApiProfile(currentApiProfileKey(), globalDefault)
}

function sidecarApiProfileKey(sidecar: unknown): string | null {
  if (!sidecar || typeof sidecar !== "object") return null
  const connectionRaw = (sidecar as { apiConnectionProfileKey?: unknown })
    .apiConnectionProfileKey
  if (typeof connectionRaw === "string" && connectionRaw.trim()) {
    return connectionRaw.trim()
  }
  const raw = (sidecar as { apiProfileKey?: unknown }).apiProfileKey
  return typeof raw === "string" && raw.trim() ? raw.trim() : null
}

function sidecarApiLaunchProfileKey(sidecar: unknown): string | null {
  if (!sidecar || typeof sidecar !== "object") return null
  const raw = (sidecar as { apiLaunchProfileKey?: unknown }).apiLaunchProfileKey
  if (typeof raw === "string" && raw.trim()) return raw.trim()
  return sidecarApiProfileKey(sidecar)
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
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index]
    if (entry.kind === "system_init" && entry.sessionId) return entry.sessionId
  }
  return null
}

function findSlashCommands(
  state: ReturnType<typeof reducerInit>,
  installedSkillCommands: string[] = []
): string[] {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i]
    if (entry.kind === "system_init") return mergeSlashCommands(entry.slashCommands, entry.skills)
  }
  return mergeSlashCommands(["clear", "reset", "permissions"], installedSkillCommands)
}

function applyComposerPatch(
  current: ComposerPrefs,
  patch: Partial<ComposerPrefs>
): ComposerPrefs {
  return {
    model: patch.model !== undefined ? patch.model : current.model,
    effort: patch.effort !== undefined ? patch.effort : current.effort
  }
}

function nullableComposerPrefs(prefs: ComposerPrefs): ComposerPrefs | null {
  return prefs.model || prefs.effort ? prefs : null
}

function sameComposerPrefs(a: ComposerPrefs, b: ComposerPrefs): boolean {
  return a.model === b.model && a.effort === b.effort
}

const SEND_STEP_WARN_MS = 1_000

/** 软中断兜底：interrupt 发出后超过该时长仍在 streaming，则强杀会话进程。 */
const INTERRUPT_FALLBACK_MS = 6_000

function monotonicMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

async function measureSendStep<T>(
  label: string,
  task: () => Promise<T>,
  warnAfterMs = SEND_STEP_WARN_MS
): Promise<T> {
  const startedAt = monotonicMs()
  try {
    return await task()
  } finally {
    const elapsed = monotonicMs() - startedAt
    if (elapsed >= warnAfterMs) {
      console.warn(`[send] ${label} took ${Math.round(elapsed)}ms`)
    }
  }
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

function collectFailedRetryableMessageIds(
  entries: ReturnType<typeof reducerInit>["entries"],
  sentInputs: ReadonlyMap<string, SentInput>
): Set<string> {
  const ids = new Set<string>()
  let currentUserId: string | null = null
  for (const entry of entries) {
    if (isAuthoredUserMessage(entry)) {
      currentUserId = sentInputs.has(entry.id) ? entry.id : null
      continue
    }
    if (entry.kind !== "result") continue
    if (
      entry.isError &&
      entry.terminalReason !== "interrupted" &&
      currentUserId
    ) {
      ids.add(currentUserId)
    }
    currentUserId = null
  }
  if (
    entries.some(
      (entry) =>
        entry.kind === "result" &&
        entry.isError &&
        entry.terminalReason !== "interrupted"
    )
  ) {
    const firstTurnId = findFirstTurnFailedMessageId(entries, sentInputs)
    if (firstTurnId) ids.add(firstTurnId)
  }
  return ids
}

function hasResumableConversationContext(
  entries: ReturnType<typeof reducerInit>["entries"]
): boolean {
  return hasResumableUiConversationContext(entries)
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
  const [showHistory, setShowHistory] = useState(false)
  const [chatReturnTarget, setChatReturnTarget] =
    useState<ChatReturnTarget | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [settingsSection, setSettingsSection] = useState("general")
  const [inputConfirmation, setInputConfirmation] = useState<{ title: string; description: string; confirmText: string } | null>(null)
  const inputDecisionRef = useRef<((accepted: boolean) => void) | null>(null)
  const confirmInputAction = useCallback((title: string, description: string, confirmText: string) => new Promise<boolean>((resolve) => {
    inputDecisionRef.current?.(false)
    inputDecisionRef.current = resolve
    setInputConfirmation({ title, description, confirmText })
  }), [])
  const settleInputAction = useCallback((accepted: boolean) => {
    const resolve = inputDecisionRef.current
    inputDecisionRef.current = null
    setInputConfirmation(null)
    resolve?.(accepted)
  }, [])
  useEffect(() => () => { inputDecisionRef.current?.(false) }, [])
  const [planMode, setPlanMode] = useState(false)
  const [collaborationMode, setCollaborationMode] = useState(false)
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
  // claude --help 动态解析的 effort 档位（空数组 = 回退内置清单）
  const [effortLevels, setEffortLevels] = useState<string[]>([])
  useEffect(() => {
    let generation = 0
    const refreshEffortLevels = () => {
      const request = ++generation
      void detectEffortLevels().then((levels) => {
        if (request === generation) setEffortLevels(levels)
      }).catch(() => {
        if (request === generation) setEffortLevels([])
      })
    }
    refreshEffortLevels()
    window.addEventListener("claudinal:cli-installation-changed", refreshEffortLevels)
    return () => {
      generation++
      window.removeEventListener("claudinal:cli-installation-changed", refreshEffortLevels)
    }
  }, [])
  // 当前会话的"已显式覆盖" composer prefs（来自 sidecar），用于 effortSource 判定
  const [sessionComposer, setSessionComposer] = useState<ComposerPrefs | null>(
    null
  )
  const [thirdPartyApiVersion, setThirdPartyApiVersion] = useState(0)
  const [oauthUsage, setOauthUsage] = useState<OauthUsage | null>(null)
  const [draft, setDraft] = useState("")
  const [draftImages, setDraftImages] = useState<ImagePayload[]>([])
  const [draftDocuments, setDraftDocuments] = useState<DocumentPayload[]>([])
  const [pinTick, setPinTick] = useState(0)
  const [titleTick, setTitleTick] = useState(0)
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0)
  const [showRename, setShowRename] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [diffScope, setDiffScope] = useState<DiffPanelScope>({ kind: "all" })
  const [diffInitialPath, setDiffInitialPath] = useState<string | null>(null)
  const [showCollabFlow, setShowCollabFlow] = useState(false)
  const [showSubagents, setShowSubagents] = useState(false)
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null)
  const [collabSettingsTick, setCollabSettingsTick] = useState(0)
  const [installedSkillCommands, setInstalledSkillCommands] = useState<string[]>([])
  const [skillPreview, setSkillPreview] = useState<Skill[]>([])
  const [skillPreviewStale, setSkillPreviewStale] = useState(false)
  const skillRequestRef = useRef(0)
  const [pendingDeleteSession, setPendingDeleteSession] =
    useState<PendingDeleteSession | null>(null)
  const [pendingRemoveProjectId, setPendingRemoveProjectId] = useState<
    string | null
  >(null)
  const [loadingSession, setLoadingSession] = useState(false)
  const [runningTick, setRunningTick] = useState(0)
  const [gitStatus, setGitStatus] = useState<GitWorktreeStatus | null>(null)
  const [diffPatch, setDiffPatch] = useState<WorktreeDiff | null>(null)
  const [diffPatchLoading, setDiffPatchLoading] = useState(false)
  const [diffPatchError, setDiffPatchError] = useState<string | null>(null)
  const [reviewDiffs, setReviewDiffs] = useState<ReviewRunDiff[]>([])
  const [permissionRequests, setPermissionRequests] = useState<
    PermissionRequestPayload[]
  >([])
  const [pendingClaudeWorkspaceTrust, setPendingClaudeWorkspaceTrust] =
    useState<PendingClaudeWorkspaceTrust | null>(null)
  const [sentInputVersion, setSentInputVersion] = useState(0)
  // fork 功能已废弃，未来基于 CLI --fork-session 重做（plan.md §9.1.1）
  const stateRef = useRef<ReducerState>(reducerInit())
  const sessionIdRef = useRef<string | null>(null)
  const selectedSessionIdRef = useRef<string | null>(null)
  const activeRuntimeIdRef = useRef<string | null>(null)
  const runningSessionsRef = useRef<Map<string, RunningSession>>(new Map())
  const sentInputsRef = useRef<Map<string, SentInput>>(new Map())
  const sessionComposerRef = useRef<ComposerPrefs | null>(null)
  const composerDraftsRef = useRef(new ComposerDraftStore())
  const apiProfileKeyRef = useRef(currentApiProfileKey())
  const apiLaunchProfileKeyRef = useRef(currentApiLaunchProfileKey())
  const permissionModeSourceRef =
    useRef<SessionPermissionModeSource>("default")
  const returnViewRef = useRef<ReturnView>("chat")
  const settingsEntryTargetRef = useRef<ChatReturnTarget | null>(null)
  const permissionUnlistenRef = useRef<UnlistenFn | null>(null)
  const collabMcpEnabledRef = useRef(false)
  const installedSkillCommandsRef = useRef<string[]>([])
  const switchTokenRef = useRef(0)
  const ownersRef = useRef(new Map<string, ConversationOwner>())
  const viewOwnerRef = useRef({ token: -1, projectId: "", key: "" })
  if (viewOwnerRef.current.token !== switchTokenRef.current || viewOwnerRef.current.projectId !== (project?.id ?? "")) {
    const known = [...ownersRef.current.values()].find((owner) => owner.project.id === project?.id && selectedSessionId && owner.sessionId === selectedSessionId)
    viewOwnerRef.current = { token: switchTokenRef.current, projectId: project?.id ?? "", key: known?.key ?? crypto.randomUUID() }
  }
  const activeConversationKey = viewOwnerRef.current.key
  const currentUiIntentRef = useRef({ key: activeConversationKey, composerPrefs, permissionMode: planMode ? "plan" : sessionPermissionMode })
  currentUiIntentRef.current = { key: activeConversationKey, composerPrefs, permissionMode: planMode ? "plan" : sessionPermissionMode }
  const submissionAdapterRef = useRef<SubmissionAdapter<InputContext>>(null!)
  const coordinatorRef = useRef<SubmissionCoordinator<InputContext>>(null!)
  if (!coordinatorRef.current) coordinatorRef.current = new SubmissionCoordinator<InputContext>({
    changed: (task) => submissionAdapterRef.current.changed(task),
    persist: (task) => submissionAdapterRef.current.persist(task),
    prepare: (task) => submissionAdapterRef.current.prepare(task),
    write: (task) => submissionAdapterRef.current.write(task),
    settled: (task) => submissionAdapterRef.current.settled(task)
  })
  const pendingApiRuntimeRefreshRef = useRef(false)
  const pendingComposerRuntimeRefreshRef = useRef(false)
  const streamingRefsCacheRef = useRef<{
    key: string
    value: Array<{ projectId: string; sessionId: string }>
  }>({ key: "", value: [] })
  const waitingRefsCacheRef = useRef<{
    key: string
    value: Array<{ projectId: string; sessionId: string }>
  }>({ key: "", value: [] })
  const claudeWorkspaceTrustDecisionRef = useRef<
    ((trusted: boolean) => void) | null
  >(null)
  const claudeWorkspaceTrustCheckRef = useRef<Promise<boolean> | null>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId
  }, [selectedSessionId])

  useEffect(() => {
    installedSkillCommandsRef.current = installedSkillCommands
  }, [installedSkillCommands])

  const settleClaudeWorkspaceTrust = useCallback((trusted: boolean) => {
    const resolve = claudeWorkspaceTrustDecisionRef.current
    claudeWorkspaceTrustDecisionRef.current = null
    setPendingClaudeWorkspaceTrust(null)
    resolve?.(trusted)
  }, [])

  const ensureClaudeWorkspaceTrust = useCallback(async (): Promise<boolean> => {
    if (!project) return true
    if (activeRuntimeIdRef.current ?? sessionIdRef.current) return true
    if (claudeWorkspaceTrustCheckRef.current) {
      return claudeWorkspaceTrustCheckRef.current
    }

    const cwd = project.cwd
    const switchToken = switchTokenRef.current
    const check = (async () => {
      let info: ClaudeWorkspaceTrustInfo
      try {
        info = await claudeWorkspaceTrustInfo(cwd)
      } catch (error) {
        toast.error(`检查 Claude 工作区信任失败：${String(error)}`)
        return false
      }
      if (switchToken !== switchTokenRef.current) return false
      if (!shouldPromptClaudeWorkspaceTrust(info)) return true

      return new Promise<boolean>((resolve) => {
        claudeWorkspaceTrustDecisionRef.current = resolve
        setPendingClaudeWorkspaceTrust({ cwd, info })
      })
    })()
    claudeWorkspaceTrustCheckRef.current = check
    try {
      return await check
    } finally {
      if (claudeWorkspaceTrustCheckRef.current === check) {
        claudeWorkspaceTrustCheckRef.current = null
      }
    }
  }, [project])

  const trustPendingClaudeWorkspace = useCallback(async () => {
    if (!pendingClaudeWorkspaceTrust) {
      throw new Error("没有待确认的 Claude 工作区")
    }
    const info = await trustClaudeWorkspace(pendingClaudeWorkspaceTrust.cwd)
    if (!info.trusted) {
      throw new Error("Claude 工作区信任状态未写入")
    }
    settleClaudeWorkspaceTrust(true)
  }, [pendingClaudeWorkspaceTrust, settleClaudeWorkspaceTrust])

  useEffect(() => {
    if (
      pendingClaudeWorkspaceTrust &&
      pendingClaudeWorkspaceTrust.cwd !== project?.cwd
    ) {
      settleClaudeWorkspaceTrust(false)
    }
  }, [pendingClaudeWorkspaceTrust, project?.cwd, settleClaudeWorkspaceTrust])

  useEffect(
    () => () => {
      const resolve = claudeWorkspaceTrustDecisionRef.current
      claudeWorkspaceTrustDecisionRef.current = null
      resolve?.(false)
    },
    []
  )

  const rememberSentInput = useCallback((input: SentInput) => {
    const map = sentInputsRef.current
    map.set(input.localId, input)
    if (map.size > 200) {
      const first = map.keys().next().value
      if (first) map.delete(first)
    }
    setSentInputVersion((version) => version + 1)
  }, [])

  const applyPermissionModeState = useCallback(
    (
      mode: AppSettings["defaultPermissionMode"],
      source: SessionPermissionModeSource
    ) => {
      permissionModeSourceRef.current = source
      setSessionPermissionMode(mode)
      setPlanMode(mode === "plan")
    },
    []
  )

  const applyDefaultPermissionModeState = useCallback(() => {
    applyPermissionModeState(loadSettings().defaultPermissionMode, "default")
  }, [applyPermissionModeState])

  const applyInstalledSkills = useCallback((skills: Skill[]) => {
    const commands = slashCommandsFromSkills(skills)
    installedSkillCommandsRef.current = commands
    setInstalledSkillCommands(commands)
    saveSlashCommandsCache(findSlashCommands(stateRef.current, commands))
  }, [])

  const refreshInstalledSkills = useCallback(async () => {
    const request = ++skillRequestRef.current
    try {
      const skills = await listSkills(project?.cwd ?? null)
      if (request !== skillRequestRef.current) return
      setSkillPreview(skills)
      setSkillPreviewStale(false)
      applyInstalledSkills(skills)
    } catch (error) {
      if (request !== skillRequestRef.current) return
      setSkillPreviewStale(true)
      console.warn("读取技能列表失败:", error)
    }
  }, [applyInstalledSkills, project?.cwd])

  useEffect(() => {
    void refreshInstalledSkills()
  }, [refreshInstalledSkills])

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
    run.owner.state = next
    if (activeRuntimeIdRef.current === run.runtimeId) {
      dispatch({ kind: "replace_state", state: next })
      stateRef.current = next
    }
  }, [])

  const applyRunningAction = useCallback(
    (run: RunningSession, action: ReducerAction) => {
      run.state = reduce(run.state, action)
      run.owner.state = run.state
      if (activeRuntimeIdRef.current === run.runtimeId) {
        stateRef.current = run.state
        dispatch(action)
      }
      if (run.jsonlSessionId && (action.kind === "submitted_input" || action.kind === "user_local" || action.kind === "delivery_changed" || action.kind === "runtime_exited" || (action.kind === "event" && action.event.type === "user"))) {
        void patchSessionSidecar(run.project.cwd, run.jsonlSessionId, inputMetadataPatch(run.state)).catch((error) => console.warn("input metadata persistence failed", error))
      }
    },
    []
  )

  const syncRunningSessionStreaming = useCallback((run: RunningSession) => {
    const next = run.turnActive || subagentRegistryBusy(run.subagents)
    if (run.streaming === next) return
    run.streaming = next
    if (activeRuntimeIdRef.current === run.runtimeId) {
      setStreaming(next)
    }
    setRunningTick((tick) => tick + 1)
  }, [])

  const setRunningSessionTurnActive = useCallback(
    (run: RunningSession, next: boolean) => {
      run.turnActive = next
      syncRunningSessionStreaming(run)
    },
    [syncRunningSessionStreaming]
  )

  // 同一会话同一类网络错误在 NETWORK_TOAST_THROTTLE_MS 内只弹一次，
  // 避免代理失效后 stderr 持续刷屏。
  const networkToastTimestampsRef = useRef<
    Map<string, Map<NetworkErrorTopic, number>>
  >(new Map())
  const NETWORK_TOAST_THROTTLE_MS = 30_000
  // openSettings 定义在更下方，用 ref 中转避免 useCallback 依赖循环。
  const openSettingsRef = useRef<(section?: string) => void>(() => {})

  const reportNetworkError = useCallback(
    (
      runtimeId: string,
      source: "stderr" | "result" | "proxy",
      raw: string | null | undefined
    ) => {
      const hit = detectNetworkError(raw)
      if (!hit) return
      let perSession = networkToastTimestampsRef.current.get(runtimeId)
      if (!perSession) {
        perSession = new Map()
        networkToastTimestampsRef.current.set(runtimeId, perSession)
      }
      const now = Date.now()
      const lastAt = perSession.get(hit.topic) ?? 0
      if (now - lastAt < NETWORK_TOAST_THROTTLE_MS) return
      perSession.set(hit.topic, now)
      const sourceInfo =
        source === "stderr"
          ? { label: "CLI", settingsSection: "network", actionLabel: "网络设置" }
          : source === "proxy"
            ? {
                label: "第三方 API 本地代理",
                settingsSection: "third-party-api",
                actionLabel: "第三方 API"
              }
            : { label: "结果", settingsSection: "network", actionLabel: "网络设置" }
      toast.error(hit.summary, {
        description: `${hit.toastHint}来源：${sourceInfo.label}`,
        duration: 9_000,
        action: {
          label: sourceInfo.actionLabel,
          onClick: () => openSettingsRef.current(sourceInfo.settingsSection)
        }
      })
    },
    []
  )

  const persistReviewDiffs = useCallback((run: RunningSession) => {
    const sid = run.jsonlSessionId
    if (!sid) return
    patchSessionSidecar(run.project.cwd, sid, { reviewDiffs: run.reviewDiffs })
      .then(() => setSidebarRefreshKey((tick) => tick + 1))
      .catch((error) => {
        toast.error(`保存文件 diff 记录失败: ${String(error)}`)
      })
  }, [])

  /**
   * 为当前回合建立审查基线。返回是否新建了快照。
   * 守卫：run 上已有未结算的基线时直接复用（返回 false）——
   * result→finishRunReview 的间隙里用户手动开新回合、随后排队跟进经
   * sendQueuedFollowup 并入该回合时会带着活基线再次进来，此时覆盖
   * reviewSnapshotId 会让旧快照永远无人 finish/discard（Rust 侧临时目录泄漏）；
   * 复用更早的基线还能让 diff 覆盖两次输入的全部改动。
   */
  const beginRunReview = useCallback(
    async (run: RunningSession | null): Promise<boolean> => {
      if (!run) return false
      if (run.reviewSnapshotId) return false
      try {
        const snapshot = await reviewSnapshotStart(run.project.cwd)
        run.reviewSnapshotId = snapshot.id
        return true
      } catch (e) {
        run.reviewSnapshotId = null
        toast.error(`建立文件审查基线失败: ${String(e)}`)
        throw e
      }
    },
    []
  )

  const finishRunReview = useCallback(async (run: RunningSession) => {
    const snapshotId = run.reviewSnapshotId
    run.reviewSnapshotId = null
    const appendReview = (review: ReviewRunDiff) => {
      run.reviewDiffs = [...run.reviewDiffs, review]
      run.owner.reviewDiffs = run.reviewDiffs
      const runSessionId = run.jsonlSessionId
      if (shouldSyncRunReviewToConversation(
        activeRuntimeIdRef.current,
        run.runtimeId,
        selectedSessionIdRef.current,
        runSessionId
      )) {
        setReviewDiffs(run.reviewDiffs)
      }
      persistReviewDiffs(run)
      setRunningTick((tick) => tick + 1)
    }
    if (!snapshotId) {
      appendReview({
        id: `empty-${Date.now()}`,
        createdAt: Date.now(),
        diff: { isRepo: false, files: [], patchError: null }
      })
      return
    }
    try {
      const diff = await reviewSnapshotFinish(snapshotId)
      appendReview({
        id: snapshotId,
        createdAt: Date.now(),
        diff
      })
    } catch (e) {
      toast.error(`生成文件审查 diff 失败: ${String(e)}`)
      appendReview({
        id: snapshotId,
        createdAt: Date.now(),
        diff: { isRepo: false, files: [], patchError: String(e) }
      })
    }
  }, [persistReviewDiffs])

  const discardRunReview = useCallback(async (run: RunningSession | null) => {
    const snapshotId = run?.reviewSnapshotId
    if (!run || !snapshotId) return
    run.reviewSnapshotId = null
    try {
      await reviewSnapshotFinish(snapshotId)
    } catch (e) {
      toast.error(`清理文件审查基线失败: ${String(e)}`)
    }
  }, [])

  const restoreQueuedInputsToDraft = useCallback((
    items: QueuedInput[],
    action: "restore" | "copy" = "restore"
  ) => {
    if (items.length === 0) return
    const text = items
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n\n")
    const images = items.flatMap((item) => item.images)
    const documents = items.flatMap((item) => item.documents)
    if (text) setDraft(text)
    setDraftImages(images)
    setDraftDocuments(documents)
    toast.info(
      action === "copy"
        ? "已复制文本到编辑器"
        : items.length === 1
          ? "已把队列消息取回到聊天框"
          : `已把 ${items.length} 条队列消息取回到聊天框`
    )
  }, [])

  const notifyQueuedRecovery = useCallback((items: QueuedInput[]) => {
    if (items.length) toast.info(`${items.length} 条未发送输入已保留在本地恢复区`)
  }, [])

  const rememberComposerDraft = useCallback(
    (key: string | undefined, next: ComposerDraft) => {
      if (!key) return
      composerDraftsRef.current.set(key, next)
    },
    []
  )

  /**
   * 清理软中断状态：取消强杀兜底定时器并复位 interrupting 标志。
   * 调用点：result 事件到达、stdin 写入失败回退强杀、closeRunningSession。
   */
  const clearInterruptState = useCallback((run: RunningSession) => {
    if (run.interruptTimer !== null) {
      window.clearTimeout(run.interruptTimer)
      run.interruptTimer = null
    }
    if (run.interrupting) {
      run.interrupting = false
      setRunningTick((tick) => tick + 1)
    }
  }, [])

  const closeRunningSession = useCallback(
    async (
      runtimeId: string,
      opts: {
        dropQueued?: boolean
        stopProcess?: boolean
        preserveConversationState?: boolean
      } = {}
    ) => {
      const run = runningSessionsRef.current.get(runtimeId)
      if (!run) {
        setPermissionRequests((cur) =>
          cur.filter((request) => request.session_id !== runtimeId)
        )
        if (activeRuntimeIdRef.current === runtimeId) {
          activeRuntimeIdRef.current = null
          sessionIdRef.current = null
          setSessionId(null)
          setStreaming(false)
          if (!opts.preserveConversationState) setReviewDiffs([])
          collabMcpEnabledRef.current = false
        }
        if (opts.stopProcess !== false) {
          await stopSession(runtimeId).catch((e) => console.error(e))
        }
        return
      }

      const isActive = activeRuntimeIdRef.current === runtimeId
      // 关闭即强杀：清掉软中断兜底定时器，避免定时器在 run 移除后再触发误杀
      clearInterruptState(run)
      applyRunningAction(run, { kind: "runtime_exited" })
      if (opts.dropQueued !== false && run.queuedInputs.length > 0) {
        run.queuedInputs = []
      }
      run.unlisten.forEach((unlisten) => unlisten())
      run.unlisten = []
      void finishRunReview(run)
      run.owner.runtimeId = null
      runningSessionsRef.current.delete(runtimeId)
      networkToastTimestampsRef.current.delete(runtimeId)
      setPermissionRequests((cur) =>
        cur.filter((request) => request.session_id !== runtimeId)
      )
      if (isActive) {
        activeRuntimeIdRef.current = null
        sessionIdRef.current = null
        setSessionId(null)
        setStreaming(false)
        if (!opts.preserveConversationState) setReviewDiffs([])
        collabMcpEnabledRef.current = false
      }
      if (opts.stopProcess !== false) {
        await stopSession(runtimeId).catch((e) => console.error(e))
      }
      setRunningTick((tick) => tick + 1)
    },
    [applyRunningAction, clearInterruptState, finishRunReview]
  )

  const deleteSessionRecord = useCallback(async (p: Project, sid: string) => {
    await deleteSessionJsonl(p.cwd, sid)
    unpin(p.id, sid)
    unarchive(p.id, sid)
    setSidebarRefreshKey((k) => k + 1)
  }, [])

  const refreshActiveApiRuntime = useCallback(
    (message = "API 配置已刷新，当前会话上下文已保留，下一次发送会使用新配置") => {
      const runtimeId = activeRuntimeIdRef.current ?? sessionIdRef.current
      if (!runtimeId) return
      const run = runningSessionsRef.current.get(runtimeId)

      if (run?.streaming || (run && run.pendingPermissionRequestIds.size > 0)) {
        pendingApiRuntimeRefreshRef.current = true
        toast.warning(
          "API 配置已保存；当前请求结束后会刷新运行会话，当前会话上下文会保留"
        )
        return
      }

      pendingApiRuntimeRefreshRef.current = false
      pendingComposerRuntimeRefreshRef.current = false
      if (run && run.queuedInputs.length > 0) {
        notifyQueuedRecovery(run.queuedInputs)
        run.queuedInputs = []
        setRunningTick((tick) => tick + 1)
      }
      const sid = run?.jsonlSessionId ?? (run ? findInitSessionId(run.state) : null)
      if (sid) {
        setSelectedSessionId((cur) => {
          const next = cur ?? sid
          selectedSessionIdRef.current = next
          return next
        })
      }
      void closeRunningSession(runtimeId, {
        dropQueued: false,
        preserveConversationState: true
      })
        .then(() => toast.info(message))
        .catch((error) => {
          toast.error(`刷新 API 会话失败: ${String(error)}`)
        })
    },
    [closeRunningSession, restoreQueuedInputsToDraft]
  )

  const refreshActiveComposerRuntime = useCallback(
    (message = "会话启动配置已刷新，下一次发送会使用新配置") => {
      const runtimeId = activeRuntimeIdRef.current ?? sessionIdRef.current
      if (!runtimeId) {
        pendingComposerRuntimeRefreshRef.current = false
        return
      }
      const run = runningSessionsRef.current.get(runtimeId)
      if (run?.streaming || (run && run.pendingPermissionRequestIds.size > 0)) {
        pendingComposerRuntimeRefreshRef.current = true
        toast.warning(
          "会话启动配置已保存；当前请求结束后会刷新运行会话，下一次发送会使用新配置"
        )
        return
      }

      pendingApiRuntimeRefreshRef.current = false
      pendingComposerRuntimeRefreshRef.current = false
      const sid = run?.jsonlSessionId ?? (run ? findInitSessionId(run.state) : null)
      if (sid) {
        setSelectedSessionId((cur) => {
          const next = cur ?? sid
          selectedSessionIdRef.current = next
          return next
        })
      }
      void closeRunningSession(runtimeId, { dropQueued: false })
        .then(() => toast.info(message))
        .catch((error) => {
          toast.error(`刷新会话启动配置失败: ${String(error)}`)
        })
    },
    [closeRunningSession]
  )

  const writeCurrentPermissionModeSidecar = useCallback(
    (mode: AppSettings["defaultPermissionMode"] | null) => {
      const activeRuntimeId = activeRuntimeIdRef.current
      const run = activeRuntimeId
        ? runningSessionsRef.current.get(activeRuntimeId)
        : null
      const cwd = run?.project.cwd ?? project?.cwd
      const sid =
        run?.jsonlSessionId ??
        (run ? findInitSessionId(run.state) : null) ??
        selectedSessionId ??
        findInitSessionId(stateRef.current)
      if (!cwd || !sid) return

      patchSessionSidecar(cwd, sid, { permissionMode: mode })
        .catch((e) => console.warn("sidecar permission mode write failed:", e))
    },
    [project?.cwd, selectedSessionId]
  )

  const detachActiveSession = useCallback(async () => {
    const runtimeId = activeRuntimeIdRef.current
    activeRuntimeIdRef.current = null
    sessionIdRef.current = null
    setSessionId(null)
    setStreaming(false)
    setReviewDiffs([])
    collabMcpEnabledRef.current = false
    if (!runtimeId) return
    const run = runningSessionsRef.current.get(runtimeId)
    if (
      run &&
      !run.streaming &&
      ![...coordinatorRef.current.tasks.values()].some((task) => task.conversationKey === run.owner.key && isActiveInput(task)) &&
      run.pendingPermissionRequestIds.size === 0
    ) {
      void closeRunningSession(runtimeId, { dropQueued: false })
    }
  }, [closeRunningSession])

  const stopActiveSession = useCallback(async () => {
    const runtimeId = activeRuntimeIdRef.current ?? sessionIdRef.current
    if (runtimeId) {
      const run = runningSessionsRef.current.get(runtimeId)
      if (run) notifyQueuedRecovery(run.queuedInputs)
      await closeRunningSession(runtimeId)
      return
    }
    activeRuntimeIdRef.current = null
    sessionIdRef.current = null
    setSessionId(null)
    setStreaming(false)
    collabMcpEnabledRef.current = false
  }, [closeRunningSession, restoreQueuedInputsToDraft])

  const findRunningSession = useCallback(
    (p: Project, jsonlSessionId: string): RunningSession | null => {
      for (const run of runningSessionsRef.current.values()) {
        if (run.project.id !== p.id) continue
        const sid = run.jsonlSessionId
        if (sid && !run.jsonlSessionId) run.jsonlSessionId = sid
        if (sid === jsonlSessionId) return run
      }
      return null
    },
    []
  )

  const ensureSidecarApiProfile = useCallback(
    async (
      p: Project,
      sid: string,
      apiProfileKey: string,
      apiLaunchProfileKey: string
    ): Promise<void> => {
      const existing = await readSessionSidecar(p.cwd, sid)
      const base = (
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? existing
          : {}
      ) as Record<string, unknown>
      const storedProfileKey = sidecarApiProfileKey(base)
      const profileKey = storedProfileKey ?? apiProfileKey
      const hasConnectionProfile =
        typeof base.apiConnectionProfileKey === "string" &&
        base.apiConnectionProfileKey.trim()
      const hasLegacyProfile =
        typeof base.apiProfileKey === "string" && base.apiProfileKey.trim()
      const hasLaunchProfile =
        typeof base.apiLaunchProfileKey === "string" &&
        base.apiLaunchProfileKey.trim()
      const defaults: Record<string, unknown> = {}
      if (!hasConnectionProfile) defaults.apiConnectionProfileKey = profileKey
      if (!hasLegacyProfile) defaults.apiProfileKey = profileKey
      if (!hasLaunchProfile && !storedProfileKey) {
        defaults.apiLaunchProfileKey = apiLaunchProfileKey
      }
      if (Object.keys(defaults).length > 0) {
        await patchSessionSidecar(p.cwd, sid, {}, defaults)
      }
    },
    []
  )

  const stopRunningSessionForJsonl = useCallback(
    async (p: Project, jsonlSessionId: string) => {
      const targets: string[] = []
      for (const run of runningSessionsRef.current.values()) {
        if (run.project.id !== p.id) continue
        const sid = run.jsonlSessionId
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
    viewOwnerRef.current = { token: switchTokenRef.current, projectId: run.project.id, key: run.owner.key }
    activeRuntimeIdRef.current = run.runtimeId
    sessionIdRef.current = run.runtimeId
    setSessionId(run.runtimeId)
    setStreaming(run.streaming)
    dispatch({ kind: "replace_state", state: run.state })
    stateRef.current = run.state
    sessionComposerRef.current = run.sessionComposer
    setSessionComposer(run.sessionComposer)
    setComposerPrefs(run.composerPrefs)
    applyPermissionModeState(run.permissionMode, run.permissionModeSource)
    collabMcpEnabledRef.current = run.collabMcpEnabled
    setReviewDiffs(run.reviewDiffs)
  }, [applyPermissionModeState, flushRunningActions])

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
    // 一次性迁移：旧版 localStorage 里的明文代理密码 / 第三方 API Key → keychain（keychain 可用时静默执行）
    void migrateLegacyProxyPassword()
    void migrateLegacyThirdPartyApiKeys()
    cleanupManagedGlobalClaudeSettings().catch((error) => {
      console.error("清理旧版第三方 API 全局配置失败:", error)
      toast.warning("旧版第三方 API 全局配置清理失败", {
        description: String(error)
      })
    })
    loadGlobalDefault()
      .then((p) => {
        setGlobalDefault(p)
        // 启动时 Composer 按当前 API profile 显示默认值；第三方不继承官方全局模型。
        setComposerPrefs(currentComposerDefault(p))
      })
      .catch(() => {
        // 读 settings.json 失败不致命；保持默认 auto
      })
    const settings = loadSettings()
    applyPermissionModeState(settings.defaultPermissionMode, "default")
    if (settings.autoCheckUpdate) {
      void checkForAppUpdate({ silent: true })
    }
    if (isOfficialApi()) {
      fetchOauthUsage()
        .then((u) => setOauthUsage(u))
        .catch(() => setOauthUsage(null))
    }
    const list = listProjects()
    setProjects(list)
    if (list.length > 0) setProject((cur) => cur ?? list[0])
    listenPermissionRequests((payload) => {
      const enqueue = () => {
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
      }
      const run = runningSessionsRef.current.get(payload.session_id)
      if (!run) return
      const permissionMode =
        run?.permissionMode ?? loadSettings().defaultPermissionMode
      const autoApproval = autoApprovePermissionRequest(payload, permissionMode)
      if (autoApproval) {
        resolvePermissionRequest({
          sessionId: payload.session_id,
          requestId: payload.request_id,
          transport: payload.transport ?? null,
          response: autoApproval.response
        }).catch((e) => {
          toast.error(`自动处理权限请求失败: ${String(e)}`)
          if (runningSessionsRef.current.has(payload.session_id)) enqueue()
        })
        return
      }
      const remembered = findPermissionMemoryMatch(payload)
      if (remembered) {
        const response: Record<string, unknown> = { behavior: "allow" }
        if (payload.request.input !== undefined) {
          response.updatedInput = payload.request.input
        }
        resolvePermissionRequest({
          sessionId: payload.session_id,
          requestId: payload.request_id,
          transport: payload.transport ?? null,
          response
        })
          .then(() => {
            toast.success(`已按权限记忆允许: ${remembered.label}`)
          })
          .catch((e) => {
            toast.error(`权限记忆规则执行失败: ${String(e)}`)
            if (runningSessionsRef.current.has(payload.session_id)) enqueue()
          })
        return
      }
      enqueue()
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
      if (isEditableShortcutTarget(e.target)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault()
        returnViewRef.current = "chat"
        settingsEntryTargetRef.current = null
        setShowSettings(false)
        setShowPlugins(false)
        setShowHistory(false)
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
      const currentDefault = fallbackComposerPrefsForApiProfile(
        currentApiProfileKey(),
        next
      )
      if (sessionComposerRef.current) return
      setComposerPrefs(currentDefault)
      const activeRuntimeId = activeRuntimeIdRef.current
      const activeRun = activeRuntimeId
        ? runningSessionsRef.current.get(activeRuntimeId)
        : null
      const activeRunDefault = activeRun
        ? fallbackComposerPrefsForApiProfile(activeRun.apiProfileKey, next)
        : null
      if (
        activeRun &&
        !activeRun.sessionComposer &&
        activeRunDefault &&
        !sameComposerPrefs(activeRun.composerPrefs, activeRunDefault)
      ) {
        activeRun.composerPrefs = activeRunDefault
        refreshActiveComposerRuntime()
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
      const settings = loadSettings()
      if (permissionModeSourceRef.current === "default") {
        applyPermissionModeState(settings.defaultPermissionMode, "default")
      }
      const activeRuntimeId = activeRuntimeIdRef.current
      let shouldRefreshActiveRun = false
      let updatedRunningSession = false
      for (const run of runningSessionsRef.current.values()) {
        if (run.permissionModeSource !== "default") continue
        if (run.permissionMode === settings.defaultPermissionMode) continue
        run.permissionMode = settings.defaultPermissionMode
        updatedRunningSession = true
        if (run.runtimeId === activeRuntimeId) {
          shouldRefreshActiveRun = true
        }
      }
      if (updatedRunningSession) {
        setRunningTick((tick) => tick + 1)
      }
      if (shouldRefreshActiveRun) {
        refreshActiveComposerRuntime("默认权限模式已刷新，下一次发送会使用新配置")
      }
    }
    const refreshSettings = () => {
      refreshAppSettings()
      refreshComposerDefaults()
    }
    const clearProfileBoundLaunchPrefs = (profileKey: string) => {
      sessionComposerRef.current = null
      setSessionComposer(null)
      setComposerPrefs(
        fallbackComposerPrefsForApiProfile(profileKey, globalDefault)
      )
    }
    const refreshThirdPartyApi = () => {
      const previousProfileKey = apiProfileKeyRef.current
      const nextProfileKey = currentApiProfileKey()
      const previousLaunchProfileKey = apiLaunchProfileKeyRef.current
      const nextLaunchProfileKey = currentApiLaunchProfileKey()
      apiProfileKeyRef.current = nextProfileKey
      apiLaunchProfileKeyRef.current = nextLaunchProfileKey
      setThirdPartyApiVersion((version) => version + 1)
      if (previousProfileKey !== nextProfileKey) {
        clearProfileBoundLaunchPrefs(nextProfileKey)
        const runtimeId = activeRuntimeIdRef.current
        const run = runtimeId ? runningSessionsRef.current.get(runtimeId) : null
        if (run?.streaming || (run && run.pendingPermissionRequestIds.size > 0)) {
          pendingApiRuntimeRefreshRef.current = true
          toast.warning(
            "API 提供商已切换；当前请求仍使用原连接，结束后会保留当前会话，下一次发送使用新连接"
          )
        } else if (runtimeId) {
          refreshActiveApiRuntime(
            "API 提供商已切换，当前会话上下文已保留；下一次发送将使用新连接"
          )
        } else {
          pendingApiRuntimeRefreshRef.current = false
          pendingComposerRuntimeRefreshRef.current = false
          toast.info(
            "API 提供商已切换，当前会话上下文已保留；下一次发送将使用新连接"
          )
        }
        setSidebarRefreshKey((k) => k + 1)
      } else if (previousLaunchProfileKey !== nextLaunchProfileKey) {
        clearProfileBoundLaunchPrefs(nextProfileKey)
        refreshActiveApiRuntime(
          "第三方 API 模型配置已刷新，当前会话上下文已保留"
        )
      } else if (nextProfileKey !== "official") {
        refreshActiveApiRuntime()
      }
      refreshComposerDefaults()
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
    const off4 = subscribeSettingsBus("settings", () =>
      setCollabSettingsTick((t) => t + 1)
    )
    const off5 = subscribeSettingsBus("oauthUsage", () => {
      setOauthUsage(null)
      if (isOfficialApi()) {
        fetchOauthUsage().then(setOauthUsage).catch(() => setOauthUsage(null))
      }
    })
    return () => {
      off1()
      off2()
      off3()
      off4()
      off5()
    }
  }, [
    applyDefaultPermissionModeState,
    applyPermissionModeState,
    closeRunningSession,
    refreshActiveApiRuntime,
    refreshActiveComposerRuntime,
    globalDefault
  ])

  const teardown = useCallback(async () => {
    await stopActiveSession()
  }, [stopActiveSession])

  const pendingForkRef = useRef<{ sourceId: string; resumeAt: string } | null>(null)
  const startSession = useCallback(async (owner: ConversationOwner, task: SubmittedInput<InputContext>): Promise<string | null> => {
    const project = owner.project
    if (owner.runtimeId && runningSessionsRef.current.has(owner.runtimeId)) return owner.runtimeId
    const foreground = () => viewOwnerRef.current.key === owner.key
    const guard = () => {
      coordinatorRef.current.assertCurrent(task)
      if (currentAuthorizationRevision() !== task.context.authorizationRevision) throw new Error("授权配置已改变，请恢复原配置后重试")
      if (currentApiLaunchProfileKey() !== task.profileRevision) throw new Error("提供商配置已改变，请恢复原配置后重试")
    }
    guard()
    let createdRuntimeId: string | null = null
    try {
      const proxyEnv = buildProxyEnv(await loadProxyAsync())
      const cfg = loadSettings()
      const collabCfg = loadCollabSettings()
      const thirdPartyApi = await loadThirdPartyApiConfigAsync()
      const thirdPartyReady =
        thirdPartyApi.enabled &&
        !!trimApiUrl(thirdPartyApi.requestUrl) &&
        !!thirdPartyApi.apiKey.trim()
      const thirdPartyEnv = thirdPartyReady
        ? buildClaudeLaunchEnv(thirdPartyApi)
        : {}
      const env = { ...thirdPartyEnv, ...proxyEnv }
      const apiProfileKey = currentApiProfileKey()
      const apiLaunchProfileKey = currentApiLaunchProfileKey()
      const fork = owner.fork
      let resumeSessionId = fork?.sourceId ?? owner.sessionId
      if (
        resumeSessionId &&
        !hasResumableConversationContext(owner.state.entries)
      ) {
        resumeSessionId = null
        owner.sessionId = null
        if (foreground()) { selectedSessionIdRef.current = null; setSelectedSessionId(null); setSelectedSessionMeta(null); setReviewDiffs([]) }
      }
      const launchComposerPrefs = task.context.composerPrefs
      const launchSessionComposer = task.context.sessionComposer
      const launchReviewDiffs = resumeSessionId ? owner.reviewDiffs : []
      const uiModel = launchComposerPrefs.model.trim()
      const thirdPartyLaunchModel =
        thirdPartyReady && uiModel
          ? resolveThirdPartyComposerLaunchModel(thirdPartyApi, uiModel)
          : thirdPartyReady
            ? resolveThirdPartyDefaultLaunchModel(thirdPartyApi)
            : ""
      const uiEffort = launchComposerPrefs.effort.trim()
      const launchEffort =
        thirdPartyReady &&
        thirdPartyApi.inputFormat === "openai-chat-completions" &&
        uiEffort === "max"
          ? "xhigh"
          : uiEffort
      const model =
        (thirdPartyReady ? thirdPartyLaunchModel : uiModel) || null
      const launchPermissionMode = task.context.permissionMode
      guard()
      const id = crypto.randomUUID()
      createdRuntimeId = id
      const baseRunState = owner.state
      const resumedSubagents = settleSubagentRegistryForResume(
        baseRunState.subagents
      )
      const runState =
        resumedSubagents === baseRunState.subagents
          ? baseRunState
          : { ...baseRunState, subagents: resumedSubagents }
      const run: RunningSession = {
        owner,
        runtimeId: id,
        project,
        jsonlSessionId: fork ? null : resumeSessionId,
        launchModel: model,
        apiProfileKey,
        apiLaunchProfileKey,
        selectedSessionMeta: resumeSessionId ? owner.selectedSessionMeta : null,
        state: runState,
        activeInputId: null,
        midTurnInput: false,
        sendingQueued: false,
        turnActive: false,
        subagents: resumedSubagents,
        streaming: false,
        interrupting: false,
        interruptTimer: null,
        pendingPermissionRequestIds: new Set(),
        pendingActions: [],
        queuedInputs: [],
        unlisten: [],
        permissionMode: launchPermissionMode,
        permissionModeSource: owner.permissionModeSource,
        composerPrefs: launchComposerPrefs,
        sessionComposer: launchSessionComposer,
        collabMcpEnabled: collabCfg.enabled,
        reviewSnapshotId: null,
        reviewDiffs: launchReviewDiffs,
        upstreamStatus: null
      }
      owner.runtimeId = id
      runningSessionsRef.current.set(id, run)
      if (foreground()) {
        collabMcpEnabledRef.current = collabCfg.enabled
        activeRuntimeIdRef.current = id
        sessionIdRef.current = id
        setSessionId(id)
        stateRef.current = runState
        dispatch({ kind: "replace_state", state: runState })
      }
      setRunningTick((tick) => tick + 1)
      const u1 = await listenSessionEvents(id, (ev) => {
        let event = markInterruptedResult(
          eventWithLaunchModelIntent(run, ev),
          run.interrupting
        )
        const acknowledgedId = (event as { type?: string; uuid?: string }).type === "user" ? (event as { uuid?: string }).uuid : undefined
        const localEcho = acknowledgedId && !(event as { parent_tool_use_id?: string }).parent_tool_use_id
          ? coordinatorRef.current.acknowledge(acknowledgedId) : false
        event = markAuthoredEvent(localEcho ? { ...event, claudinalAuthored: true } : event, run.state.entries)
        const subagentTransition = reduceSubagentRegistry(run.subagents, event)
        if (subagentTransition.changed) {
          run.subagents = subagentTransition.registry
          syncRunningSessionStreaming(run)
        }
        if (!localEcho) applyRunningAction(run, { kind: "event", event })
        if ((event as { parent_tool_use_id?: string }).parent_tool_use_id) return
        const t = (event as { type?: string }).type
        if (t === "assistant" || t === "stream_event") coordinatorRef.current.response(owner.key, eventInputIds(event))
        const evSessionId = (event as { parent_tool_use_id?: string }).parent_tool_use_id ? undefined : (event as { session_id?: string }).session_id
        const knownSessionId = evSessionId ?? run.jsonlSessionId
        if (knownSessionId && run.jsonlSessionId !== knownSessionId) {
          run.jsonlSessionId = knownSessionId
          owner.sessionId = knownSessionId
          void patchSessionSidecar(run.project.cwd, knownSessionId, inputMetadataPatch(run.state)).catch(console.warn)
          void ensureSidecarApiProfile(
            run.project,
            knownSessionId,
            run.apiProfileKey,
            run.apiLaunchProfileKey
          ).catch((e) => console.warn("sidecar api profile write failed:", e))
          if (activeRuntimeIdRef.current === run.runtimeId) {
            setSelectedSessionId((cur) => {
              const next = cur ?? knownSessionId
              selectedSessionIdRef.current = next
              return next
            })
          }
          setRunningTick((tick) => tick + 1)
        }
        const composerPatch = composerPrefsPatchFromCommandEvent(event)
        if (composerPatch) {
          const updated = applyComposerPatch(run.composerPrefs, composerPatch)
          const updatedSession = nullableComposerPrefs(
            applyComposerPatch(run.sessionComposer ?? EMPTY_COMPOSER_PREFS, composerPatch)
          )
          run.composerPrefs = updated
          owner.composerPrefs = updated
          run.sessionComposer = updatedSession
          owner.sessionComposer = updatedSession
          if (activeRuntimeIdRef.current === run.runtimeId) {
            sessionComposerRef.current = updatedSession
            setSessionComposer(updatedSession)
            setComposerPrefs(updated)
          }
          const sid = run.jsonlSessionId
          if (sid) {
            patchSessionSidecar(run.project.cwd, sid, { composer: updated })
              .catch((e) => console.warn("sidecar composer command write failed:", e))
          }
        }
        if (
          t === "stream_event" &&
          (event as { event?: { type?: string } }).event?.type === "message_start"
        ) {
          setRunningSessionTurnActive(run, true)
        }
        if (t === "system") {
          const apiKeySource = (event as { apiKeySource?: string }).apiKeySource
          if (apiKeySource) {
            try {
              localStorage.setItem("claudinal.api-key-source", apiKeySource)
            } catch {
              // ignore
            }
          }
          const slash = (event as { slash_commands?: unknown }).slash_commands
          const skills = (event as { skills?: unknown }).skills
          const eventSlashCommands = Array.isArray(slash)
            ? (slash as unknown[]).filter(
                (s): s is string => typeof s === "string"
              )
            : []
          const eventSkillCommands = Array.isArray(skills)
            ? (skills as unknown[]).filter(
                (s): s is string => typeof s === "string"
              )
            : []
          if (Array.isArray(slash) || Array.isArray(skills)) {
            saveSlashCommandsCache(mergeSlashCommands(eventSlashCommands, eventSkillCommands))
          }
          const mcpServers = (event as { mcp_servers?: unknown }).mcp_servers
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
          run.activeInputId = null
          // 软中断在此收尾：result 到达即回合已终止，清掉 interrupting 态与强杀兜底定时器
          clearInterruptState(run)
          // 把网络相关的失败 result 也走一遍 toast；主要看 result/error 文本。
          const isError = (event as { is_error?: unknown }).is_error === true
          const interrupted =
            (event as { terminal_reason?: unknown }).terminal_reason === "interrupted"
          if (isError && !interrupted) {
            const text = [
              (event as { result?: unknown }).result,
              (event as { error?: unknown }).error,
              (event as { stop_reason?: unknown }).stop_reason
            ]
              .filter((v): v is string => typeof v === "string")
              .join("\n")
            if (text) {
              reportNetworkError(run.runtimeId, "result", text)
            }
          }
          const resultSessionId =
            (event as { session_id?: string }).session_id ??
            run.jsonlSessionId
          // 回合结束：上游状态条不再有意义（成功则已 recovered，失败则 result 错误已落地）
          run.upstreamStatus = null
          setRunningSessionTurnActive(run, false)
          recordResultUsage(
            event as {
              total_cost_usd?: number
              modelUsage?: Record<string, never>
            }
          )
          if (subagentTransition.resultDisposition === "intermediate") {
            // 前台 turn 已结束，但异步 Agent 尚未全部完成并被主会话汇总。
            // reducer 不插入“完成”卡；整体 streaming 由 subagent cycle 保持。
            setSidebarRefreshKey((k) => k + 1)
            return
          }
          coordinatorRef.current.complete(owner.key, isError || interrupted, eventInputIds(event), () => finishRunReview(run))
          // A guide sent at the boundary may already be waiting in the CLI for
          // the next turn. Keep it active; this result must not settle that input.
          setRunningSessionTurnActive(run, coordinatorRef.current.hasRunning(owner.key))
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
          const sid = resultSessionId
          if (sid) {
            // Backend merges this patch under a per-session lock. Composer is a
            // default only: a concurrent explicit picker update must win.
            const patch: Record<string, unknown> = {
              ...inputMetadataPatch(run.state),
              result: event,
              apiProfileKey: run.apiProfileKey,
              apiConnectionProfileKey: run.apiProfileKey,
              apiLaunchProfileKey: run.apiLaunchProfileKey
            }
            if (run.reviewDiffs.length > 0) patch.reviewDiffs = run.reviewDiffs
            if (run.permissionModeSource === "session") {
              patch.permissionMode = run.permissionMode
            }
            patchSessionSidecar(
              run.project.cwd,
              sid,
              patch,
              run.sessionComposer ? { composer: run.sessionComposer } : undefined
            )
              .then(() => setSidebarRefreshKey((k) => k + 1))
              .catch((e) => console.warn("sidecar write failed:", e))
          }
          if (
            pendingApiRuntimeRefreshRef.current &&
            activeRuntimeIdRef.current === run.runtimeId
          ) {
            refreshActiveApiRuntime()
          } else if (
            pendingComposerRuntimeRefreshRef.current &&
            activeRuntimeIdRef.current === run.runtimeId
          ) {
            refreshActiveComposerRuntime()
          }
        }
      })
      run.unlisten.push(u1)
      const u2 = await listenSessionErrors(id, (line) => {
        const ev = { type: "stderr", line } as unknown as ClaudeEvent
        applyRunningAction(run, { kind: "event", event: ev })
        reportNetworkError(run.runtimeId, "stderr", line)
      })
      run.unlisten.push(u2)
      const u3 = await listenSessionProxyStatus(id, (ev) => {
        if (!shouldTrackProxyStatus(run.streaming, run.interrupting)) return
        run.upstreamStatus = reduceProxyStatus(run.upstreamStatus, ev, Date.now())
        setRunningTick((tick) => tick + 1)
        if (ev.kind === "upstream-error" || ev.kind === "network-error") {
          reportNetworkError(run.runtimeId, "proxy", proxyStatusErrorText(ev))
        }
      })
      run.unlisten.push(u3)
      const u4 = await listenSessionLifecycle(id, (event) => {
        if (!runningSessionsRef.current.has(id)) return
        coordinatorRef.current.connectionLost(owner.key)
        applyRunningAction(run, { kind: "runtime_exited" })
        if (run.turnActive) {
          applyRunningAction(run, { kind: "event", event: {
            type: "stderr", line: `CLI 连接已结束（退出码 ${event.exitCode ?? "未知"}），请检查记录后继续。`
          } as ClaudeEvent })
        }
        notifyQueuedRecovery(run.queuedInputs)
        run.queuedInputs = []
        void closeRunningSession(id, { stopProcess: false, preserveConversationState: true })
      })
      run.unlisten.push(u4)
      guard()
      await spawnSession({
        runtimeId: id,
        forkSession: !!fork,
        resumeSessionAt: fork?.resumeAt,
        cwd: project.cwd,
        model,
        effort: launchEffort || null,
        permissionMode: launchPermissionMode,
        resumeSessionId,
        env: Object.keys(env).length > 0 ? env : null,
        permissionMcpEnabled: cfg.permissionMcpEnabled,
        permissionPromptTool: cfg.permissionPromptTool.trim() || null,
        mcpConfig: cfg.permissionMcpConfig.trim() || null,
        collabMcpEnabled: collabCfg.enabled,
        collabProviderPaths: providerPathEnv(collabCfg),
        collabEnabledProviders: enabledProviderList(collabCfg)
      })
      owner.fork = null
      run.midTurnInput = (await claudeCapabilities(id).catch(() => null))?.midTurnInput === "supported"
      setRunningTick((tick) => tick + 1)
      if (foreground()) pendingForkRef.current = null
      if (task.controller.signal.aborted) {
        await closeRunningSession(id, { preserveConversationState: true })
        return null
      }
      guard()
      if (!runningSessionsRef.current.has(id)) return null
      return id
    } catch (e) {
      if (createdRuntimeId) {
        await closeRunningSession(createdRuntimeId).catch((err) =>
          console.error(err)
        )
      }
      throw e
    }
  }, [
    planMode,
    project,
    selectedSessionId,
    selectedSessionMeta,
    reviewDiffs,
    composerPrefs,
    sessionComposer,
    ensureClaudeWorkspaceTrust,
    sessionPermissionMode,
    applyRunningAction,
    setRunningSessionTurnActive,
    syncRunningSessionStreaming,
    clearInterruptState,
    finishRunReview,
    closeRunningSession,
    ensureSidecarApiProfile,
    reportNetworkError,
    refreshActiveApiRuntime,
    refreshActiveComposerRuntime,
    globalDefault
  ])

  const startingSessionsRef = useRef(new Map<string, Promise<string | null>>())
  const ensureSession = useCallback((owner: ConversationOwner, task: SubmittedInput<InputContext>): Promise<string | null> => {
    const existing = startingSessionsRef.current.get(owner.key)
    if (existing) return existing
    const pending = startSession(owner, task).finally(() => { startingSessionsRef.current.delete(owner.key) })
    startingSessionsRef.current.set(owner.key, pending)
    return pending
  }, [startSession])

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

  const openAllDiff = useCallback((path?: string | null) => {
    setDiffScope({ kind: "all" })
    setDiffInitialPath(path ?? null)
    setShowSubagents(false)
    setShowCollabFlow(false)
    setShowDiff(true)
  }, [])

  const openSubagents = useCallback((agentId: string | null = null) => {
    setShowDiff(false)
    setShowCollabFlow(false)
    setSelectedSubagentId(agentId)
    setShowSubagents(true)
  }, [])

  const handleSubagentsOpenChange = useCallback((open: boolean) => {
    setShowSubagents(open)
    if (!open) setSelectedSubagentId(null)
  }, [])

  const openReviewDiff = useCallback(
    (review: ReviewRunDiff, path?: string | null) => {
      setDiffScope({ kind: "review", review })
      setDiffInitialPath(path ?? null)
      setShowSubagents(false)
      setShowCollabFlow(false)
      setShowDiff(true)
    },
    []
  )

  const selectDiffReview = useCallback(
    (id: string | null) => {
      setDiffInitialPath(null)
      if (!id) {
        setDiffScope({ kind: "all" })
        return
      }
      const review = reviewDiffs.find((item) => item.id === id)
      if (review) setDiffScope({ kind: "review", review })
    },
    [reviewDiffs]
  )

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
    if (showDiff && diffScope.kind === "all") {
      void refreshWorktreeDiff()
    }
  }, [showDiff, diffScope.kind, refreshWorktreeDiff, sidebarRefreshKey])

  const updateSubmittedMessage = (task: SubmittedInput<InputContext>) => {
    const owner = task.context.owner
    const run = owner.runtimeId ? runningSessionsRef.current.get(owner.runtimeId) : undefined
    const payload = task.payloadRef
    const currentState = run?.state ?? owner.state
    const existing = [...currentState.entries, ...(currentState.pendingInputs ?? [])].find((e) => e.kind === "message" && e.id === task.messageId)
    const uiBlocks = existing?.kind === "message" && existing.rawText === payload.text && existing.inputRevision === task.inputRevision && !existing.submissionPendingNames?.length
      ? existing.blocks : payload.uiBlocks ?? inputUiBlocks(payload.text, payload.images, payload.documents)
    const message = {
      kind: "message" as const, role: "user" as const, id: task.messageId, streaming: false,
      blocks: payload.pendingNames?.length ? [...uiBlocks, ...payload.pendingNames.map((name) => ({ type: "attachment" as const, attachmentName: name, attachmentContentMode: "metadata-only" as const }))] : uiBlocks,
      rawText: payload.text, ts: existing?.ts ?? task.createdAt, localState: task.localState, deliveryState: task.deliveryState,
      delivery: task.mode === "guide" ? "guide" as const : undefined,
      runState: task.runState, attemptId: task.attemptId, attemptIds: task.attempts.map((a) => a.id), attemptDetails: task.attempts.map((a) => ({ ...a })), inputRevision: task.inputRevision,
      transcriptUuid: task.deliveryState === "acknowledged" || task.deliveryState === "responded" ? task.attemptId : undefined,
      submissionTimings: { registered: task.timings.registered, saved: task.timings.saved, writeStarted: task.timings.writeStarted, written: task.timings.written, firstResponse: task.timings.firstResponse },
      submissionError: task.error, submissionPendingNames: payload.pendingNames
    }
    const pending = task.queuedBehindTurn && task.timings.writeStarted === undefined
    if (run) applyRunningAction(run, { kind: "submitted_input", message, pending })
    else {
      owner.state = reduce(owner.state, { kind: "submitted_input", message, pending })
      if (viewOwnerRef.current.key === owner.key) { stateRef.current = owner.state; dispatch({ kind: "replace_state", state: owner.state }) }
    }
    setRunningTick((tick) => tick + 1)
  }
  const persistSubmittedInput = (task: SubmittedInput<InputContext>) => saveOutbox({
    schemaVersion: 1, id: task.messageId, cwd: task.context.owner.project.cwd, conversationId: task.context.owner.sessionId,
    runtimeId: task.context.owner.runtimeId ?? undefined, text: task.payloadRef.text, images: task.payloadRef.images, documents: task.payloadRef.documents, attempts: task.attempts.map((a) => ({ ...a })), mode: task.mode, state: task.deliveryState,
    createdAt: task.createdAt, conversationKey: task.conversationKey, attemptId: task.attemptId,
    inputRevision: task.inputRevision, profileRevision: task.profileRevision
  })
  const checkInputTarget = (task: SubmittedInput<InputContext>) => {
    coordinatorRef.current.assertCurrent(task)
    if (currentAuthorizationRevision() !== task.context.authorizationRevision) throw new Error("授权配置已改变，请恢复原配置后重试")
    const owner = task.context.owner
    if (currentApiLaunchProfileKey() !== task.profileRevision) throw new Error("提供商配置已改变，请恢复原配置后重试")
    if (currentUiIntentRef.current.key === owner.key && (task.context.permissionMode !== currentUiIntentRef.current.permissionMode || !sameComposerPrefs(task.context.composerPrefs, currentUiIntentRef.current.composerPrefs))) throw new Error("模型或权限已改变，请恢复提交时的配置后重试")
    const run = owner.runtimeId ? runningSessionsRef.current.get(owner.runtimeId) : undefined
    if (run && run.permissionMode !== task.context.permissionMode) throw new Error("此请求的权限已改变，尚未发送")
  }
  submissionAdapterRef.current = {
    changed: updateSubmittedMessage,
    persist: persistSubmittedInput,
    prepare: async (task) => {
      const { owner, options } = task.context
      checkInputTarget(task)
      let text = task.payloadRef.text
      const { images, documents } = task.payloadRef
      if (!options.bypassPreprocess) {
        let route = routeCommand(text, findSlashCommands(owner.state, []), owner.state.entries.some((e) => e.kind === "system_init") ? [] : installedSkillCommandsRef.current)
        if (/^\s*\/model(?:\s|$)/.test(text)) route = (await claudeCapabilities()).headlessModelCommand === "supported" ? "cli" : "confirm_text"
        checkInputTarget(task)
        if ((route === "preview" || route === "confirm_text") && task.context.approvedCommand !== text) {
          coordinatorRef.current.status(task, "needs_confirmation")
          if (viewOwnerRef.current.key !== owner.key) throw new Error("请回到此对话确认命令后重试")
          const accepted = await confirmInputAction(route === "preview" ? "调用本地预览命令" : "此命令尚未确认可执行", "完整原文和附件已保留。此操作需要确认后才会交给 CLI。", route === "preview" ? "继续调用" : "作为文本发送")
          checkInputTarget(task)
          if (!accepted) { coordinatorRef.current.cancel(task.messageId); throw new DOMException("已取消", "AbortError") }
          task.context.approvedCommand = text
        }
        if (route === "confirm_text") text = `用户提供的普通文本：\n${text}`
        if (task.context.collaborationMode) {
          const cfg = loadCollabSettings()
          if (!cfg.enabled) throw new Error("请先启用协同配置后重试")
          text = buildCollaborationPrompt(text, cfg)
        }
      }
      const trust = await claudeWorkspaceTrustInfo(owner.project.cwd)
      checkInputTarget(task)
      if (shouldPromptClaudeWorkspaceTrust(trust)) {
        coordinatorRef.current.status(task, "needs_confirmation")
        if (viewOwnerRef.current.key !== owner.key) throw new Error("请回到此对话确认工作区后重试")
        if (!(await ensureClaudeWorkspaceTrust())) { coordinatorRef.current.cancel(task.messageId); throw new DOMException("工作区未授权", "AbortError") }
      }
      checkInputTarget(task)
      coordinatorRef.current.status(task, "preparing")
      task.context.cliBlocks = options.cliBlocks ?? compileUserInput(text, images, documents)
      validateInputSize(task.context.cliBlocks)
      const id = await measureSendStep("ensureSession", () => ensureSession(owner, task))
      checkInputTarget(task)
      const run = id ? runningSessionsRef.current.get(id) : undefined
      if (!run) throw new Error("会话连接失败，尚未发送")
      if (task.context.collaborationMode && !run.collabMcpEnabled) throw new Error("此会话未加载协同 MCP，请新建会话")
      if (run.interrupting) throw new Error("正在停止，请结束后重试")
      if (run.streaming && (task.mode !== "guide" || !run.midTurnInput)) throw new Error("当前会话尚未确认支持引导，请本轮结束后发送")
      await coordinatorRef.current.waitForSettlement(owner.key)
      checkInputTarget(task)
      await measureSendStep("beginRunReview", () => beginRunReview(run))
      if (task.controller.signal.aborted) { await discardRunReview(run); coordinatorRef.current.assertCurrent(task) }
      checkInputTarget(task)
      if (shouldPromptClaudeWorkspaceTrust(await claudeWorkspaceTrustInfo(owner.project.cwd))) throw new Error("工作区授权已撤销，尚未发送")
      checkInputTarget(task)
    },
    write: async (task) => {
      try { checkInputTarget(task) } catch (error) { throw Object.assign(new Error(String(error)), { deliveryCertainty: "not_sent" }) }
      const owner = task.context.owner
      const run = owner.runtimeId ? runningSessionsRef.current.get(owner.runtimeId) : undefined
      if (!run) throw Object.assign(new Error("会话已结束"), { deliveryCertainty: "not_sent" })
      // A result can arrive while prepare/persist is awaiting. Re-establish a
      // baseline after that result's review settles before writing the next turn.
      try {
        await coordinatorRef.current.waitForSettlement(owner.key)
        await beginRunReview(run)
        checkInputTarget(task)
        if (run.interrupting) throw new Error("正在停止，尚未发送")
      } catch (error) { throw Object.assign(new Error(String(error)), { deliveryCertainty: "not_sent" }) }
      const guiding = task.mode === "guide" && run.streaming
      if (guiding && !run.midTurnInput) throw Object.assign(new Error("当前会话不支持引导"), { deliveryCertainty: "not_sent" })
      const blocks = task.context.cliBlocks!
      rememberSentInput({ localId: task.messageId, ...task.payloadRef, cliBlocks: blocks, ts: task.createdAt })
      if (!guiding) run.activeInputId = task.messageId
      setRunningSessionTurnActive(run, true)
      try { await sendCliInput(run.runtimeId, blocks, undefined, task.attemptId, guiding) }
      catch (error) {
        if (task.deliveryState !== "acknowledged" && task.deliveryState !== "responded") {
          if (guiding) throw error // Preserve the current run and its shared file baseline.
          run.activeInputId = null; setRunningSessionTurnActive(run, false)
          // Uncertain writes may have side effects; preserve and settle their baseline.
          if ((error as { deliveryCertainty?: string })?.deliveryCertainty === "not_sent") await discardRunReview(run)
          else await finishRunReview(run)
        }
        throw error
      }
    },
    settled: (task) => {
      if (task.deliveryState === "acknowledged" || task.deliveryState === "responded") void removeOutbox(task.messageId).catch(console.warn)
      else void updateOutboxState(task.messageId, task.deliveryState, task.attemptId).catch(console.warn)
    }
  }

  const send = useCallback((text: string, images: ImagePayload[], documents: DocumentPayload[], options: SendOptions = {}): SubmitOutcome => {
    if (!project) return { kind: "rejected", reason: "请先选择项目" }
    if (!text.trim() && !images.length && !documents.length && !options.payload?.prepare) return { kind: "rejected", reason: "输入为空" }
    const command = text.trim()
    if (!options.bypassPreprocess && ["/clear", "/reset", "/permissions"].includes(command)) {
      if (images.length || documents.length || options.payload?.prepare) { toast.info("本地命令不能携带附件"); return { kind: "cancelled" } }
      if (command === "/permissions") { setSettingsSection("config"); setShowSettings(true) }
      else {
        coordinatorRef.current.stop(viewOwnerRef.current.key)
        const oldRuntime = activeRuntimeIdRef.current
        if (oldRuntime) void closeRunningSession(oldRuntime, { preserveConversationState: true })
        ++switchTokenRef.current
        viewOwnerRef.current = { token: switchTokenRef.current, projectId: project.id, key: crypto.randomUUID() }
        stateRef.current = reducerInit(); dispatch({ kind: "reset" })
        setReviewDiffs([]); setSelectedSessionId(null); selectedSessionIdRef.current = null; setSelectedSessionMeta(null)
        applyDefaultPermissionModeState()
      }
      return { kind: "local_action" }
    }
    // A reused runtime owns one coordinator queue. Its result listener also
    // closes over this owner, so returning to it must not create another key.
    const activeRun = activeRuntimeIdRef.current ? runningSessionsRef.current.get(activeRuntimeIdRef.current) : undefined
    const runtimeOwner = activeRun?.project.id === project.id ? activeRun.owner : undefined
    const key = runtimeOwner?.key ?? viewOwnerRef.current.key
    if (runtimeOwner) viewOwnerRef.current = { token: switchTokenRef.current, projectId: project.id, key }
    let owner = runtimeOwner ?? ownersRef.current.get(key)
    if (!owner) {
      owner = { key, project, sessionId: selectedSessionIdRef.current, runtimeId: activeRuntimeIdRef.current,
        state: stateRef.current, selectedSessionMeta, reviewDiffs, composerPrefs, sessionComposer,
        permissionMode: planMode ? "plan" : sessionPermissionMode, permissionModeSource: permissionModeSourceRef.current,
        profileRevision: currentApiLaunchProfileKey(), fork: pendingForkRef.current }
      ownersRef.current.set(key, owner)
    }
    owner.composerPrefs = { ...composerPrefs }; owner.sessionComposer = sessionComposer; owner.permissionMode = planMode ? "plan" : sessionPermissionMode
    // Capture intent for each submission; queued requests do not silently adopt later settings.
    owner.state = owner.runtimeId ? runningSessionsRef.current.get(owner.runtimeId)?.state ?? owner.state : stateRef.current
    if (options.mode === "guide") {
      const run = owner.runtimeId ? runningSessionsRef.current.get(owner.runtimeId) : undefined
      if (run?.streaming && (!run.midTurnInput || run.interrupting)) { toast.info("当前会话暂不能引导，请使用排队发送"); return { kind: "rejected", reason: "引导不可用" } }
    }
    return coordinatorRef.current.submit({ conversationKey: key, mode: options.mode, context: { owner, options, collaborationMode, authorizationRevision: currentAuthorizationRevision(), composerPrefs: { ...composerPrefs }, sessionComposer, permissionMode: planMode ? "plan" : sessionPermissionMode }, payload: options.payload ?? { text, images, documents },
      profileRevision: currentApiLaunchProfileKey(), sourceDraftRevision: options.sourceDraftRevision ?? 0, draftKey: options.draftKey })
  }, [project, selectedSessionMeta, reviewDiffs, composerPrefs, sessionComposer, planMode, sessionPermissionMode, collaborationMode, applyDefaultPermissionModeState, closeRunningSession])

  const hasLaterExecution = (task: SubmittedInput<InputContext>) => {
    if (task.timings.writeStarted === undefined) return false
    const entries = task.context.owner.state.entries
    const index = entries.findIndex((e) => e.kind === "message" && e.id === task.messageId)
    return entries.slice(index + 1).some((e) => e.kind === "message" && (e.role === "assistant" || e.role === "user" && ["acknowledged", "responded", "awaiting_ack", "writing", "delivery_unknown"].includes(e.deliveryState ?? "")))
  }
  const editSubmittedMessage = async (id: string, payload: InputPayload) => {
    const task = coordinatorRef.current.tasks.get(id)
    if (!task) return
    const edited = { text: payload.text, images: payload.images, documents: payload.documents }
    if (hasLaterExecution(task)) {
      if (!(await confirmInputAction("编辑内容作为新请求", "后续执行历史保持不变，编辑后的内容将追加为新消息；已执行的操作不会回滚。", "发送新请求"))) return
      coordinatorRef.current.submit({ conversationKey: task.conversationKey, sourceDraftRevision: 0, payload: edited, profileRevision: task.profileRevision, context: { ...task.context, options: {} } })
      coordinatorRef.current.resume(task.conversationKey)
    } else { task.context.options = {}; coordinatorRef.current.retry(id, edited) }
  }

  const retryUserMessage = useCallback(async (messageId: string) => {
    const task = coordinatorRef.current.tasks.get(messageId)
    if (task && hasLaterExecution(task)) {
      if (await confirmInputAction("作为新请求重新发送", "此消息之后已有执行记录。重新发送会保留原历史和文件变更，并追加一条新请求。", "发送新请求")) {
        coordinatorRef.current.submit({ conversationKey: task.conversationKey, sourceDraftRevision: 0, payload: task.payloadRef, profileRevision: task.profileRevision, context: { ...task.context } })
        coordinatorRef.current.resume(task.conversationKey)
      }
      return
    }
    if (task && ["failed", "cancelled", "paused", "queued"].includes(task.deliveryState)) { coordinatorRef.current.retry(messageId); return }
    if (task?.deliveryState === "delivery_unknown") {
      if (await confirmInputAction("再次发送可能重复执行", "无法确定原请求是否已被接收。请先检查现有记录；再次发送会作为一条新请求保留原消息。", "再次发送")) {
        const { payloadRef, context } = task
        coordinatorRef.current.submit({ conversationKey: task.conversationKey, sourceDraftRevision: 0, payload: payloadRef, profileRevision: task.profileRevision, context: { ...context } })
        coordinatorRef.current.resume(task.conversationKey)
      }
      return
    }
    const retryOwner = switchTokenRef.current
    let item = sentInputsRef.current.get(messageId)
    if (!project) return
    if (streaming) { toast.warning("请先停止当前轮次"); return }
    const sourceState = stateRef.current
    const sourceId = selectedSessionIdRef.current ?? findInitSessionId(sourceState)
    const entry = sourceState.entries.find((entry) => entry.kind === "message" && entry.id === messageId)
    const transcriptMessageId = entry?.kind === "message" ? entry.transcriptUuid ?? messageId : messageId
    if (!item && entry?.kind === "message" && sourceId) {
      try {
        const events = await readSessionTranscript(project.cwd, sourceId)
        if (retryOwner !== switchTokenRef.current) return
        item = retryInputFromTranscript(events.find((event) => (event as { uuid?: string }).uuid === transcriptMessageId), entry) ?? undefined
      } catch (error) { toast.error(`读取原始输入失败：${String(error)}`); return }
    }
    if (!item) { toast.warning("原始输入或完整附件不可用，请从本地恢复区取回"); return }
    const notSent = entry?.kind === "message" && entry.deliveryState === "failed"
    const accepted = await confirmInputAction(notSent ? "重新发送未送达输入" : "在新分支重新执行", notSent
      ? "将重新提交保存的原文与附件，现有历史保持不变。"
      : "原会话和代码文件保持不变。已经执行过的操作可能再次发生，请先检查记录。", "继续")
    if (!accepted || retryOwner !== switchTokenRef.current) return
    try {
      let fork: { sourceId: string; resumeAt: string } | null = null
      if (!notSent && sourceId) {
        const events = await readSessionTranscript(project.cwd, sourceId) as Array<ClaudeEvent & { uuid?: string }>
        if (retryOwner !== switchTokenRef.current) return
        const index = events.findIndex((event) => event.uuid === transcriptMessageId)
        if (index < 0 && sourceState.entries.some((entry) => entry.kind === "message" && entry.role === "assistant")) {
          toast.warning("无法确认历史分支位置，原记录保持不变。请从恢复区取回输入并选择会话后发送。")
          return
        }
        const previous = events.slice(0, Math.max(0, index)).reverse().find((event) => event.type === "assistant" && event.uuid)
        if (previous?.uuid) {
          if ((await claudeCapabilities()).forkSession !== "supported") { toast.warning("当前 CLI 尚未确认支持历史分支，原记录已保留"); return }
          fork = { sourceId, resumeAt: previous.uuid }
        }
      }
      if (retryOwner !== switchTokenRef.current) return
      const runtime = activeRuntimeIdRef.current
      if (runtime) await closeRunningSession(runtime, { preserveConversationState: true })
      if (retryOwner !== switchTokenRef.current) return
      if (!notSent) {
        ++switchTokenRef.current
        viewOwnerRef.current = { token: switchTokenRef.current, projectId: project.id, key: crypto.randomUUID() }
        pendingForkRef.current = fork
        selectedSessionIdRef.current = null
        setSelectedSessionId(null)
        setSelectedSessionMeta(null)
        const truncated = fork ? reduce(sourceState, { kind: "truncate_after_message", messageId }) : reducerInit()
        const next = { ...truncated, entries: truncated.entries.filter((entry) => entry.kind !== "system_init") }
        stateRef.current = next
        dispatch({ kind: "replace_state", state: next })
        setReviewDiffs([])
      }
      const outcome = await send(item.text, item.images, item.documents, { bypassPreprocess: true, cliBlocks: item.cliBlocks })
      if (outcome.kind !== "registered_in_ui") {
        pendingForkRef.current = null
        if (!activeRuntimeIdRef.current) {
          selectedSessionIdRef.current = sourceId
          setSelectedSessionId(sourceId)
          stateRef.current = sourceState
          dispatch({ kind: "replace_state", state: sourceState })
        }
        toast.info("输入仍保存在本地恢复区，原会话未修改")
      }
    } catch (error) { pendingForkRef.current = null; toast.error(`重新执行失败，原历史保留：${String(error)}`) }
  }, [project, streaming, send, closeRunningSession, confirmInputAction])

  const stop = useCallback(async () => {
    const pendingGuidance = [...coordinatorRef.current.tasks.values()].some((task) =>
      task.conversationKey === viewOwnerRef.current.key && task.mode === "guide" && task.runState === "running"
      && task.deliveryState !== "acknowledged" && task.deliveryState !== "responded")
    coordinatorRef.current.stop(viewOwnerRef.current.key)
    settleInputAction(false)
    settleClaudeWorkspaceTrust(false)
    const runtimeId = activeRuntimeIdRef.current ?? sessionIdRef.current
    const run = runtimeId ? runningSessionsRef.current.get(runtimeId) : null
    if (!run || !run.streaming) {
      // 非 streaming（或 run 不存在）：维持原有强杀语义
      await teardown()
      return
    }
    if (pendingGuidance) {
      // An unconsumed guide already in CLI stdin cannot be recalled. Closing
      // this runtime prevents it from starting another turn after interrupt.
      await closeRunningSession(run.runtimeId, { preserveConversationState: true })
      return
    }
    // 软中断已在途：等待 result 或兜底定时器收尾，避免重复发 interrupt
    if (run.interrupting) return
    // ① 排队中的 followup 先还原回草稿：被中断回合的 result 会触发 sendQueuedFollowup，
    //    不取回的话刚停下的工作会立刻被排队消息重新推回去
    const queuedFollowups = run.queuedInputs.filter(
      (item) => item.mode === "followup"
    )
    if (queuedFollowups.length > 0) {
      run.queuedInputs = run.queuedInputs.filter(
        (item) => item.mode !== "followup"
      )
      notifyQueuedRecovery(queuedFollowups)
    }
    // ② interrupting 标志驱动停止按钮 spinner（runningTick 触发渲染）
    run.interrupting = true
    run.upstreamStatus = null
    // ③ 兜底：超时仍在 streaming 则强杀该 run 自身。
    //    不走 teardown（stopActiveSession 以"当前活动会话"为目标，
    //    兜底触发时用户可能已切到别的会话，会误杀新会话）
    run.interruptTimer = window.setTimeout(() => {
      run.interruptTimer = null
      run.interrupting = false
      setRunningTick((tick) => tick + 1)
      if (!run.streaming) return
      toast.error("中断超时，已强制停止会话进程")
      notifyQueuedRecovery(run.queuedInputs)
      void closeRunningSession(run.runtimeId)
    }, INTERRUPT_FALLBACK_MS)
    setRunningTick((tick) => tick + 1)
    // ④ CLI 原生回合中断（等价 TUI Esc）：进程与会话保活，
    //    被中断回合产出 result 后由既有 result 处理复位 streaming / interrupting
    try {
      await interruptSession(run.runtimeId)
    } catch (e) {
      // stdin 写入失败（进程可能已退出）：立即回退强杀
      clearInterruptState(run)
      toast.error(`发送中断请求失败，已强制停止会话进程: ${String(e)}`)
      notifyQueuedRecovery(run.queuedInputs)
      await closeRunningSession(run.runtimeId)
    }
  }, [
    teardown,
    restoreQueuedInputsToDraft,
    closeRunningSession,
    clearInterruptState
  ])

  const handlePermissionModeChange = useCallback(
    (mode: AppSettings["defaultPermissionMode"]) => {
      const changed = mode !== sessionPermissionMode || (mode === "plan") !== planMode
      applyPermissionModeState(mode, "session")
      const activeRuntimeId = activeRuntimeIdRef.current
      const activeRun = activeRuntimeId
        ? runningSessionsRef.current.get(activeRuntimeId)
        : null
      if (activeRun) {
        activeRun.permissionMode = mode
        activeRun.permissionModeSource = "session"
      }
      writeCurrentPermissionModeSidecar(mode)
      if (changed) {
        refreshActiveComposerRuntime("权限模式已刷新，下一次发送会使用新配置")
      }
    },
    [
      applyPermissionModeState,
      planMode,
      refreshActiveComposerRuntime,
      sessionPermissionMode,
      writeCurrentPermissionModeSidecar
    ]
  )

  const handlePlanModeChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        handlePermissionModeChange("plan")
        return
      }
      const mode = loadSettings().defaultPermissionMode
      const changed = mode !== sessionPermissionMode || planMode
      applyPermissionModeState(mode, "default")
      const activeRuntimeId = activeRuntimeIdRef.current
      const activeRun = activeRuntimeId
        ? runningSessionsRef.current.get(activeRuntimeId)
        : null
      if (activeRun) {
        activeRun.permissionMode = mode
        activeRun.permissionModeSource = "default"
      }
      writeCurrentPermissionModeSidecar(null)
      if (changed) {
        refreshActiveComposerRuntime("权限模式已恢复默认，下一次发送会使用新配置")
      }
    },
    [
      applyPermissionModeState,
      handlePermissionModeChange,
      planMode,
      refreshActiveComposerRuntime,
      sessionPermissionMode,
      writeCurrentPermissionModeSidecar
    ]
  )

  const handleCollaborationModeChange = useCallback((enabled: boolean) => {
    if (!enabled) {
      setCollaborationMode(false)
      return
    }
    const cfg = loadCollabSettings()
    if (!cfg.enabled) {
      setSettingsSection("collaboration")
      setShowSettings(true)
      toast.info("请先在设置中启用协同；启用后对新会话生效")
      return
    }
    const activeSessionId = activeRuntimeIdRef.current ?? sessionIdRef.current
    if (activeSessionId && !collabMcpEnabledRef.current) {
      toast.warning("当前 Claude 会话未加载协同 MCP；请新建会话后再使用协同")
      return
    }
    setCollaborationMode(true)
  }, [])

  const switchProject = useCallback(
    async (next: Project) => {
      const token = ++switchTokenRef.current
      await detachActiveSession()
      if (token !== switchTokenRef.current) return
      viewOwnerRef.current = { token, projectId: next.id, key: crypto.randomUUID() }
      stateRef.current = reducerInit()
      dispatch({ kind: "reset" })
      setReviewDiffs([])
      setProject(next)
      setSelectedSessionId(null)
      setSelectedSessionMeta(null)
      sessionComposerRef.current = null
      setSessionComposer(null)
      setComposerPrefs(currentComposerDefault(globalDefault))
      applyDefaultPermissionModeState()
      setCollaborationMode(false)
    },
    [applyDefaultPermissionModeState, detachActiveSession, globalDefault]
  )

  const switchSession = useCallback(
    async (p: Project, s: SessionMeta) => {
      const token = ++switchTokenRef.current
      await detachActiveSession()
      if (token !== switchTokenRef.current) return
      const targetOwner = [...ownersRef.current.values()].find((owner) => owner.project.id === p.id && owner.sessionId === s.id)
      viewOwnerRef.current = { token, projectId: p.id, key: targetOwner?.key ?? crypto.randomUUID() }
      selectedSessionIdRef.current = s.id
      setLoadingSession(true)
      setCollaborationMode(false)
      stateRef.current = reducerInit()
      dispatch({ kind: "reset" })
      setReviewDiffs([])
      setProject(p)
      setSelectedSessionId(s.id)
      setSelectedSessionMeta(s)
      const runningSession = findRunningSession(p, s.id)
      if (runningSession) {
        const canUseRunningLaunchConfig = canUseApiProfileLaunchPrefs(
          runningSession.apiLaunchProfileKey,
          currentApiLaunchProfileKey()
        )
        if (
          canUseRunningLaunchConfig ||
          runningSession.streaming ||
          runningSession.pendingPermissionRequestIds.size > 0
        ) {
          runningSession.selectedSessionMeta = s
          activateRunningSession(runningSession)
          setLoadingSession(false)
          return
        }
        try {
          await closeRunningSession(runningSession.runtimeId, { dropQueued: false })
        } catch (error) {
          toast.error(`关闭旧 API 运行会话失败: ${String(error)}`)
          setLoadingSession(false)
          return
        }
      }
      const localOwner = [...ownersRef.current.values()].find((owner) => owner.project.id === p.id && owner.sessionId === s.id)
      if (localOwner) {
        viewOwnerRef.current = { token, projectId: p.id, key: localOwner.key }
        stateRef.current = localOwner.state; dispatch({ kind: "replace_state", state: localOwner.state })
        setReviewDiffs(localOwner.reviewDiffs); setComposerPrefs(localOwner.composerPrefs); setSessionComposer(localOwner.sessionComposer)
        applyPermissionModeState(localOwner.permissionMode, localOwner.permissionModeSource)
        setLoadingSession(false); return
      }
      try {
        const events = (await readSessionTranscript(p.cwd, s.id)) as ClaudeEvent[]
        if (token !== switchTokenRef.current) return
        // sidecar 里持久化的 result 事件追加到末尾，恢复 ✓ 完成 chip
        const sidecar = (await readSessionSidecar(p.cwd, s.id)) as
          | {
              result?: ClaudeEvent
              composer?: { model?: string; effort?: string }
              permissionMode?: unknown
              reviewDiffs?: unknown
            }
          | null
        if (token !== switchTokenRef.current) return
        const sidecarPermissionMode = pickPermissionModeFromSidecar(sidecar)
        applyPermissionModeState(
          sidecarPermissionMode ?? loadSettings().defaultPermissionMode,
          sidecarPermissionMode ? "session" : "default"
        )
        const currentProfileKey = currentApiProfileKey()
        const currentLaunchProfileKey = currentApiLaunchProfileKey()
        const storedLaunchProfileKey = sidecarApiLaunchProfileKey(sidecar)
        const canUseSessionLaunchPrefs = canUseApiProfileLaunchPrefs(
          storedLaunchProfileKey,
          currentLaunchProfileKey
        )
        const merged: ClaudeEvent[] =
          sidecar?.result ? [...events, sidecar.result] : events
        const preparedEvents = restoreTranscriptInputOrigins(merged, sidecar)
        const restored = restoreInputMetadata(reduce(reducerInit(), { kind: "load_transcript", events: preparedEvents }), sidecar)
        dispatch({ kind: "replace_state", state: restored })
        stateRef.current = restored
        setReviewDiffs(parseStoredReviewDiffs(sidecar))
        // 还原会话级 composer 偏好：sidecar 是 GUI 显式选择；没有 sidecar
        // 时从 Claude CLI jsonl 里的 /model、/effort 和 system/init 反推。
        const transcriptPrefs = canUseSessionLaunchPrefs
          ? pickComposerFromTranscript(preparedEvents)
          : null
        const sessionPrefs = mergeComposerPrefs(
          transcriptPrefs,
          canUseSessionLaunchPrefs ? pickComposerFromSidecar(sidecar) : null
        )
        sessionComposerRef.current = sessionPrefs
        setSessionComposer(sessionPrefs)
        setComposerPrefs(
          sessionPrefs ??
            fallbackComposerPrefsForApiProfile(currentProfileKey, globalDefault)
        )
      } catch (e) {
        if (token !== switchTokenRef.current) return
        toast.error(`加载会话失败: ${String(e)}`)
      } finally {
        if (token === switchTokenRef.current) setLoadingSession(false)
      }
    },
    [
      applyPermissionModeState,
      detachActiveSession,
      findRunningSession,
      activateRunningSession,
      closeRunningSession,
      globalDefault
    ]
  )

  const onProjectAdded = useCallback(
    async (p: Project) => {
      const token = ++switchTokenRef.current
      await detachActiveSession()
      if (token !== switchTokenRef.current) return
      viewOwnerRef.current = { token, projectId: p.id, key: crypto.randomUUID() }
      stateRef.current = reducerInit()
      dispatch({ kind: "reset" })
      setReviewDiffs([])
      setProject(p)
      setSelectedSessionId(null)
      setSelectedSessionMeta(null)
      sessionComposerRef.current = null
      setSessionComposer(null)
      setComposerPrefs(currentComposerDefault(globalDefault))
      applyDefaultPermissionModeState()
      setProjects(listProjects())
      returnViewRef.current = "chat"
      settingsEntryTargetRef.current = null
      setShowSettings(false)
      setShowPlugins(false)
      setShowHistory(false)
      toast.success(`项目「${p.name}」已添加`)
    },
    [applyDefaultPermissionModeState, detachActiveSession, globalDefault]
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
      sessionComposerRef.current = null
      setSessionComposer(null)
      setComposerPrefs(currentComposerDefault(globalDefault))
      applyDefaultPermissionModeState()
      dispatch({ kind: "reset" })
      setReviewDiffs([])
    }
    setPendingRemoveProjectId(null)
    toast.success("项目已从列表移除")
  }, [
    applyDefaultPermissionModeState,
    pendingRemoveProjectId,
    project,
    stopRunningSessionsForProject,
    globalDefault
  ])

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
    viewOwnerRef.current = { token, projectId: project?.id ?? "", key: crypto.randomUUID() }
    stateRef.current = reducerInit()
    selectedSessionIdRef.current = null
    dispatch({ kind: "reset" })
    setReviewDiffs([])
    setSelectedSessionId(null)
    setSelectedSessionMeta(null)
    // 新对话清掉会话级覆盖，回到当前 API profile 的默认 Composer。
    sessionComposerRef.current = null
    setSessionComposer(null)
    setComposerPrefs(currentComposerDefault(globalDefault))
    applyDefaultPermissionModeState()
    setCollaborationMode(false)
  }, [applyDefaultPermissionModeState, detachActiveSession, globalDefault, project?.id])

  const openSettings = useCallback((section: string = "general") => {
    if (!showSettings) {
      returnViewRef.current = showPlugins
        ? "plugins"
        : showHistory
          ? "history"
          : "chat"
      settingsEntryTargetRef.current =
        !showPlugins && !showHistory && project && selectedSessionMeta
          ? { kind: "session", project, session: selectedSessionMeta }
          : null
    }
    setChatReturnTarget(null)
    setSidebarVisible(true)
    setShowPlugins(false)
    setShowHistory(false)
    setSettingsSection(typeof section === "string" ? section : "general")
    setShowSettings(true)
  }, [project, selectedSessionMeta, showPlugins, showHistory, showSettings])

  const openPlugins = useCallback(() => {
    returnViewRef.current = "chat"
    settingsEntryTargetRef.current = null
    setChatReturnTarget(null)
    setSidebarVisible(true)
    setShowSettings(false)
    setShowHistory(false)
    setShowPlugins(true)
  }, [])

  const openHistory = useCallback(() => {
    returnViewRef.current = "chat"
    settingsEntryTargetRef.current = null
    setChatReturnTarget(null)
    setSidebarVisible(true)
    setShowSettings(false)
    setShowPlugins(false)
    setShowHistory(true)
  }, [])

  // openSettings 通过 ref 中转：reportNetworkError 在 ensureSession 上方（line ~500）
  // 就被定义，但 openSettings 在更下方（这里）定义，直接闭包引用会触发 TS
  // "used before declaration"。同步到 ref 即可。
  useEffect(() => {
    openSettingsRef.current = openSettings
  }, [openSettings])

  const returnToChat = useCallback(() => {
    const target = chatReturnTarget ?? settingsEntryTargetRef.current
    const returnView: ReturnView = target ? "chat" : returnViewRef.current
    const currentProjectId = project?.id ?? null
    returnViewRef.current = "chat"
    settingsEntryTargetRef.current = null
    setChatReturnTarget(null)
    setShowSettings(false)
    setShowPlugins(returnView === "plugins")
    setShowHistory(returnView === "history")
    if (target?.kind === "session") {
      setShowPlugins(false)
      setShowHistory(false)
      if (currentProjectId === target.project.id && selectedSessionIdRef.current === target.session.id) return
      void switchSession(target.project, target.session)
    } else if (target?.kind === "project") {
      setShowPlugins(false)
      setShowHistory(false)
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
    setShowHistory(false)
    void newConversation()
  }, [newConversation])

  const addProjectFromChrome = useCallback(() => {
    returnViewRef.current = "chat"
    settingsEntryTargetRef.current = null
    setChatReturnTarget(null)
    setShowSettings(false)
    setShowPlugins(false)
    setShowHistory(false)
    setShowAdd(true)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableShortcutTarget(e.target)) return
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
    setReviewDiffs([])
    setProject(null)
    setSelectedSessionId(null)
    setSelectedSessionMeta(null)
    sessionComposerRef.current = null
    setSessionComposer(null)
    setComposerPrefs(currentComposerDefault(globalDefault))
    applyDefaultPermissionModeState()
  }, [applyDefaultPermissionModeState, detachActiveSession, globalDefault])

  const deleteCurrentSession = useCallback(() => {
    if (!project) return
    const target = selectedSessionId ?? findInitSessionId(state)
    if (!target) {
      toast.error("当前没有会话，无法删除")
      return
    }
    const sessionMeta =
      selectedSessionMeta?.id === target ? selectedSessionMeta : null
    setPendingDeleteSession({
      project,
      sessionId: target,
      title: sessionMeta
        ? sessionDisplayTitle(sessionMeta)
        : getSessionTitle(target) ?? target.slice(0, 8)
    })
  }, [project, selectedSessionId, selectedSessionMeta, state])

  const requestDeleteSession = useCallback(
    (targetProject: Project, session: SessionMeta) => {
      setPendingDeleteSession({
        project: targetProject,
        sessionId: session.id,
        title: sessionDisplayTitle(session)
      })
    },
    []
  )

  const performDelete = useCallback(async () => {
    const target = pendingDeleteSession
    if (!target) return
    const currentSessionId =
      selectedSessionIdRef.current ?? findInitSessionId(stateRef.current)
    const deletingCurrent =
      project?.id === target.project.id && currentSessionId === target.sessionId
    if (deletingCurrent) ++switchTokenRef.current
    try {
      await stopRunningSessionForJsonl(target.project, target.sessionId)
      await deleteSessionRecord(target.project, target.sessionId)
      composerDraftsRef.current.deleteSession(target.project.id, target.sessionId)
      setPendingDeleteSession(null)
      if (deletingCurrent) {
        activeRuntimeIdRef.current = null
        sessionIdRef.current = null
        selectedSessionIdRef.current = null
        setSessionId(null)
        setStreaming(false)
        dispatch({ kind: "reset" })
        setReviewDiffs([])
        setSelectedSessionId(null)
        setSelectedSessionMeta(null)
        sessionComposerRef.current = null
        setSessionComposer(null)
        setComposerPrefs(currentComposerDefault(globalDefault))
        applyDefaultPermissionModeState()
        setShowRename(false)
        setShowDiff(false)
        setCollaborationMode(false)
      }
      toast.success("会话已删除")
    } catch (e) {
      toast.error(`删除失败: ${String(e)}`)
    }
  }, [
    applyDefaultPermissionModeState,
    deleteSessionRecord,
    pendingDeleteSession,
    project,
    stopRunningSessionForJsonl,
    globalDefault
  ])

  const archiveCurrentSession = useCallback(async () => {
    if (!project) return
    const target = selectedSessionId ?? findInitSessionId(state)
    if (!target) {
      toast.error("当前没有会话，无法归档")
      return
    }
    const willArchive = !isArchived(project.id, target)
    toggleArchive(project.id, target)
    if (willArchive) {
      // 归档时自动取消置顶，避免置顶区出现一个其实已经隐藏的会话
      unpin(project.id, target)
      await stopRunningSessionForJsonl(project, target)
      dispatch({ kind: "reset" })
      setReviewDiffs([])
      setSelectedSessionId(null)
      setSelectedSessionMeta(null)
      sessionComposerRef.current = null
      setSessionComposer(null)
      setComposerPrefs(currentComposerDefault(globalDefault))
      applyDefaultPermissionModeState()
      toast.success("会话已归档")
    } else {
      toast.success("已取消归档")
    }
    setSidebarRefreshKey((k) => k + 1)
  }, [
    applyDefaultPermissionModeState,
    project,
    selectedSessionId,
    state,
    stopRunningSessionForJsonl,
    globalDefault
  ])

  const empty = state.entries.length === 0
  const jsonlSessionId = selectedSessionId ?? findInitSessionId(state)
  const activeSubagents = state.subagents.agents
  const activeRunningSubagentCount = runningSubagentCount(state.subagents)
  const activeComposerDraftKey = project
    ? composerDraftsRef.current.keyFor(project.id, jsonlSessionId, activeConversationKey)
    : undefined
  const activeComposerDraft = activeComposerDraftKey
    ? composerDraftsRef.current.get(activeComposerDraftKey)
    : undefined
  const handleComposerDraftChange = useCallback(
    (next: ComposerDraft) => {
      rememberComposerDraft(activeComposerDraftKey, next)
    },
    [activeComposerDraftKey, rememberComposerDraft]
  )
  const streamingJsonlId = streaming ? jsonlSessionId : null
  const streamingSessionRefs = useMemo(() => {
    const refs: Array<{ projectId: string; sessionId: string }> = []
    for (const run of runningSessionsRef.current.values()) {
      if (!run.streaming) continue
      const sid = run.jsonlSessionId
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
      const sid = run.jsonlSessionId
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
  const reviewDiffCount = reviewDiffs.reduce(
    (total, review) => total + review.diff.files.length,
    0
  )
  const visibleDiffCount = Math.max(
    diffCount,
    reviewDiffCount,
    gitStatus?.changedFiles ?? 0,
    diffPatch?.files.length ?? 0
  )
  const slashCommands = findSlashCommands(state, installedSkillCommands)
  const runtimeCommandsKnown = state.entries.some((entry) => entry.kind === "system_init")
  const commandDescriptions = Object.fromEntries(slashCommands.map((command) => {
    const sources = skillPreview.filter((skill) => skill.name === command)
    const detail = sources.map((skill) => [skill.source, skill.description].filter(Boolean).join(" · ")).join(" / ")
    return [command, [runtimeCommandsKnown ? "当前 CLI 会话" : skillPreviewStale ? "缓存预览 · 读取失败" : "本地预览 · 待 CLI 确认", detail].filter(Boolean).join(" · ")]
  }))
  const activeRun = sessionId ? runningSessionsRef.current.get(sessionId) : undefined
  const activeUpstreamStatus = activeRun?.upstreamStatus ?? null
  const activeInterrupting = activeRun?.interrupting ?? false
  const submissionActions: SubmissionActions = {
    payload: (id) => coordinatorRef.current.tasks.get(id)?.payloadRef,
    retry: retryUserMessage,
    edit: (id, payload) => { void editSubmittedMessage(id, payload) },
    cancel: (id) => coordinatorRef.current.cancel(id),
    canGuide: (id) => {
      const task = coordinatorRef.current.tasks.get(id)
      const run = task?.context.owner.runtimeId ? runningSessionsRef.current.get(task.context.owner.runtimeId) : undefined
      return task?.deliveryState === "queued" && task.mode !== "guide" && !!run?.midTurnInput && run.streaming && !run.interrupting
    },
    guide: (id) => {
      const task = coordinatorRef.current.tasks.get(id)
      const run = task?.context.owner.runtimeId ? runningSessionsRef.current.get(task.context.owner.runtimeId) : undefined
      if (run?.midTurnInput && run.streaming && !run.interrupting) coordinatorRef.current.promote(id)
    },
    resume: (id) => { const task = coordinatorRef.current.tasks.get(id); if (task) coordinatorRef.current.resume(task.conversationKey) }
  }
  const retryableMessageIds = useMemo(
    () => new Set([...collectFailedRetryableMessageIds(state.entries, sentInputsRef.current), ...state.entries.filter((entry) => isAuthoredUserMessage(entry) && entry.blocks.some((block) => block.type === "text" || block.type === "image" || block.type === "attachment")).map((entry) => (entry.kind === "message" ? entry.id : ""))]),
    [state.entries, sentInputVersion]
  )
  const activePermissionRequest =
    permissionRequests.find((request) => request.session_id === sessionId) ??
    null
  const activeUserInputRequest =
    activePermissionRequest && isAskUserQuestionRequest(activePermissionRequest)
      ? activePermissionRequest
      : null
  const activeToolPermissionRequest =
    activePermissionRequest && !activeUserInputRequest
      ? activePermissionRequest
      : null
  void titleTick

  const handleModelEffortChange = useCallback(
    (next: { model?: string; effort?: string }) => {
      setComposerPrefs((cur) => {
        const updated: ComposerPrefs = {
          model: next.model !== undefined ? next.model : cur.model,
          effort: next.effort !== undefined ? next.effort : cur.effort
        }
        if (sameComposerPrefs(cur, updated)) return cur
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
          patchSessionSidecar(project.cwd, sid, { composer: updated })
            .catch((e) => console.warn("sidecar composer write failed:", e))
        }
        refreshActiveComposerRuntime("模型/思考强度已刷新，下一次发送会使用新配置")
        return updated
      })
    },
    [project, selectedSessionId, state, refreshActiveComposerRuntime]
  )

  const thirdPartyApiConfig = useMemo(
    () => loadThirdPartyApiConfig(),
    [thirdPartyApiVersion]
  )

  const openaiCompatibleProvider =
    thirdPartyApiConfig.enabled &&
    thirdPartyApiConfig.inputFormat === "openai-chat-completions"

  const modelOptions = useMemo(() => {
    if (!thirdPartyApiConfig.enabled) {
      return [] as Array<{ value: string; label?: string }>
    }
    return providerComposerModelOptions(thirdPartyApiConfig)
  }, [thirdPartyApiConfig])

  const modelOptionValues = useMemo(
    () => new Set(modelOptions.map((option) => option.value)),
    [modelOptions]
  )

  useEffect(() => {
    const shouldKeepModel = (model: string) => {
      return isComposerModelAllowed(
        model,
        modelOptionValues,
        thirdPartyApiConfig.enabled
      )
    }

    setComposerPrefs((cur) =>
      shouldKeepModel(cur.model) ? cur : { ...cur, model: "" }
    )
    setSessionComposer((cur) => {
      if (!cur || shouldKeepModel(cur.model)) return cur
      const next = { ...cur, model: "" }
      return next.effort ? next : null
    })
  }, [modelOptionValues, thirdPartyApiConfig.enabled])

  const projectActions = useMemo(() => {
    if (!project) return []
    return getProjectEnv(loadProjectEnvStore(), project.id).actions ?? []
  }, [project?.id, showSettings])

  const collabEnabled = useMemo(() => {
    void collabSettingsTick
    return loadCollabSettings().enabled
  }, [collabSettingsTick])

  return (
    <TooltipProvider>
      <>
        <div className="flex h-screen flex-col bg-background text-foreground">
          <AppChrome
            sidebarVisible={sidebarVisible}
            inSettings={showSettings || showPlugins || showHistory}
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
                  onProjectsChanged={() => setProjects(listProjects())}
	              />
            </Suspense>
          ) : (
          <div className="flex min-h-0 flex-1 gap-1.5 bg-sidebar p-1.5 pt-1.5">
            <div
              className="sidebar-pane shrink-0 overflow-hidden"
              data-collapsed={!sidebarVisible || undefined}
              inert={!sidebarVisible}
            >
              <div className="sidebar-pane__inner">
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
                      setShowHistory(false)
                      switchProject(p)
                    }}
                    onSelectSession={(p, s) => {
                      setShowPlugins(false)
                      setShowHistory(false)
                      switchSession(p, s)
                    }}
                    onDeleteSession={requestDeleteSession}
                    onAdd={() => setShowAdd(true)}
                    onRemove={handleRemove}
                    onNewConversation={() => {
                      setShowPlugins(false)
                      setShowHistory(false)
                      void newConversation()
                    }}
                    onOpenSettings={() => openSettings()}
                    onOpenPlugins={openPlugins}
                    onOpenHistory={openHistory}
                    refreshKey={sidebarRefreshKey}
                  />
                </Suspense>
              </div>
            </div>

            <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-background rounded-lg border overflow-hidden">
            {showPlugins ? (
              <Suspense fallback={<PaneLoader label="正在加载插件…" />}>
                <PluginsView
                  cwd={project?.cwd ?? null}
                  onBack={returnToChat}
                  onSkillsChanged={applyInstalledSkills}
                />
              </Suspense>
            ) : showHistory ? (
              <Suspense fallback={<PaneLoader label="正在加载历史…" />}>
                <HistoryView
                  projects={projects}
                  onBack={returnToChat}
                  onSelectSession={(p, s) => {
                    setShowHistory(false)
                    void switchSession(p, s)
                  }}
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
                  onShowDiff={() => openAllDiff()}
                  diffCount={visibleDiffCount}
                  onShowCollabFlow={() => {
                    setShowDiff(false)
                    setShowSubagents(false)
                    setShowCollabFlow(true)
                  }}
                  collabEnabled={collabEnabled}
                  onShowSubagents={() => openSubagents()}
                  subagentCount={activeSubagents.length}
                  runningSubagentCount={activeRunningSubagentCount}
                />
              </Suspense>
            )}

            {[...ownersRef.current.values()].some((owner) => owner.key !== activeConversationKey && [...coordinatorRef.current.tasks.values()].some((task) => task.conversationKey === owner.key && task.deliveryState !== "responded")) && <nav aria-label="本地待处理对话" className="flex flex-wrap gap-2 border-b px-6 py-2 text-xs">
              {[...ownersRef.current.values()].filter((owner) => owner.key !== activeConversationKey && [...coordinatorRef.current.tasks.values()].some((task) => task.conversationKey === owner.key && task.deliveryState !== "responded")).map((owner) => <button key={owner.key} className="rounded-md border px-2 py-1 text-muted-foreground hover:text-foreground" onClick={async () => {
                const token = ++switchTokenRef.current
                await detachActiveSession()
                if (token !== switchTokenRef.current) return
                viewOwnerRef.current = { token, projectId: owner.project.id, key: owner.key }
                setProject(owner.project); setSelectedSessionId(owner.sessionId); selectedSessionIdRef.current = owner.sessionId
                setSelectedSessionMeta(owner.selectedSessionMeta); setReviewDiffs(owner.reviewDiffs)
                setComposerPrefs(owner.composerPrefs); setSessionComposer(owner.sessionComposer)
                applyPermissionModeState(owner.permissionMode, owner.permissionModeSource)
                const run = owner.runtimeId ? runningSessionsRef.current.get(owner.runtimeId) : undefined
                if (run) activateRunningSession(run)
                else { stateRef.current = owner.state; dispatch({ kind: "replace_state", state: owner.state }) }
              }}>{owner.project.name} · {owner.state.entries.flatMap((e) => isAuthoredUserMessage(e) ? [e.rawText || "附件消息"] : [])[0]?.slice(0, 28) || "待处理消息"}</button>)}
            </nav>}
            <div className="flex min-h-0 flex-1 flex-col">
              {loadingSession ? (
                <div className="flex-1 min-h-0 grid place-items-center"><BuddyLoader /></div>
              ) : empty ? (
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
                  <Welcome
                    project={project}
                    onAddProject={() => setShowAdd(true)}
                    suggestions={project ? SUGGESTIONS : undefined}
                    onPickSuggestion={(s) => {
                      setDraft(s)
                      setDraftImages([])
                      setDraftDocuments([])
                    }}
                  />
                </div>
              ) : (
                <Suspense fallback={<PaneLoader label="正在加载会话…" />}>
                  <MessageStream
                    onOpenPermissions={() => openSettings("config")}
                    key={`stream-${activeConversationKey}`}
                    entries={state.entries}
                    streaming={streaming}
                    cwd={project?.cwd ?? null}
                    reviews={reviewDiffs}
                    onShowDiff={openReviewDiff}
                    retryableMessageIds={retryableMessageIds}
                    onRetryMessage={retryUserMessage}
                    submissionActions={submissionActions}
                    slashCommands={slashCommands}
                    pendingSubagentCount={activeRunningSubagentCount}
                    subagents={activeSubagents}
                    onOpenSubagent={(agentId) => openSubagents(agentId)}
                  />
                </Suspense>
              )}
              {/* Keep one Composer mounted when the first event replaces the welcome view. */}
              <div className={cn("shrink-0", (loadingSession || (empty && !project)) && "hidden")}>
                {!!state.pendingInputs?.length && <div className="px-6 pt-2">
                  <QueuedComposerBar messages={state.pendingInputs} actions={submissionActions} />
                </div>}
                {project && projectActions.length > 0 && (
                  <div className="shrink-0 bg-background px-6 pt-2">
                    <div className="mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl">
                      <Suspense fallback={null}>
                        <ProjectActionsBar
                          cwd={project.cwd}
                          actions={projectActions}
                        />
                      </Suspense>
                    </div>
                  </div>
                )}
                {activeUpstreamStatus && (
                  <div className="shrink-0 bg-background px-6 pt-2">
                    <UpstreamStatusBanner status={activeUpstreamStatus} />
                  </div>
                )}
                <div className="shrink-0 bg-background px-6 pt-2 empty:hidden">
                  <Suspense fallback={null}>
                    <RunStatusStrip
                      entries={state.entries}
                      streaming={streaming}
                      cwd={project?.cwd ?? null}
                      diffOpen={showDiff}
                      onShowDiff={openAllDiff}
                    />
                  </Suspense>
                </div>
                <div className={cn(empty && "px-6 pb-6 pt-2")}>
                  <div className={cn(empty && "mx-auto max-w-3xl space-y-2 xl:max-w-4xl 2xl:max-w-5xl")}>
                <InputRecovery centered={empty} cwd={project?.cwd} liveMessageIds={[...coordinatorRef.current.tasks.keys()]} activeRuntimeIds={[...runningSessionsRef.current.keys()]} onRestore={(input) => {
                  const current = activeComposerDraft
                  setDraft([current?.text, input.text].filter(Boolean).join("\n\n"))
                  setDraftImages([...(current?.images ?? []), ...input.images])
                  setDraftDocuments([...(current?.documents ?? []), ...input.documents])
                }} />
                <Suspense fallback={<ComposerLoader />}>
                  <Composer
                    centered={empty}
                    onSend={send}
                    onStop={stop}
                    streaming={streaming || [...coordinatorRef.current.tasks.values()].some((task) => task.conversationKey === activeConversationKey && isActiveInput(task))}
                    interrupting={activeInterrupting}
                    midTurnSupported={!!activeRun?.midTurnInput && !!activeRun.streaming}
                    disabled={!cliPath || !project}
                    draftKey={activeComposerDraftKey}
                    initialDraft={activeComposerDraft}
                    onDraftChange={handleComposerDraftChange}
                    externalText={draft}
                    externalImages={draftImages}
                    externalDocuments={draftDocuments}
                    onExternalTextConsumed={() => {
                      setDraft("")
                      setDraftImages([])
                      setDraftDocuments([])
                    }}
                    cwd={project?.cwd ?? null}
                    slashCommands={slashCommands}
                    commandDescriptions={commandDescriptions}
                    commandAvailability={runtimeCommandsKnown ? "runtime" : skillPreviewStale ? "stale" : "preview"}
                    planMode={planMode}
                    onPlanModeChange={handlePlanModeChange}
                    permissionMode={sessionPermissionMode}
                    onPermissionModeChange={handlePermissionModeChange}
                    gitStatus={gitStatus}
                    onGitStatusRefresh={refreshGitStatus}
                    onOpenPlugins={openPlugins}
                    collaborationMode={collaborationMode}
                    onCollaborationModeChange={handleCollaborationModeChange}
                    oauthUsage={oauthUsage}
                    model={composerPrefs.model}
                    effort={composerPrefs.effort}
                    onModelEffortChange={handleModelEffortChange}
                    modelOptions={modelOptions}
                    restrictModelOptions={thirdPartyApiConfig.enabled}
                    availableEffortLevels={effortLevels}
                    openaiCompatibleProvider={openaiCompatibleProvider}
                    globalDefault={globalDefault}
                    sessionPrefs={sessionComposer}
                  />
                </Suspense>
                    {empty && project && (
                      <div className="flex justify-start">
                        <Suspense fallback={null}>
                          <ProjectPicker
                            projects={projects}
                            current={project}
                            onSelect={(p) => {
                              if (p.id !== project?.id) switchProject(p)
                            }}
                            onAdd={() => setShowAdd(true)}
                            onClear={clearProject}
                          />
                        </Suspense>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
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
        {pendingDeleteSession && (
          <Suspense fallback={null}>
            <ConfirmDialog
              open={!!pendingDeleteSession}
              onOpenChange={(open) => {
                if (!open) setPendingDeleteSession(null)
              }}
              title="删除会话"
              destructive
              confirmText="删除"
              description={
                <span>
                  将永久删除会话「
                  <span className="font-medium">
                    {pendingDeleteSession.title}
                  </span>
                  」{" "}
                  <code className="font-mono text-xs">
                    {pendingDeleteSession.sessionId.slice(0, 8)}
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
              onOpenChange={(value) => {
                setShowDiff(value)
                if (!value) {
                  setDiffInitialPath(null)
                  setDiffScope({ kind: "all" })
                }
              }}
              entries={diffScope.kind === "review" ? [] : state.entries}
              gitStatus={diffScope.kind === "review" ? null : gitStatus}
              worktreeDiff={diffScope.kind === "review" ? null : diffPatch}
              snapshotDiffs={
                diffScope.kind === "review"
                  ? [diffScope.review.diff]
                  : reviewDiffs.map((review) => review.diff)
              }
              worktreeDiffLoading={
                diffScope.kind === "review" ? false : diffPatchLoading
              }
              worktreeDiffError={
                diffScope.kind === "review" ? null : diffPatchError
              }
              cwd={project?.cwd ?? null}
              initialFilePath={diffInitialPath}
              title={diffScope.kind === "review" ? "本轮文件 diff" : "文件 diff"}
              reviews={reviewDiffs}
              selectedReviewId={
                diffScope.kind === "review" ? diffScope.review.id : null
              }
              onSelectReview={selectDiffReview}
              onRefresh={() => void refreshWorktreeDiff()}
            />
          </Suspense>
        )}
        {showCollabFlow && (
          <Suspense fallback={null}>
            <CollaborationFlow
              open={showCollabFlow}
              onOpenChange={setShowCollabFlow}
              cwd={project?.cwd ?? null}
              currentSessionId={jsonlSessionId}
            />
          </Suspense>
        )}
        {showSubagents && (
          <Suspense fallback={null}>
            <SubagentsPanel
              open={showSubagents}
              onOpenChange={handleSubagentsOpenChange}
              agents={activeSubagents}
              cwd={project?.cwd ?? null}
              sessionId={jsonlSessionId}
              selectedAgentId={selectedSubagentId}
              onSelectedAgentChange={setSelectedSubagentId}
            />
          </Suspense>
        )}
        {pendingClaudeWorkspaceTrust && (
          <Suspense fallback={null}>
            <ClaudeWorkspaceTrustDialog
              open
              info={pendingClaudeWorkspaceTrust.info}
              onCancel={() => settleClaudeWorkspaceTrust(false)}
              onTrust={trustPendingClaudeWorkspace}
            />
          </Suspense>
        )}
        {activeUserInputRequest && (
          <Suspense fallback={null}>
            <UserInputDialog
              request={activeUserInputRequest}
              onSettled={settlePermissionRequest}
            />
          </Suspense>
        )}
        {inputConfirmation && (
          <Suspense fallback={null}>
            <ConfirmDialog open onOpenChange={(open) => { if (!open) settleInputAction(false) }}
              title={inputConfirmation.title} description={inputConfirmation.description}
              confirmText={inputConfirmation.confirmText} onConfirm={() => settleInputAction(true)} />
          </Suspense>
        )}
        {activeToolPermissionRequest && (
          <Suspense fallback={null}>
            <PermissionDialog
              request={activeToolPermissionRequest}
              onSettled={settlePermissionRequest}
            />
          </Suspense>
        )}
        <Toaster />
      </>
    </TooltipProvider>
  )
}
