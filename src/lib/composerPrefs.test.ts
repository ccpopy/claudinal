import { describe, expect, it } from "vitest"
import {
  buildEffortOrder,
  composerPrefsPatchFromCommandEvent,
  effortLabel,
  effortSource,
  isComposerModelAllowed,
  isClaudeModelEntry,
  mergeComposerPrefs,
  OPENAI_EFFORT_LEVELS,
  pickComposerFromSidecar,
  pickComposerFromTranscript,
  sanitizeComposerModel,
  syncEffortToGlobal,
  type EffortLevel
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

  it("passes through unknown/new effort levels for dynamic CLI support", () => {
    // 不再硬编码白名单——CLI 新增档位 / ultracode 经 /effort 透传，由 CLI 自行校验
    expect(
      composerPrefsPatchFromCommandEvent(
        userText(
          "<command-name>/effort</command-name><command-args>ultracode</command-args>"
        )
      )
    ).toEqual({ effort: "ultracode" })
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

describe("composerPrefs.isComposerModelAllowed", () => {
  it("allows built-in Claude entries when model options are not restricted", () => {
    const allowed = new Set<string>()

    expect(isComposerModelAllowed("opus[1m]", allowed, false)).toBe(true)
    expect(isComposerModelAllowed("gpt-5.5", allowed, false)).toBe(false)
  })

  it("allows only explicit role options when model options are restricted", () => {
    const allowed = new Set(["sonnet", "opus", "opus[1m]"])

    expect(isComposerModelAllowed("", allowed, true)).toBe(true)
    expect(isComposerModelAllowed("opus[1m]", allowed, true)).toBe(true)
    expect(isComposerModelAllowed("sonnet[1m]", allowed, true)).toBe(false)
    expect(isComposerModelAllowed("gpt-5.5[1m]", allowed, true)).toBe(false)
  })
})

describe("composerPrefs.buildEffortOrder", () => {
  it("falls back to builtin levels when dynamic list is empty", () => {
    expect(buildEffortOrder([])).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ])
  })

  it("orders known levels and appends unknown new levels after them", () => {
    expect(buildEffortOrder(["max", "low", "turbo", "high"])).toEqual([
      "",
      "low",
      "high",
      "max",
      "turbo"
    ])
  })

  it("dedupes and lowercases dynamic levels", () => {
    expect(buildEffortOrder(["LOW", "low", " High "])).toEqual([
      "",
      "low",
      "high"
    ])
  })
})

describe("composerPrefs.effortLabel", () => {
  it("uses builtin labels for known levels", () => {
    expect(effortLabel("")).toBe("Auto")
    expect(effortLabel("xhigh")).toBe("Extra high")
    expect(effortLabel("max")).toBe("Max")
  })

  it("labels OpenAI low-end levels none/minimal", () => {
    expect(effortLabel("none")).toBe("None")
    expect(effortLabel("minimal")).toBe("Minimal")
  })

  it("falls back to capitalized label for unknown levels", () => {
    expect(effortLabel("turbo")).toBe("Turbo")
    expect(effortLabel("super-max")).toBe("Super max")
  })

  it("labels the ultracode sentinel as 'Ultracode'", () => {
    expect(effortLabel("ultracode")).toBe("Ultracode")
  })
})

describe("composerPrefs ultracode sentinel", () => {
  it("never injects ultracode into the --help-derived order", () => {
    // ultracode 是 GUI 在 ModelEffortPicker 手动追加的 sentinel，不应通过
    // buildEffortOrder 进入档位清单。即便 claude --help 误带 ultracode，也要被剔除，
    // 否则会和 picker 末尾的追加项形成重复菜单项（重复 React key）。
    expect(buildEffortOrder([])).not.toContain("ultracode")
    expect(buildEffortOrder(["low", "high", "max"])).not.toContain("ultracode")
    const withStray = buildEffortOrder(["low", "ultracode", "high"])
    expect(withStray).not.toContain("ultracode")
    expect(withStray).toEqual(["", "low", "high"])
  })

  it("preserves the ultracode sentinel through /effort command parsing", () => {
    expect(
      composerPrefsPatchFromCommandEvent(
        ev({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "<command-name>/effort</command-name><command-args>UltraCode</command-args>"
              }
            ]
          }
        })
      )
    ).toEqual({ effort: "ultracode" })
  })

  it("refuses to persist the ultracode sentinel as a global default", async () => {
    // ultracode 是会话级 sentinel：syncEffortToGlobal 不允许写入 settings.json，
    // 提前 return false（不触达任何 IPC/写文件）。
    await expect(syncEffortToGlobal("ultracode")).resolves.toBe(false)
    await expect(syncEffortToGlobal("max")).resolves.toBe(false)
  })
})

describe("composerPrefs.OPENAI_EFFORT_LEVELS", () => {
  it("holds the OpenAI reasoning_effort full set in order, without auto/max/ultracode", () => {
    expect(OPENAI_EFFORT_LEVELS).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
    ])
    // 不含 auto sentinel（""）、Claude 语义 max、CC 设置 ultracode
    expect(OPENAI_EFFORT_LEVELS).not.toContain("")
    expect(OPENAI_EFFORT_LEVELS).not.toContain("max")
    expect(OPENAI_EFFORT_LEVELS).not.toContain("ultracode")
  })

  it("every OpenAI level resolves to a non-fallback label", () => {
    // none/minimal/low/medium/high/xhigh 都应有专门 label（首字母大写、非原样回退）
    const labels = OPENAI_EFFORT_LEVELS.map(effortLabel)
    expect(labels).toEqual([
      "None",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high"
    ])
  })
})

