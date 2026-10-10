import { useEffect, useMemo, useRef, useState } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleStop,
  Clock3,
  Copy,
  Loader2,
  Search,
  Waypoints,
  X,
  type LucideIcon
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import { MessageStream } from "@/components/MessageStream"
import { AssistantMarkdown } from "@/components/AssistantMarkdown"
import { readSubagentTranscriptChunk } from "@/lib/ipc"
import { init as reducerInit, reduce } from "@/lib/reducer"
import {
  revealSubagentTranscriptEvents,
  mergeSubagentTranscriptEvents,
  runningSubagentCount,
  type SubagentStatus,
  type SubagentTask
} from "@/lib/subagents"
import { cn, formatRunDuration } from "@/lib/utils"
import type { ClaudeEvent } from "@/types/events"
import type { UIEntry } from "@/types/ui"

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
  },
  unknown: {
    label: "状态未知",
    Icon: Clock3,
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
  unknown: SubagentTask[]
} {
  return {
    running: agents
      .filter((agent) => agent.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt),
    finished: agents
      .filter((agent) => agent.status !== "running" && agent.status !== "unknown")
      .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt)),
    unknown: agents.filter((agent) => agent.status === "unknown").sort((a, b) => b.updatedAt - a.updatedAt)
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
  allAgents,
  now,
  onSelect
}: {
  agent: SubagentTask
  allAgents: SubagentTask[]
  now: number
  onSelect: () => void
}) {
  const end = agent.status === "running" ? now : (agent.endedAt ?? agent.updatedAt)
  const duration = Math.max(0, end - agent.startedAt)
  const parent = allAgents.find((item) => item.id === agent.parentTaskId)
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
        {(agent.parentTaskId || agent.spawnDepth !== undefined) && (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" title={agent.parentTaskId}>
            {agent.spawnDepth !== undefined && `层级 ${agent.spawnDepth}`}
            {agent.parentTaskId && ` · 父任务：${parent?.description ?? `${agent.parentTaskId}（未关联）`}`}
          </span>
        )}
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
  allAgents,
  now,
  onSelect
}: {
  title: string
  agents: SubagentTask[]
  allAgents: SubagentTask[]
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
          allAgents={allAgents}
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

export function subagentResponseText(entries: UIEntry[], fallback?: string): string {
  const messages = entries.filter((entry) => entry.kind === "message" && entry.role === "assistant")
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = messages[index]
    if (entry.kind !== "message" || entry.blocks.some((block) => block.type === "tool_use")) continue
    const text = entry.blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n\n").trim()
    if (text) return text
  }
  return fallback ?? ""
}

export function searchSubagentEntries(entries: UIEntry[], query: string): UIEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return entries
  return entries.filter((entry) => (entry.kind === "message"
    ? entry.blocks.map((block) => [block.text, block.toolName,
      block.toolInput === undefined ? "" : JSON.stringify(block.toolInput),
      block.toolResultContent === undefined ? "" : JSON.stringify(block.toolResultContent)].filter(Boolean).join("\n")).join("\n")
    : JSON.stringify(entry)).toLocaleLowerCase().includes(needle))
}

