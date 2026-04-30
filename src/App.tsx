import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useCallback
} from "react"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { toast } from "sonner"
import {
  detectClaudeCli,
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
import { buildProxyEnv, loadProxy } from "@/lib/proxy"
import { loadSettings, recordResultUsage } from "@/lib/settings"
import {
  EMPTY_COMPOSER_PREFS,
  loadGlobalDefault,
  pickComposerFromSidecar,
  type ComposerPrefs
} from "@/lib/composerPrefs"
import { saveMcpStatusCache } from "@/lib/mcp"
import { saveSlashCommandsCache } from "@/lib/slashCommands"
import {
  buildClaudeEnv,
  loadThirdPartyApiConfig,
  providerModelOptions,
  trimApiUrl
} from "@/lib/thirdPartyApi"
import { isOfficialApi } from "@/lib/oauthUsage"
import { reduce, init as reducerInit } from "@/lib/reducer"
import {
  listProjects,
  removeProject as removeProjectStore,
  type Project
} from "@/lib/projects"
import type { ImagePayload, UIBlock } from "@/types/ui"
import type { ClaudeEvent } from "@/types/events"
import { Composer } from "@/components/Composer"
import { MessageStream } from "@/components/MessageStream"
import { PluginsView } from "@/components/PluginsView"
import { Sidebar } from "@/components/Sidebar"
import { Welcome } from "@/components/Welcome"
import { ProjectPicker } from "@/components/ProjectPicker"
import { AddProjectDialog } from "@/components/AddProjectDialog"
import { RenameSessionDialog } from "@/components/RenameSessionDialog"
import { DiffOverview } from "@/components/DiffOverview"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { BuddyLoader } from "@/components/BuddyLoader"
import { SettingsWorkspace } from "@/components/Settings"
import { ChatHeader } from "@/components/ChatHeader"
import { AppChrome } from "@/components/AppChrome"
import { PermissionDialog } from "@/components/PermissionDialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { getSessionTitle, setSessionTitle } from "@/lib/sessionTitles"

const SUGGESTIONS = [
  "帮我想个合适的入门任务，把它实现出来，再一步步给我讲解决方案",
  "给我讲讲这个项目",
  "扫一遍代码，列出潜在的 bug 与改进点"
]

function chatTitle(
  state: ReturnType<typeof reducerInit>,
  project: Project,
  jsonlSessionId: string | null
): string {
  if (jsonlSessionId) {
    const custom = getSessionTitle(jsonlSessionId)
    if (custom) return custom
  }
  for (const e of state.entries) {
    if (e.kind === "message" && e.role === "user") {
      for (const b of e.blocks) {
        if (b.type === "text" && b.text) return b.text.split("\n")[0].slice(0, 80)
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
  const [showAdd, setShowAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [settingsSection, setSettingsSection] = useState("general")
  const [planMode, setPlanMode] = useState(false)
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
  const [pending, setPending] = useState<
    Array<{ localId: string; text: string; images: ImagePayload[] }>
  >([])
  const [permissionRequests, setPermissionRequests] = useState<
    PermissionRequestPayload[]
  >([])
  // fork 功能已废弃，未来基于 CLI --fork-session 重做（plan.md §9.1.1）
  const unlistenRef = useRef<UnlistenFn[]>([])
  const permissionUnlistenRef = useRef<UnlistenFn | null>(null)

  useEffect(() => {
    detectClaudeCli()
      .then(setCliPath)
      .catch((e) => toast.error(`未找到 claude CLI: ${String(e)}`))
    loadGlobalDefault()
      .then((p) => {
        setGlobalDefault(p)
        // 启动时 Composer 显示全局默认，作为新对话的起点
        setComposerPrefs(p)
      })
      .catch(() => {
        // 读 settings.json 失败不致命；保持默认 auto
      })
    if (isOfficialApi()) {
      fetchOauthUsage()
        .then((u) => setOauthUsage(u))
        .catch(() => setOauthUsage(null))
    }
    const list = listProjects()
    setProjects(list)
    if (list.length > 0) setProject((cur) => cur ?? list[0])
    listenPermissionRequests((payload) => {
      setPermissionRequests((cur) =>
        cur.some((p) => p.request_id === payload.request_id)
          ? cur
          : [...cur, payload]
      )
    })
      .then((u) => {
        permissionUnlistenRef.current = u
      })
      .catch((e) => toast.error(`权限监听启动失败: ${String(e)}`))
    return () => {
      unlistenRef.current.forEach((u) => u())
      unlistenRef.current = []
      permissionUnlistenRef.current?.()
      permissionUnlistenRef.current = null
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault()
        setShowSettings(false)
        setShowAdd(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    if (streaming) return
    if (pending.length === 0) return
    if (!sessionId) return
    const head = pending[0]
    setPending((cur) => cur.slice(1))
    dispatch({ kind: "unqueue_local", localId: head.localId })
    const blocks: Array<Record<string, unknown>> = []
    if (head.text) blocks.push({ type: "text", text: head.text })
    for (const image of head.images) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: image.mime, data: image.data }
      })
    }
    setStreaming(true)
    sendUserMessage(sessionId, blocks).catch((e) => {
      toast.error(`发送失败: ${String(e)}`)
      setStreaming(false)
    })
  }, [streaming, pending, sessionId])

  const teardown = useCallback(async () => {
    if (sessionId) {
      try {
        await stopSession(sessionId)
      } catch (e) {
        console.error(e)
      }
    }
    unlistenRef.current.forEach((u) => u())
    unlistenRef.current = []
    setPermissionRequests([])
    setSessionId(null)
    setStreaming(false)
    setPending((cur) => {
      if (cur.length > 0) {
        for (const p of cur) dispatch({ kind: "drop_local", localId: p.localId })
        toast(`已取消排队中的 ${cur.length} 条消息`)
      }
      return []
    })
  }, [sessionId])

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (!project) {
      setShowAdd(true)
      return null
    }
    if (sessionId) return sessionId
    try {
      const proxyEnv = buildProxyEnv(loadProxy())
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
      const uiModel = composerPrefs.model.trim()
      const uiEffort = composerPrefs.effort.trim()
      const model = uiModel || cfg.defaultModel.trim() || null
      const id = await spawnSession({
        cwd: project.cwd,
        model,
        effort: uiEffort || cfg.defaultEffort.trim() || null,
        permissionMode: planMode ? "plan" : cfg.defaultPermissionMode || "default",
        resumeSessionId: selectedSessionId,
        env: Object.keys(env).length > 0 ? env : null,
        permissionMcpEnabled: cfg.permissionMcpEnabled,
        permissionPromptTool: cfg.permissionPromptTool.trim() || null,
        mcpConfig: cfg.permissionMcpConfig.trim() || null
      })
      const u1 = await listenSessionEvents(id, (ev) => {
        dispatch({ kind: "event", event: ev })
        const t = (ev as { type?: string }).type
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
          setStreaming(false)
          setSidebarRefreshKey((k) => k + 1)
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
            (ev as { session_id?: string }).session_id ?? null
          if (project && sid) {
            // 保留 sidecar 已有字段，更新 result；如果用户在 session id 分配前就
            // 改过 composer，这里把 sessionComposer 一并落地。
            readSessionSidecar(project.cwd, sid)
              .then((existing) => {
                const base = (existing && typeof existing === "object"
                  ? existing
                  : {}) as Record<string, unknown>
                const next: Record<string, unknown> = { ...base, result: ev }
                if (sessionComposer && !base.composer) {
                  next.composer = sessionComposer
                }
                return writeSessionSidecar(project.cwd, sid, next)
              })
              .catch((e) => console.warn("sidecar write failed:", e))
          }
        }
      })
      const u2 = await listenSessionErrors(id, (line) => {
        const ev = { type: "stderr", line } as unknown as ClaudeEvent
        dispatch({ kind: "event", event: ev })
      })
      unlistenRef.current.push(u1, u2)
      setSessionId(id)
      return id
    } catch (e) {
      toast.error(`启动会话失败: ${String(e)}`)
      return null
    }
  }, [planMode, project, sessionId, selectedSessionId, composerPrefs])

  const send = useCallback(
    async (text: string, images: ImagePayload[]) => {
      // 客户端可处理的斜杠命令直接拦截，不投递给 CLI
      const trimmed = text.trim()
      if (trimmed === "/clear" || trimmed === "/reset") {
        await teardown()
        dispatch({ kind: "reset" })
        setSelectedSessionId(null)
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

      if (streaming) {
        dispatch({
          kind: "user_local",
          blocks: uiBlocks,
          queued: true,
          localId
        })
        setPending((cur) => [...cur, { localId, text, images }])
        return
      }

      const id = await ensureSession()
      if (!id) return
      const blocks: Array<Record<string, unknown>> = []
      if (text) blocks.push({ type: "text", text })
      for (const image of images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: image.mime, data: image.data }
        })
      }
      dispatch({ kind: "user_local", blocks: uiBlocks, localId })
      setStreaming(true)
      try {
        await sendUserMessage(id, blocks)
      } catch (e) {
        toast.error(`发送失败: ${String(e)}`)
        setStreaming(false)
      }
    },
    [streaming, ensureSession, teardown]
  )

  const stop = useCallback(async () => {
    await teardown()
  }, [teardown])

  const switchProject = useCallback(
    async (next: Project) => {
      await teardown()
      dispatch({ kind: "reset" })
      setProject(next)
      setSelectedSessionId(null)
    },
    [teardown]
  )

  const switchSession = useCallback(
    async (p: Project, s: SessionMeta) => {
      await teardown()
      setLoadingSession(true)
      dispatch({ kind: "reset" })
      setProject(p)
      setSelectedSessionId(s.id)
      setSidebarRefreshKey((k) => k + 1)
      try {
        const events = (await readSessionTranscript(p.cwd, s.id)) as ClaudeEvent[]
        // sidecar 里持久化的 result 事件追加到末尾，恢复 ✓ 完成 chip
        const sidecar = (await readSessionSidecar(p.cwd, s.id)) as
          | { result?: ClaudeEvent; composer?: { model?: string; effort?: string } }
          | null
        const merged: ClaudeEvent[] =
          sidecar?.result ? [...events, sidecar.result] : events
        dispatch({ kind: "load_transcript", events: merged })
        // 还原会话级 composer 偏好；没有 sidecar.composer 就用全局默认
        const sessionPrefs = pickComposerFromSidecar(sidecar)
        setSessionComposer(sessionPrefs)
        setComposerPrefs(sessionPrefs ?? globalDefault)
      } catch (e) {
        toast.error(`加载会话失败: ${String(e)}`)
      } finally {
        setLoadingSession(false)
      }
    },
    [teardown, globalDefault]
  )

  const onProjectAdded = useCallback(
    async (p: Project) => {
      await teardown()
      dispatch({ kind: "reset" })
      setProject(p)
      setSelectedSessionId(null)
      setProjects(listProjects())
      setShowSettings(false)
      toast.success(`项目「${p.name}」已添加`)
    },
    [teardown]
  )

  const handleRemove = useCallback((id: string) => {
    setPendingRemoveProjectId(id)
  }, [])

  const performRemoveProject = useCallback(async () => {
    const id = pendingRemoveProjectId
    if (!id) return
    removeProjectStore(id)
    setProjects(listProjects())
    if (project?.id === id) {
      await teardown()
      setProject(null)
      setSelectedSessionId(null)
      dispatch({ kind: "reset" })
    }
    setPendingRemoveProjectId(null)
    toast.success("项目已从列表移除")
  }, [pendingRemoveProjectId, project, teardown])

  const pendingRemoveProject = useMemo(
    () =>
      pendingRemoveProjectId
        ? projects.find((p) => p.id === pendingRemoveProjectId)
        : null,
    [pendingRemoveProjectId, projects]
  )

  const newConversation = useCallback(async () => {
    await teardown()
    dispatch({ kind: "reset" })
    setSelectedSessionId(null)
    // 新对话清掉会话级覆盖，回到全局默认
    setSessionComposer(null)
    setComposerPrefs(globalDefault)
  }, [teardown, globalDefault])

  const openSettings = useCallback((section = "general") => {
    setSidebarVisible(true)
    setShowPlugins(false)
    setSettingsSection(section)
    setShowSettings(true)
  }, [])

  const openPlugins = useCallback(() => {
    setSidebarVisible(true)
    setShowSettings(false)
    setShowPlugins(true)
  }, [])

  const returnToChat = useCallback(() => {
    setShowSettings(false)
    setShowPlugins(false)
  }, [])

  const newConversationFromChrome = useCallback(() => {
    setShowSettings(false)
    setShowPlugins(false)
    void newConversation()
  }, [newConversation])

  const addProjectFromChrome = useCallback(() => {
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
    await teardown()
    dispatch({ kind: "reset" })
    setProject(null)
    setSelectedSessionId(null)
  }, [teardown])

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
    if (!target) return
    await teardown()
    try {
      await deleteSessionJsonl(project.cwd, target)
      dispatch({ kind: "reset" })
      setSelectedSessionId(null)
      setSidebarRefreshKey((k) => k + 1)
      toast.success("会话已删除")
    } catch (e) {
      toast.error(`删除失败: ${String(e)}`)
    }
  }, [project, selectedSessionId, state, teardown])

  const empty = state.entries.length === 0
  const jsonlSessionId = selectedSessionId ?? findInitSessionId(state)
  const streamingJsonlId = streaming ? jsonlSessionId : null
  const diffCount = countDiffFiles(state.entries)
  const slashCommands = findSlashCommands(state)
  const activePermissionRequest = permissionRequests[0] ?? null
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
        setSessionComposer(updated)
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

  const extraModels = useMemo(() => {
    const cfg = loadThirdPartyApiConfig()
    if (!cfg.enabled) return [] as { value: string; label?: string }[]
    return providerModelOptions(cfg).map((model) => ({
      value: model,
      label: cfg.providerName ? `${cfg.providerName} · ${model}` : model
    }))
  }, [showSettings])

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
            <SettingsWorkspace
              currentCwd={project?.cwd ?? null}
              sidebarVisible={sidebarVisible}
              initialSection={settingsSection}
            />
          ) : (
          <div className="flex min-h-0 flex-1 gap-1.5 bg-sidebar p-1.5 pt-1.5">
            {sidebarVisible && (
              <Sidebar
                projects={projects}
                selectedProjectId={project?.id ?? null}
                selectedSessionId={selectedSessionId}
                streamingProjectId={streaming ? project?.id ?? null : null}
                streamingSessionId={streamingJsonlId}
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
                onOpenSettings={openSettings}
                onOpenPlugins={openPlugins}
                refreshKey={sidebarRefreshKey}
              />
            )}

            <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-background rounded-lg border overflow-hidden">
            {showPlugins ? (
              <PluginsView
                cwd={project?.cwd ?? null}
                onBack={returnToChat}
              />
            ) : (
              <>
            {project && !empty && (
              <ChatHeader
                key={`hdr-${selectedSessionId ?? sessionId ?? "new"}-${pinTick}-${titleTick}`}
                project={project}
                resumeSessionId={selectedSessionId}
                jsonlSessionId={jsonlSessionId}
                title={chatTitle(state, project, jsonlSessionId)}
                onPinChange={() => setPinTick((t) => t + 1)}
                onRename={
                  jsonlSessionId ? () => setShowRename(true) : undefined
                }
                onDelete={deleteCurrentSession}
                onShowDiff={() => setShowDiff(true)}
                diffCount={diffCount}
              />
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
                    <div className="mx-auto max-w-4xl space-y-2">
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
                        onPlanModeChange={setPlanMode}
                        onOpenPlugins={openPlugins}
                        oauthUsage={oauthUsage}
                        model={composerPrefs.model}
                        effort={composerPrefs.effort}
                        onModelEffortChange={handleModelEffortChange}
                        extraModels={extraModels}
                        globalDefault={globalDefault}
                        sessionPrefs={sessionComposer}
                      />
                      <div className="flex justify-start">
                        <ProjectPicker
                          projects={projects}
                          current={project}
                          onSelect={(p) => {
                            if (p.id !== project.id) switchProject(p)
                          }}
                          onAdd={() => setShowAdd(true)}
                          onClear={clearProject}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                <MessageStream
                  key={`stream-${selectedSessionId ?? sessionId ?? "new"}`}
                  entries={state.entries}
                  streaming={streaming}
                />
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
                  onPlanModeChange={setPlanMode}
                  onOpenPlugins={openPlugins}
                  oauthUsage={oauthUsage}
                  model={composerPrefs.model}
                  effort={composerPrefs.effort}
                  onModelEffortChange={handleModelEffortChange}
                  extraModels={extraModels}
                  globalDefault={globalDefault}
                  sessionPrefs={sessionComposer}
                />
              </>
            )}
              </>
            )}
            </div>
          </div>
          )}
        </div>

        <AddProjectDialog
          open={showAdd}
          onOpenChange={setShowAdd}
          onAdded={onProjectAdded}
        />
        {jsonlSessionId && (
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
        )}
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
        <DiffOverview
          open={showDiff}
          onOpenChange={setShowDiff}
          entries={state.entries}
        />
        <PermissionDialog
          request={activePermissionRequest}
          onSettled={(requestId) =>
            setPermissionRequests((cur) =>
              cur.filter((p) => p.request_id !== requestId)
            )
          }
        />
        <Toaster />
      </>
    </TooltipProvider>
  )
}
