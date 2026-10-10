import type { ClaudeEvent } from "@/types/events"
import { isTaskNotificationEvent } from "./messageOrigin"

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled" | "unknown"

export interface SubagentTask {
  id: string
  toolUseId: string | null
  description: string
  status: SubagentStatus
  startedAt: number
  updatedAt: number
  endedAt?: number
  outputFile?: string
  model?: string
  summary?: string
  result?: string
  notificationQueuedAt?: number
  notificationDeliveredAt?: number
  /** CLI task identity and relationship metadata; absent fields stay unknown. */
  aliases?: string[]
  parentTaskId?: string
  spawnDepth?: number
  runId?: string
  taskType?: string
  subagentType?: string
  isBackgrounded?: boolean
  rawStatus?: string
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
  lastToolName?: string
  prompt?: string
  lifecyclePatch?: Record<string, unknown>
  forwardedEvents?: ClaudeEvent[]
  forwardedTruncated?: boolean
}

export interface SubagentRegistry {
  agents: SubagentTask[]
  cycleActive: boolean
  activeAgentIds: string[]
  /** Once observed, the per-process level signal owns background membership. */
  backgroundTaskIds?: string[]
}

export type SubagentResultDisposition = "none" | "intermediate" | "final"

export interface SubagentTransition {
  registry: SubagentRegistry
  changed: boolean
  resultDisposition: SubagentResultDisposition
}

interface TaskNotification {
  taskId: string
  toolUseId?: string
  outputFile?: string
  status?: SubagentStatus
  summary?: string
  result?: string
  rawStatus?: string
}

const MAX_NOTIFICATION_RESULT_CHARS = 64 * 1024
const MAX_FORWARDED_EVENTS = 512
const MAX_FORWARDED_CHARS = 2 * 1024 * 1024

export function isForwardedSubagentEvent(event: ClaudeEvent): boolean {
  const obj = event as Record<string, unknown>
  return !!stringValue(obj.parent_tool_use_id) || !!stringValue(obj.agent_id)
}

export function isSubagentLifecycleEvent(event: ClaudeEvent): boolean {
  return event.type === "system" && ["task_started", "task_progress", "task_notification", "task_updated", "background_tasks_changed"].includes(String(event.subtype))
}

export function initSubagentRegistry(): SubagentRegistry {
  return { agents: [], cycleActive: false, activeAgentIds: [] }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function eventTimestamp(event: ClaudeEvent): number {
  const obj = event as Record<string, unknown>
  const raw = obj.timestamp ?? obj.ts
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw === "string") {
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function eventText(event: ClaudeEvent): string {
  const obj = event as Record<string, unknown>
  if (typeof obj.content === "string") return obj.content
  const message = recordOf(obj.message)
  const content = message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      const item = recordOf(block)
      return item?.type === "text" && typeof item.text === "string"
        ? item.text
        : ""
    })
    .filter(Boolean)
    .join("\n")
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function xmlTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"))
  const value = match?.[1]?.trim()
  return value ? decodeXmlText(value) : undefined
}

function normalizeStatus(value: unknown): SubagentStatus | undefined {
  if (typeof value !== "string") return undefined
  const status = value.trim().toLowerCase()
  if (!status) return undefined
  if (status === "completed" || status === "success") return "completed"
  if (["cancelled", "canceled", "interrupted", "stopped", "killed"].includes(status)) {
    return "cancelled"
  }
  if (status === "failed" || status === "error") return "failed"
  if (status === "running" || status === "in_progress") {
    return "running"
  }
  return "unknown"
}

function parseTaskNotification(event: ClaudeEvent): TaskNotification | null {
  const text = eventText(event)
  if (!/<task-notification>/i.test(text)) return null
  const taskId = xmlTag(text, "task-id")
  if (!taskId) return null
  const result = xmlTag(text, "result")
  const rawStatus = xmlTag(text, "status")
  return {
    taskId,
    toolUseId: xmlTag(text, "tool-use-id"),
    outputFile: xmlTag(text, "output-file"),
    status: normalizeStatus(rawStatus) ?? "unknown",
    rawStatus,
    summary: xmlTag(text, "summary"),
    result:
      result && result.length > MAX_NOTIFICATION_RESULT_CHARS
        ? `${result.slice(0, MAX_NOTIFICATION_RESULT_CHARS)}…`
        : result
  }
}

