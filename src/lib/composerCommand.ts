/**
 * Composer 输入的起始 slash 命令识别:用于把 "/frontend-design …" 的
 * 命令 token 渲染成高亮 chip(参考 codex desktop 的技能高亮)。
 *
 * 规则:
 * - 只匹配文本开头("/cmd" 必须是第一个 token,行中不提);
 * - 命令名允许 字母/数字/._- 与 plugin 作用域冒号;
 * - 命令名后必须跟空白或结束("/path/..." 不误判);
 * - 必须在已知命令集合内:精确匹配,或匹配作用域命令的最后一段
 *   (注册名 "frontend-design:frontend-design" 时输入 "/frontend-design" 也算)。
 */
export interface ComposerCommandMatch {
  /** 含前导斜杠的原始 token,如 "/frontend-design" */
  raw: string
  /** token 之后的全部文本(含前导空白) */
  rest: string
  /** 命中的注册命令名 */
  command: string
}

export interface ComposerCommandBackspaceEdit {
  text: string
  caret: number
}

const COMMAND_LABEL_ACRONYMS = new Map([
  ["ai", "AI"],
  ["api", "API"],
  ["cli", "CLI"],
  ["mcp", "MCP"],
  ["sdk", "SDK"],
  ["ui", "UI"],
  ["ux", "UX"]
])

/**
 * 把命令 token 转成仅供展示的友好名称。真实输入值不会被改写。
 * 作用域命令只展示最后一段，例如 `/plugin:frontend-design` 显示为
 * `Frontend Design`。
 */
export function composerCommandLabel(command: string): string {
  const normalized = command.replace(/^\/+/, "").split(":").at(-1) ?? ""
  return normalized
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => {
      const acronym = COMMAND_LABEL_ACRONYMS.get(part.toLowerCase())
      if (acronym) return acronym
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`
    })
    .join(" ")
}

/**
 * 剥离标题开头的 slash 命令 token。命令名后必须是空白或文本结束，
 * 因而 `/usr/local/bin ...` 之类路径不会被误当成命令。
 */
export function stripLeadingSlashCommand(text: string): string {
  const match = text.match(/^\/[\w.:-]+(?=\s|$)/)
  if (!match) return text
  return text.slice(match[0].length).trimStart()
}

export function matchComposerCommand(
  text: string,
  commands: readonly string[]
): ComposerCommandMatch | null {
  if (!text.startsWith("/") || commands.length === 0) return null
  const m = text.match(/^\/([\w.:-]+)(?=\s|$)/)
  if (!m) return null
  const name = m[1]
  let hit: string | null = null
  for (const c of commands) {
    if (!c) continue
    if (c === name) {
      hit = c
      break
    }
    // 作用域命令的末段匹配:"plugin:skill" 允许输入 "/skill"
    const scopeIdx = c.lastIndexOf(":")
    if (scopeIdx >= 0 && c.slice(scopeIdx + 1) === name) {
      hit = c
      break
    }
  }
  if (!hit) return null
  return { raw: m[0], rest: text.slice(m[0].length), command: hit }
}

/**
 * 已知 slash 命令在输入框中表现为一个视觉 token。仅当输入恰好只含该
 * token、光标折叠在末尾时，Backspace 才一次删除整个命令；有空格、参数、
 * 选区或光标位于中间时均交还给 textarea 的原生编辑行为。
 */
export function getComposerCommandBackspaceEdit(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  commands: readonly string[]
): ComposerCommandBackspaceEdit | null {
  if (selectionStart !== selectionEnd || selectionEnd !== text.length) {
    return null
  }
  const match = matchComposerCommand(text, commands)
  if (!match || match.rest !== "" || selectionStart !== match.raw.length) {
    return null
  }
  return { text: "", caret: 0 }
}
