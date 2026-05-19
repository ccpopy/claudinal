import type { ClaudeCliVersionInfo } from "./ipc"

export const CLAUDE_CLI_POST_COMMAND_RECHECK_DELAYS_MS = [
  500, 1000, 2000, 4000, 8000, 12000
] as const

type SleepFn = (ms: number) => Promise<void>

const sleep: SleepFn = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))

export interface ClaudeCliUpdateAvailability {
  currentVersion: string | null
  availableVersion: string
  packageManager: string | null
  updateCommand: string | null
}

function shouldStopPostCommandVersionPolling(
  info: ClaudeCliVersionInfo,
  previousVersion: string | null
): boolean {
  if (previousVersion) {
    return !info.installed || info.version !== previousVersion
  }
  return info.installed
}

export async function waitForClaudeCliPostCommandVersion(
  readVersion: () => Promise<ClaudeCliVersionInfo>,
  previousVersion: string | null,
  sleepFn: SleepFn = sleep
): Promise<ClaudeCliVersionInfo> {
  let info: ClaudeCliVersionInfo | null = null
  let lastError: unknown = null
  const readAndCheck = async () => {
    try {
      info = await readVersion()
      lastError = null
      return shouldStopPostCommandVersionPolling(info, previousVersion)
    } catch (error) {
      lastError = error
      return false
    }
  }

  if (await readAndCheck()) {
    return info!
  }

  for (const delay of CLAUDE_CLI_POST_COMMAND_RECHECK_DELAYS_MS) {
    await sleepFn(delay)
    if (await readAndCheck()) {
      return info!
    }
  }

  if (lastError) {
    throw lastError
  }
  if (!info) {
    throw new Error("未能读取 Claude CLI 版本")
  }
  return info
}

export function claudeCliUpdateAvailabilityFromCommandOutput(
  stdout: string,
  stderr = ""
): ClaudeCliUpdateAvailability | null {
  const output = [stdout, stderr].filter(Boolean).join("\n")
  const updateMatch = output.match(
    /Update available:\s*v?(\d+(?:\.\d+){1,3}(?:[-+][^\s]+)?)\s*(?:->|→|=>|to)\s*v?(\d+(?:\.\d+){1,3}(?:[-+][^\s]+)?)/i
  )
  if (!updateMatch) return null

  const managerMatch = output.match(/Claude is managed by\s+([^\r\n.]+)/i)
  const commandMatch = output.match(/(?:To update,\s*)?run:\s*([^\r\n]+)/i)

  return {
    currentVersion: updateMatch[1] ?? null,
    availableVersion: updateMatch[2],
    packageManager: managerMatch?.[1]?.trim() || null,
    updateCommand: commandMatch?.[1]?.trim() || null
  }
}

export const SUPPORTED_CLAUDE_CLI_PACKAGE_MANAGERS = [
  "winget",
  "scoop",
  "brew",
  "npm",
  "pnpm",
  "yarn"
] as const
export type SupportedClaudeCliPackageManager =
  (typeof SUPPORTED_CLAUDE_CLI_PACKAGE_MANAGERS)[number]

export interface ClaudeCliPackageManagerUpgradePlan {
  manager: SupportedClaudeCliPackageManager
  args: string[]
  displayCommand: string
}

const SAFE_PACKAGE_MANAGER_ARG_RE = /^[A-Za-z0-9._\-/@:+=]+$/
const UNSAFE_COMMAND_RE = /[\r\n;&|`$<>(){}\[\]\\'"]/

/**
 * 解析 `claude update` 输出的建议命令（例如 "winget upgrade Anthropic.ClaudeCode"），
 * 如果命令满足白名单：可执行管理器 + 安全参数，则返回结构化升级计划，否则返回 null。
 * 此函数只做前端友好转换；后端 `run_claude_cli_package_manager_upgrade` 会再校验一次。
 */
export function parseSupportedPackageManagerUpgrade(
  command: string | null | undefined
): ClaudeCliPackageManagerUpgradePlan | null {
  if (!command) return null
  const trimmed = command.trim()
  if (!trimmed) return null
  if (UNSAFE_COMMAND_RE.test(trimmed)) return null
  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 2) return null
  const manager = tokens[0].toLowerCase()
  const supported = SUPPORTED_CLAUDE_CLI_PACKAGE_MANAGERS.find(
    (name) => name === manager
  )
  if (!supported) return null
  const args = tokens.slice(1)
  if (!args.every((arg) => SAFE_PACKAGE_MANAGER_ARG_RE.test(arg))) return null
  return {
    manager: supported,
    args,
    displayCommand: `${supported} ${args.join(" ")}`
  }
}
