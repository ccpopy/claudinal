import type { UIMessage } from "@/types/ui"

/**
 * 用户消息里由 CLI / 宿主注入的上下文块。只拆出「独占整行」的标签块，
 * 用户在句子中间提到的 `<system-reminder>` 字样保持原文不动。
 */
export interface InjectedContext {
  tag: string
  label: string
  content: string
}

const INJECTED_TAG_LABELS: Record<string, string> = {
  "system-reminder": "系统提醒",
  "local-command-caveat": "本地命令说明",
  "task-notification": "后台任务通知"
}

const INJECTED_BLOCK_RE =
  /(^|\n)[ \t]*<(system-reminder|local-command-caveat|task-notification)>([\s\S]*?)<\/\2>[ \t]*(?=\n|$)/gi

/**
 * CLI 后台任务结束时注入的 `<task-notification>`：后台 shell 命令或
 * 异步 Agent 结束后，CLI 以用户身份插入这条通知来唤醒模型。
 */
export interface TaskNotification {
  kind: "command" | "agent" | "task"
  outcome: "completed" | "failed" | "killed" | "unknown"
  /** 命令描述或 Agent 名称；解析不到时为 undefined */
  name?: string
  exitCode?: number
  summary?: string
  taskId?: string
  toolUseId?: string
  outputFile?: string
  status?: string
}

export function parseTaskNotification(content: string): TaskNotification {
  const field = (tag: string) =>
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(content)?.[1]?.trim() || undefined
  const status = field("status")
  const summary = field("summary")
  const named = summary ? /^(Background command|Agent|Task)\s+"([\s\S]+?)"\s+(.*)$/i.exec(summary) : null
  const kindWord = named?.[1].toLowerCase()
  const kind = kindWord === "background command" ? "command" : kindWord === "agent" ? "agent" : "task"
  const exit = summary ? /exit code (-?\d+)/i.exec(summary) : null
  const outcomeText = `${status ?? ""} ${named?.[3] ?? summary ?? ""}`.toLowerCase()
  const outcome = /fail|error/.test(outcomeText)
    ? "failed"
    : /kill|stop|cancel/.test(outcomeText)
      ? "killed"
      : /complet|success|done|finish/.test(outcomeText)
        ? "completed"
        : "unknown"
  return {
    kind,
    outcome,
    name: named?.[2],
    exitCode: exit ? Number(exit[1]) : undefined,
    summary,
    taskId: field("task-id"),
    toolUseId: field("tool-use-id"),
    outputFile: field("output-file"),
    status
  }
}

/**
 * 整条用户消息只有 CLI 注入的上下文（如后台任务通知），没有用户写的内容。
 * 这类消息按系统事件展示，也不计入会话时间线。
 */
export function isInjectedOnlyUserMessage(message: UIMessage): boolean {
  if (message.role !== "user" || message.deliveryState) return false
  if (message.blocks.some((block) => block.type !== "text" && block.type !== "tool_result")) return false
  const text = message.blocks.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("\n").trim()
  if (!text) return false
  const { body, injected } = splitInjectedContext(text)
  return !body && injected.length > 0
}

export function splitInjectedContext(text: string): {
  body: string
  injected: InjectedContext[]
} {
  const injected: InjectedContext[] = []
  const body = text.replace(INJECTED_BLOCK_RE, (_match, lead: string, tag: string, content: string) => {
    const key = tag.toLowerCase()
    injected.push({ tag: key, label: INJECTED_TAG_LABELS[key] ?? key, content: content.trim() })
    return lead
  })
  if (injected.length === 0) return { body: text, injected }
  return { body: body.replace(/\n{3,}/g, "\n\n").trim(), injected }
}
