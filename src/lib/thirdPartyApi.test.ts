import { describe, expect, it } from "vitest"
import {
  buildClaudeEnv,
  clearManagedClaudeEnv,
  createThirdPartyApiProvider,
  maskSecret,
  normalizeThirdPartyApiConfig,
  providerModelInputOptions,
  providerModelOptions,
  trimApiUrl,
  type ThirdPartyApiConfig
} from "./thirdPartyApi"

function makeConfig(patch: Partial<ThirdPartyApiConfig> = {}): ThirdPartyApiConfig {
  return normalizeThirdPartyApiConfig({
    enabled: true,
    providerName: "X",
    requestUrl: "https://api.example.com",
    apiKey: "sk-test",
    inputFormat: "anthropic",
    authField: "ANTHROPIC_AUTH_TOKEN",
    models: {
      mainModel: "claude-3-7-sonnet",
      haikuModel: "claude-3-5-haiku",
      sonnetModel: "claude-3-7-sonnet",
      opusModel: "claude-opus-4",
      subagentModel: "claude-3-5-haiku"
    },
    availableModels: ["claude-3-7-sonnet", "claude-3-5-haiku", "claude-opus-4"],
    ...patch
  })
}

describe("thirdPartyApi.normalizeThirdPartyApiConfig", () => {
  it("falls back to defaults for missing string fields", () => {
    const cfg = normalizeThirdPartyApiConfig({})
    expect(cfg.providerName).toBe("")
    expect(cfg.apiKey).toBe("")
    expect(cfg.inputFormat).toBe("anthropic")
    expect(cfg.authField).toBe("ANTHROPIC_AUTH_TOKEN")
    expect(cfg.mainAlias).toBe("sonnet")
    expect(cfg.availableModels).toEqual([])
    expect(cfg.models.mainModel).toBe("")
  })

  it("clamps inputFormat and authField to known values", () => {
    const cfg = normalizeThirdPartyApiConfig({
      inputFormat: "anthropic" as never,
      authField: "FOO" as never
    })
    expect(cfg.inputFormat).toBe("anthropic")
    expect(cfg.authField).toBe("ANTHROPIC_AUTH_TOKEN")
    const open = normalizeThirdPartyApiConfig({
      inputFormat: "openai-chat-completions",
      authField: "ANTHROPIC_API_KEY"
    })
    expect(open.inputFormat).toBe("openai-chat-completions")
    expect(open.authField).toBe("ANTHROPIC_API_KEY")
  })

  it("infers mainAlias when not explicitly set", () => {
    const opus = normalizeThirdPartyApiConfig({
      models: { mainModel: "X", opusModel: "X" } as never
    })
    expect(opus.mainAlias).toBe("opus")
    const haiku = normalizeThirdPartyApiConfig({
      models: { mainModel: "Y", haikuModel: "Y" } as never
    })
    expect(haiku.mainAlias).toBe("haiku")
    const fallback = normalizeThirdPartyApiConfig({
      models: { mainModel: "Z" } as never
    })
    expect(fallback.mainAlias).toBe("sonnet")
  })

  it("dedupes and trims availableModels", () => {
    const cfg = normalizeThirdPartyApiConfig({
      availableModels: [" a ", "b", "a", "  "] as never
    })
    expect(cfg.availableModels).toEqual(["a", "b"])
  })
})

