import { describe, expect, it } from "vitest"
import {
  composerPrefsPatchFromCommandEvent,
  effortSource,
  isClaudeModelEntry,
  mergeComposerPrefs,
  pickComposerFromSidecar,
  pickComposerFromTranscript
} from "./composerPrefs"
import type { ClaudeEvent } from "@/types/events"

const ev = (e: Record<string, unknown>): ClaudeEvent => e as ClaudeEvent

describe("composerPrefs.pickComposerFromSidecar", () => {
  it("returns null for non-object inputs and missing composer key", () => {
    expect(pickComposerFromSidecar(null)).toBeNull()
    expect(pickComposerFromSidecar("string")).toBeNull()
    expect(pickComposerFromSidecar({})).toBeNull()
    expect(pickComposerFromSidecar({ composer: null })).toBeNull()
  })

  it("returns trimmed composer prefs when at least one field is set", () => {
    expect(
      pickComposerFromSidecar({ composer: { model: "  sonnet  " } })
    ).toEqual({ model: "sonnet", effort: "" })
    expect(
      pickComposerFromSidecar({ composer: { model: "", effort: " high " } })
    ).toEqual({ model: "", effort: "high" })
  })

  it("returns null when both fields are empty after trim", () => {
    expect(
      pickComposerFromSidecar({ composer: { model: "  ", effort: "" } })
    ).toBeNull()
  })
})

describe("composerPrefs.mergeComposerPrefs", () => {
  it("prefers override values over base when present", () => {
    expect(
      mergeComposerPrefs({ model: "a", effort: "low" }, { model: "b", effort: "high" })
    ).toEqual({ model: "b", effort: "high" })
  })

  it("falls back to base when override fields are empty", () => {
    expect(
      mergeComposerPrefs(
        { model: "base-model", effort: "medium" },
        { model: "", effort: "" }
      )
    ).toEqual({ model: "base-model", effort: "medium" })
  })

  it("returns null when neither has any value", () => {
    expect(mergeComposerPrefs({ model: "", effort: "" }, null)).toBeNull()
    expect(mergeComposerPrefs(null, null)).toBeNull()
  })

  it("treats partial overrides correctly", () => {
    expect(
      mergeComposerPrefs({ model: "base", effort: "low" }, { model: "", effort: "high" })
    ).toEqual({ model: "base", effort: "high" })
  })
})

describe("composerPrefs.composerPrefsPatchFromCommandEvent", () => {
  const userText = (text: string) =>
    ev({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] }
    })

  it("extracts /effort command argument", () => {
    expect(
      composerPrefsPatchFromCommandEvent(
        userText(
          "<command-name>/effort</command-name><command-args>high</command-args>"
        )
      )
    ).toEqual({ effort: "high" })
  })

  it("normalizes effort aliases like 'extra high' / 'maximum' / 'auto'", () => {
    expect(
      composerPrefsPatchFromCommandEvent(
        userText(
          "<command-name>effort</command-name><command-args>extra-high</command-args>"
        )
      )
    ).toEqual({ effort: "xhigh" })
    expect(
      composerPrefsPatchFromCommandEvent(
        userText(
          "<command-name>/effort</command-name><command-args>maximum</command-args>"
        )
      )
    ).toEqual({ effort: "max" })
    expect(
      composerPrefsPatchFromCommandEvent(
        userText(
          "<command-name>/effort</command-name><command-args>auto</command-args>"
        )
      )
    ).toEqual({ effort: "" })
  })

  it("rejects unknown effort levels", () => {
    expect(
      composerPrefsPatchFromCommandEvent(
        userText(
          "<command-name>/effort</command-name><command-args>moonshot</command-args>"
        )
      )
    ).toBeNull()
  })

  it("extracts /model command argument and resets on default/auto", () => {
    expect(
      composerPrefsPatchFromCommandEvent(
        userText(
          "<command-name>/model</command-name><command-args>opus</command-args>"
        )
      )
    ).toEqual({ model: "opus" })
    expect(
      composerPrefsPatchFromCommandEvent(
        userText("<command-name>/model</command-name><command-args>auto</command-args>")
      )
    ).toEqual({ model: "" })
    expect(
      composerPrefsPatchFromCommandEvent(
        userText("<command-name>/model</command-name><command-args>default</command-args>")
      )
    ).toEqual({ model: "" })
  })

  it("returns null when message has no command-name tag", () => {
    expect(
      composerPrefsPatchFromCommandEvent(userText("plain message"))
    ).toBeNull()
  })
})