function SubagentTranscript({
  agent,
  cwd,
  sessionId,
  onOpenSubagent
}: {
  agent: SubagentTask
  cwd: string | null
  sessionId: string | null
  onOpenSubagent: (agentId: string) => void
}) {
  const [events, setEvents] = useState<ClaudeEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [available, setAvailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const offsetRef = useRef(0)
  const [query, setQuery] = useState("")

  useEffect(() => {
    offsetRef.current = 0
    setEvents([])
    setLoading(true)
    setAvailable(false)
    setError(null)
    setQuery("")
  }, [agent.id, cwd, sessionId])

  useEffect(() => {
    if (!cwd || !sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(agent.id)) {
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
              chunk.reset ? chunk.events : mergeSubagentTranscriptEvents(current, chunk.events)
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
      agent.status === "running" || agent.status === "unknown" ? window.setInterval(() => void load(), 1200) : null
    return () => {
      cancelled = true
      if (interval !== null) window.clearInterval(interval)
    }
  }, [agent.id, agent.status, cwd, sessionId])

  const transcriptState = useMemo(
    () =>
      reduce(reducerInit(), {
        kind: "load_transcript",
        events: revealSubagentTranscriptEvents(mergeSubagentTranscriptEvents(events, agent.forwardedEvents ?? []), agent)
      }),
    [events, agent.forwardedEvents, agent.id, agent.toolUseId]
  )
  const entries = useMemo(
    () => removeAssignmentPrompt(transcriptState.entries),
    [transcriptState.entries]
  )
  const nestedRunning = runningSubagentCount(transcriptState.subagents)
  const visibleEntries = useMemo(() => searchSubagentEntries(entries, query), [entries, query])
  const responseText = subagentResponseText(entries, agent.result)

  const toolbar = (
    <div className="flex items-center gap-2 border-b px-4 py-2">
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索该智能体的过程和回答"
        aria-label="搜索子智能体转录" className="h-8 min-w-0 flex-1 text-xs" />
      {query.trim() && <span className="shrink-0 text-[11px] text-muted-foreground">{visibleEntries.length} 条</span>}
      <Button type="button" variant="ghost" size="sm" disabled={!responseText} aria-label="复制子智能体回答"
        onClick={() => { void navigator.clipboard.writeText(responseText).then(() => toast.success("已复制智能体回答"), (reason) => toast.error(`复制回答失败：${String(reason)}`)) }}>
        <Copy className="size-3.5" />复制回答
      </Button>
    </div>
  )

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
      <>
        {toolbar}
        {agent.forwardedTruncated && !available && <p className="px-4 py-2 text-xs text-muted-foreground">转发缓存已达到上限，较早记录需从完整会话转录读取。</p>}
        {query.trim() && visibleEntries.length === 0 ? <div className="grid flex-1 place-items-center text-sm text-muted-foreground">没有匹配的记录</div> : <MessageStream
          entries={visibleEntries}
          streaming={!query.trim() && agent.status === "running"}
          autoScroll={!query.trim() && shouldAutoScrollSubagentTranscript(agent.status)}
          cwd={cwd}
          pendingSubagentCount={nestedRunning}
          subagents={transcriptState.subagents.agents}
          onOpenSubagent={onOpenSubagent}
        />}
      </>
    )
  }

  if (agent.result) {
    return (
      <>{toolbar}<ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {!query.trim() || agent.result.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
            ? <AssistantMarkdown text={agent.result} cwd={cwd} /> : <p className="text-sm text-muted-foreground">没有匹配的记录</p>}
        </div>
      </ScrollArea></>
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
              : agent.status === "unknown" ? "已收到智能体消息，生命周期尚未确认"
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
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId || agent.aliases?.includes(selectedAgentId ?? "")) ?? null
  const selectedParent = agents.find((agent) => agent.id === selectedAgent?.parentTaskId)
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
                  {(selectedAgent.parentTaskId || selectedAgent.runId || selectedAgent.spawnDepth !== undefined) && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      {selectedAgent.spawnDepth !== undefined && <span>层级 {selectedAgent.spawnDepth}</span>}
                      {selectedParent ? <button type="button" className="max-w-64 truncate underline underline-offset-2" onClick={() => onSelectedAgentChange(selectedParent.id)}>父任务：{selectedParent.description}</button>
                        : selectedAgent.parentTaskId && <span title={selectedAgent.parentTaskId}>父任务未关联</span>}
                      {selectedAgent.runId && <span className="max-w-32 truncate font-mono" title={selectedAgent.runId}>运行 {selectedAgent.runId}</span>}
                      {selectedAgent.rawStatus && selectedAgent.status === "unknown" && <span title={selectedAgent.rawStatus}>{selectedAgent.rawStatus}</span>}
                    </div>
                  )}
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
                onOpenSubagent={onSelectedAgentChange}
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
                      allAgents={agents}
                      now={now}
                      onSelect={onSelectedAgentChange}
                    />
                    <AgentSection
                      title="已结束"
                      agents={groups.finished}
                      allAgents={agents}
                      now={now}
                      onSelect={onSelectedAgentChange}
                    />
                    <AgentSection
                      title="状态未知"
                      agents={groups.unknown}
                      allAgents={agents}
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
