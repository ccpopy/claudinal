import { useEffect, useReducer, useRef, useState, useCallback } from "react"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { toast } from "sonner"
import {
  detectClaudeCli,
  spawnSession,
  sendUserMessage,
  stopSession,
  listenSessionEvents,
  listenSessionErrors,
  readSessionTranscript,
  type SessionMeta
} from "@/lib/ipc"
import { buildProxyEnv, loadProxy } from "@/lib/proxy"
import { reduce, init as reducerInit } from "@/lib/reducer"
import {
  listProjects,
  removeProject as removeProjectStore,
  type Project
} from "@/lib/projects"
import type { UIBlock } from "@/types/ui"
import type { ClaudeEvent } from "@/types/events"
import { Composer } from "@/components/Composer"
import { MessageStream } from "@/components/MessageStream"
import { Sidebar } from "@/components/Sidebar"
import { Welcome } from "@/components/Welcome"
import { AddProjectDialog } from "@/components/AddProjectDialog"
import { Settings } from "@/components/Settings"
import { ChatHeader } from "@/components/ChatHeader"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"

const SUGGESTIONS = [
  "帮我想个合适的入门任务，把它实现出来，再一步步给我讲解决方案",
  "给我讲讲这个项目",
  "扫一遍代码，列出潜在的 bug 与改进点"
]

function chatTitle(
  state: ReturnType<typeof reducerInit>,
  project: Project
): string {
  for (const e of state.entries) {
    if (e.kind === "message" && e.role === "user") {
      for (const b of e.blocks) {
        if (b.type === "text" && b.text) return b.text.split("\n")[0].slice(0, 80)
      }
    }
  }
  return `${project.name} · 新对话`
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
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0)
  const unlistenRef = useRef<UnlistenFn[]>([])

  useEffect(() => {
    detectClaudeCli()
      .then(setCliPath)
      .catch((e) => toast.error(`未找到 claude CLI: ${String(e)}`))
    setProjects(listProjects())
    return () => {
      unlistenRef.current.forEach((u) => u())
      unlistenRef.current = []
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
    setSessionId(null)
    setStreaming(false)
  }, [sessionId])

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (!project) {
      setShowAdd(true)
      return null
    }
    if (sessionId) return sessionId
    try {
      const proxyEnv = buildProxyEnv(loadProxy())
      const id = await spawnSession({
        cwd: project.cwd,
        model: null,
        effort: null,
        permissionMode: "acceptEdits",
        resumeSessionId: selectedSessionId,
        env: Object.keys(proxyEnv).length > 0 ? proxyEnv : null
      })
      const u1 = await listenSessionEvents(id, (ev) => {
        dispatch({ kind: "event", event: ev })
        const t = (ev as { type?: string }).type
        if (t === "result") {
          setStreaming(false)
          setSidebarRefreshKey((k) => k + 1)
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
    async (text: string, images: string[]) => {
      const id = await ensureSession()
      if (!id) return
      const blocks: Array<Record<string, unknown>> = []
      if (text) blocks.push({ type: "text", text })
      for (const data of images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data }
        })
      }
      const uiBlocks: UIBlock[] = []
      if (text) uiBlocks.push({ type: "text", text })
      for (const data of images) {
        uiBlocks.push({
          type: "image",
          imageMediaType: "image/png",
          imageData: data
        })
      }
      dispatch({ kind: "user_local", blocks: uiBlocks })
      setStreaming(true)
      try {
        await sendUserMessage(id, blocks)
      } catch (e) {
        toast.error(`发送失败: ${String(e)}`)
        setStreaming(false)
      }
    },
    [ensureSession]
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
      dispatch({ kind: "reset" })
      setProject(p)
      setSelectedSessionId(s.id)
      setSidebarRefreshKey((k) => k + 1)
      try {
        const events = await readSessionTranscript(p.cwd, s.id)
        dispatch({ kind: "load_transcript", events: events as ClaudeEvent[] })
      } catch (e) {
        toast.error(`加载会话失败: ${String(e)}`)
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

  const handleRemove = useCallback(
    (id: string) => {
      removeProjectStore(id)
      setProjects(listProjects())
      if (project?.id === id) {
        teardown()
        setProject(null)
        setSelectedSessionId(null)
        dispatch({ kind: "reset" })
      }
    },
    [project, teardown]
  )

  const newConversation = useCallback(async () => {
    await teardown()
    dispatch({ kind: "reset" })
    setSelectedSessionId(null)
  }, [teardown])

  const empty = state.entries.length === 0

  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar
          projects={projects}
          selectedProjectId={project?.id ?? null}
          selectedSessionId={selectedSessionId}
          onSelectProject={switchProject}
          onSelectSession={switchSession}
          onAdd={() => setShowAdd(true)}
          onRemove={handleRemove}
          onNewConversation={newConversation}
          onOpenSettings={() => setShowSettings(true)}
          refreshKey={sidebarRefreshKey}
        />

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {project && !empty && (
            <ChatHeader
              key={`hdr-${selectedSessionId ?? sessionId ?? "new"}-${pinTick}`}
              project={project}
              sessionId={sessionId}
              resumeSessionId={selectedSessionId}
              title={chatTitle(state, project)}
              onPinChange={() => setPinTick((t) => t + 1)}
            />
          )}

          {empty ? (
            <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-6 py-10">
              <div className="w-full max-w-2xl flex flex-col items-center gap-6">
                <Welcome
                  project={project}
                  onAddProject={() => setShowAdd(true)}
                  suggestions={project ? SUGGESTIONS : undefined}
                  onPickSuggestion={(s) => setDraft(s)}
                />
                {project && (
                  <div className="w-full">
                    <Composer
                      onSend={send}
                      onStop={stop}
                      streaming={streaming}
                      disabled={!cliPath}
                      centered
                      externalText={draft}
                      onExternalTextConsumed={() => setDraft("")}
                    />
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
              />
            </>
          )}
        </div>

        <AddProjectDialog
          open={showAdd}
          onOpenChange={setShowAdd}
          onAdded={onProjectAdded}
        />
        <Settings open={showSettings} onOpenChange={setShowSettings} />
        <Toaster />
      </div>
    </TooltipProvider>
  )
}
