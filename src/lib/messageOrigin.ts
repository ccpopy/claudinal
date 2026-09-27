import type { ClaudeEvent } from "@/types/events"
import type { UIActivityCategory, UIEntry, UIMessage } from "@/types/ui"
import { parseTaskNotification } from "./userMessageText"

/** Tool results also use the API's user role, but are never authored turns. */
export function isAuthoredUserMessage(entry: UIEntry): entry is UIMessage & { role: "user" } {
  return entry.kind === "message" && entry.role === "user"
    && entry.blocks.some((block) => block.type !== "tool_result")
}

export function markAuthoredEvent(event: ClaudeEvent, entries: readonly UIEntry[], ids?: ReadonlySet<string>): ClaudeEvent {
  if (event.type !== "user") return event
  const uuid = (event as { uuid?: unknown }).uuid
  if (typeof uuid !== "string") return event
  const local = entries.find((entry) => isAuthoredUserMessage(entry)
    && (entry.id === uuid || entry.attemptIds?.includes(uuid)))
  const text = local && isAuthoredUserMessage(local)
    ? local.rawText ?? local.blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
    : undefined
  return local || ids?.has(uuid) ? { ...event, claudinalAuthored: true,
    ...(text !== undefined ? { claudinalAuthoredText: text } : {}) } : event
}

export function eventUserText(event: Record<string, unknown>): string {
  const message = event.message as { content?: unknown } | undefined
  const content = message?.content ?? event.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("\n")
}

export function originKind(event: Record<string, unknown>): string {
  const origin = event.origin as { kind?: unknown } | undefined
  return typeof origin?.kind === "string" ? origin.kind : ""
}

const ORIGIN_CATEGORIES: Record<string, UIActivityCategory> = {
  "task-notification": "task", "task_notification": "task",
  "hook": "hook", "hook-context": "hook", "hook_response": "hook",
  "compact-summary": "compact", "compact_summary": "compact",
  "local-command": "command", "local_command": "command",
  "teammate-message": "teammate", "teammate_message": "teammate",
  "system": "context", "system-reminder": "context", "plugin": "context"
}

export function hasInjectedProvenance(event: Record<string, unknown>): boolean {
  if (event.claudinalAuthored === true) return false
  const content = (event.message as { content?: unknown } | undefined)?.content
  return ["isMeta", "is_meta", "isSynthetic", "is_synthetic", "isCompactSummary", "is_compact_summary"]
    .some((key) => event[key] === true)
    || [event.sourceToolUseID, event.source_tool_use_id].some((id) => typeof id === "string" && !!id)
    || Object.hasOwn(ORIGIN_CATEGORIES, originKind(event))
    || (Array.isArray(content) && content.some((block) => block?.type === "tool_result" && typeof block.tool_use_id === "string"))
}

export function isTaskNotificationEvent(
  event: Record<string, unknown>, taskIds: readonly string[] = [], toolIds: readonly string[] = []
): boolean {
  if (event.claudinalAuthored === true) return false
  const text = eventUserText(event).trim()
  if (event.type === "user" && ORIGIN_CATEGORIES[originKind(event)] === "task") return true
  if (!/^<task-notification>[\s\S]*?<\/task-notification>(?:\s|$)/i.test(text)) return false
  if (event.type === "queue-operation") return true
  if (event.type !== "user") return false
  if (hasInjectedProvenance(event)) return true
  const note = parseTaskNotification(text)
  return (!!note.taskId && taskIds.includes(note.taskId)) || (!!note.toolUseId && toolIds.includes(note.toolUseId))
}

function commandOutputFollowsInput(entries: readonly UIEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === "result" || (entry.kind === "message" && entry.role === "assistant")) return false
    if (!isAuthoredUserMessage(entry)) continue
    if (entry.delivery === "guide" || ["queued", "paused", "preparing", "cancelled", "failed"].includes(entry.deliveryState ?? "")) continue
    const text = entry.rawText ?? entry.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n")
    return /^\s*(?:\/[\w.:-]+(?:\s|$)|!\s*\S)/.test(text)
  }
  return false
}

/** Classification needs provenance or a matching operation; text alone is not proof. */
export function userActivityCategory(
  event: Record<string, unknown>, entries: readonly UIEntry[], taskIds: readonly string[] = []
): UIActivityCategory | null {
  if (event.type !== "user" || event.claudinalAuthored === true) return null
  const uuid = typeof event.uuid === "string" ? event.uuid : undefined
  const replay = uuid ? entries.find((entry) => entry.kind === "activity" && entry.eventId === uuid) : undefined
  if (replay?.kind === "activity") return replay.category
  const toolIds = entries.flatMap((entry) => entry.kind === "message" && entry.role === "assistant"
    ? entry.blocks.flatMap((block) => block.type === "tool_use" && block.toolUseId ? [block.toolUseId] : []) : [])
  if (isTaskNotificationEvent(event, taskIds, toolIds)) return "task"
  const text = eventUserText(event).trim()
  const commandOutput = /^<(local-command-(?:stdout|stderr)|bash-(?:stdout|stderr))>[\s\S]*?<\/\1>(?:\s|$)/i.test(text)
  const injected = hasInjectedProvenance(event)
  if (commandOutput && (injected || commandOutputFollowsInput(entries))) return "command"
  if (!injected) return null
  if (event.isCompactSummary === true || event.is_compact_summary === true) return "compact"
  const origin = Object.hasOwn(ORIGIN_CATEGORIES, originKind(event)) ? ORIGIN_CATEGORIES[originKind(event)] : undefined
  if (origin) return origin
  if (/^<teammate-message(?:\s|>)/i.test(text)) return "teammate"
  if (typeof event.hookName === "string" || typeof event.hook_event_name === "string"
    || /^<(?:user-prompt-submit-hook|session-start-hook|hook-context)(?:\s|>)/i.test(text)) return "hook"
  if (/^<(?:local-command-[\w-]+|bash-(?:input|stdout|stderr))(?:\s|>)/i.test(text)) return "command"
  return "context"
}

export function activityLabel(category: UIActivityCategory, text: string): string {
  if (category === "task") {
    const note = parseTaskNotification(text)
    const kind = { command: "后台命令", agent: "子智能体", task: "后台任务" }[note.kind]
    const outcome = { completed: "已完成", failed: "失败", killed: "已停止", unknown: "通知" }[note.outcome]
    const subject = note.name ?? note.summary
    return `${kind}${outcome}${subject ? ` · ${subject.replace(/\s+/g, " ").slice(0, 100)}` : ""}`
  }
  if (category === "command") return "本地命令输出"
  if (category === "hook") return "Hook 补充信息"
  if (category === "compact") return "上下文压缩与恢复"
  if (category === "teammate") return "子智能体消息"
  return /^\s*<system-reminder>/i.test(text) ? "系统提醒" : "CLI 补充上下文"
}
