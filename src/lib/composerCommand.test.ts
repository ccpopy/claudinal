import { describe, expect, it } from "vitest"
import {
  composerCommandLabel,
  getComposerCommandBackspaceEdit,
  matchComposerCommand,
  stripLeadingSlashCommand
} from "./composerCommand"

const COMMANDS = ["effort", "review", "frontend-design:frontend-design", "clear"]

describe("matchComposerCommand", () => {
  it("matches a leading known command with args", () => {
    const hit = matchComposerCommand("/effort max", COMMANDS)
    expect(hit).toEqual({ raw: "/effort", rest: " max", command: "effort" })
  })

  it("matches a bare command at end of input", () => {
    const hit = matchComposerCommand("/clear", COMMANDS)
    expect(hit?.raw).toBe("/clear")
    expect(hit?.rest).toBe("")
  })

  it("matches the last segment of a scoped plugin command", () => {
    const hit = matchComposerCommand("/frontend-design 帮我重构样式", COMMANDS)
    expect(hit?.raw).toBe("/frontend-design")
    expect(hit?.command).toBe("frontend-design:frontend-design")
  })

  it("rejects unknown commands", () => {
    expect(matchComposerCommand("/random 文本", COMMANDS)).toBeNull()
  })

  it("rejects commands not at the start", () => {
    expect(matchComposerCommand("用 /effort 跑一下", COMMANDS)).toBeNull()
  })

  it("rejects path-like input", () => {
    expect(matchComposerCommand("/usr/local/bin 看下", COMMANDS)).toBeNull()
  })

  it("rejects when command list is empty", () => {
    expect(matchComposerCommand("/effort max", [])).toBeNull()
  })
})

describe("stripLeadingSlashCommand", () => {
  it("strips scoped commands while preserving their arguments", () => {
    expect(stripLeadingSlashCommand("/frontend-design:frontend-design 优化面板")).toBe(
      "优化面板"
    )
  })

  it("preserves path-like input", () => {
    expect(stripLeadingSlashCommand("/usr/local/bin 看下")).toBe(
      "/usr/local/bin 看下"
    )
  })
})

describe("composerCommandLabel", () => {
  it("humanizes a kebab-case skill command", () => {
    expect(composerCommandLabel("/frontend-design")).toBe("Frontend Design")
  })

  it("uses the last scoped segment and preserves common acronyms", () => {
    expect(composerCommandLabel("/plugin:mcp-server")).toBe("MCP Server")
  })
})

describe("getComposerCommandBackspaceEdit", () => {
  it("deletes a bare known command as one token", () => {
    expect(
      getComposerCommandBackspaceEdit(
        "/frontend-design",
        "/frontend-design".length,
        "/frontend-design".length,
        COMMANDS
      )
    ).toEqual({ text: "", caret: 0 })
  })

  it.each(["/frontend-design ", "/frontend-design test"])(
    "keeps native deletion while arguments remain: %s",
    (text) => {
      expect(
        getComposerCommandBackspaceEdit(text, text.length, text.length, COMMANDS)
      ).toBeNull()
    }
  )

  it("keeps native deletion when text is selected", () => {
    const text = "/frontend-design"
    expect(
      getComposerCommandBackspaceEdit(text, 1, text.length, COMMANDS)
    ).toBeNull()
  })

  it("keeps native deletion when the caret is not at the end", () => {
    const text = "/frontend-design"
    expect(getComposerCommandBackspaceEdit(text, 4, 4, COMMANDS)).toBeNull()
  })

  it("keeps native deletion for unknown commands", () => {
    const text = "/unknown"
    expect(
      getComposerCommandBackspaceEdit(text, text.length, text.length, COMMANDS)
    ).toBeNull()
  })
})
