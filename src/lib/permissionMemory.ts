import type { PermissionRequestPayload } from "@/lib/ipc"

const KEY = "claudinal.permission-memory.v1"

export interface PermissionMemoryRule {
  id: string
  cwd: string
  toolName: string
  command: string
  createdAt: number
  label: string
}

interface Store {
  rules: PermissionMemoryRule[]
}

function normalizeCwd(cwd: string | undefined): string {
  return (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function requestCommand(request: PermissionRequestPayload | null): string | null {
  const command = request?.request.input?.command
  return typeof command === "string" && command.trim() ? command : null
}

function requestToolName(request: PermissionRequestPayload | null): string | null {
  const raw = request?.request.tool_name ?? request?.request.display_name
  return typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { rules: [] }
    const parsed = JSON.parse(raw) as Partial<Store>
    return {
      rules: Array.isArray(parsed.rules)
        ? parsed.rules.filter(isPermissionMemoryRule)
        : []
    }
  } catch (error) {
    console.warn("读取权限记忆规则失败:", error)
    return { rules: [] }
  }
}

function saveStore(store: Store) {
  localStorage.setItem(KEY, JSON.stringify(store))
}

function isPermissionMemoryRule(value: unknown): value is PermissionMemoryRule {
  if (!value || typeof value !== "object") return false
  const rule = value as Partial<PermissionMemoryRule>
  return (
    typeof rule.id === "string" &&
    typeof rule.cwd === "string" &&
    typeof rule.toolName === "string" &&
    typeof rule.command === "string" &&
    typeof rule.createdAt === "number" &&
    typeof rule.label === "string"
  )
}

export function canRememberExactPermission(
  request: PermissionRequestPayload | null
): boolean {
  if (!request) return false
  if (request.transport === "mcp") return false
  if (hasPermissionSuggestion(request)) return false
  return !!requestCommand(request) && !!requestToolName(request) && !!request.cwd
}

function hasPermissionSuggestion(
  request: PermissionRequestPayload | null
): boolean {
  const suggestions = request?.request.permission_suggestions
  return Array.isArray(suggestions) && suggestions.some(Boolean)
}

export function hasAllowRuleSuggestion(
  request: PermissionRequestPayload | null
): boolean {
  const suggestions = request?.request.permission_suggestions
  if (!Array.isArray(suggestions)) return false
  return suggestions.some(
    (suggestion) =>
      suggestion &&
      typeof suggestion === "object" &&
      suggestion.type === "addRules" &&
      suggestion.behavior === "allow" &&
      Array.isArray(suggestion.rules) &&
      suggestion.rules.length > 0
  )
}

export function rememberExactPermissionRequest(
  request: PermissionRequestPayload
): PermissionMemoryRule {
  const command = requestCommand(request)
  const toolName = requestToolName(request)
  const cwd = normalizeCwd(request.cwd)
  if (!command || !toolName || !cwd) {
    throw new Error("当前权限请求不能保存为精确命令规则")
  }
  const id = `${cwd}::${toolName}::${command}`
  const label = `${toolName}: ${command.split("\n")[0]}`
  const store = loadStore()
  const existing = store.rules.find((rule) => rule.id === id)
  if (existing) return existing
  const rule: PermissionMemoryRule = {
    id,
    cwd,
    toolName,
    command,
    createdAt: Date.now(),
    label
  }
  saveStore({ rules: [...store.rules, rule] })
  return rule
}

export function findPermissionMemoryMatch(
  request: PermissionRequestPayload
): PermissionMemoryRule | null {
  const command = requestCommand(request)
  const toolName = requestToolName(request)
  const cwd = normalizeCwd(request.cwd)
  if (!command || !toolName || !cwd) return null
  return (
    loadStore().rules.find(
      (rule) =>
        rule.cwd === cwd &&
        rule.toolName === toolName &&
        rule.command === command
    ) ?? null
  )
}
