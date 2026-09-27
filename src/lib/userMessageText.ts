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
