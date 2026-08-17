import { useEffect, useMemo, useRef, useState } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleStop,
  Clock3,
  Loader2,
  Waypoints,
  X,
  type LucideIcon
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { MessageStream } from "@/components/MessageStream"
import { AssistantMarkdown } from "@/components/AssistantMarkdown"
import { readSubagentTranscriptChunk } from "@/lib/ipc"
import { init as reducerInit, reduce } from "@/lib/reducer"
import {
  revealSubagentTranscriptEvents,
  runningSubagentCount,
  type SubagentStatus,
  type SubagentTask
} from "@/lib/subagents"
import { cn, formatRunDuration } from "@/lib/utils"
import type { ClaudeEvent } from "@/types/events"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  agents: SubagentTask[]
  cwd: string | null
  sessionId: string | null
  selectedAgentId: string | null
  onSelectedAgentChange: (agentId: string | null) => void
}

interface StatusPresentation {
  label: string
  Icon: LucideIcon
  className: string
}

const STATUS_PRESENTATION: Record<SubagentStatus, StatusPresentation> = {
  running: {
    label: "处理中",
    Icon: Loader2,
    className: "text-primary"
  },
  completed: {
    label: "已完成",
    Icon: CheckCircle2,
    className: "text-connected"
  },
  failed: {
    label: "失败",
    Icon: AlertTriangle,
    className: "text-destructive"
  },
  cancelled: {
    label: "已取消",
    Icon: CircleStop,
    className: "text-muted-foreground"
  }
}

const AVATAR_TONES = [
  "border-primary/20 bg-primary/10 text-primary",
  "border-connected/20 bg-connected/10 text-connected",
  "border-warn/20 bg-warn/10 text-warn",
  "border-border bg-muted text-muted-foreground"
]

function hashAgentId(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0
  return Math.abs(hash)
}

export function partitionSubagents(agents: SubagentTask[]): {
  running: SubagentTask[]
  finished: SubagentTask[]
} {
  return {
    running: agents
      .filter((agent) => agent.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt),
    finished: agents
      .filter((agent) => agent.status !== "running")
      .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt))
  }
}

export function shouldAutoScrollSubagentTranscript(
  status: SubagentStatus
): boolean {
  return status === "running"
}

function AgentAvatar({ agent, className }: { agent: SubagentTask; className?: string }) {
  const tone = AVATAR_TONES[hashAgentId(agent.id) % AVATAR_TONES.length]
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full border",
        tone,
        className
      )}
      aria-hidden="true"
    >
      <Bot className="size-4" />
    </span>
  )
}

function AgentStatus({ status }: { status: SubagentStatus }) {
  const presentation = STATUS_PRESENTATION[status]
  const StatusIcon = presentation.Icon
  return (
    <span className={cn("inline-flex items-center gap-1", presentation.className)}>
      <StatusIcon
        className={cn("size-3", status === "running" && "animate-spin")}
        aria-hidden="true"
      />
      {presentation.label}
    </span>
  )
}

function AgentRow({
  agent,
  now,
  onSelect
}: {
  agent: SubagentTask
  now: number
  onSelect: () => void
}) {
  const end = agent.status === "running" ? now : (agent.endedAt ?? agent.updatedAt)
  const duration = Math.max(0, end - agent.startedAt)
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AgentAvatar agent={agent} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" title={agent.description}>
          {agent.description}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <AgentStatus status={agent.status} />
          {agent.model && <span className="truncate font-mono">{agent.model}</span>}
        </span>
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/75">
        {formatRunDuration(duration, agent.status === "running")}
      </span>
    </button>
  )
}

function AgentSection({
  title,
  agents,
  now,
  onSelect
}: {
  title: string
  agents: SubagentTask[]
  now: number
  onSelect: (agentId: string) => void
}) {
  if (agents.length === 0) return null
  return (
    <section className="space-y-1">
      <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title} · {agents.length}
      </div>
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          now={now}
          onSelect={() => onSelect(agent.id)}
        />
      ))}
    </section>
  )
}

function removeAssignmentPrompt(entries: ReturnType<typeof reducerInit>["entries"]) {
  let removed = false
  return entries.filter((entry) => {
    if (
      !removed &&
      entry.kind === "message" &&
      entry.role === "user" &&
      entry.blocks.some((block) => block.type !== "tool_result")
    ) {
      removed = true
      return false
    }
    return true
  })
}

