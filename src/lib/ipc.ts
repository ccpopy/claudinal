import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { ClaudeEvent } from "../types/events"

export type SpawnArgs = {
  cwd: string
  model: string | null
  effort: string | null
  permissionMode: string | null
  resumeSessionId?: string | null
  env?: Record<string, string> | null
  permissionMcpEnabled?: boolean | null
  permissionPromptTool?: string | null
  mcpConfig?: string | null
}

export interface DirEntry {
  name: string
  path: string
  is_dir: boolean
}

export interface SessionMeta {
  id: string
  file_path: string
  modified_ts: number
  size_bytes: number
  msg_count: number
  ai_title: string | null
  first_user_text: string | null
}

export async function detectClaudeCli(): Promise<string> {
  return invoke<string>("detect_claude_cli")
}

export async function spawnSession(args: SpawnArgs): Promise<string> {
  return invoke<string>("spawn_session", args as Record<string, unknown>)
}

export interface PermissionRule {
  toolName?: string
  ruleContent?: string
  [k: string]: unknown
}

export interface PermissionUpdate {
  type?: string
  mode?: string
  behavior?: "allow" | "deny" | "ask" | string
  destination?: "session" | "localSettings" | "projectSettings" | "userSettings" | string
  rules?: PermissionRule[]
  [k: string]: unknown
}

export interface PermissionToolRequest {
  subtype?: string
  tool_name?: string
  display_name?: string
  input?: Record<string, unknown>
  description?: string
  permission_suggestions?: PermissionUpdate[]
  tool_use_id?: string
  [k: string]: unknown
}

export interface PermissionRequestPayload {
  type: "control_request"
  transport?: "stdio" | "mcp" | string
  request_id: string
  session_id: string
  cwd?: string
  request: PermissionToolRequest
  [k: string]: unknown
}

export async function listenPermissionRequests(
  handler: (payload: PermissionRequestPayload) => void
): Promise<UnlistenFn> {
  return listen<PermissionRequestPayload>(
    "claudinal://permission/request",
    (e) => handler(e.payload)
  )
}

export async function resolvePermissionRequest(args: {
  sessionId: string
  requestId: string
  transport?: string | null
  response: Record<string, unknown>
}): Promise<void> {
  return invoke("resolve_permission_request", {
    resolution: {
      sessionId: args.sessionId,
      requestId: args.requestId,
      transport: args.transport ?? null,
      response: args.response
    }
  })
}

export async function sendUserMessage(
  sessionId: string,
  contentBlocks: Array<Record<string, unknown>>
): Promise<void> {
  return invoke("send_user_message", { sessionId, contentBlocks })
}

export async function stopSession(sessionId: string): Promise<void> {
  return invoke("stop_session", { sessionId })
}

export async function createDir(path: string): Promise<void> {
  return invoke("create_dir", { path })
}

export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path })
}

export async function defaultWorkspaceRoot(): Promise<string> {
  return invoke<string>("default_workspace_root")
}

export async function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path })
}

export async function listProjectSessions(cwd: string): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("list_project_sessions", { cwd })
}

export async function readSessionTranscript(
  cwd: string,
  sessionId: string
): Promise<ClaudeEvent[]> {
  return invoke<ClaudeEvent[]>("read_session_transcript", { cwd, sessionId })
}

export async function deleteSessionJsonl(
  cwd: string,
  sessionId: string
): Promise<void> {
  return invoke("delete_session_jsonl", { cwd, sessionId })
}

export async function readSessionSidecar(
  cwd: string,
  sessionId: string
): Promise<unknown | null> {
  return invoke<unknown | null>("read_session_sidecar", { cwd, sessionId })
}

export async function writeSessionSidecar(
  cwd: string,
  sessionId: string,
  data: unknown
): Promise<void> {
  return invoke("write_session_sidecar", { cwd, sessionId, data })
}

export async function openPath(path: string): Promise<void> {
  return invoke("open_path", { path })
}

export async function openExternal(url: string): Promise<void> {
  return invoke("open_external", { url })
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke("write_text_file", { path, contents })
}

export async function watchSessions(cwd: string): Promise<void> {
  return invoke("watch_sessions", { cwd })
}

export async function unwatchSessions(cwd: string): Promise<void> {
  return invoke("unwatch_sessions", { cwd })
}

export async function listenSessionsChanged(
  cwd: string,
  handler: () => void
): Promise<UnlistenFn> {
  return listen(`claudinal://sessions/${cwd}/changed`, () => handler())
}

export interface FileMatch {
  path: string
  rel: string
  is_dir: boolean
}

