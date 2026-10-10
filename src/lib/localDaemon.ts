import { invoke } from "@tauri-apps/api/core"

export interface LocalDaemonStatus {
  enabled: boolean
  isolation: "unverified"
  reason: string
  officialTasksCommand: string
  officialLogsCommand: string
  docsUrl: string
}

/** Display fallback only; it never authorizes collection. The backend gate is authoritative. */
export const UNVERIFIED_LOCAL_DAEMON_STATUS: Readonly<LocalDaemonStatus> = Object.freeze({
  enabled: false,
  isolation: "unverified",
  reason: "后台任务隔离尚未验证：公开任务列表不含 provider、凭据来源或 endpoint 指纹；CLAUDE_CONFIG_DIR 仅能区分 supervisor，不能证明凭据与设置继承隔离；Claudinal 临时代理也不能保证在应用退出后可用。当前禁止应用读取外部任务与日志，请在已确认配置的官方 CLI 中检查。",
  officialTasksCommand: "claude agents --json --all",
  officialLogsCommand: "claude logs <id>",
  docsUrl: "https://code.claude.com/docs/en/agent-view#list-sessions-as-json"
})

export interface LocalDaemonTask {
  cwd: string
  kind: "interactive" | "background"
  startedAt: number
  id: string | null
  state: "working" | "blocked" | "done" | "failed" | "stopped" | null
  pid: number | null
  status: "busy" | "waiting" | "idle" | null
  waitingFor: string | null
  sessionId: string | null
  name: string | null
  source: "official_cli_agents"
}

export function localDaemonStatus(): Promise<LocalDaemonStatus> {
  return invoke<LocalDaemonStatus>("local_daemon_status")
}

/** Registered but always rejected by the unverified-isolation backend gate in 0.6.0. */
export function readLocalDaemonTasks(cwd?: string): Promise<LocalDaemonTask[]> {
  return invoke<LocalDaemonTask[]>("read_local_daemon_tasks", { cwd: cwd ?? null })
}

/** Inert, bounded/redacted plain text only if a future backend verifies isolation. */
export function readLocalDaemonLogs(id: string): Promise<string> {
  return invoke<string>("read_local_daemon_logs", { id })
}

export const AGENT_TEAMS_DIAGNOSTIC = "Agent Teams 沿用提供商中的实验开关 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1。目前没有可靠的 headless 共享任务板或队友控制合约；普通子智能体事件不能证明 Teams 可观测。resume/rewind 不会恢复进程内队友，任务状态可能滞后，关闭需等待当前工作完成；本版本未认证真实 Teams 协作。"