function SubagentTranscript({
  agent,
  cwd,
  sessionId
}: {
  agent: SubagentTask
  cwd: string | null
  sessionId: string | null
}) {
  const [events, setEvents] = useState<ClaudeEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [available, setAvailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const offsetRef = useRef(0)

  useEffect(() => {
    offsetRef.current = 0
    setEvents([])
    setLoading(true)
    setAvailable(false)
    setError(null)
  }, [agent.id, cwd, sessionId])

  useEffect(() => {
    if (!cwd || !sessionId) {
      setLoading(false)
      return
    }
    let cancelled = false
    let inFlight = false

    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
        let iterations = 0
        let more = false
        do {
          const chunk = await readSubagentTranscriptChunk({
            cwd,
            sessionId,
            agentId: agent.id,
            offset: offsetRef.current
          })
          if (cancelled) return
          setAvailable(chunk.available)
          setError(null)
          offsetRef.current = chunk.nextOffset
          if (chunk.events.length > 0 || chunk.reset) {
            setEvents((current) =>
              chunk.reset ? chunk.events : [...current, ...chunk.events]
            )
          }
          more = chunk.truncated
          iterations += 1
        } while (more && iterations < 32)
      } catch (reason) {
        if (!cancelled) setError(String(reason))
      } finally {
        if (!cancelled) setLoading(false)
        inFlight = false
      }
    }

    void load()
    const interval =
      agent.status === "running" ? window.setInterval(() => void load(), 1200) : null
    return () => {
      cancelled = true
      if (interval !== null) window.clearInterval(interval)
    }
  }, [agent.id, agent.status, cwd, sessionId])

  const transcriptState = useMemo(
    () =>
      reduce(reducerInit(), {
        kind: "load_transcript",
        events: revealSubagentTranscriptEvents(events)
      }),
    [events]
  )
  const entries = useMemo(
    () => removeAssignmentPrompt(transcriptState.entries),
    [transcriptState.entries]
  )
  const nestedRunning = runningSubagentCount(transcriptState.subagents)

  if (error && entries.length === 0) {
    return (
      <div className="grid flex-1 place-items-center px-8 text-center">
        <div className="max-w-md rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          读取智能体过程失败：{error}
        </div>
      </div>
    )
  }

  if (entries.length > 0) {
    return (
      <MessageStream
        entries={entries}
        streaming={agent.status === "running"}
        autoScroll={shouldAutoScrollSubagentTranscript(agent.status)}
        cwd={cwd}
        pendingSubagentCount={nestedRunning}
      />
    )
  }

  if (agent.result) {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <AssistantMarkdown text={agent.result} cwd={cwd} />
        </div>
      </ScrollArea>
    )
  }

  return (
    <div className="grid flex-1 place-items-center px-8 text-center text-sm text-muted-foreground">
      <div className="flex max-w-sm flex-col items-center gap-2">
        {loading || agent.status === "running" ? (
          <Loader2 className="size-5 animate-spin" />
        ) : (
          <Clock3 className="size-5" />
        )}
        <span>
          {loading
            ? "正在读取智能体过程…"
            : !available && agent.status === "running"
              ? "智能体已启动，等待首条过程记录…"
              : "该智能体没有可读取的过程记录"}
        </span>
      </div>
    </div>
  )
}

export function SubagentsPanel({
  open,
  onOpenChange,
  agents,
  cwd,
  sessionId,
  selectedAgentId,
  onSelectedAgentChange
}: Props) {
  const [now, setNow] = useState(() => Date.now())
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null
  const groups = useMemo(() => partitionSubagents(agents), [agents])

  useEffect(() => {
    if (!open || groups.running.length === 0) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [open, groups.running.length])

  useEffect(() => {
    if (selectedAgentId && !selectedAgent) onSelectedAgentChange(null)
  }, [onSelectedAgentChange, selectedAgent, selectedAgentId])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-30 bg-background/60 backdrop-blur-[1px] duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed bottom-0 right-0 top-9 z-40 flex w-[min(760px,calc(100vw-16px))] flex-col overflow-hidden border-l bg-background shadow-2xl outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-8 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-8"
        >
          {selectedAgent ? (
            <>
              <div className="flex min-h-14 items-center gap-2 border-b px-3 py-2.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  aria-label="返回全部子智能体"
                  onClick={() => onSelectedAgentChange(null)}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <AgentAvatar agent={selectedAgent} />
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title
                    className="truncate text-sm font-medium"
                    title={selectedAgent.description}
                  >
                    {selectedAgent.description}
                  </DialogPrimitive.Title>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <AgentStatus status={selectedAgent.status} />
                    {selectedAgent.summary && (
                      <span className="truncate">{selectedAgent.summary}</span>
                    )}
                  </div>
                </div>
                <DialogPrimitive.Close asChild>
                  <Button variant="ghost" size="icon" className="size-8" aria-label="关闭">
                    <X className="size-4" />
                  </Button>
                </DialogPrimitive.Close>
              </div>
              <SubagentTranscript
                agent={selectedAgent}
                cwd={cwd}
                sessionId={sessionId}
              />
            </>
          ) : (
            <>
              <div className="flex min-h-14 items-center gap-2 border-b px-4 py-2.5">
                <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <Waypoints className="size-4" />
                </span>
                <DialogPrimitive.Title className="text-sm font-medium">
                  子智能体
                </DialogPrimitive.Title>
                <Badge variant="outline" className="text-[10px]">
                  {agents.length}
                </Badge>
                <DialogPrimitive.Close asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto size-8"
                    aria-label="关闭"
                  >
                    <X className="size-4" />
                  </Button>
                </DialogPrimitive.Close>
              </div>
              {agents.length === 0 ? (
                <div className="grid flex-1 place-items-center px-8 text-center text-sm text-muted-foreground">
                  当前会话没有启动子智能体
                </div>
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <div className="mx-auto w-full max-w-2xl px-5 pb-6 pt-3">
                    <AgentSection
                      title="运行中"
                      agents={groups.running}
                      now={now}
                      onSelect={onSelectedAgentChange}
                    />
                    <AgentSection
                      title="已完成"
                      agents={groups.finished}
                      now={now}
                      onSelect={onSelectedAgentChange}
                    />
                  </div>
                </ScrollArea>
              )}
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
