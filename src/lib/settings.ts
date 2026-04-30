const KEY = "claudinal.settings"

export const DEFAULT_PERMISSION_MCP_TOOL =
  "mcp__claudinal_permission__approval_prompt"

export const DEFAULT_PERMISSION_MCP_CONFIG = `{
  "mcpServers": {
    "claudinal_permission": {
      "command": "\${CLAUDINAL_EXE}",
      "args": ["--permission-mcp-server"]
    }
  }
}`

export interface AppSettings {
  // P3.1 常规
  autoCheckUpdate: boolean
  // P3.3 配置
  defaultModel: string
  defaultEffort: string
  defaultPermissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions"
  claudeCliPath: string
  permissionMcpEnabled: boolean
  permissionPromptTool: string
  permissionMcpConfig: string
  // P3.4 个性化：高频 slash 命令 pin（不带 / 前缀，与 system/init.slash_commands 一致）
  pinnedSlash: string[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoCheckUpdate: true,
  defaultModel: "",
  defaultEffort: "",
  defaultPermissionMode: "default",
  claudeCliPath: "",
  permissionMcpEnabled: false,
  permissionPromptTool: DEFAULT_PERMISSION_MCP_TOOL,
  permissionMcpConfig: DEFAULT_PERMISSION_MCP_CONFIG,
  pinnedSlash: []
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS, pinnedSlash: [] }
    const obj = JSON.parse(raw)
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const merged = { ...DEFAULT_SETTINGS, ...(obj as Partial<AppSettings>) }
      // 字段类型护栏：旧版本 / 手改 localStorage 时可能写错
      if (!Array.isArray(merged.pinnedSlash)) merged.pinnedSlash = []
      else merged.pinnedSlash = merged.pinnedSlash.filter((s) => typeof s === "string")
      return merged
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_SETTINGS, pinnedSlash: [] }
}

export function saveSettings(s: AppSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // ignore
  }
}

const USAGE_KEY = "claudinal.usage"

export interface UsageSnapshot {
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheRead: number
  totalCacheWrite: number
  byModel: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      costUsd: number
    }
  >
  updatedAt: number
}

const EMPTY_USAGE: UsageSnapshot = {
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  byModel: {},
  updatedAt: 0
}

export function loadUsage(): UsageSnapshot {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    if (!raw) return { ...EMPTY_USAGE, byModel: {} }
    const obj = JSON.parse(raw)
    if (obj && typeof obj === "object")
      return { ...EMPTY_USAGE, ...(obj as Partial<UsageSnapshot>) }
  } catch {
    // ignore
  }
  return { ...EMPTY_USAGE, byModel: {} }
}

interface ModelUsageEntry {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
}

export function recordResultUsage(
  result: {
    total_cost_usd?: number
    modelUsage?: Record<string, ModelUsageEntry>
  } | null | undefined
) {
  if (!result) return
  const snap = loadUsage()
  if (typeof result.total_cost_usd === "number") {
    snap.totalCostUsd += result.total_cost_usd
  }
  const mu = result.modelUsage ?? {}
  for (const [model, entry] of Object.entries(mu)) {
    const cur = snap.byModel[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0
    }
    cur.inputTokens += entry.inputTokens ?? 0
    cur.outputTokens += entry.outputTokens ?? 0
    cur.cacheReadInputTokens += entry.cacheReadInputTokens ?? 0
    cur.cacheCreationInputTokens += entry.cacheCreationInputTokens ?? 0
    cur.costUsd += entry.costUSD ?? 0
    snap.byModel[model] = cur
    snap.totalInputTokens += entry.inputTokens ?? 0
    snap.totalOutputTokens += entry.outputTokens ?? 0
    snap.totalCacheRead += entry.cacheReadInputTokens ?? 0
    snap.totalCacheWrite += entry.cacheCreationInputTokens ?? 0
  }
  snap.updatedAt = Date.now()
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(snap))
  } catch {
    // ignore
  }
}

export function clearUsage() {
  try {
    localStorage.removeItem(USAGE_KEY)
  } catch {
    // ignore
  }
}
