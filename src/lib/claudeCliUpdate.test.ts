import { describe, expect, it } from "vitest"
import {
  CLAUDE_CLI_POST_COMMAND_RECHECK_DELAYS_MS,
  waitForClaudeCliPostCommandVersion
} from "./claudeCliUpdate"
import type { ClaudeCliVersionInfo } from "./ipc"

function cliInfo(
  version: string | null,
  installed = version !== null
): ClaudeCliVersionInfo {
  return {
    installed,
    path: installed ? "C:/Users/me/.local/bin/claude.exe" : null,
    version,
    min_supported_version: "2.1.123",
    supported: Boolean(version),
    update_command: "claude update",
    install_command: "irm https://claude.ai/install.ps1 | iex",
    docs_url: "https://docs.anthropic.com/en/docs/claude-code/cli-reference",
    setup_url: "https://code.claude.com/docs/en/setup"
  }
}

describe("waitForClaudeCliPostCommandVersion", () => {
  it("waits for the CLI version to change after an update command", async () => {
    const versions = [cliInfo("2.1.123"), cliInfo("2.1.123"), cliInfo("2.1.143")]
    const sleeps: number[] = []

    const info = await waitForClaudeCliPostCommandVersion(
      async () => versions.shift() ?? cliInfo("2.1.143"),
      "2.1.123",
      async (ms) => {
        sleeps.push(ms)
      }
    )

    expect(info.version).toBe("2.1.143")
    expect(sleeps).toEqual([500, 1000])
  })

  it("returns the last observed version when the update command leaves it unchanged", async () => {
    const sleeps: number[] = []

    const info = await waitForClaudeCliPostCommandVersion(
      async () => cliInfo("2.1.143"),
      "2.1.143",
      async (ms) => {
        sleeps.push(ms)
      }
    )

    expect(info.version).toBe("2.1.143")
    expect(sleeps).toEqual([...CLAUDE_CLI_POST_COMMAND_RECHECK_DELAYS_MS])
  })

  it("waits for an install command to make the CLI detectable", async () => {
    const versions = [
      cliInfo(null, false),
      cliInfo(null, false),
      cliInfo("2.1.143")
    ]
    const sleeps: number[] = []

    const info = await waitForClaudeCliPostCommandVersion(
      async () => versions.shift() ?? cliInfo("2.1.143"),
      null,
      async (ms) => {
        sleeps.push(ms)
      }
    )

    expect(info.installed).toBe(true)
    expect(info.version).toBe("2.1.143")
    expect(sleeps).toEqual([500, 1000])
  })
})