function launchFromEvent(event: ClaudeEvent): SubagentTask | null {
  const obj = event as Record<string, unknown>
  const toolResult =
    recordOf(obj.toolUseResult) ?? recordOf(obj.tool_use_result)
  if (!toolResult) return null
  const status = stringValue(toolResult.status)?.toLowerCase()
  if (toolResult.isAsync !== true && status !== "async_launched") return null
  const id = stringValue(toolResult.agentId ?? toolResult.agent_id)
  if (!id) return null
  const message = recordOf(obj.message)
  const content = message?.content
  let toolUseId: string | null = null
  if (Array.isArray(content)) {
    for (const block of content) {
      const item = recordOf(block)
      if (item?.type !== "tool_result") continue
      toolUseId = stringValue(item.tool_use_id) ?? null
      if (toolUseId) break
    }
  }
  const ts = eventTimestamp(event)
  return {
    id,
    toolUseId,
    description:
      stringValue(toolResult.description) ?? `Agent ${id.slice(0, 8)}`,
    status: "running",
    startedAt: ts,
    updatedAt: ts,
    outputFile: stringValue(toolResult.outputFile ?? toolResult.output_file),
    model: stringValue(toolResult.resolvedModel ?? toolResult.resolved_model),
    isBackgrounded: true,
    runId: stringValue(toolResult.runId ?? toolResult.run_id),
    parentTaskId: stringValue(obj.parent_task_id ?? obj.agent_id)
  }
}

function isFailedResult(event: ClaudeEvent): boolean {
  const obj = event as Record<string, unknown>
  if (obj.type !== "result") return false
  if (obj.is_error === true) return true
  const subtype = stringValue(obj.subtype)?.toLowerCase()
  const terminalReason = stringValue(obj.terminal_reason)?.toLowerCase()
  return (
    subtype?.startsWith("error") === true ||
    terminalReason === "api_error" ||
    terminalReason === "failed"
  )
}

