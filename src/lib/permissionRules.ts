// 把一条 permission_denial 推断成 settings.json `permissions.allow` 用的规则字符串。
// 规则语法参考 CLI assistant 文字提示（如 `Bash(curl:*)`）。

interface DenialInput {
  toolName?: string
  toolInput?: Record<string, unknown>
}

export function inferAllowRule(d: DenialInput): string | null {
  const name = d.toolName ?? ""
  const input = d.toolInput ?? {}
  if (!name) return null

  if (name === "Bash" || name === "PowerShell") {
    const cmd = (input.command as string) ?? ""
    const first = cmd.trim().split(/\s+/)[0]
    if (!first) return null
    return `${name}(${first}:*)`
  }
  if (name === "Write" || name === "Edit" || name === "MultiEdit") {
    const fp = (input.file_path as string) ?? (input.path as string)
    if (fp) return `${name}(${fp})`
    return name
  }
  if (name === "Read") {
    const fp = (input.file_path as string) ?? (input.path as string)
    if (fp) return `Read(${fp})`
    return "Read"
  }
  if (name === "WebFetch") {
    const url = (input.url as string) ?? ""
    try {
      const u = new URL(url)
      return `WebFetch(${u.host})`
    } catch {
      return "WebFetch"
    }
  }
  return name
}

export function appendAllowRule(
  current: string[] | undefined,
  rule: string
): string[] {
  const list = Array.isArray(current) ? current.slice() : []
  if (list.includes(rule)) return list
  list.push(rule)
  return list
}
