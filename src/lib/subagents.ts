import type { ClaudeEvent } from "@/types/events"

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled"

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
}

export interface SubagentRegistry {
  agents: SubagentTask[]
  cycleActive: boolean
  activeAgentIds: string[]
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
}

const MAX_NOTIFICATION_RESULT_CHARS = 64 * 1024

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
  if (status.includes("complete") || status === "success") return "completed"
  if (status.includes("cancel") || status.includes("interrupt") || status === "stopped") {
    return "cancelled"
  }
  if (status.includes("fail") || status.includes("error")) return "failed"
  if (status.includes("running") || status.includes("progress") || status === "pending") {
    return "running"
  }
  return undefined
}

function parseTaskNotification(event: ClaudeEvent): TaskNotification | null {
  const text = eventText(event)
  if (!/<task-notification>/i.test(text)) return null
  const taskId = xmlTag(text, "task-id")
  if (!taskId) return null
  const result = xmlTag(text, "result")
  return {
    taskId,
    toolUseId: xmlTag(text, "tool-use-id"),
    outputFile: xmlTag(text, "output-file"),
    status: normalizeStatus(xmlTag(text, "status")),
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
    model: stringValue(toolResult.resolvedModel ?? toolResult.resolved_model)
  }
}

function isDeliveredTaskNotification(event: ClaudeEvent): boolean {
  const obj = event as Record<string, unknown>
  if (obj.type !== "user") return false
  const origin = recordOf(obj.origin)
  return origin?.kind === "task-notification" || /<task-notification>/i.test(eventText(event))
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

export function subagentCycleReadyForFinal(registry: SubagentRegistry): boolean {
  if (!registry.cycleActive || registry.activeAgentIds.length === 0) return false
  const byId = new Map(registry.agents.map((agent) => [agent.id, agent]))
  return registry.activeAgentIds.every((id) => {
    const agent = byId.get(id)
    if (!agent || agent.status === "running") return false
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
  const ts = eventTimestamp(event)
  const launch = launchFromEvent(event)

  if (launch) {
    const existingIndex = current.agents.findIndex((agent) => agent.id === launch.id)
    const agents = current.agents.slice()
    if (existingIndex >= 0) {
      agents[existingIndex] = {
        ...agents[existingIndex],
        ...launch,
        startedAt: agents[existingIndex].startedAt || launch.startedAt,
        endedAt: undefined,
        summary: undefined,
        result: undefined,
        notificationQueuedAt: undefined,
        notificationDeliveredAt: undefined
      }
    } else {
      agents.push(launch)
    }
    const activeAgentIds = current.activeAgentIds.includes(launch.id)
      ? current.activeAgentIds
      : [...current.activeAgentIds, launch.id]
    return {
      registry: { agents, cycleActive: true, activeAgentIds },
      changed: true,
      resultDisposition: "none"
    }
  }

  const notification = parseTaskNotification(event)
  if (notification) {
    const index = current.agents.findIndex((agent) => agent.id === notification.taskId)
    if (index >= 0) {
      const previous = current.agents[index]
      const delivered = isDeliveredTaskNotification(event)
      const queued = type === "queue-operation" && obj.operation === "enqueue"
      const status = notification.status ?? previous.status
      const endedAt = status === "running" ? undefined : (previous.endedAt ?? ts)
      const next: SubagentTask = {
        ...previous,
        toolUseId: notification.toolUseId ?? previous.toolUseId,
        outputFile: notification.outputFile ?? previous.outputFile,
        status,
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
      const agents = current.agents.slice()
      agents[index] = next
      return {
        registry: { ...current, agents },
        changed: true,
        resultDisposition: "none"
      }
    }
  }

  if (type !== "result") {
    return { registry: current, changed: false, resultDisposition: "none" }
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
    return { registry: current, changed: false, resultDisposition: "final" }
  }

  if (!subagentCycleReadyForFinal(current)) {
    return { registry: current, changed: false, resultDisposition: "intermediate" }
  }

  return {
    registry: { ...current, cycleActive: false, activeAgentIds: [] },
    changed: true,
    resultDisposition: "final"
  }
}

export function subagentRegistryBusy(registry: SubagentRegistry): boolean {
  return registry.cycleActive
}

export function runningSubagentCount(registry: SubagentRegistry): number {
  return registry.agents.filter((agent) => agent.status === "running").length
}

export function settleSubagentRegistryForResume(
  registry: SubagentRegistry
): SubagentRegistry {
  if (!registry.cycleActive && registry.activeAgentIds.length === 0) return registry
  return { ...registry, cycleActive: false, activeAgentIds: [] }
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

export function revealSubagentTranscriptEvents(events: ClaudeEvent[]): ClaudeEvent[] {
  return events.map(
    (event) =>
      ({
        ...(event as Record<string, unknown>),
        isSidechain: false
      }) as unknown as ClaudeEvent
  )
}
