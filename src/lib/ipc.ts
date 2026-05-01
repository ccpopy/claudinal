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

export interface GitFileChange {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface GitWorktreeStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  changedFiles: number
  additions: number
  deletions: number
  files: GitFileChange[]
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface WorktreeFileDiff {
  path: string
  oldPath: string | null
  status: string
  additions: number
  deletions: number
  binary: boolean
  hunks: DiffHunk[]
}

export interface WorktreeDiff {
  isRepo: boolean
  files: WorktreeFileDiff[]
}

export interface GithubCliStatus {
  installed: boolean
  path: string | null
  version: string | null
  authenticated: boolean
  user: string | null
  message: string
}

export interface GitBranchInfo {
  name: string
  current: boolean
}

export interface GitBranchList {
  isRepo: boolean
  current: string | null
  branches: GitBranchInfo[]
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

export interface GlobalSessionMeta extends SessionMeta {
  cwd: string | null
  dirLabel: string
}

export async function listRecentSessionsAll(
  limit = 50
): Promise<GlobalSessionMeta[]> {
  return invoke<GlobalSessionMeta[]>("list_recent_sessions_all", { limit })
}

export async function gitWorktreeStatus(
  cwd: string
): Promise<GitWorktreeStatus> {
  return invoke<GitWorktreeStatus>("git_worktree_status", { cwd })
}

export async function worktreeDiff(cwd: string): Promise<WorktreeDiff> {
  return invoke<WorktreeDiff>("worktree_diff", { cwd })
}

export async function gitBranchList(cwd: string): Promise<GitBranchList> {
  return invoke<GitBranchList>("git_branch_list", { cwd })
}

export async function gitCheckoutBranch(args: {
  cwd: string
  branch: string
  create?: boolean
}): Promise<void> {
  return invoke("git_checkout_branch", {
    cwd: args.cwd,
    branch: args.branch,
    create: args.create ?? false
  })
}

export async function githubCliStatus(): Promise<GithubCliStatus> {
  return invoke<GithubCliStatus>("github_cli_status")
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

export interface ProjectActionResult {
  stdout: string
  stderr: string
  exit_code: number
}

export async function runProjectAction(args: {
  cwd: string
  command: string
}): Promise<ProjectActionResult> {
  return invoke<ProjectActionResult>("run_project_action", args)
}

export async function openExternal(url: string): Promise<void> {
  return invoke("open_external", { url })
}

export interface PlaywrightInstallState {
  root_path: string
  root_exists: boolean
  env_override: string | null
  chromium: boolean
  firefox: boolean
  webkit: boolean
}

export async function detectPlaywrightInstall(): Promise<PlaywrightInstallState> {
  return invoke<PlaywrightInstallState>("detect_playwright_install")
}

export interface ProxyTestResult {
  ok: boolean
  status: number | null
  latency_ms: number
  message: string
}

export async function testProxyConnection(args: {
  url: string
  target?: string
  timeoutMs?: number
}): Promise<ProxyTestResult> {
  return invoke<ProxyTestResult>("test_proxy_connection", {
    req: {
      url: args.url,
      target: args.target ?? null,
      timeoutMs: args.timeoutMs ?? null
    }
  })
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke("write_text_file", { path, contents })
}

export async function keychainAvailable(): Promise<boolean> {
  return invoke<boolean>("keychain_available")
}

export async function keychainSet(account: string, secret: string): Promise<void> {
  return invoke("keychain_set", { account, secret })
}

export async function keychainGet(account: string): Promise<string | null> {
  return invoke<string | null>("keychain_get", { account })
}

export async function keychainDelete(account: string): Promise<void> {
  return invoke("keychain_delete", { account })
}

export interface AuthStatus {
  loggedIn: boolean
  authMethod: string | null
  apiProvider: string | null
  email: string | null
  orgId: string | null
  orgName: string | null
  subscriptionType: string | null
  raw: Record<string, unknown> | null
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("auth_status")
}

export async function authLogout(): Promise<string> {
  return invoke<string>("auth_logout")
}

export async function authStartLogin(useConsole: boolean): Promise<void> {
  return invoke("auth_start_login", { useConsole })
}

export async function authCancelLogin(): Promise<void> {
  return invoke("auth_cancel_login")
}

export async function authOpenLoginTerminal(useConsole: boolean): Promise<void> {
  return invoke("auth_open_login_terminal", { useConsole })
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

export interface ClaudeJsonMcpConfigs {
  path: string
  global: Record<string, unknown> | null
  project: Record<string, unknown> | null
}

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

export async function readClaudeJsonMcpConfigs(
  cwd?: string
): Promise<ClaudeJsonMcpConfigs> {
  return invoke<ClaudeJsonMcpConfigs>("read_claude_json_mcp_configs", {
    cwd: cwd ?? null
  })
}

export async function writeClaudeJsonMcpConfig(
  scope: McpScope,
  data: Record<string, unknown>,
  cwd?: string
): Promise<void> {
  return invoke("write_claude_json_mcp_config", {
    scope,
    cwd: cwd ?? null,
    data
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

export interface SessionSearchHit {
  sessionId: string
  cwd: string
  role: string
  ts: string | null
  snippet: string
  filePath: string | null
  modifiedTs: number | null
  aiTitle: string | null
  firstUserText: string | null
  dirLabel: string | null
}

export async function searchSessions(
  query: string,
  limit = 50
): Promise<SessionSearchHit[]> {
  return invoke<SessionSearchHit[]>("search_sessions", { query, limit })
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
