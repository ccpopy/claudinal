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
  type PermissionRequestPayload,
  type SessionMeta
} from "@/lib/ipc"
import { buildProxyEnv, loadProxy } from "@/lib/proxy"
import { loadSettings, recordResultUsage } from "@/lib/settings"
import { saveSlashCommandsCache } from "@/lib/slashCommands"
import {
  buildClaudeEnv,
  loadThirdPartyApiConfig,
  trimApiUrl
} from "@/lib/thirdPartyApi"
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
import { Sidebar } from "@/components/Sidebar"
import { Welcome } from "@/components/Welcome"
import { ProjectPicker } from "@/components/ProjectPicker"
import { AddProjectDialog } from "@/components/AddProjectDialog"
import { RenameSessionDialog } from "@/components/RenameSessionDialog"
import { DiffOverview } from "@/components/DiffOverview"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { BuddyLoader } from "@/components/BuddyLoader"
import { Settings } from "@/components/Settings"
import { ChatHeader } from "@/components/ChatHeader"
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
      const model = thirdPartyReady
        ? null
        : cfg.defaultModel.trim() || null
      const id = await spawnSession({
        cwd: project.cwd,
        model,
        effort: cfg.defaultEffort.trim() || null,
        permissionMode: cfg.defaultPermissionMode || "default",
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
        }
        if (t === "result") {
          setStreaming(false)
          setSidebarRefreshKey((k) => k + 1)
          recordResultUsage(
            ev as {
              total_cost_usd?: number
              modelUsage?: Record<string, never>
            }
          )
          const sid =
            (ev as { session_id?: string }).session_id ?? null
          if (project && sid) {
            writeSessionSidecar(project.cwd, sid, { result: ev }).catch((e) =>
              console.warn("sidecar write failed:", e)
            )
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
  }, [project, sessionId, selectedSessionId])

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
          | { result?: ClaudeEvent }
          | null
        const merged: ClaudeEvent[] =
          sidecar?.result ? [...events, sidecar.result] : events
        dispatch({ kind: "load_transcript", events: merged })
      } catch (e) {
        toast.error(`加载会话失败: ${String(e)}`)
      } finally {
        setLoadingSession(false)
      }
    },
    [teardown]
  )

  const onProjectAdded = useCallback(
    async (p: Project) => {
      await teardown()
      dispatch({ kind: "reset" })
      setProject(p)
      setSelectedSessionId(null)
      setProjects(listProjects())
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
  }, [teardown])

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

  return (
    <TooltipProvider>
      <>
        <div className="flex h-screen bg-sidebar text-foreground gap-1.5 p-1.5">
          <Sidebar
            projects={projects}
            selectedProjectId={project?.id ?? null}
            selectedSessionId={selectedSessionId}
            streamingProjectId={streaming ? project?.id ?? null : null}
            streamingSessionId={streamingJsonlId}
            onSelectProject={switchProject}
            onSelectSession={switchSession}
            onAdd={() => setShowAdd(true)}
            onRemove={handleRemove}
            onNewConversation={newConversation}
            onOpenSettings={() => setShowSettings(true)}
            refreshKey={sidebarRefreshKey}
          />

          <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-background rounded-lg border overflow-hidden">
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
              <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-6 py-10">
                <div className="w-full max-w-2xl flex flex-col items-center gap-6">
                  <Welcome
                    project={project}
                    onAddProject={() => setShowAdd(true)}
                    suggestions={project ? SUGGESTIONS : undefined}
                    onPickSuggestion={(s) => setDraft(s)}
                  />
                  {project && (
                    <div className="w-full space-y-2">
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
                  )}
                </div>
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
                />
              </>
            )}
          </div>
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
        <Settings
          open={showSettings}
          onOpenChange={setShowSettings}
          currentCwd={project?.cwd ?? null}
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