describe("composerPrefs.pickComposerFromTranscript", () => {
  it("rolls model forward through system/init then assistant turns when no /model lock", () => {
    const events: ClaudeEvent[] = [
      ev({ type: "system", subtype: "init", model: "claude-3-7-sonnet" }),
      ev({
        type: "assistant",
        message: { role: "assistant", model: "claude-opus-4", content: [] }
      })
    ]
    // 没有 /model 锁定时，assistant 的 model 会覆盖 system/init 的 baseline
    expect(pickComposerFromTranscript(events)).toEqual({
      model: "claude-opus-4",
      effort: ""
    })
  })

  it("uses system/init model when no assistant turn follows", () => {
    const events: ClaudeEvent[] = [
      ev({ type: "system", subtype: "init", model: "claude-3-7-sonnet" })
    ]
    expect(pickComposerFromTranscript(events)).toEqual({
      model: "claude-3-7-sonnet",
      effort: ""
    })
  })

  it("explicit /model overrides system/init and locks subsequent assistant model", () => {
    const events: ClaudeEvent[] = [
      ev({ type: "system", subtype: "init", model: "sonnet" }),
      ev({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "<command-name>/model</command-name><command-args>opus</command-args>"
            }
          ]
        }
      }),
      ev({
        type: "assistant",
        message: { role: "assistant", model: "post-override", content: [] }
      })
    ]
    expect(pickComposerFromTranscript(events)).toEqual({
      model: "opus",
      effort: ""
    })
  })

  it("captures last /effort command and reflects empty model when only effort changed", () => {
    const events: ClaudeEvent[] = [
      ev({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "<command-name>/effort</command-name><command-args>medium</command-args>"
            }
          ]
        }
      }),
      ev({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "<command-name>/effort</command-name><command-args>max</command-args>"
            }
          ]
        }
      })
    ]
    expect(pickComposerFromTranscript(events)).toEqual({
      model: "",
      effort: "max"
    })
  })

  it("returns null when transcript has no usable signals", () => {
    expect(pickComposerFromTranscript([])).toBeNull()
    expect(
      pickComposerFromTranscript([ev({ type: "system", subtype: "init" })])
    ).toBeNull()
  })
})

describe("composerPrefs.effortSource", () => {
  const session = { model: "", effort: "max" }
  const global = { model: "", effort: "medium" }

  it('returns "auto" when current effort is empty', () => {
    expect(effortSource("", session, global)).toBe("auto")
  })

  it('returns "session" when current matches the session override', () => {
    expect(effortSource("max", session, global)).toBe("session")
  })

  it('returns "default" when current matches the global default', () => {
    expect(effortSource("medium", null, global)).toBe("default")
  })

  it('falls through to "session" when current does not match either', () => {
    expect(effortSource("low", session, global)).toBe("session")
  })
})

describe("composerPrefs.isClaudeModelEntry", () => {
  it("treats empty string and built-in aliases as Claude entries", () => {
    expect(isClaudeModelEntry("")).toBe(true)
    expect(isClaudeModelEntry("sonnet")).toBe(true)
    expect(isClaudeModelEntry("opus")).toBe(true)
    expect(isClaudeModelEntry("opusplan")).toBe(true)
    expect(isClaudeModelEntry("sonnet[1m]")).toBe(true)
  })

  it("recognizes claude- and anthropic. prefixes", () => {
    expect(isClaudeModelEntry("claude-3-7-sonnet")).toBe(true)
    expect(isClaudeModelEntry("anthropic.claude-opus-4")).toBe(true)
  })

  it("rejects third-party model identifiers", () => {
    expect(isClaudeModelEntry("gpt-4o")).toBe(false)
    expect(isClaudeModelEntry("deepseek-v3")).toBe(false)
  })
})
