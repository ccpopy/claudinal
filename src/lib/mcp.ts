export const MCP_STATUS_CACHE_KEY = "claudinal.mcp-status"

export interface McpServerStatus {
  name: string
  status: string
}

export interface McpServerConfig {
  type?: "stdio" | "http" | string
  command?: string
  args?: string[]
  env?: Record<string, string>
  envPassthrough?: string[]
  cwd?: string
  url?: string
  headers?: Record<string, string>
  auth?: "none" | "bearer" | "oauth" | string
  disabled?: boolean
  [key: string]: unknown
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>
  [key: string]: unknown
}

export function normalizeMcpConfig(raw: unknown): McpConfigFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { mcpServers: {} }
  }
  const obj = raw as Record<string, unknown>
  const servers =
    obj.mcpServers &&
    typeof obj.mcpServers === "object" &&
    !Array.isArray(obj.mcpServers)
      ? (obj.mcpServers as Record<string, McpServerConfig>)
      : {}
  return { ...obj, mcpServers: servers }
}

export function loadMcpStatusCache(): McpServerStatus[] {
  try {
    const raw = localStorage.getItem(MCP_STATUS_CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is McpServerStatus =>
          item &&
          typeof item === "object" &&
          typeof item.name === "string" &&
          typeof item.status === "string"
      )
      .slice(0, 200)
  } catch {
    return []
  }
}

export function saveMcpStatusCache(statuses: McpServerStatus[]) {
  try {
    localStorage.setItem(
      MCP_STATUS_CACHE_KEY,
      JSON.stringify(statuses.slice(0, 200))
    )
  } catch {
    // ignore
  }
}
