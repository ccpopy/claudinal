import type { ClaudeCliVersionInfo } from "./ipc"

export const CLAUDE_CLI_POST_COMMAND_RECHECK_DELAYS_MS = [
  500, 1000, 2000, 4000, 8000, 12000
] as const

type SleepFn = (ms: number) => Promise<void>

const sleep: SleepFn = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))

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
