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
  let info = await readVersion()
  if (shouldStopPostCommandVersionPolling(info, previousVersion)) {
    return info
  }

  for (const delay of CLAUDE_CLI_POST_COMMAND_RECHECK_DELAYS_MS) {
    await sleepFn(delay)
    info = await readVersion()
    if (shouldStopPostCommandVersionPolling(info, previousVersion)) {
      return info
    }
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