function isInterruptedResult(event: ClaudeEvent): boolean {
  const obj = event as Record<string, unknown>
  return (
    obj.type === "result" &&
    stringValue(obj.terminal_reason)?.toLowerCase() === "interrupted"
  )
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function settleUnconfirmedForegroundTasks(registry: SubagentRegistry): SubagentRegistry {
  const agents = registry.agents.map((agent) => agent.status === "running" && agent.isBackgrounded !== true
    ? { ...agent, status: "unknown" as const, rawStatus: "terminal_unconfirmed" } : agent)
  return agents.some((agent, index) => agent !== registry.agents[index]) ? { ...registry, agents } : registry
}

function matchesTask(agent: SubagentTask, id: string): boolean {
  return agent.id === id || agent.aliases?.includes(id) === true
}

function runIsLate(previous: SubagentTask | undefined, runId: string | undefined): boolean {
  // The public contract promises lexical run order, but no particular format.
  return !!previous?.runId && !!runId && runId < previous.runId
}

function transcriptKey(event: ClaudeEvent): string {
  const obj = event as Record<string, unknown>
  const message = recordOf(obj.message)
  const id = stringValue(message?.id) ?? stringValue(obj.uuid)
  return `${obj.type}:${id ?? JSON.stringify(message ?? obj)}`
}

function mergeTranscriptMessage(previous: ClaudeEvent, next: ClaudeEvent): ClaudeEvent {
  const oldMessage = recordOf((previous as Record<string, unknown>).message)
  const newMessage = recordOf((next as Record<string, unknown>).message)
  if (!oldMessage || !newMessage) return next
  const oldContent = oldMessage.content
  const newContent = newMessage.content
  if (!Array.isArray(oldContent) || !Array.isArray(newContent)) return next
  const content = oldContent.slice()
  const matched = new Set<number>()
  for (let index = 0; index < newContent.length; index++) {
    const block = recordOf(newContent[index])
    const toolId = stringValue(block?.id ?? block?.tool_use_id)
    const at = toolId ? content.findIndex((value) => {
      const item = recordOf(value)
      return item?.type === block?.type && (item?.id ?? item?.tool_use_id) === toolId
    }) : content.findIndex((value, position) => {
      if (matched.has(position)) return false
      const item = recordOf(value)
      if (item?.type !== block?.type) return false
      const field = block?.type === "text" ? "text" : block?.type === "thinking" ? "thinking" : null
      return field && typeof item?.[field] === "string" && typeof block?.[field] === "string"
        ? item[field].startsWith(block[field]) || block[field].startsWith(item[field])
        : JSON.stringify(item) === JSON.stringify(block)
    })
    const oldBlock = recordOf(content[at])
    if (oldBlock && block && oldBlock.type === block.type) {
      const merged = { ...oldBlock, ...block }
      for (const field of ["text", "thinking"] as const) {
        if (typeof oldBlock[field] === "string" && typeof block[field] === "string"
          && oldBlock[field].startsWith(block[field])) merged[field] = oldBlock[field]
      }
      if (block.type === "tool_use") {
        const oldInput = recordOf(oldBlock.input)
        const newInput = recordOf(block.input)
        if (oldInput && newInput) merged.input = { ...oldInput, ...newInput }
      }
      content[at] = merged
    } else if (at >= 0) content[at] = newContent[index]
    else content.push(newContent[index])
    matched.add(at >= 0 ? at : content.length - 1)
  }
  return { ...previous, ...next, message: { ...oldMessage, ...newMessage, content } } as ClaudeEvent
}

/** Reconcile complete message snapshots and disk replay without duplicating blocks. */
export function mergeSubagentTranscriptEvents(
  current: ClaudeEvent[], incoming: ClaudeEvent[]
): ClaudeEvent[] {
  if (!incoming.length) return current
  const events = current.slice()
  const keys = new Map(events.map((event, index) => [transcriptKey(event), index]))
  for (const event of incoming) {
    const key = transcriptKey(event)
    const at = keys.get(key)
    if (at === undefined) {
      keys.set(key, events.length)
      events.push(event)
    } else events[at] = mergeTranscriptMessage(events[at], event)
  }
  return events
}

function boundForwardedEvents(events: ClaudeEvent[]): { events: ClaudeEvent[]; truncated: boolean } {
  let chars = 0
  const bounded: ClaudeEvent[] = []
  for (let index = events.length - 1; index >= 0 && bounded.length < MAX_FORWARDED_EVENTS; index--) {
    const size = JSON.stringify(events[index]).length
    if (chars + size > MAX_FORWARDED_CHARS) break
    chars += size
    bounded.push(events[index])
  }
  return { events: bounded.reverse(), truncated: bounded.length < events.length }
}

function withTask(current: SubagentRegistry, next: SubagentTask, previous?: SubagentTask): SubagentTransition {
  let agents = current.agents.slice()
  // A level can name the task before its start edge supplies the spawn tool ID.
  // Reconcile that entry with an earlier unattributed forwarded tool slot.
  const orphan = next.toolUseId ? agents.find((agent) => agent !== previous
    && agent.id === `tool:${next.toolUseId}` && agent.id !== next.id) : undefined
  if (orphan) {
    const forwarded = boundForwardedEvents(mergeSubagentTranscriptEvents(orphan.forwardedEvents ?? [], next.forwardedEvents ?? []))
    next = { ...orphan, ...next,
      aliases: [...new Set([...(orphan.aliases ?? []), ...(next.aliases ?? []), orphan.id])],
      parentTaskId: next.parentTaskId ?? orphan.parentTaskId,
      startedAt: Math.min(orphan.startedAt, next.startedAt),
      forwardedEvents: forwarded.events,
      forwardedTruncated: orphan.forwardedTruncated || next.forwardedTruncated || forwarded.truncated }
    agents = agents.filter((agent) => agent !== orphan).map((agent) => agent.parentTaskId === orphan.id
      ? { ...agent, parentTaskId: next.id } : agent)
  }
  const at = previous ? agents.findIndex((agent) => agent.id === previous.id) : -1
  if (at >= 0) agents[at] = next
  else agents.push(next)
  // Promote an unattributed tool slot when its authoritative task id arrives.
  if (previous && previous.id !== next.id) agents = agents.map((agent) => agent.parentTaskId === previous.id
    ? { ...agent, parentTaskId: next.id } : agent)
  let activeAgentIds = [...new Set(current.activeAgentIds.map((id) => id === previous?.id || id === orphan?.id ? next.id : id))]
  const strictlyNewerRun = !!previous?.runId && !!next.runId && next.runId > previous.runId
  if (next.status === "unknown") activeAgentIds = activeAgentIds.filter((id) => id !== next.id)
  else if (next.status === "running" && next.isBackgrounded === true && !activeAgentIds.includes(next.id)
    && (!current.backgroundTaskIds || current.backgroundTaskIds.includes(next.id) || strictlyNewerRun)) {
    activeAgentIds = [...activeAgentIds, next.id]
  }
  const registry = { ...current, agents, activeAgentIds, cycleActive: current.cycleActive || activeAgentIds.length > 0 }
  return { registry, changed: true, resultDisposition: "none" }
}

function backgroundMembershipTransition(current: SubagentRegistry, event: ClaudeEvent, ts: number): SubagentTransition | null {
  const obj = event as Record<string, unknown>
  if (event.type !== "system" || obj.subtype !== "background_tasks_changed" || !Array.isArray(obj.tasks)) return null
  const tasks = obj.tasks.map(recordOf).filter((task): task is Record<string, unknown> =>
    !!task && task.task_type === "local_agent" && task.ambient !== true && !!stringValue(task.task_id))
  const backgroundTaskIds = [...new Set(tasks.map((task) => stringValue(task.task_id)!))]
  let agents = current.agents.slice()
  for (const task of tasks) {
    const id = stringValue(task.task_id)!
    const at = agents.findIndex((agent) => matchesTask(agent, id))
    const previous = agents[at]
    const runId = stringValue(task.run_id)
    if (runIsLate(previous, runId)) continue
    const newRun = !!previous?.runId && !!runId && runId > previous.runId
    const running = !previous || newRun || previous.status === "running"
      || previous.status === "unknown" && !previous.rawStatus || previous.rawStatus === "background_terminal_unconfirmed"
    const next: SubagentTask = {
      ...previous, id, toolUseId: previous?.toolUseId ?? null,
      aliases: previous && previous.id !== id ? [...(previous.aliases ?? []), previous.id] : previous?.aliases,
      description: stringValue(task.description) ?? previous?.description ?? `Agent ${id.slice(0, 8)}`,
      status: running ? "running" : previous?.status ?? "unknown",
      rawStatus: running ? undefined : previous?.rawStatus,
      startedAt: newRun ? ts : previous?.startedAt ?? ts,
      updatedAt: ts, endedAt: running ? undefined : previous?.endedAt,
      runId: runId ?? previous?.runId, taskType: "local_agent", isBackgrounded: true,
      subagentType: stringValue(task.subagent_type) ?? previous?.subagentType,
      parentTaskId: stringValue(task.parent_task_id) ?? previous?.parentTaskId,
      notificationQueuedAt: newRun ? undefined : previous?.notificationQueuedAt,
      notificationDeliveredAt: newRun ? undefined : previous?.notificationDeliveredAt,
      summary: newRun ? undefined : previous?.summary, result: newRun ? undefined : previous?.result
    }
    if (at >= 0) agents[at] = next
    else agents.push(next)
  }
  const live = new Set(backgroundTaskIds)
  agents = agents.map((agent) => agent.isBackgrounded === true && agent.status === "running" && !live.has(agent.id)
    ? { ...agent, status: "unknown" as const, rawStatus: "background_terminal_unconfirmed", updatedAt: ts }
    : agent)
  // A queued notification still needs delivery to the main turn; absence from
  // the live set proves the task ended, but cannot prove its summary was consumed.
  const activeAgentIds = agents.filter((agent) => live.has(agent.id) && agent.status !== "unknown"
    || current.activeAgentIds.includes(agent.id) && agent.status !== "unknown"
      && agent.notificationQueuedAt !== undefined && agent.notificationDeliveredAt === undefined).map((agent) => agent.id)
  return { registry: { ...current, agents, activeAgentIds, backgroundTaskIds,
    cycleActive: current.cycleActive || activeAgentIds.length > 0 }, changed: true, resultDisposition: "none" }
}

function lifecycleTransition(current: SubagentRegistry, event: ClaudeEvent, ts: number): SubagentTransition | null {
  if (!isSubagentLifecycleEvent(event)) return null
  const obj = event as Record<string, unknown>
  const id = stringValue(obj.task_id)
  if (!id) return null
  const toolUseId = stringValue(obj.tool_use_id)
  const previous = current.agents.find((agent) => matchesTask(agent, id))
    ?? current.agents.find((agent) => !!toolUseId && agent.toolUseId === toolUseId)
  // Shell/MCP/workflow task events share the public schema but are not Agents.
  const taskType = stringValue(obj.task_type)
  if ((!previous && taskType && taskType !== "local_agent") || obj.ambient === true) return null
  if (!previous && obj.subtype !== "task_started" && !stringValue(obj.subagent_type)) return null
  const runId = stringValue(obj.run_id)
  if (runIsLate(previous, runId)) return { registry: current, changed: false, resultDisposition: "none" }
  const newRun = !!previous?.runId && !!runId && runId > previous.runId
  const patch = recordOf(obj.patch)
  const rawStatus = stringValue(patch?.status ?? obj.status)
  const status = rawStatus ? normalizeStatus(rawStatus)!
    : obj.subtype === "task_started" && (!previous || newRun || (previous.status === "unknown" && !previous.rawStatus))
      ? "running" : previous?.status ?? "unknown"
  const next: SubagentTask = {
    ...previous,
    id,
    aliases: previous && previous.id !== id ? [...(previous.aliases ?? []), previous.id] : previous?.aliases,
    toolUseId: toolUseId ?? previous?.toolUseId ?? null,
    description: stringValue(patch?.description ?? obj.description) ?? previous?.description ?? `Agent ${id.slice(0, 8)}`,
    status,
    rawStatus: rawStatus ?? (newRun ? undefined : previous?.rawStatus),
    startedAt: newRun ? ts : previous?.startedAt ?? ts,
    updatedAt: ts,
    endedAt: status === "running" || status === "unknown" ? undefined
      : typeof patch?.end_time === "number" ? patch.end_time : previous?.endedAt ?? ts,
    runId: runId ?? previous?.runId,
    parentTaskId: stringValue(obj.parent_task_id) ?? previous?.parentTaskId,
    spawnDepth: typeof obj.spawn_depth === "number" && Number.isFinite(obj.spawn_depth) && obj.spawn_depth >= 0
      ? obj.spawn_depth : previous?.spawnDepth,
    taskType: taskType ?? previous?.taskType,
    subagentType: stringValue(obj.subagent_type) ?? previous?.subagentType,
    isBackgrounded: typeof patch?.is_backgrounded === "boolean" ? patch.is_backgrounded
      : typeof obj.is_backgrounded === "boolean" ? obj.is_backgrounded : previous?.isBackgrounded,
    prompt: stringValue(obj.prompt) ?? previous?.prompt,
    outputFile: stringValue(obj.output_file) ?? previous?.outputFile,
    summary: stringValue(obj.summary ?? patch?.error) ?? (newRun ? undefined : previous?.summary),
    result: newRun ? undefined : previous?.result,
    usage: (recordOf(obj.usage) as SubagentTask["usage"]) ?? previous?.usage,
    lastToolName: stringValue(obj.last_tool_name) ?? previous?.lastToolName,
    lifecyclePatch: patch ? { ...(previous?.lifecyclePatch ?? {}), ...patch } : previous?.lifecyclePatch,
    notificationQueuedAt: newRun ? undefined : previous?.notificationQueuedAt,
    notificationDeliveredAt: newRun ? undefined : previous?.notificationDeliveredAt
  }
  return withTask(current, next, previous)
}

function forwardedTransition(current: SubagentRegistry, event: ClaudeEvent, ts: number): SubagentTransition | null {
  if (!isForwardedSubagentEvent(event) || !["assistant", "user", "stream_event"].includes(event.type)) return null
  const obj = event as Record<string, unknown>
  const agentId = stringValue(obj.agent_id)
  const toolUseId = stringValue(obj.parent_tool_use_id)
  const previous = current.agents.find((agent) => !!agentId && matchesTask(agent, agentId))
    ?? current.agents.find((agent) => !!toolUseId && agent.toolUseId === toolUseId)
  const runId = stringValue(obj.run_id)
  if (runIsLate(previous, runId)) return { registry: current, changed: false, resultDisposition: "none" }
  const newRun = !!previous?.runId && !!runId && runId > previous.runId
  const id = agentId ?? previous?.id ?? `tool:${toolUseId}`
  const parent = current.agents.find((agent) => agent.forwardedEvents?.some((frame) => {
    const content = recordOf((frame as Record<string, unknown>).message)?.content
    return Array.isArray(content) && content.some((block) => {
      const item = recordOf(block)
      return item?.type === "tool_use" && item.id === toolUseId
    })
  }))
  const allEvents = mergeSubagentTranscriptEvents(previous?.forwardedEvents ?? [], [event])
  const bounded = boundForwardedEvents(allEvents)
  const next: SubagentTask = {
    ...previous,
    id,
    aliases: previous && previous.id !== id ? [...(previous.aliases ?? []), previous.id] : previous?.aliases,
    toolUseId: toolUseId ?? previous?.toolUseId ?? null,
    parentTaskId: stringValue(obj.parent_task_id) ?? previous?.parentTaskId ?? parent?.id,
    description: previous?.description ?? `Agent ${id.slice(0, 8)}`,
    status: newRun ? "unknown" : previous?.status ?? "unknown",
    startedAt: newRun ? ts : previous?.startedAt ?? ts,
    updatedAt: Math.max(previous?.updatedAt ?? ts, ts),
    runId: runId ?? previous?.runId,
    endedAt: newRun ? undefined : previous?.endedAt,
    notificationQueuedAt: newRun ? undefined : previous?.notificationQueuedAt,
    notificationDeliveredAt: newRun ? undefined : previous?.notificationDeliveredAt,
    summary: newRun ? undefined : previous?.summary,
    result: newRun ? undefined : previous?.result,
    model: stringValue(recordOf(obj.message)?.model) ?? previous?.model,
    forwardedEvents: bounded.events,
    forwardedTruncated: previous?.forwardedTruncated || bounded.truncated
  }
  return withTask(current, next, previous)
}

export function subagentCycleReadyForFinal(registry: SubagentRegistry): boolean {
  if (!registry.cycleActive || registry.activeAgentIds.length === 0) return false
  const byId = new Map(registry.agents.map((agent) => [agent.id, agent]))
  return registry.activeAgentIds.every((id) => {
    const agent = byId.get(id)
    if (!agent || agent.status === "running") return false
    if (agent.status === "unknown") return true
    return (
      agent.notificationDeliveredAt !== undefined ||
      agent.notificationQueuedAt === undefined
    )
  })
}

export function reduceSubagentRegistry(
  current: SubagentRegistry,
  event: ClaudeEvent
): SubagentTransition {
  const obj = event as Record<string, unknown>
  const type = stringValue(obj.type)
  if (obj.claudinalAuthored === true) return { registry: current, changed: false, resultDisposition: "none" }
  const ts = eventTimestamp(event)
  const backgroundMembership = backgroundMembershipTransition(current, event, ts)
  if (backgroundMembership) return backgroundMembership
  const lifecycle = lifecycleTransition(current, event, ts)
  if (lifecycle) return lifecycle
  const forwarded = forwardedTransition(current, event, ts)
  if (forwarded) current = forwarded.registry
  const launch = launchFromEvent(event)

  if (launch) {
    const previous = current.agents.find((agent) => matchesTask(agent, launch.id))
      ?? current.agents.find((agent) => !!launch.toolUseId && agent.toolUseId === launch.toolUseId)
    if (runIsLate(previous, launch.runId)) return forwarded ?? { registry: current, changed: false, resultDisposition: "none" }
    const newRun = !!previous?.runId && !!launch.runId && launch.runId > previous.runId
    return withTask(current, {
      ...previous,
      ...launch,
      aliases: previous && previous.id !== launch.id ? [...(previous.aliases ?? []), previous.id] : previous?.aliases,
      parentTaskId: launch.parentTaskId ?? previous?.parentTaskId,
      runId: launch.runId ?? previous?.runId,
      status: !newRun && previous && (previous.status !== "unknown" || previous.rawStatus) ? previous.status : launch.status,
      startedAt: newRun ? ts : previous?.startedAt ?? ts,
      endedAt: newRun ? undefined : previous?.endedAt,
      notificationQueuedAt: newRun ? undefined : previous?.notificationQueuedAt,
      notificationDeliveredAt: newRun ? undefined : previous?.notificationDeliveredAt,
      summary: newRun ? undefined : previous?.summary,
      result: newRun ? undefined : previous?.result
    }, previous)
  }

  const notification = isTaskNotificationEvent(obj, current.agents.map((agent) => agent.id),
    current.agents.flatMap((agent) => agent.toolUseId ? [agent.toolUseId] : []))
    ? parseTaskNotification(event) : null
  if (notification) {
    const index = current.agents.findIndex((agent) => agent.id === notification.taskId)
    if (index >= 0) {
      const previous = current.agents[index]
      if (runIsLate(previous, stringValue(recordOf(obj.origin)?.runId))) {
        return { registry: current, changed: false, resultDisposition: "none" }
      }
      const delivered = type === "user"
      const queued = type === "queue-operation" && obj.operation === "enqueue"
      const status = notification.status ?? previous.status
      const endedAt = status === "running" || status === "unknown" ? undefined : (previous.endedAt ?? ts)
      const next: SubagentTask = {
        ...previous,
        toolUseId: notification.toolUseId ?? previous.toolUseId,
        outputFile: notification.outputFile ?? previous.outputFile,
        status,
        rawStatus: notification.rawStatus ?? previous.rawStatus,
        updatedAt: ts,
        endedAt,
        summary: notification.summary ?? previous.summary,
        result: notification.result ?? previous.result,
        notificationQueuedAt: queued
          ? (previous.notificationQueuedAt ?? ts)
          : previous.notificationQueuedAt,
        notificationDeliveredAt: delivered
          ? ts
          : previous.notificationDeliveredAt
      }
      return withTask(current, next, previous)
    }
  }

  if (type !== "result" || isForwardedSubagentEvent(event)) {
    return forwarded ?? { registry: current, changed: false, resultDisposition: "none" }
  }

  if (isInterruptedResult(event)) {
    const active = new Set(current.activeAgentIds)
    const agents = current.agents.map((agent) =>
      active.has(agent.id) && agent.status === "running"
        ? {
            ...agent,
            status: "cancelled" as const,
            updatedAt: ts,
            endedAt: ts,
            summary: agent.summary ?? "主任务已取消"
          }
        : agent
    )
    const registry = {
      agents,
      cycleActive: false,
      activeAgentIds: []
    }
    const changed =
      current.cycleActive ||
      !sameStringArray(current.activeAgentIds, registry.activeAgentIds) ||
      agents.some((agent, index) => agent !== current.agents[index])
    return { registry, changed, resultDisposition: "final" }
  }

  if (isFailedResult(event)) {
    if (!current.cycleActive) {
      return { registry: current, changed: false, resultDisposition: "final" }
    }
    return {
      registry: { ...current, cycleActive: false, activeAgentIds: [] },
      changed: true,
      resultDisposition: "final"
    }
  }

  if (!current.cycleActive) {
    const registry = settleUnconfirmedForegroundTasks(current)
    return { registry, changed: registry !== current, resultDisposition: "final" }
  }

  if (subagentRegistryBusy(current) && !subagentCycleReadyForFinal(current)) {
    return { registry: current, changed: false, resultDisposition: "intermediate" }
  }

  return {
    registry: { ...settleUnconfirmedForegroundTasks(current), cycleActive: false, activeAgentIds: [] },
    changed: true,
    resultDisposition: "final"
  }
}

export function subagentRegistryBusy(registry: SubagentRegistry): boolean {
  if (!registry.cycleActive) return false
  return registry.activeAgentIds.some((id) => registry.agents.some((agent) => agent.id === id && agent.status !== "unknown"))
}

export function runningSubagentCount(registry: SubagentRegistry): number {
  return registry.agents.filter((agent) => agent.status === "running").length
}

export function settleSubagentRegistryForResume(
  registry: SubagentRegistry
): SubagentRegistry {
  if (!registry.cycleActive && registry.activeAgentIds.length === 0 && registry.backgroundTaskIds === undefined
    && !registry.agents.some((agent) => agent.status === "running")) return registry
  return { ...registry, cycleActive: false, activeAgentIds: [], backgroundTaskIds: undefined, agents: registry.agents.map((agent) => agent.status === "running"
    ? { ...agent, status: "unknown", rawStatus: "runtime_disconnected" } : agent) }
}

export function truncateSubagentRegistry(
  registry: SubagentRegistry,
  cutoffTs: number
): SubagentRegistry {
  const agents = registry.agents.filter((agent) => agent.startedAt < cutoffTs)
  const validIds = new Set(agents.map((agent) => agent.id))
  const activeAgentIds = registry.activeAgentIds.filter((id) => validIds.has(id))
  return {
    agents,
    activeAgentIds,
    cycleActive: registry.cycleActive && activeAgentIds.length > 0
  }
}

export function revealSubagentTranscriptEvents(events: ClaudeEvent[], agent?: SubagentTask): ClaudeEvent[] {
  return events.map(
    (event) => {
      const obj = event as Record<string, unknown>
      return ({
        ...obj,
        isSidechain: false,
        ...(!agent || matchesTask(agent, String(obj.agent_id)) || obj.parent_tool_use_id === agent.toolUseId
          ? { parent_tool_use_id: null, agent_id: undefined } : {})
      }) as unknown as ClaudeEvent
    }
  )
}