describe("thirdPartyApi.buildClaudeEnv", () => {
  it("returns existing env stripped of managed keys when disabled", () => {
    const cfg = makeConfig({ enabled: false })
    const env = buildClaudeEnv(cfg, {
      ANTHROPIC_BASE_URL: "old",
      ANTHROPIC_AUTH_TOKEN: "old",
      UNRELATED: "keep"
    })
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.UNRELATED).toBe("keep")
  })

  it("emits the proxy-routed sentinel and target URL with API key passthrough", () => {
    const env = buildClaudeEnv(makeConfig())
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("claudinal-proxy")
    expect(env.CLAUDINAL_PROXY_TARGET_URL).toBe("https://api.example.com")
    expect(env.CLAUDINAL_PROXY_API_KEY).toBe("sk-test")
    expect(env.CLAUDINAL_PROXY_INPUT_FORMAT).toBe("anthropic")
    expect(env.CLAUDINAL_PROXY_AUTH_FIELD).toBe("ANTHROPIC_AUTH_TOKEN")
    expect(env.CLAUDINAL_PROXY_USE_FULL_URL).toBe("0")
  })

  it("populates ANTHROPIC_DEFAULT_*_MODEL only when corresponding model fields are set", () => {
    const env = buildClaudeEnv(makeConfig())
    expect(env.ANTHROPIC_MODEL).toBe("claude-3-7-sonnet")
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-3-5-haiku")
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-3-7-sonnet")
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4")
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-3-5-haiku")

    const partial = makeConfig({
      models: {
        mainModel: "only-main",
        haikuModel: "",
        sonnetModel: "",
        opusModel: "",
        subagentModel: ""
      }
    })
    const env2 = buildClaudeEnv(partial)
    expect(env2.ANTHROPIC_MODEL).toBe("only-main")
    expect(env2.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
    expect(env2.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
    expect(env2.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(env2.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
  })

  it("serializes availableModels JSON only when non-empty", () => {
    const cfg = makeConfig({ availableModels: ["m1", "m2"] })
    const env = buildClaudeEnv(cfg)
    expect(env.CLAUDINAL_PROXY_AVAILABLE_MODELS).toBe(
      JSON.stringify(["m1", "m2"])
    )
    const empty = buildClaudeEnv(makeConfig({ availableModels: [] }))
    expect(empty.CLAUDINAL_PROXY_AVAILABLE_MODELS).toBeUndefined()
  })

  it("flips USE_FULL_URL when configured", () => {
    const env = buildClaudeEnv(makeConfig({ useFullUrl: true }))
    expect(env.CLAUDINAL_PROXY_USE_FULL_URL).toBe("1")
  })

  it("does not write CLAUDINAL_PROXY_API_KEY when key is whitespace", () => {
    const env = buildClaudeEnv(makeConfig({ apiKey: "   " }))
    expect(env.CLAUDINAL_PROXY_API_KEY).toBeUndefined()
    // 仍标记 ANTHROPIC_AUTH_TOKEN 给 CLI（避免 CLI 走自己的鉴权链路）
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("claudinal-proxy")
  })
})

describe("thirdPartyApi.clearManagedClaudeEnv", () => {
  it("removes all managed keys but preserves unrelated ones", () => {
    const next = clearManagedClaudeEnv({
      ANTHROPIC_BASE_URL: "x",
      ANTHROPIC_AUTH_TOKEN: "x",
      ANTHROPIC_API_KEY: "x",
      ANTHROPIC_MODEL: "x",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "x",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "x",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "x",
      CLAUDE_CODE_SUBAGENT_MODEL: "x",
      CLAUDINAL_PROXY_TARGET_URL: "x",
      CLAUDINAL_PROXY_API_KEY: "x",
      CLAUDINAL_PROXY_INPUT_FORMAT: "x",
      CLAUDINAL_PROXY_AUTH_FIELD: "x",
      CLAUDINAL_PROXY_USE_FULL_URL: "x",
      CLAUDINAL_PROXY_OPENAI_REASONING_EFFORT: "x",
      CLAUDINAL_PROXY_MAIN_MODEL: "x",
      CLAUDINAL_PROXY_HAIKU_MODEL: "x",
      CLAUDINAL_PROXY_SONNET_MODEL: "x",
      CLAUDINAL_PROXY_OPUS_MODEL: "x",
      CLAUDINAL_PROXY_AVAILABLE_MODELS: "x",
      USER_VAR: "keep"
    })
    expect(Object.keys(next)).toEqual(["USER_VAR"])
  })

  it("returns empty object when input is undefined", () => {
    expect(clearManagedClaudeEnv(undefined)).toEqual({})
  })
})

describe("thirdPartyApi.providerModelOptions", () => {
  it("returns only mapped per-role models in a deduped list", () => {
    const list = providerModelOptions({
      models: {
        mainModel: "m1",
        haikuModel: "m4",
        sonnetModel: "",
        opusModel: "m3",
        subagentModel: ""
      }
    })
    expect(list).toEqual(["m1", "m4", "m3"])
  })
})

describe("thirdPartyApi.providerModelInputOptions", () => {
  it("merges fetched provider models with mapped models for editor suggestions", () => {
    const list = providerModelInputOptions({
      availableModels: ["m1", "m2", "  m3  "],
      models: {
        mainModel: "m1",
        haikuModel: "m4",
        sonnetModel: "",
        opusModel: "m3",
        subagentModel: "m5"
      }
    })
    expect(list).toEqual(["m1", "m2", "m3", "m4", "m5"])
  })
})

describe("thirdPartyApi.maskSecret", () => {
  it("masks short secrets entirely", () => {
    expect(maskSecret("")).toBe("")
    expect(maskSecret("short-key")).toBe("•".repeat("short-key".length))
  })

  it("keeps prefix and suffix for long secrets", () => {
    expect(maskSecret("sk-ant-1234567890ABCDEF")).toBe("sk-ant…CDEF")
  })
})

describe("thirdPartyApi.trimApiUrl", () => {
  it("trims whitespace and strips trailing slashes", () => {
    expect(trimApiUrl("  https://api.example.com/  ")).toBe(
      "https://api.example.com"
    )
    expect(trimApiUrl("https://x.com////")).toBe("https://x.com")
    expect(trimApiUrl("")).toBe("")
  })
})

describe("thirdPartyApi.createThirdPartyApiProvider", () => {
  it("assigns an id when missing and preserves explicit id", () => {
    const a = createThirdPartyApiProvider()
    expect(a.id).toBeTruthy()
    const b = createThirdPartyApiProvider({ id: "fixed-1" })
    expect(b.id).toBe("fixed-1")
  })

  it("propagates legacyApiKey flag when set", () => {
    const p = createThirdPartyApiProvider({
      apiKey: "sk-x",
      legacyApiKey: true
    })
    expect(p.legacyApiKey).toBe(true)
  })
})
