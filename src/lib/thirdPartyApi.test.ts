import { describe, expect, it } from "vitest"
import {
  buildClaudeLaunchEnv,
  buildClaudeEnv,
  buildClaudeRuntimeSettingsPreview,
  clearManagedClaudeEnv,
  createThirdPartyApiProvider,
  maskSecret,
  normalizeThirdPartyApiConfig,
  parseRuntimeSettingsJson,
  providerComposerModelOptions,
  providerModelInputOptions,
  providerModelOptions,
  resolveThirdPartyComposerLaunchModel,
  resolveThirdPartyDefaultComposerModel,
  resolveThirdPartyDefaultLaunchModel,
  canUseApiProfileLaunchPrefs,
  shouldResumeWithApiProfile,
  thirdPartyApiRequiresLocalProxy,
  thirdPartyApiConnectionProfileKey,
  thirdPartyApiRuntimeProfileKey,
  thirdPartyApiUsesLocalProxy,
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
      fableModel: "",
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
    expect(cfg.routingMode).toBe("direct")
    expect(cfg.cacheHitOptimizationEnabled).toBe(true)
    expect(cfg.enablePromptCaching1h).toBe(true)
    expect(cfg.cchRewriteEnabled).toBe(false)
    expect(cfg.cchSeed).toBe("")
    expect(cfg.disableTelemetry).toBe(false)
    expect(cfg.hideAiAttribution).toBe(false)
    expect(cfg.agentTeamsEnabled).toBe(false)
    expect(cfg.toolSearchEnabled).toBe(false)
    expect(cfg.maxThinkingEnabled).toBe(false)
    expect(cfg.mainAlias).toBe("sonnet")
    expect(cfg.availableModels).toEqual([])
    expect(cfg.modelSupports1m).toEqual({
      sonnet: false,
      opus: false,
      fable: false
    })
    expect(cfg.runtimeSettingsJson).toBe("")
    expect(cfg.models.mainModel).toBe("")
  })

  it("clamps inputFormat and authField to known values", () => {
    const cfg = normalizeThirdPartyApiConfig({
      inputFormat: "anthropic" as never,
      authField: "FOO" as never,
      routingMode: "bad" as never
    })
    expect(cfg.inputFormat).toBe("anthropic")
    expect(cfg.authField).toBe("ANTHROPIC_AUTH_TOKEN")
    expect(cfg.routingMode).toBe("direct")
    const open = normalizeThirdPartyApiConfig({
      inputFormat: "openai-chat-completions",
      authField: "ANTHROPIC_API_KEY",
      routingMode: "proxy"
    })
    expect(open.inputFormat).toBe("openai-chat-completions")
    expect(open.authField).toBe("ANTHROPIC_API_KEY")
    expect(open.routingMode).toBe("proxy")
  })

  it("preserves explicit cache option opt-outs and cch settings", () => {
    const cfg = normalizeThirdPartyApiConfig({
      cacheHitOptimizationEnabled: false,
      enablePromptCaching1h: false,
      cchRewriteEnabled: true,
      cchSeed: "0x6E52736AC806831E",
      disableTelemetry: true,
      hideAiAttribution: true,
      agentTeamsEnabled: true,
      toolSearchEnabled: true,
      maxThinkingEnabled: true
    })
    expect(cfg.cacheHitOptimizationEnabled).toBe(false)
    expect(cfg.enablePromptCaching1h).toBe(false)
    expect(cfg.cchRewriteEnabled).toBe(true)
    expect(cfg.cchSeed).toBe("0x6E52736AC806831E")
    expect(cfg.disableTelemetry).toBe(true)
    expect(cfg.hideAiAttribution).toBe(true)
    expect(cfg.agentTeamsEnabled).toBe(true)
    expect(cfg.toolSearchEnabled).toBe(true)
    expect(cfg.maxThinkingEnabled).toBe(true)

    const invalid = normalizeThirdPartyApiConfig({
      cacheHitOptimizationEnabled: "false" as never,
      enablePromptCaching1h: "false" as never,
      disableTelemetry: "true" as never,
      hideAiAttribution: "true" as never,
      agentTeamsEnabled: "true" as never,
      toolSearchEnabled: "true" as never,
      maxThinkingEnabled: "true" as never
    })
    expect(invalid.cacheHitOptimizationEnabled).toBe(true)
    expect(invalid.enablePromptCaching1h).toBe(true)
    expect(invalid.disableTelemetry).toBe(false)
    expect(invalid.hideAiAttribution).toBe(false)
    expect(invalid.agentTeamsEnabled).toBe(false)
    expect(invalid.toolSearchEnabled).toBe(false)
    expect(invalid.maxThinkingEnabled).toBe(false)
  })

  it("normalizes explicit model 1M capability declarations", () => {
    const cfg = normalizeThirdPartyApiConfig({
      modelSupports1m: {
        sonnet: true,
        opus: true,
        fable: true
      }
    } as never)
    expect(cfg.modelSupports1m).toEqual({
      sonnet: true,
      opus: true,
      fable: true
    })

    const invalid = normalizeThirdPartyApiConfig({
      modelSupports1m: {
        sonnet: "true",
        opus: 1,
        fable: "yes"
      }
    } as never)
    expect(invalid.modelSupports1m).toEqual({
      sonnet: false,
      opus: false,
      fable: false
    })
  })

  it("migrates legacy disableAttributionHeader to cacheHitOptimizationEnabled", () => {
    const cfg = normalizeThirdPartyApiConfig({
      disableAttributionHeader: false
    } as never)
    expect(cfg.cacheHitOptimizationEnabled).toBe(false)
  })

  it("infers mainAlias when not explicitly set", () => {
    const opus = normalizeThirdPartyApiConfig({
      models: { mainModel: "X", opusModel: "X" } as never
    })
    expect(opus.mainAlias).toBe("opus")
    const fable = normalizeThirdPartyApiConfig({
      models: { mainModel: "F", fableModel: "F" } as never
    })
    expect(fable.mainAlias).toBe("fable")
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

describe("thirdPartyApi.runtimeSettings", () => {
  it("parses an empty runtime settings value as an empty object", () => {
    expect(parseRuntimeSettingsJson("   ")).toEqual({})
  })

  it("requires runtime settings to be a JSON object", () => {
    expect(() => parseRuntimeSettingsJson("[]")).toThrow(
      "运行时 settings 必须是 JSON 对象"
    )
    expect(() => parseRuntimeSettingsJson("{")).toThrow(
      "运行时 settings JSON 无效"
    )
  })

  it("requires env values to be strings", () => {
    expect(() =>
      parseRuntimeSettingsJson('{"env":{"FEATURE_FLAG":true}}')
    ).toThrow("运行时 settings.env.FEATURE_FLAG 必须是字符串")
  })

  it("rejects env keys managed by Claudinal", () => {
    expect(() =>
      parseRuntimeSettingsJson('{"env":{"ANTHROPIC_MODEL":"manual"}}')
    ).toThrow("运行时 settings.env.ANTHROPIC_MODEL 由 Claudinal 管理")
    expect(() =>
      parseRuntimeSettingsJson(
        '{"env":{"CLAUDE_CODE_ATTRIBUTION_HEADER":"manual"}}'
      )
    ).toThrow(
      "运行时 settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER 由 Claudinal 管理"
    )
    expect(() =>
      parseRuntimeSettingsJson(
        '{"env":{"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"manual"}}'
      )
    ).toThrow(
      "运行时 settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 由 Claudinal 管理"
    )
    expect(() =>
      parseRuntimeSettingsJson('{"env":{"ENABLE_TOOL_SEARCH":"true"}}')
    ).toThrow("运行时 settings.env.ENABLE_TOOL_SEARCH 由 Claudinal 管理")
    expect(() =>
      parseRuntimeSettingsJson('{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"max"}}')
    ).toThrow("运行时 settings.env.CLAUDE_CODE_EFFORT_LEVEL 由 Claudinal 管理")
  })

  it("merges provider runtime settings with generated Claude env for preview", () => {
    const settings = buildClaudeRuntimeSettingsPreview(
      makeConfig({
        runtimeSettingsJson:
          '{"model":"opus[1m]","alwaysThinkingEnabled":true,"env":{"EXTRA":"1"}}'
      })
    )
    expect(settings.model).toBe("opus[1m]")
    expect(settings.alwaysThinkingEnabled).toBe(true)
    expect(settings.env).toMatchObject({
      EXTRA: "1",
      ANTHROPIC_BASE_URL: "https://api.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-test",
      ANTHROPIC_MODEL: "claude-3-7-sonnet",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      ENABLE_PROMPT_CACHING_1H: "1"
    })
  })

  it("adds managed top-level runtime settings for optional behavior switches", () => {
    const settings = buildClaudeRuntimeSettingsPreview(
      makeConfig({
        hideAiAttribution: true,
        disableTelemetry: true,
        agentTeamsEnabled: true,
        toolSearchEnabled: true,
        maxThinkingEnabled: true
      })
    )
    expect(settings.attribution).toEqual({ commit: "", pr: "" })
    expect(settings.env).toMatchObject({
      DISABLE_TELEMETRY: "1",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      ENABLE_TOOL_SEARCH: "true",
      CLAUDE_CODE_EFFORT_LEVEL: "max"
    })
  })

  it("rejects manual attribution when the managed hide-attribution switch is enabled", () => {
    expect(() =>
      buildClaudeRuntimeSettingsPreview(
        makeConfig({
          hideAiAttribution: true,
          runtimeSettingsJson: '{"attribution":{"commit":"manual","pr":""}}'
        })
      )
    ).toThrow("运行时 settings.attribution 由 Claudinal")
  })

  it("adds runtime settings JSON to launch env only after validation", () => {
    const env = buildClaudeLaunchEnv(
      makeConfig({
        runtimeSettingsJson: '{"model":"opus[1m]"}'
      })
    )
    expect(env.CLAUDINAL_RUNTIME_SETTINGS_JSON).toBe('{"model":"opus[1m]"}')
    expect(() =>
      buildClaudeLaunchEnv(
        makeConfig({
          runtimeSettingsJson: '{"env":{"ANTHROPIC_MODEL":"manual"}}'
        })
      )
    ).toThrow("运行时 settings.env.ANTHROPIC_MODEL 由 Claudinal 管理")
  })

  it("adds managed top-level runtime settings JSON to launch env", () => {
    const env = buildClaudeLaunchEnv(
      makeConfig({
        hideAiAttribution: true,
        runtimeSettingsJson: '{"env":{"EXTRA":"1"}}'
      })
    )
    expect(JSON.parse(env.CLAUDINAL_RUNTIME_SETTINGS_JSON)).toEqual({
      env: { EXTRA: "1" },
      attribution: { commit: "", pr: "" }
    })
  })
})

describe("thirdPartyApi.runtimeProfile", () => {
  it("changes when launch-affecting model mappings change", () => {
    const base = makeConfig({ id: "provider-a" } as Partial<ThirdPartyApiConfig>)
    const changed = makeConfig({
      id: "provider-a",
      models: {
        ...base.models,
        opusModel: "claude-opus-4-7[1m]"
      }
    } as Partial<ThirdPartyApiConfig>)

    expect(thirdPartyApiRuntimeProfileKey(changed)).not.toBe(
      thirdPartyApiRuntimeProfileKey(base)
    )
  })

  it("changes when the default model alias changes", () => {
    const base = makeConfig({
      id: "provider-a",
      mainAlias: "sonnet"
    } as Partial<ThirdPartyApiConfig>)
    const changed = makeConfig({
      id: "provider-a",
      mainAlias: "opus"
    } as Partial<ThirdPartyApiConfig>)

    expect(thirdPartyApiRuntimeProfileKey(changed)).not.toBe(
      thirdPartyApiRuntimeProfileKey(base)
    )
  })

  it("keeps the connection profile stable when only model mappings change", () => {
    const base = makeConfig({ id: "provider-a" } as Partial<ThirdPartyApiConfig>)
    const changed = makeConfig({
      id: "provider-a",
      models: {
        ...base.models,
        opusModel: "claude-opus-4-7[1m]",
        subagentModel: "claude-opus-4-7[1m]"
      }
    } as Partial<ThirdPartyApiConfig>)

    expect(thirdPartyApiConnectionProfileKey(changed)).toBe(
      thirdPartyApiConnectionProfileKey(base)
    )
  })

  it("changes the connection profile when provider routing changes", () => {
    const base = makeConfig({ id: "provider-a" } as Partial<ThirdPartyApiConfig>)
    const changed = makeConfig({
      id: "provider-a",
      requestUrl: "https://api.other.example.com",
      inputFormat: "openai-chat-completions"
    } as Partial<ThirdPartyApiConfig>)

    expect(thirdPartyApiConnectionProfileKey(changed)).not.toBe(
      thirdPartyApiConnectionProfileKey(base)
    )
  })

  it("changes profile keys when the local proxy routing mode changes", () => {
    const base = makeConfig({ id: "provider-a" } as Partial<ThirdPartyApiConfig>)
    const changed = makeConfig({
      id: "provider-a",
      routingMode: "proxy"
    } as Partial<ThirdPartyApiConfig>)

    expect(thirdPartyApiConnectionProfileKey(changed)).not.toBe(
      thirdPartyApiConnectionProfileKey(base)
    )
    expect(thirdPartyApiRuntimeProfileKey(changed)).not.toBe(
      thirdPartyApiRuntimeProfileKey(base)
    )
  })

  it("changes when runtime settings JSON changes", () => {
    const base = makeConfig({
      id: "provider-a",
      runtimeSettingsJson: '{"model":"claude-opus-4-7"}'
    } as Partial<ThirdPartyApiConfig>)
    const changed = makeConfig({
      id: "provider-a",
      runtimeSettingsJson: '{"model":"claude-opus-4-7[1m]"}'
    } as Partial<ThirdPartyApiConfig>)

    expect(thirdPartyApiRuntimeProfileKey(changed)).not.toBe(
      thirdPartyApiRuntimeProfileKey(base)
    )
  })

  it("changes when cache optimization options change", () => {
    const base = makeConfig({ id: "provider-a" } as Partial<ThirdPartyApiConfig>)
    const changed = makeConfig({
      id: "provider-a",
      enablePromptCaching1h: false
    } as Partial<ThirdPartyApiConfig>)

    expect(thirdPartyApiRuntimeProfileKey(changed)).not.toBe(
      thirdPartyApiRuntimeProfileKey(base)
    )
  })

  it("changes when optional runtime behavior switches change", () => {
    const base = makeConfig({ id: "provider-a" } as Partial<ThirdPartyApiConfig>)
    const changed = makeConfig({
      id: "provider-a",
      toolSearchEnabled: true
    } as Partial<ThirdPartyApiConfig>)

    expect(thirdPartyApiRuntimeProfileKey(changed)).not.toBe(
      thirdPartyApiRuntimeProfileKey(base)
    )
  })

  it("does not include API key changes in the runtime profile key", () => {
    const base = makeConfig({ id: "provider-a", apiKey: "sk-old" } as Partial<
      ThirdPartyApiConfig
    >)
    const changed = makeConfig({ id: "provider-a", apiKey: "sk-new" } as Partial<
      ThirdPartyApiConfig
    >)

    expect(thirdPartyApiRuntimeProfileKey(changed)).toBe(
      thirdPartyApiRuntimeProfileKey(base)
    )
  })

  it("resumes third-party sessions whenever the provider entry matches", () => {
    const base = makeConfig({ id: "provider-a" } as Partial<ThirdPartyApiConfig>)
    // 同供应商：仅模型映射变化（连接指纹不变）
    const changedModel = makeConfig({
      id: "provider-a",
      models: {
        ...base.models,
        opusModel: "claude-opus-4-7[1m]"
      }
    } as Partial<ThirdPartyApiConfig>)
    // 同供应商：换镜像地址 / 换 key / 换协议与鉴权字段（连接指纹变化）
    const changedRoute = makeConfig({
      id: "provider-a",
      requestUrl: "https://api.other.example.com",
      apiKey: "sk-rotated",
      inputFormat: "openai-chat-completions",
      authField: "ANTHROPIC_API_KEY",
      useFullUrl: true
    } as Partial<ThirdPartyApiConfig>)
    const otherProvider = makeConfig({
      id: "provider-b"
    } as Partial<ThirdPartyApiConfig>)
    const currentConnectionKey = thirdPartyApiConnectionProfileKey(base)

    // official 语义不变：stored 为空或 official 才可续
    expect(shouldResumeWithApiProfile(null, "official")).toBe(true)
    expect(shouldResumeWithApiProfile("official", "official")).toBe(true)
    expect(shouldResumeWithApiProfile(currentConnectionKey, "official")).toBe(false)
    // 旧会话无归属记录 / 官方会话 → 第三方不可续
    expect(shouldResumeWithApiProfile(null, currentConnectionKey)).toBe(false)
    expect(shouldResumeWithApiProfile("official", currentConnectionKey)).toBe(false)
    // 同 providerId：指纹完全相同（仅 key 变化不影响连接指纹）
    expect(
      shouldResumeWithApiProfile(currentConnectionKey, currentConnectionKey)
    ).toBe(true)
    expect(
      shouldResumeWithApiProfile(
        thirdPartyApiConnectionProfileKey(changedModel),
        currentConnectionKey
      )
    ).toBe(true)
    // 同 providerId：旧版 sidecar 存的是运行时格式 key（third-party: 前缀）
    expect(
      shouldResumeWithApiProfile(
        thirdPartyApiRuntimeProfileKey(changedModel),
        currentConnectionKey
      )
    ).toBe(true)
    // 同 providerId：连接指纹不同（换镜像 / 换协议）也永远可续
    expect(
      shouldResumeWithApiProfile(
        thirdPartyApiConnectionProfileKey(changedRoute),
        currentConnectionKey
      )
    ).toBe(true)
    expect(
      shouldResumeWithApiProfile(
        thirdPartyApiRuntimeProfileKey(changedRoute),
        currentConnectionKey
      )
    ).toBe(true)
    // 跨供应商条目 → 不可续
    expect(
      shouldResumeWithApiProfile(
        thirdPartyApiConnectionProfileKey(otherProvider),
        currentConnectionKey
      )
    ).toBe(false)
    expect(
      shouldResumeWithApiProfile(
        thirdPartyApiRuntimeProfileKey(otherProvider),
        currentConnectionKey
      )
    ).toBe(false)
  })

  it("requires exact third-party profile match before reusing launch preferences", () => {
    const base = thirdPartyApiRuntimeProfileKey(
      makeConfig({ id: "provider-a" } as Partial<ThirdPartyApiConfig>)
    )
    const changed = thirdPartyApiRuntimeProfileKey(
      makeConfig({
        id: "provider-a",
        models: {
          ...makeConfig().models,
          opusModel: "claude-opus-4-7[1m]"
        }
      } as Partial<ThirdPartyApiConfig>)
    )

    expect(canUseApiProfileLaunchPrefs(null, "official")).toBe(true)
    expect(canUseApiProfileLaunchPrefs("official", "official")).toBe(true)
    expect(canUseApiProfileLaunchPrefs(base, "official")).toBe(false)
    expect(canUseApiProfileLaunchPrefs(null, changed)).toBe(false)
    expect(canUseApiProfileLaunchPrefs(base, changed)).toBe(false)
    expect(canUseApiProfileLaunchPrefs(changed, changed)).toBe(true)
  })
})

describe("thirdPartyApi routing mode", () => {
  it("uses direct Claude CLI env for ordinary Anthropic-compatible providers", () => {
    const cfg = makeConfig()
    expect(thirdPartyApiRequiresLocalProxy(cfg)).toBe(false)
    expect(thirdPartyApiUsesLocalProxy(cfg)).toBe(false)
  })

  it("uses the local proxy when explicitly enabled", () => {
    const cfg = makeConfig({ routingMode: "proxy" })
    expect(thirdPartyApiRequiresLocalProxy(cfg)).toBe(false)
    expect(thirdPartyApiUsesLocalProxy(cfg)).toBe(true)
  })

  it("requires the local proxy for protocol conversion, full URLs, and CCH rewrite", () => {
    expect(
      thirdPartyApiUsesLocalProxy(
        makeConfig({ inputFormat: "openai-chat-completions" })
      )
    ).toBe(true)
    expect(thirdPartyApiUsesLocalProxy(makeConfig({ useFullUrl: true }))).toBe(
      true
    )
    expect(
      thirdPartyApiUsesLocalProxy(
        makeConfig({
          cacheHitOptimizationEnabled: false,
          cchRewriteEnabled: true
        })
      )
    ).toBe(true)
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

  it("emits direct Anthropic-compatible Claude CLI env by default", () => {
    const env = buildClaudeEnv(makeConfig())
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.example.com")
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDINAL_PROXY_TARGET_URL).toBeUndefined()
    expect(env.CLAUDINAL_PROXY_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0")
    expect(env.ENABLE_PROMPT_CACHING_1H).toBe("1")
  })

  it("uses the configured direct auth field", () => {
    const env = buildClaudeEnv(makeConfig({ authField: "ANTHROPIC_API_KEY" }))
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.example.com")
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test")
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it("emits the proxy-routed sentinel and target URL when local proxy routing is enabled", () => {
    const env = buildClaudeEnv(
      makeConfig({
        routingMode: "proxy",
        models: {
          ...makeConfig().models,
          fableModel: "claude-fable-5"
        }
      })
    )
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("claudinal-proxy")
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDINAL_PROXY_TARGET_URL).toBe("https://api.example.com")
    expect(env.CLAUDINAL_PROXY_API_KEY).toBe("sk-test")
    expect(env.CLAUDINAL_PROXY_INPUT_FORMAT).toBe("anthropic")
    expect(env.CLAUDINAL_PROXY_AUTH_FIELD).toBe("ANTHROPIC_AUTH_TOKEN")
    expect(env.CLAUDINAL_PROXY_USE_FULL_URL).toBe("0")
    expect(env.CLAUDINAL_PROXY_FABLE_MODEL).toBe("claude-fable-5")
  })

  it("emits optional Claude Code behavior env vars only when enabled", () => {
    const base = buildClaudeEnv(makeConfig())
    expect(base.DISABLE_TELEMETRY).toBeUndefined()
    expect(base.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    expect(base.ENABLE_TOOL_SEARCH).toBeUndefined()
    expect(base.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()

    const env = buildClaudeEnv(
      makeConfig({
        disableTelemetry: true,
        agentTeamsEnabled: true,
        toolSearchEnabled: true,
        maxThinkingEnabled: true
      })
    )
    expect(env.DISABLE_TELEMETRY).toBe("1")
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1")
    expect(env.ENABLE_TOOL_SEARCH).toBe("true")
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe("max")
  })

  it("omits official cache optimization env vars when disabled", () => {
    const env = buildClaudeEnv(
      makeConfig({
        cacheHitOptimizationEnabled: false,
        enablePromptCaching1h: false
      })
    )
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined()
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined()
    expect(env.ENABLE_PROMPT_CACHING_1H).toBeUndefined()
  })

  it("passes cch seed only when official cache optimization is disabled", () => {
    const enabled = buildClaudeEnv(
      makeConfig({
        cacheHitOptimizationEnabled: true,
        cchRewriteEnabled: true,
        cchSeed: "0x6E52736AC806831E"
      })
    )
    expect(enabled.CLAUDINAL_PROXY_CCH_SEED).toBeUndefined()

    const disabled = buildClaudeEnv(
      makeConfig({
        cacheHitOptimizationEnabled: false,
        cchRewriteEnabled: true,
        cchSeed: "0x6E52736AC806831E"
      })
    )
    expect(disabled.CLAUDINAL_PROXY_CCH_SEED).toBe("0x6E52736AC806831E")
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
        fableModel: "",
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
    const cfg = makeConfig({
      availableModels: ["m1", "m2"],
      routingMode: "proxy"
    })
    const env = buildClaudeEnv(cfg)
    expect(env.CLAUDINAL_PROXY_AVAILABLE_MODELS).toBe(
      JSON.stringify(["m1", "m2"])
    )
    const empty = buildClaudeEnv(
      makeConfig({ availableModels: [], routingMode: "proxy" })
    )
    expect(empty.CLAUDINAL_PROXY_AVAILABLE_MODELS).toBeUndefined()
    const direct = buildClaudeEnv(makeConfig({ availableModels: ["m1"] }))
    expect(direct.CLAUDINAL_PROXY_AVAILABLE_MODELS).toBeUndefined()
  })

  it("flips USE_FULL_URL when configured", () => {
    const env = buildClaudeEnv(makeConfig({ useFullUrl: true }))
    expect(env.CLAUDINAL_PROXY_USE_FULL_URL).toBe("1")
  })

  it("does not write CLAUDINAL_PROXY_API_KEY when key is whitespace", () => {
    const env = buildClaudeEnv(makeConfig({ apiKey: "   " }))
    expect(env.CLAUDINAL_PROXY_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()

    const proxy = buildClaudeEnv(
      makeConfig({ apiKey: "   ", routingMode: "proxy" })
    )
    expect(proxy.CLAUDINAL_PROXY_API_KEY).toBeUndefined()
    // 本地代理模式仍用哨兵 token 避免 CLI 走自己的鉴权链路。
    expect(proxy.ANTHROPIC_AUTH_TOKEN).toBe("claudinal-proxy")
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
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "x",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "x",
      DISABLE_TELEMETRY: "x",
      ENABLE_PROMPT_CACHING_1H: "x",
      ENABLE_TOOL_SEARCH: "x",
      CLAUDE_CODE_EFFORT_LEVEL: "x",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "x",
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
      CLAUDINAL_PROXY_FABLE_MODEL: "x",
      CLAUDINAL_PROXY_AVAILABLE_MODELS: "x",
      CLAUDINAL_PROXY_CCH_SEED: "x",
      CLAUDINAL_RUNTIME_SETTINGS_JSON: "x",
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
        fableModel: "m6",
        subagentModel: ""
      }
    })
    expect(list).toEqual(["m1", "m4", "m3", "m6"])
  })
})

describe("thirdPartyApi.providerComposerModelOptions", () => {
  it("returns role aliases instead of raw provider model ids", () => {
    const list = providerComposerModelOptions({
      models: {
        mainModel: "gpt-5.5",
        haikuModel: "gpt-5.4-mini",
        sonnetModel: "gpt-5.4",
        opusModel: "gpt-5.5",
        fableModel: "gpt-5.6",
        subagentModel: "gpt-5.4-mini"
      },
      modelSupports1m: {
        sonnet: false,
        opus: true,
        fable: true
      }
    })

    expect(list).toEqual([
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "opus[1m]", label: "Opus 1M" },
      { value: "fable", label: "Fable" },
      { value: "fable[1m]", label: "Fable 1M" },
      { value: "haiku", label: "Haiku" }
    ])
  })

  it("omits 1M aliases unless the role declares support", () => {
    const list = providerComposerModelOptions({
      models: {
        mainModel: "",
        haikuModel: "",
        sonnetModel: "gpt-5.4",
        opusModel: "gpt-5.5",
        fableModel: "gpt-5.6",
        subagentModel: ""
      },
      modelSupports1m: {
        sonnet: false,
        opus: false,
        fable: false
      }
    })

    expect(list.map((option) => option.value)).toEqual([
      "sonnet",
      "opus",
      "fable"
    ])
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
        fableModel: "m6",
        subagentModel: "m5"
      }
    })
    expect(list).toEqual(["m1", "m2", "m3", "m4", "m6", "m5"])
  })
})

describe("thirdPartyApi.resolveThirdPartyDefaultComposerModel", () => {
  it("uses the Default fallback model's declared 1M role", () => {
    expect(
      resolveThirdPartyDefaultComposerModel(
        makeConfig({
          mainAlias: "sonnet",
          models: {
            mainModel: "claude-opus-4",
            haikuModel: "claude-3-5-haiku",
            sonnetModel: "claude-3-7-sonnet",
            opusModel: "claude-opus-4",
            fableModel: "claude-fable-5",
            subagentModel: "claude-3-5-haiku"
          },
          modelSupports1m: {
            sonnet: false,
            opus: true,
            fable: false
          }
        })
      )
    ).toBe("opus[1m]")

    expect(
      resolveThirdPartyDefaultComposerModel(
        makeConfig({
          models: {
            mainModel: "claude-3-7-sonnet",
            haikuModel: "claude-3-5-haiku",
            sonnetModel: "claude-3-7-sonnet",
            opusModel: "claude-opus-4",
            fableModel: "claude-fable-5",
            subagentModel: "claude-3-5-haiku"
          },
          modelSupports1m: {
            sonnet: true,
            opus: false,
            fable: false
          }
        })
      )
    ).toBe("sonnet[1m]")

    expect(
      resolveThirdPartyDefaultComposerModel(
        makeConfig({
          models: {
            mainModel: "claude-fable-5",
            haikuModel: "claude-3-5-haiku",
            sonnetModel: "claude-3-7-sonnet",
            opusModel: "claude-opus-4",
            fableModel: "claude-fable-5",
            subagentModel: "claude-3-5-haiku"
          },
          modelSupports1m: {
            sonnet: false,
            opus: false,
            fable: true
          }
        })
      )
    ).toBe("fable[1m]")
  })

  it("leaves Default empty when the matched role does not declare 1M support", () => {
    expect(
      resolveThirdPartyDefaultComposerModel(
        makeConfig({
          models: {
            mainModel: "claude-opus-4",
            haikuModel: "claude-3-5-haiku",
            sonnetModel: "claude-3-7-sonnet",
            opusModel: "claude-opus-4",
            fableModel: "claude-fable-5",
            subagentModel: "claude-3-5-haiku"
          },
          modelSupports1m: {
            sonnet: true,
            opus: false,
            fable: false
          }
        })
      )
    ).toBe("")

    expect(
      resolveThirdPartyDefaultComposerModel(
        makeConfig({
          models: {
            mainModel: "claude-main-custom",
            haikuModel: "claude-3-5-haiku",
            sonnetModel: "claude-3-7-sonnet",
            opusModel: "claude-opus-4",
            fableModel: "claude-fable-5",
            subagentModel: "claude-3-5-haiku"
          },
          modelSupports1m: {
            sonnet: true,
            opus: true,
            fable: true
          }
        })
      )
    ).toBe("")
  })
})

describe("thirdPartyApi launch model resolution", () => {
  it("maps Composer role aliases to configured provider model ids", () => {
    const cfg = makeConfig({
      models: {
        mainModel: "provider-sonnet-1m",
        haikuModel: "provider-haiku",
        sonnetModel: "provider-sonnet-1m",
        opusModel: "provider-opus-1m",
        fableModel: "provider-fable-1m",
        subagentModel: "provider-haiku"
      }
    })

    expect(resolveThirdPartyComposerLaunchModel(cfg, "sonnet[1m]")).toBe(
      "provider-sonnet-1m[1m]"
    )
    expect(resolveThirdPartyComposerLaunchModel(cfg, "opus")).toBe(
      "provider-opus-1m"
    )
    expect(resolveThirdPartyComposerLaunchModel(cfg, "fable[1m]")).toBe(
      "provider-fable-1m[1m]"
    )
    expect(resolveThirdPartyComposerLaunchModel(cfg, "haiku")).toBe(
      "provider-haiku"
    )
    expect(resolveThirdPartyComposerLaunchModel(cfg, "raw-model")).toBe(
      "raw-model"
    )
  })

  it("does not duplicate the Claude Code 1M suffix when provider ids already include it", () => {
    const cfg = makeConfig({
      models: {
        mainModel: "claude-opus-4-8[1m]",
        haikuModel: "claude-3-5-haiku",
        sonnetModel: "claude-sonnet-4-5[1m]",
        opusModel: "claude-opus-4-8[1m]",
        fableModel: "claude-fable-5[1m]",
        subagentModel: "claude-3-5-haiku"
      }
    })

    expect(resolveThirdPartyComposerLaunchModel(cfg, "sonnet[1m]")).toBe(
      "claude-sonnet-4-5[1m]"
    )
    expect(resolveThirdPartyComposerLaunchModel(cfg, "opus[1m]")).toBe(
      "claude-opus-4-8[1m]"
    )
    expect(resolveThirdPartyComposerLaunchModel(cfg, "fable[1m]")).toBe(
      "claude-fable-5[1m]"
    )
  })

  it("maps the Default 1M Composer role to the configured launch model", () => {
    const cfg = makeConfig({
      mainAlias: "sonnet",
      models: {
        mainModel: "claude-opus-4-8",
        haikuModel: "claude-3-5-haiku",
        sonnetModel: "claude-sonnet-4-5[1m]",
        opusModel: "claude-opus-4-8",
        fableModel: "claude-fable-5[1m]",
        subagentModel: "claude-3-5-haiku"
      },
      modelSupports1m: {
        sonnet: true,
        opus: true,
        fable: true
      }
    })

    expect(resolveThirdPartyDefaultComposerModel(cfg)).toBe("opus[1m]")
    expect(resolveThirdPartyDefaultLaunchModel(cfg)).toBe(
      "claude-opus-4-8[1m]"
    )
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
