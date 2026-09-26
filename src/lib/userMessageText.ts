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