export async function listFiles(
  cwd: string,
  prefix: string
): Promise<FileMatch[]> {
  return invoke<FileMatch[]>("list_files", { cwd, prefix })
}

export type SettingsScope = "global" | "project" | "project-local"

export async function claudeSettingsPath(
  scope: SettingsScope,
  cwd?: string
): Promise<string> {
  return invoke<string>("claude_settings_path_for", { scope, cwd: cwd ?? null })
}

export async function readClaudeSettings(
  scope: SettingsScope,
  cwd?: string
): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("read_claude_settings", {
    scope,
    cwd: cwd ?? null
  })
}

export async function writeClaudeSettings(
  scope: SettingsScope,
  data: Record<string, unknown>,
  cwd?: string
): Promise<void> {
  return invoke("write_claude_settings", {
    scope,
    cwd: cwd ?? null,
    data
  })
}

export type McpScope = "global" | "project"

export async function claudeMcpPath(
  scope: McpScope,
  cwd?: string
): Promise<string> {
  return invoke<string>("claude_mcp_path_for", { scope, cwd: cwd ?? null })
}

export async function readClaudeMcpConfig(
  scope: McpScope,
  cwd?: string
): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("read_claude_mcp_config", {
    scope,
    cwd: cwd ?? null
  })
}

export async function writeClaudeMcpConfig(
  scope: McpScope,
  data: Record<string, unknown>,
  cwd?: string
): Promise<void> {
  return invoke("write_claude_mcp_config", {
    scope,
    cwd: cwd ?? null,
    data
  })
}

/** CLAUDE.md 三 scope：global = ~/.claude/CLAUDE.md，project = <cwd>/CLAUDE.md，project-local = <cwd>/.claude/CLAUDE.local.md */
export async function claudeMdPath(
  scope: SettingsScope,
  cwd?: string
): Promise<string> {
  return invoke<string>("claude_md_path_for", { scope, cwd: cwd ?? null })
}

export async function readClaudeMd(
  scope: SettingsScope,
  cwd?: string
): Promise<string> {
  return invoke<string>("read_claude_md", { scope, cwd: cwd ?? null })
}

export async function writeClaudeMd(
  scope: SettingsScope,
  contents: string,
  cwd?: string
): Promise<void> {
  return invoke("write_claude_md", {
    scope,
    cwd: cwd ?? null,
    contents
  })
}

export interface OauthUsageWindow {
  utilization: number
  resets_at: string
}

export interface OauthUsageExtra {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export interface OauthUsage {
  five_hour?: OauthUsageWindow
  seven_day?: OauthUsageWindow
  seven_day_opus?: OauthUsageWindow | null
  seven_day_sonnet?: OauthUsageWindow | null
  extra_usage?: OauthUsageExtra
  [k: string]: unknown
}

export async function readClaudeOauthToken(): Promise<string | null> {
  return invoke<string | null>("read_claude_oauth_token")
}

export async function fetchOauthUsage(): Promise<OauthUsage> {
  return invoke<OauthUsage>("fetch_oauth_usage")
}

export interface ProviderModelsRequest {
  requestUrl: string
  apiKey: string
  authField: string
  inputFormat: string
  useFullUrl: boolean
}

export async function fetchProviderModels(
  args: ProviderModelsRequest
): Promise<string[]> {
  return invoke<string[]>("fetch_provider_models", { ...args })
}

export interface ModelUsageAgg {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  cost_usd: number
}

export interface GlobalUsage {
  total_cost_usd: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read: number
  total_cache_write: number
  session_count: number
  with_sidecar_count: number
  skipped_sidecar_count: number
  scan_errors: Array<{ path: string; reason: string }>
  by_model: Record<string, ModelUsageAgg>
  last_updated: number
}

export interface ActivityCell {
  date: string
  hour: number
  count: number
}

export async function scanGlobalUsage(): Promise<GlobalUsage> {
  return invoke<GlobalUsage>("scan_global_usage")
}

export async function scanActivityHeatmap(days: number): Promise<ActivityCell[]> {
  return invoke<ActivityCell[]>("scan_activity_heatmap", { days })
}

export async function listenSessionEvents(
  sessionId: string,
  handler: (ev: ClaudeEvent) => void
): Promise<UnlistenFn> {
  return listen<ClaudeEvent>(`claude://session/${sessionId}/event`, (e) =>
    handler(e.payload)
  )
}

export async function listenSessionErrors(
  sessionId: string,
  handler: (line: string) => void
): Promise<UnlistenFn> {
  return listen<string>(`claude://session/${sessionId}/error`, (e) =>
    handler(e.payload)
  )
}
