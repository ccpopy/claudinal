import { describe, expect, it } from "vitest"
import {
  CLAUDE_CLI_POST_COMMAND_RECHECK_DELAYS_MS,
  claudeCliUpdateAvailabilityFromCommandOutput,
  parseSupportedPackageManagerUpgrade,
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
    version_error: null,
    min_supported_version: "2.1.123",
    supported: Boolean(version),
    update_command: "claude update",
    install_command: "npm install -g @anthropic-ai/claude-code",
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

  it("keeps polling when a post-install version check fails transiently", async () => {
    const versions = [cliInfo("2.1.143")]
    const sleeps: number[] = []
    let attempts = 0

    const info = await waitForClaudeCliPostCommandVersion(
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error("读取 Claude CLI 版本超时")
        return versions.shift() ?? cliInfo("2.1.143")
      },
      null,
      async (ms) => {
        sleeps.push(ms)
      }
    )

    expect(info.installed).toBe(true)
    expect(info.version).toBe("2.1.143")
    expect(sleeps).toEqual([500])
  })

  it("throws the last post-command version check error after all retries fail", async () => {
    const sleeps: number[] = []

    await expect(
      waitForClaudeCliPostCommandVersion(
        async () => {
          throw new Error("读取 Claude CLI 版本超时")
        },
        null,
        async (ms) => {
          sleeps.push(ms)
        }
      )
    ).rejects.toThrow("读取 Claude CLI 版本超时")

    expect(sleeps).toEqual([...CLAUDE_CLI_POST_COMMAND_RECHECK_DELAYS_MS])
  })
})

describe("claudeCliUpdateAvailabilityFromCommandOutput", () => {
  it("detects a package-manager-managed Claude CLI update from command output", () => {
    const availability = claudeCliUpdateAvailabilityFromCommandOutput(
      [
        "Current version: 2.1.123",
        "Checking for updates to latest version...",
        "Claude is managed by winget.",
        "Update available: 2.1.123 -> 2.1.143",
        "To update, run: winget upgrade Anthropic.ClaudeCode"
      ].join("\n")
    )

    expect(availability).toEqual({
      currentVersion: "2.1.123",
      availableVersion: "2.1.143",
      packageManager: "winget",
      updateCommand: "winget upgrade Anthropic.ClaudeCode"
    })
  })

  it("returns null when the update command output has no available version", () => {
    expect(
      claudeCliUpdateAvailabilityFromCommandOutput(
        "Current version: 2.1.143\nClaude is already up to date."
      )
    ).toBeNull()
  })
})

describe("parseSupportedPackageManagerUpgrade", () => {
  it("parses winget upgrade with package id", () => {
    expect(
      parseSupportedPackageManagerUpgrade("winget upgrade Anthropic.ClaudeCode")
    ).toEqual({
      manager: "winget",
      args: ["upgrade", "Anthropic.ClaudeCode"],
      displayCommand: "winget upgrade Anthropic.ClaudeCode"
    })
  })

  it("parses brew tap upgrade", () => {
    expect(
      parseSupportedPackageManagerUpgrade("brew upgrade anthropic/tap/claude-code")
    ).toEqual({
      manager: "brew",
      args: ["upgrade", "anthropic/tap/claude-code"],
      displayCommand: "brew upgrade anthropic/tap/claude-code"
    })
  })

  it("parses scoop update with bucket prefixed name", () => {
    expect(
      parseSupportedPackageManagerUpgrade("scoop update claude-code")
    ).toEqual({
      manager: "scoop",
      args: ["update", "claude-code"],
      displayCommand: "scoop update claude-code"
    })
  })

  it("parses npm install -g with version tag", () => {
    expect(
      parseSupportedPackageManagerUpgrade(
        "npm install -g @anthropic-ai/claude-code@latest --include=optional"
      )
    ).toEqual({
      manager: "npm",
      args: [
        "install",
        "-g",
        "@anthropic-ai/claude-code@latest",
        "--include=optional"
      ],
      displayCommand:
        "npm install -g @anthropic-ai/claude-code@latest --include=optional"
    })
  })

  it("is case-insensitive for manager name", () => {
    const plan = parseSupportedPackageManagerUpgrade("WINGET upgrade Anthropic.ClaudeCode")
    expect(plan?.manager).toBe("winget")
  })

  it("rejects commands with shell metacharacters", () => {
    for (const cmd of [
      "winget upgrade Anthropic.ClaudeCode; rm -rf /",
      "winget upgrade Anthropic.ClaudeCode && bad",
      "winget upgrade $(whoami)",
      "winget upgrade `whoami`",
      "winget upgrade Anthropic.ClaudeCode\nls"
    ]) {
      expect(parseSupportedPackageManagerUpgrade(cmd)).toBeNull()
    }
  })

  it("rejects unknown package managers", () => {
    expect(parseSupportedPackageManagerUpgrade("apt install claude")).toBeNull()
    expect(parseSupportedPackageManagerUpgrade("choco upgrade claude")).toBeNull()
  })

  it("rejects commands with too few tokens or empty input", () => {
    expect(parseSupportedPackageManagerUpgrade("winget")).toBeNull()
    expect(parseSupportedPackageManagerUpgrade("  ")).toBeNull()
    expect(parseSupportedPackageManagerUpgrade(null)).toBeNull()
    expect(parseSupportedPackageManagerUpgrade(undefined)).toBeNull()
  })

  it("rejects args containing unsafe characters", () => {
    expect(
      parseSupportedPackageManagerUpgrade("brew upgrade claude-code,extra")
    ).toBeNull()
    expect(
      parseSupportedPackageManagerUpgrade('npm install -g "claude-code"')
    ).toBeNull()
  })
})