describe("composerPrefs effort pool by provider (ModelEffortPicker source-of-truth)", () => {
  // 镜像 ModelEffortPicker 里的 effortPool / visibleEfforts 计算逻辑，
  // 锁定 PR3 的 provider 分场景行为（避免 UI 重构悄悄回归）。
  const effortPool = (openaiCompatible: boolean): EffortLevel[] =>
    openaiCompatible
      ? (["", ...OPENAI_EFFORT_LEVELS] as EffortLevel[])
      : buildEffortOrder([])
  const visibleEfforts = (openaiCompatible: boolean): EffortLevel[] =>
    openaiCompatible
      ? effortPool(true)
      : ([...effortPool(false), "ultracode"] as EffortLevel[])

  it("OpenAI compatible: auto + 6 OpenAI levels, includes none/minimal, no max/ultracode", () => {
    const visible = visibleEfforts(true)
    expect(visible).toEqual([
      "",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
    ])
    expect(visible).toContain("none")
    expect(visible).toContain("minimal")
    expect(visible).not.toContain("max")
    expect(visible).not.toContain("ultracode")
  })

  it("Anthropic path: Claude builtin order + ultracode, no none/minimal", () => {
    const visible = visibleEfforts(false)
    expect(visible).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode"
    ])
    expect(visible).toContain("max")
    expect(visible).toContain("ultracode")
    expect(visible).not.toContain("none")
    expect(visible).not.toContain("minimal")
  })

  it("switching provider flips the level source between the two pools", () => {
    expect(visibleEfforts(true)).not.toEqual(visibleEfforts(false))
    // OpenAI 池绝不含 ultracode；Anthropic 池绝不含 OpenAI 低档
    expect(visibleEfforts(true)).not.toContain("ultracode")
    expect(visibleEfforts(false)).not.toContain("none")
  })
})

describe("composerPrefs.sanitizeComposerModel", () => {
  it("maps whole-string <...> sentinel shapes to empty", () => {
    expect(sanitizeComposerModel("<synthetic>")).toBe("")
    expect(sanitizeComposerModel("<unknown>")).toBe("")
    expect(sanitizeComposerModel("  <synthetic>  ")).toBe("")
    // 边界形态：空尖括号与含内部空格的整串 <...> 同样视为哨兵
    expect(sanitizeComposerModel("<>")).toBe("")
    expect(sanitizeComposerModel("< synthetic >")).toBe("")
  })

  it("keeps real model ids and [1m] bracket aliases untouched (trim only)", () => {
    // 方括号别名（sonnet[1m]）与 <...> 哨兵形态必须区分清楚
    expect(sanitizeComposerModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
    expect(sanitizeComposerModel("sonnet[1m]")).toBe("sonnet[1m]")
    expect(sanitizeComposerModel("  opus[1m]  ")).toBe("opus[1m]")
    expect(sanitizeComposerModel("")).toBe("")
    // 非整串 <...> 形态不误杀（哨兵判定仅针对整个值）
    expect(sanitizeComposerModel("a<b>")).toBe("a<b>")
  })
})

describe("composerPrefs synthetic model sentinel", () => {
  // Claude CLI 在 API 出错（重试耗尽、模型不可用等）时会写入合成 assistant 消息，
  // 其 message.model 为字面量 "<synthetic>"。任何摄入点都不得把它当作会话模型，
  // 否则 --model "<synthetic>" 会触发"模型不存在 → 再写合成消息"的报错死循环。
  const initEv = (model: string) =>
    ev({ type: "system", subtype: "init", model })
  const assistantEv = (model: string) =>
    ev({
      type: "assistant",
      message: { role: "assistant", model, content: [] }
    })
  const modelCommandEv = (arg: string) =>
    ev({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: `<command-name>/model</command-name><command-args>${arg}</command-args>`
          }
        ]
      }
    })

  it("skips a trailing synthetic assistant turn and keeps the last real assistant model", () => {
    expect(
      pickComposerFromTranscript([
        initEv("claude-x"),
        assistantEv("claude-y"),
        assistantEv("<synthetic>")
      ])
    ).toEqual({ model: "claude-y", effort: "" })
  })

  it("falls back to the init model when every assistant turn is synthetic", () => {
    expect(
      pickComposerFromTranscript([
        initEv("claude-x"),
        assistantEv("<synthetic>")
      ])
    ).toEqual({ model: "claude-x", effort: "" })
  })

  it("returns null for a transcript with only synthetic assistant turns", () => {
    expect(pickComposerFromTranscript([assistantEv("<synthetic>")])).toBeNull()
  })

  it("keeps explicit /model at highest priority over later synthetic turns", () => {
    expect(
      pickComposerFromTranscript([
        initEv("claude-x"),
        modelCommandEv("opus"),
        assistantEv("<synthetic>")
      ])
    ).toEqual({ model: "opus", effort: "" })
  })

  it("normalizes sentinel /model arguments to empty (defensive)", () => {
    expect(
      composerPrefsPatchFromCommandEvent(modelCommandEv("&lt;synthetic&gt;"))
    ).toEqual({ model: "" })
    expect(
      composerPrefsPatchFromCommandEvent(modelCommandEv("<synthetic>"))
    ).toEqual({ model: "" })
  })

  it("self-heals polluted sidecars by reading sentinel models as empty", () => {
    // model 净化后与 effort 双空时维持「返回 null」的既有语义
    expect(
      pickComposerFromSidecar({ composer: { model: "<synthetic>", effort: "" } })
    ).toBeNull()
    expect(
      pickComposerFromSidecar({
        composer: { model: "<synthetic>", effort: "high" }
      })
    ).toEqual({ model: "", effort: "high" })
  })

  it("sanitizes the system/init model defensively", () => {
    expect(pickComposerFromTranscript([initEv("<synthetic>")])).toBeNull()
  })
})
