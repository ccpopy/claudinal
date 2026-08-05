import { describe, expect, it } from "vitest"
import {
  shouldPromptClaudeWorkspaceTrust,
  type ClaudeWorkspaceTrustInfo
} from "./claudeWorkspaceTrust"

function trustInfo(
  patch: Partial<ClaudeWorkspaceTrustInfo> = {}
): ClaudeWorkspaceTrustInfo {
  return {
    projectKey: "F:/project/example",
    trusted: false,
    allowCount: 2,
    settingsSources: [".claude/settings.local.json"],
    configPath: "C:/Users/test/.claude.json",
    ...patch
  }
}

describe("claudeWorkspaceTrust", () => {
  it("prompts only when untrusted allow rules would be ignored", () => {
    expect(shouldPromptClaudeWorkspaceTrust(trustInfo())).toBe(true)
    expect(
      shouldPromptClaudeWorkspaceTrust(trustInfo({ trusted: true }))
    ).toBe(false)
    expect(
      shouldPromptClaudeWorkspaceTrust(trustInfo({ allowCount: 0 }))
    ).toBe(false)
  })

  it("does not treat source metadata as a trust decision", () => {
    expect(
      shouldPromptClaudeWorkspaceTrust(
        trustInfo({ settingsSources: [], allowCount: 1 })
      )
    ).toBe(true)
  })
})
