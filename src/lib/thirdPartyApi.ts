import {
  keychainAvailable,
  keychainDelete,
  keychainGet,
  keychainSet,
  readClaudeSettings,
  writeClaudeSettings
} from "@/lib/ipc"
import { emitSettingsBus } from "@/lib/settingsBus"

const KEY = "claudinal.third-party-api"
// keychain 条目 account 前缀；service 在 Rust 侧固定为 "claudinal"
const KEYCHAIN_ACCOUNT_PREFIX = "third-party-api.api-key:"

function keychainAccountForProvider(providerId: string): string {
  return `${KEYCHAIN_ACCOUNT_PREFIX}${providerId}`
}

export type ProviderInputFormat = "anthropic" | "openai-chat-completions"
export type ProviderAuthField = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY"
export type ProviderRoutingMode = "direct" | "proxy"
export type ClaudeModelAlias = "sonnet" | "opus" | "fable" | "haiku"

export interface ModelMapping {
  mainModel: string
  haikuModel: string
  sonnetModel: string
  opusModel: string
  fableModel: string
  subagentModel: string
}

export interface ModelSupports1mMapping {
  sonnet: boolean
  opus: boolean
  fable: boolean
}

export interface ThirdPartyApiConfig {
  enabled: boolean
  providerName: string
  remark: string
  officialUrl: string
  apiKey: string
  requestUrl: string
  useFullUrl: boolean
  inputFormat: ProviderInputFormat
  authField: ProviderAuthField
  routingMode: ProviderRoutingMode
  cacheHitOptimizationEnabled: boolean
  enablePromptCaching1h: boolean
  cchRewriteEnabled: boolean
  cchSeed: string
  disableTelemetry: boolean
  hideAiAttribution: boolean
  agentTeamsEnabled: boolean
  toolSearchEnabled: boolean
  maxThinkingEnabled: boolean
  mainAlias: ClaudeModelAlias
  availableModels: string[]
  models: ModelMapping
  modelSupports1m: ModelSupports1mMapping
  runtimeSettingsJson: string
}

export interface ThirdPartyApiProvider extends ThirdPartyApiConfig {
  id: string
  /** apiKey 仍以明文形式存放在 localStorage（旧版或 keychain 不可用时的降级路径）。
   * keychain 写入成功后该标记会被清理；UI 可据此显示明文存储警告。 */
  legacyApiKey?: boolean
}

export interface ThirdPartyApiStore {
  activeProviderId: string
  providers: ThirdPartyApiProvider[]
}

export const OFFICIAL_PROVIDER_ID = "official"

export const DEFAULT_THIRD_PARTY_API: ThirdPartyApiConfig = {
  enabled: true,
  providerName: "",
  remark: "",
  officialUrl: "",
  apiKey: "",
  requestUrl: "",
  useFullUrl: false,
  inputFormat: "anthropic",
  authField: "ANTHROPIC_AUTH_TOKEN",
  routingMode: "direct",
  cacheHitOptimizationEnabled: true,
  enablePromptCaching1h: true,
  cchRewriteEnabled: false,
  cchSeed: "",
  disableTelemetry: false,
  hideAiAttribution: false,
  agentTeamsEnabled: false,
  toolSearchEnabled: false,
  maxThinkingEnabled: false,
  mainAlias: "sonnet",
  availableModels: [],
  runtimeSettingsJson: "",
  models: {
    mainModel: "",
    haikuModel: "",
    sonnetModel: "",
    opusModel: "",
    fableModel: "",
    subagentModel: ""
  },
  modelSupports1m: {
    sonnet: false,
    opus: false,
    fable: false
  }
}

export const DEFAULT_THIRD_PARTY_API_STORE: ThirdPartyApiStore = {
  activeProviderId: OFFICIAL_PROVIDER_ID,
  providers: []
}

const MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "DISABLE_TELEMETRY",
  "ENABLE_PROMPT_CACHING_1H",
  "ENABLE_TOOL_SEARCH",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "CLAUDINAL_PROXY_TARGET_URL",
  "CLAUDINAL_PROXY_API_KEY",
  "CLAUDINAL_PROXY_INPUT_FORMAT",
  "CLAUDINAL_PROXY_AUTH_FIELD",
  "CLAUDINAL_PROXY_USE_FULL_URL",
  "CLAUDINAL_PROXY_OPENAI_REASONING_EFFORT",
  "CLAUDINAL_PROXY_MAIN_MODEL",
  "CLAUDINAL_PROXY_HAIKU_MODEL",
  "CLAUDINAL_PROXY_SONNET_MODEL",
  "CLAUDINAL_PROXY_OPUS_MODEL",
  "CLAUDINAL_PROXY_FABLE_MODEL",
  "CLAUDINAL_PROXY_AVAILABLE_MODELS",
  "CLAUDINAL_PROXY_CCH_SEED",
  "CLAUDINAL_RUNTIME_SETTINGS_JSON"
]

export const CLAUDINAL_RUNTIME_SETTINGS_JSON_ENV_KEY =
  "CLAUDINAL_RUNTIME_SETTINGS_JSON"

const EMPTY_ATTRIBUTION_SETTINGS = {
  commit: "",
  pr: ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeEnvRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string"
    })
  )
}

function hasClaudinalManagedThirdPartyEnv(
  env: Record<string, string> | undefined
): boolean {
  if (!env) return false
  return (
    env.ANTHROPIC_AUTH_TOKEN === "claudinal-proxy" ||
    Object.keys(env).some((key) => key.startsWith("CLAUDINAL_PROXY_"))
  )
}

function asInputFormat(value: unknown): ProviderInputFormat {
  return value === "openai-chat-completions"
    ? "openai-chat-completions"
    : "anthropic"
}

function asAuthField(value: unknown): ProviderAuthField {
  return value === "ANTHROPIC_API_KEY"
    ? "ANTHROPIC_API_KEY"
    : "ANTHROPIC_AUTH_TOKEN"
}

function asRoutingMode(value: unknown): ProviderRoutingMode {
  return value === "proxy" ? "proxy" : "direct"
}

function asClaudeModelAlias(value: unknown): ClaudeModelAlias | null {
  if (
    value === "opus" ||
    value === "fable" ||
    value === "haiku" ||
    value === "sonnet"
  ) {
    return value
  }
  return null
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function cleanBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function cleanOptionalBoolean(
  value: unknown,
  fallback: boolean | undefined
): boolean | undefined {
  return typeof value === "boolean" ? value : fallback
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
  return Array.from(new Set(out))
}

function runtimeProfileHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const THIRD_PARTY_CONNECTION_PROFILE_PREFIX = "third-party-connection:"
const THIRD_PARTY_RUNTIME_PROFILE_PREFIX = "third-party:"

function providerProfileId(config: ThirdPartyApiConfig & { id?: string }): string {
  return cleanString(config.id).trim() || "active"
}

type ThirdPartyRoutingConfig = Pick<
  ThirdPartyApiConfig,
  | "routingMode"
  | "inputFormat"
  | "useFullUrl"
  | "cacheHitOptimizationEnabled"
  | "cchRewriteEnabled"
>

export function thirdPartyApiRequiresLocalProxy(
  config: Pick<
    ThirdPartyApiConfig,
    | "inputFormat"
    | "useFullUrl"
    | "cacheHitOptimizationEnabled"
    | "cchRewriteEnabled"
  >
): boolean {
  return (
    config.inputFormat === "openai-chat-completions" ||
    config.useFullUrl ||
    (!config.cacheHitOptimizationEnabled && config.cchRewriteEnabled)
  )
}

export function thirdPartyApiRoutingMode(
  config: ThirdPartyRoutingConfig
): ProviderRoutingMode {
  if (thirdPartyApiRequiresLocalProxy(config)) return "proxy"
  return config.routingMode === "proxy" ? "proxy" : "direct"
}

export function thirdPartyApiUsesLocalProxy(
  config: ThirdPartyRoutingConfig
): boolean {
  return thirdPartyApiRoutingMode(config) === "proxy"
}

function thirdPartyProviderIdFromProfileKey(key: string | null): string | null {
  if (!key) return null
  const prefix = key.startsWith(THIRD_PARTY_CONNECTION_PROFILE_PREFIX)
    ? THIRD_PARTY_CONNECTION_PROFILE_PREFIX
    : key.startsWith(THIRD_PARTY_RUNTIME_PROFILE_PREFIX)
      ? THIRD_PARTY_RUNTIME_PROFILE_PREFIX
      : null
  if (!prefix) return null
  const rest = key.slice(prefix.length)
  const encodedProviderId = rest.split(":", 1)[0]
  if (!encodedProviderId) return null
  try {
    return decodeURIComponent(encodedProviderId)
  } catch {
    return encodedProviderId
  }
}

export function thirdPartyApiConnectionProfileKey(
  config: ThirdPartyApiConfig & { id?: string }
): string {
  if (!config.enabled) return "official"
  const providerId = providerProfileId(config)
  const profile = {
    version: 2,
    providerId,
    requestUrl: trimApiUrl(config.requestUrl),
    inputFormat: config.inputFormat,
    authField: config.authField,
    useFullUrl: config.useFullUrl,
    routingMode: thirdPartyApiRoutingMode(config)
  }
  return `${THIRD_PARTY_CONNECTION_PROFILE_PREFIX}${encodeURIComponent(
    providerId
  )}:${runtimeProfileHash(JSON.stringify(profile))}`
}

export function thirdPartyApiRuntimeProfileKey(
  config: ThirdPartyApiConfig & { id?: string }
): string {
  if (!config.enabled) return "official"
  const providerId = providerProfileId(config)
  const profile = {
    version: 6,
    providerId,
    requestUrl: trimApiUrl(config.requestUrl),
    inputFormat: config.inputFormat,
    authField: config.authField,
    useFullUrl: config.useFullUrl,
    routingMode: thirdPartyApiRoutingMode(config),
    cacheHitOptimizationEnabled: config.cacheHitOptimizationEnabled,
    enablePromptCaching1h: config.enablePromptCaching1h,
    cchRewriteEnabled: config.cchRewriteEnabled,
    cchSeed: config.cchSeed.trim(),
    disableTelemetry: config.disableTelemetry,
    hideAiAttribution: config.hideAiAttribution,
    agentTeamsEnabled: config.agentTeamsEnabled,
    toolSearchEnabled: config.toolSearchEnabled,
    maxThinkingEnabled: config.maxThinkingEnabled,
    mainAlias: config.mainAlias,
    models: {
      mainModel: config.models.mainModel.trim(),
      haikuModel: config.models.haikuModel.trim(),
      sonnetModel: config.models.sonnetModel.trim(),
      opusModel: config.models.opusModel.trim(),
      fableModel: config.models.fableModel.trim(),
      subagentModel: config.models.subagentModel.trim()
    },
    modelSupports1m: {
      sonnet: config.modelSupports1m.sonnet,
      opus: config.modelSupports1m.opus,
      fable: config.modelSupports1m.fable
    },
    availableModels: config.availableModels
      .map((model) => model.trim())
      .filter(Boolean),
    runtimeSettingsJson: config.runtimeSettingsJson.trim()
  }
  return `third-party:${encodeURIComponent(providerId)}:${runtimeProfileHash(
    JSON.stringify(profile)
  )}`
}

/**
 * 旧会话能否带着当前 API 配置直接 `--resume`。
 * `claude --resume` 重放的是本地 jsonl，对端点 / 密钥 / 模型映射没有技术依赖，
 * 因此第三方场景只要求归属同一供应商条目（providerId 相等）即可续——
 * 请求地址、apiKey、协议、鉴权字段等连接细节变化不作废历史会话。
 * 跨供应商、官方与第三方互切、旧会话无归属记录时返回 false，由调用方决定如何处理。
 */
export function shouldResumeWithApiProfile(
  storedProfileKey: string | null,
  currentProfileKey: string
): boolean {
  const stored = storedProfileKey?.trim() || null
  if (currentProfileKey === "official") {
    return !stored || stored === "official"
  }
  const currentProviderId = thirdPartyProviderIdFromProfileKey(currentProfileKey)
  const storedProviderId = thirdPartyProviderIdFromProfileKey(stored)
  if (!currentProviderId || !storedProviderId) return false
  return storedProviderId === currentProviderId
}

export function canUseApiProfileLaunchPrefs(
  storedProfileKey: string | null,
  currentProfileKey: string
): boolean {
  const stored = storedProfileKey?.trim() || null
  if (currentProfileKey === "official") {
    return !stored || stored === "official"
  }
  return stored === currentProfileKey
}

function inferMainAlias(models: Partial<ModelMapping>): ClaudeModelAlias {
  const mainModel = cleanString(models.mainModel).trim()
  if (mainModel && mainModel === cleanString(models.opusModel).trim()) return "opus"
  if (mainModel && mainModel === cleanString(models.fableModel).trim()) return "fable"
  if (mainModel && mainModel === cleanString(models.haikuModel).trim()) return "haiku"
  return "sonnet"
}

/**
 * 一个 provider 是否非空（用于过滤未填写的草稿）。
 * keychain 模式下 apiKey 不存 localStorage，所以只要还有请求地址就算有内容。
 */
function hasProviderContent(provider: ThirdPartyApiProvider): boolean {
  const requestUrl = provider.requestUrl.trim()
  return Boolean(provider.apiKey.trim() || requestUrl)
}

export function normalizeThirdPartyApiConfig(
  raw: Partial<ThirdPartyApiConfig> | null | undefined
): ThirdPartyApiConfig {
  const models: Partial<ModelMapping> = raw?.models ?? {}
  const modelSupports1m: Partial<ModelSupports1mMapping> =
    raw?.modelSupports1m ?? {}
  const legacy = raw as
    | (Partial<ThirdPartyApiConfig> & {
        disableAttributionHeader?: unknown
      })
    | null
    | undefined
  const cacheHitOptimizationEnabled =
    cleanOptionalBoolean(raw?.cacheHitOptimizationEnabled, undefined) ??
    cleanBoolean(
      legacy?.disableAttributionHeader,
      DEFAULT_THIRD_PARTY_API.cacheHitOptimizationEnabled
    )
  return {
    ...DEFAULT_THIRD_PARTY_API,
    ...(raw ?? {}),
    providerName: cleanString(raw?.providerName),
    remark: cleanString(raw?.remark),
    officialUrl: cleanString(raw?.officialUrl),
    apiKey: cleanString(raw?.apiKey),
    requestUrl: cleanString(raw?.requestUrl),
    inputFormat: asInputFormat(raw?.inputFormat),
    authField: asAuthField(raw?.authField),
    routingMode: asRoutingMode(raw?.routingMode),
    cacheHitOptimizationEnabled,
    enablePromptCaching1h: cleanBoolean(
      raw?.enablePromptCaching1h,
      DEFAULT_THIRD_PARTY_API.enablePromptCaching1h
    ),
    cchRewriteEnabled: cleanBoolean(
      raw?.cchRewriteEnabled,
      DEFAULT_THIRD_PARTY_API.cchRewriteEnabled
    ),
    cchSeed: cleanString(raw?.cchSeed),
    disableTelemetry: cleanBoolean(
      raw?.disableTelemetry,
      DEFAULT_THIRD_PARTY_API.disableTelemetry
    ),
    hideAiAttribution: cleanBoolean(
      raw?.hideAiAttribution,
      DEFAULT_THIRD_PARTY_API.hideAiAttribution
    ),
    agentTeamsEnabled: cleanBoolean(
      raw?.agentTeamsEnabled,
      DEFAULT_THIRD_PARTY_API.agentTeamsEnabled
    ),
    toolSearchEnabled: cleanBoolean(
      raw?.toolSearchEnabled,
      DEFAULT_THIRD_PARTY_API.toolSearchEnabled
    ),
    maxThinkingEnabled: cleanBoolean(
      raw?.maxThinkingEnabled,
      DEFAULT_THIRD_PARTY_API.maxThinkingEnabled
    ),
    mainAlias: asClaudeModelAlias(raw?.mainAlias) ?? inferMainAlias(models),
    availableModels: cleanStringArray(raw?.availableModels),
    runtimeSettingsJson: cleanString(raw?.runtimeSettingsJson),
    models: {
      mainModel: cleanString(models.mainModel),
      haikuModel: cleanString(models.haikuModel),
      sonnetModel: cleanString(models.sonnetModel),
      opusModel: cleanString(models.opusModel),
      fableModel: cleanString(models.fableModel),
      subagentModel: cleanString(models.subagentModel)
    },
    modelSupports1m: {
      sonnet: cleanBoolean(
        modelSupports1m.sonnet,
        DEFAULT_THIRD_PARTY_API.modelSupports1m.sonnet
      ),
      opus: cleanBoolean(
        modelSupports1m.opus,
        DEFAULT_THIRD_PARTY_API.modelSupports1m.opus
      ),
      fable: cleanBoolean(
        modelSupports1m.fable,
        DEFAULT_THIRD_PARTY_API.modelSupports1m.fable
      )
    }
  }
}

export function parseRuntimeSettingsJson(
  raw: string
): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`运行时 settings JSON 无效：${String(error)}`)
  }
  if (!isRecord(parsed)) {
    throw new Error("运行时 settings 必须是 JSON 对象")
  }
  validateRuntimeSettingsEnv(parsed.env)
  return parsed
}

function validateRuntimeSettingsEnv(value: unknown): void {
  if (value == null) return
  if (!isRecord(value)) {
    throw new Error("运行时 settings.env 必须是对象")
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`运行时 settings.env.${key} 必须是字符串`)
    }
    if (MANAGED_ENV_KEYS.includes(key)) {
      throw new Error(
        `运行时 settings.env.${key} 由 Claudinal 管理，请使用对应供应商字段配置`
      )
    }
  }
}

function mergeRuntimeSettingsEnv(
  settings: Record<string, unknown>,
  env: Record<string, string>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...settings }
  const userEnv = isRecord(settings.env)
    ? Object.fromEntries(
        Object.entries(settings.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {}
  const mergedEnv = { ...userEnv, ...env }
  if (Object.keys(mergedEnv).length > 0) {
    next.env = mergedEnv
  } else {
    delete next.env
  }
  return next
}

function ensureRuntimeSettingNotManaged(
  settings: Record<string, unknown>,
  key: string,
  owner: string
): void {
  if (!Object.prototype.hasOwnProperty.call(settings, key)) return
  throw new Error(
    `运行时 settings.${key} 由 Claudinal 的“${owner}”开关管理，请移除手写配置或关闭该开关`
  )
}

function buildRuntimeSettingsExtra(
  config: ThirdPartyApiConfig
): Record<string, unknown> {
  const settings = parseRuntimeSettingsJson(config.runtimeSettingsJson)
  const next: Record<string, unknown> = { ...settings }
  if (config.hideAiAttribution) {
    ensureRuntimeSettingNotManaged(next, "attribution", "隐藏 AI 署名")
    next.attribution = { ...EMPTY_ATTRIBUTION_SETTINGS }
  }
  return next
}

export function buildClaudeRuntimeSettingsPreview(
  config: ThirdPartyApiConfig,
  existingEnv?: Record<string, string>
): Record<string, unknown> {
  const settings = buildRuntimeSettingsExtra(config)
  return mergeRuntimeSettingsEnv(settings, buildClaudeEnv(config, existingEnv))
}

function providerId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function createThirdPartyApiProvider(
  patch: Partial<ThirdPartyApiProvider> = {}
): ThirdPartyApiProvider {
  const provider: ThirdPartyApiProvider = {
    id: patch.id || providerId(),
    ...normalizeThirdPartyApiConfig({
      ...DEFAULT_THIRD_PARTY_API,
      ...patch
    })
  }
  if (patch.legacyApiKey) provider.legacyApiKey = true
  return provider
}

/**
 * 同步加载：apiKey 字段仅来自 localStorage 中遗留的明文（旧版本 / keychain 不可用降级）。
 * keychain 模式下密钥不会出现在同步路径，spawn 等需要密钥的场景必须使用 `loadThirdPartyApiStoreAsync`。
 */
export function loadThirdPartyApiStore(): ThirdPartyApiStore {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_THIRD_PARTY_API_STORE, providers: [] }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as {
        activeProviderId?: unknown
        providers?: unknown
      }
      if (Array.isArray(obj.providers)) {
        const providers = obj.providers
          .filter((p): p is Partial<ThirdPartyApiProvider> => {
            return !!p && typeof p === "object" && !Array.isArray(p)
          })
          .map((p) => createThirdPartyApiProvider(p))
          .filter(hasProviderContent)
        const storedActiveId =
          typeof obj.activeProviderId === "string"
            ? obj.activeProviderId
            : OFFICIAL_PROVIDER_ID
        const activeProviderId =
          storedActiveId === OFFICIAL_PROVIDER_ID ||
          providers.some((provider) => provider.id === storedActiveId)
            ? storedActiveId
            : OFFICIAL_PROVIDER_ID
        return {
          activeProviderId,
          providers
        }
      }
      const migrated = createThirdPartyApiProvider(
        parsed as Partial<ThirdPartyApiProvider>
      )
      const hasProvider = hasProviderContent(migrated)
      return {
        activeProviderId: hasProvider ? migrated.id : OFFICIAL_PROVIDER_ID,
        providers: hasProvider ? [migrated] : []
      }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_THIRD_PARTY_API_STORE, providers: [] }
}

/**
 * 异步加载：同步读 localStorage 框架后用 keychain 填回每个 provider 的 apiKey。
 * keychain 不可用或某个条目读取失败时，回退到 localStorage 中遗留的明文。
 */
export async function loadThirdPartyApiStoreAsync(): Promise<ThirdPartyApiStore> {
  const store = loadThirdPartyApiStore()
  let kcOk = false
  try {
    kcOk = await keychainAvailable()
  } catch {
    kcOk = false
  }
  if (!kcOk) return store
  const providers = await Promise.all(
    store.providers.map((provider) => hydrateProviderApiKey(provider, kcOk))
  )
  return { ...store, providers }
}

async function hydrateProviderApiKey(
  provider: ThirdPartyApiProvider,
  keychainReady: boolean
): Promise<ThirdPartyApiProvider> {
  // 先有明文（legacy / keychain 不可用）就保留，不再去 keychain 读，避免覆盖
  if (provider.apiKey || !keychainReady) return provider
  let secret = ""
  try {
    secret = (await keychainGet(keychainAccountForProvider(provider.id))) ?? ""
  } catch {
    secret = ""
  }
  return secret ? { ...provider, apiKey: secret, legacyApiKey: false } : provider
}

interface PersistResult {
  stored: "keychain" | "localstorage" | "empty"
  legacyProviderIds: string[]
}

/**
 * 写入：keychain 可用时把每个 provider 的 apiKey 送进 keychain，localStorage 中清空 apiKey 字段。
 * keychain 不可用或单条失败：apiKey 写回 localStorage 并标 `legacyApiKey: true`，UI 据此显示明文存储警告。
 */
export async function saveThirdPartyApiStoreAsync(
  store: ThirdPartyApiStore
): Promise<PersistResult> {
  let kcOk = false
  try {
    kcOk = await keychainAvailable()
  } catch {
    kcOk = false
  }
  const persisted: ThirdPartyApiProvider[] = []
  const legacyIds: string[] = []
  let hasSecret = false
  for (const provider of store.providers) {
    const sanitized: ThirdPartyApiProvider = { ...provider, legacyApiKey: false }
    const secret = provider.apiKey.trim()
    if (kcOk) {
      try {
        if (secret) {
          await keychainSet(keychainAccountForProvider(provider.id), provider.apiKey)
          sanitized.apiKey = ""
          hasSecret = true
        } else {
          await keychainDelete(keychainAccountForProvider(provider.id))
          sanitized.apiKey = ""
        }
      } catch {
        // 单条 keychain 失败 → 单条降级
        sanitized.apiKey = provider.apiKey
        sanitized.legacyApiKey = secret ? true : false
        if (secret) legacyIds.push(provider.id)
      }
    } else if (secret) {
      sanitized.apiKey = provider.apiKey
      sanitized.legacyApiKey = true
      legacyIds.push(provider.id)
    } else {
      sanitized.apiKey = ""
    }
    persisted.push(sanitized)
  }
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        activeProviderId: store.activeProviderId,
        providers: persisted
      })
    )
    emitSettingsBus("thirdPartyApi")
  } catch {
    // ignore
  }
  if (legacyIds.length > 0) {
    return { stored: "localstorage", legacyProviderIds: legacyIds }
  }
  if (hasSecret) {
    return { stored: "keychain", legacyProviderIds: [] }
  }
  return { stored: "empty", legacyProviderIds: [] }
}

/**
 * 同步保存：仅写非敏感字段（apiKey 字段被强制清空）。
 * 用于 settings bus 同步广播或不涉及密钥变更的快速保存。
 * 真正涉及 apiKey 的写入必须走 `saveThirdPartyApiStoreAsync`。
 */
export function saveThirdPartyApiStore(store: ThirdPartyApiStore) {
  try {
    const persisted = store.providers.map((provider) => ({
      ...provider,
      apiKey: provider.legacyApiKey ? provider.apiKey : "",
      legacyApiKey: provider.legacyApiKey ?? false
    }))
    localStorage.setItem(
      KEY,
      JSON.stringify({
        activeProviderId: store.activeProviderId,
        providers: persisted
      })
    )
    emitSettingsBus("thirdPartyApi")
  } catch {
    // ignore
  }
}

export function loadThirdPartyApiConfig(): ThirdPartyApiConfig {
  const store = loadThirdPartyApiStore()
  if (store.activeProviderId === OFFICIAL_PROVIDER_ID) {
    return {
      ...DEFAULT_THIRD_PARTY_API,
      enabled: false,
      models: { ...DEFAULT_THIRD_PARTY_API.models },
      modelSupports1m: { ...DEFAULT_THIRD_PARTY_API.modelSupports1m }
    }
  }
  const active = store.providers.find((p) => p.id === store.activeProviderId)
  if (!active) {
    return {
      ...DEFAULT_THIRD_PARTY_API,
      enabled: false,
      models: { ...DEFAULT_THIRD_PARTY_API.models },
      modelSupports1m: { ...DEFAULT_THIRD_PARTY_API.modelSupports1m }
    }
  }
  return { ...normalizeThirdPartyApiConfig(active), enabled: true }
}

export async function loadThirdPartyApiConfigAsync(): Promise<ThirdPartyApiConfig> {
  const store = loadThirdPartyApiStore()
  if (store.activeProviderId === OFFICIAL_PROVIDER_ID) {
    return {
      ...DEFAULT_THIRD_PARTY_API,
      enabled: false,
      models: { ...DEFAULT_THIRD_PARTY_API.models },
      modelSupports1m: { ...DEFAULT_THIRD_PARTY_API.modelSupports1m }
    }
  }
  const active = store.providers.find((p) => p.id === store.activeProviderId)
  if (!active) {
    return {
      ...DEFAULT_THIRD_PARTY_API,
      enabled: false,
      models: { ...DEFAULT_THIRD_PARTY_API.models },
      modelSupports1m: { ...DEFAULT_THIRD_PARTY_API.modelSupports1m }
    }
  }
  let kcOk = false
  try {
    kcOk = await keychainAvailable()
  } catch {
    kcOk = false
  }
  const hydrated = await hydrateProviderApiKey(active, kcOk)
  return { ...normalizeThirdPartyApiConfig(hydrated), enabled: true }
}

/** 单独删除某个 provider 在 keychain 中的密钥；删 provider 时调用，幂等。 */
export async function deleteProviderApiKey(providerId: string): Promise<void> {
  try {
    await keychainDelete(keychainAccountForProvider(providerId))
  } catch {
    // 静默；keychain 不可用 / 条目不存在都视作完成
  }
}

/**
 * 启动时一次性迁移：把 localStorage 里的明文 apiKey 写进 keychain，并从 localStorage 删除。
 * keychain 不可用 / 单条失败时静默保留旧条目，下次写入仍会重试。
 */
export async function migrateLegacyThirdPartyApiKeys(): Promise<void> {
  const store = loadThirdPartyApiStore()
  const hasLegacy = store.providers.some((p) => p.apiKey && p.apiKey.trim())
  if (!hasLegacy) return
  let kcOk = false
  try {
    kcOk = await keychainAvailable()
  } catch {
    kcOk = false
  }
  if (!kcOk) return
  const persisted: ThirdPartyApiProvider[] = []
  let migrated = false
  for (const provider of store.providers) {
    const secret = provider.apiKey?.trim()
    if (!secret) {
      persisted.push({ ...provider, apiKey: "", legacyApiKey: false })
      continue
    }
    try {
      await keychainSet(keychainAccountForProvider(provider.id), provider.apiKey)
      persisted.push({ ...provider, apiKey: "", legacyApiKey: false })
      migrated = true
    } catch {
      // 单条失败：保留 legacy
      persisted.push({ ...provider, legacyApiKey: true })
    }
  }
  if (migrated) {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          activeProviderId: store.activeProviderId,
          providers: persisted
        })
      )
      emitSettingsBus("thirdPartyApi")
    } catch {
      // ignore
    }
  }
}

export function trimApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

export function clearManagedClaudeEnv(
  env: Record<string, string> | undefined
): Record<string, string> {
  const next = { ...(env ?? {}) }
  for (const key of MANAGED_ENV_KEYS) delete next[key]
  return next
}

/**
 * 旧版第三方 API 会把 Claudinal 代理变量写进 ~/.claude/settings.json。
 * 现在供应商配置只由 Claudinal 管理；这里仅在发现明确的 Claudinal 哨兵变量时清理旧残留。
 */
export async function cleanupManagedGlobalClaudeSettings(): Promise<boolean> {
  const raw = await readClaudeSettings("global")
  if (!isRecord(raw)) return false
  const rawEnv = isRecord(raw.env) ? raw.env : {}
  const env = normalizeEnvRecord(raw.env)
  if (!hasClaudinalManagedThirdPartyEnv(env)) return false

  const next: Record<string, unknown> = { ...raw }
  const cleanedEnv = { ...rawEnv }
  for (const key of MANAGED_ENV_KEYS) delete cleanedEnv[key]
  if (Object.keys(cleanedEnv).length > 0) {
    next.env = cleanedEnv
  } else {
    delete next.env
  }
  await writeClaudeSettings("global", next)
  emitSettingsBus("composerPrefs")
  return true
}

export function clearManagedModelOverrides(
  overrides: Record<string, string> | undefined
): Record<string, string> {
  return { ...(overrides ?? {}) }
}

export function buildModelOverrides(
  config: ThirdPartyApiConfig,
  existingOverrides?: Record<string, string>
): Record<string, string> {
  void config
  return clearManagedModelOverrides(existingOverrides)
}

export function buildClaudeEnv(
  config: ThirdPartyApiConfig,
  existingEnv?: Record<string, string>
): Record<string, string> {
  const next = clearManagedClaudeEnv(existingEnv)
  if (!config.enabled) return next

  const baseUrl = trimApiUrl(config.requestUrl)
  const apiKey = config.apiKey.trim()
  const mainModel = config.models.mainModel.trim()
  const haikuModel = config.models.haikuModel.trim()
  const sonnetModel = config.models.sonnetModel.trim()
  const opusModel = config.models.opusModel.trim()
  const fableModel = config.models.fableModel.trim()
  const subagentModel = config.models.subagentModel.trim()
  const availableModels = config.availableModels
    .map((model) => model.trim())
    .filter(Boolean)
  const useLocalProxy = thirdPartyApiUsesLocalProxy(config)

  if (useLocalProxy) {
    next.ANTHROPIC_AUTH_TOKEN = "claudinal-proxy"
    if (baseUrl) next.CLAUDINAL_PROXY_TARGET_URL = baseUrl
    if (apiKey) next.CLAUDINAL_PROXY_API_KEY = apiKey
    next.CLAUDINAL_PROXY_INPUT_FORMAT = config.inputFormat
    next.CLAUDINAL_PROXY_AUTH_FIELD = config.authField
    next.CLAUDINAL_PROXY_USE_FULL_URL = config.useFullUrl ? "1" : "0"
  } else {
    if (baseUrl) next.ANTHROPIC_BASE_URL = baseUrl
    if (apiKey) next[config.authField] = apiKey
  }
  if (config.cacheHitOptimizationEnabled) {
    next.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
    next.CLAUDE_CODE_ATTRIBUTION_HEADER = "0"
  } else if (config.cchRewriteEnabled && useLocalProxy) {
    next.CLAUDINAL_PROXY_CCH_SEED = config.cchSeed.trim()
  }
  if (config.disableTelemetry) {
    next.DISABLE_TELEMETRY = "1"
  }
  if (config.enablePromptCaching1h) {
    next.ENABLE_PROMPT_CACHING_1H = "1"
  }
  if (config.agentTeamsEnabled) {
    next.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"
  }
  if (config.toolSearchEnabled) {
    next.ENABLE_TOOL_SEARCH = "true"
  }
  if (config.maxThinkingEnabled) {
    next.CLAUDE_CODE_EFFORT_LEVEL = "max"
  }
  if (mainModel) {
    next.ANTHROPIC_MODEL = mainModel
    if (useLocalProxy) next.CLAUDINAL_PROXY_MAIN_MODEL = mainModel
  }
  if (haikuModel) {
    next.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel
    if (useLocalProxy) next.CLAUDINAL_PROXY_HAIKU_MODEL = haikuModel
  }
  if (sonnetModel) {
    next.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel
    if (useLocalProxy) next.CLAUDINAL_PROXY_SONNET_MODEL = sonnetModel
  }
  if (opusModel) {
    next.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel
    if (useLocalProxy) next.CLAUDINAL_PROXY_OPUS_MODEL = opusModel
  }
  if (useLocalProxy && fableModel) {
    next.CLAUDINAL_PROXY_FABLE_MODEL = fableModel
  }
  if (useLocalProxy && availableModels.length > 0) {
    next.CLAUDINAL_PROXY_AVAILABLE_MODELS = JSON.stringify(availableModels)
  }
  if (subagentModel) next.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel

  return next
}

export function buildClaudeLaunchEnv(
  config: ThirdPartyApiConfig,
  existingEnv?: Record<string, string>
): Record<string, string> {
  const next = buildClaudeEnv(config, existingEnv)
  const runtimeSettings = buildRuntimeSettingsExtra(config)
  if (Object.keys(runtimeSettings).length > 0) {
    next[CLAUDINAL_RUNTIME_SETTINGS_JSON_ENV_KEY] =
      JSON.stringify(runtimeSettings)
  }
  return next
}

function dedupeModelValues(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )
}

function mappedModelValues(
  provider: Pick<ThirdPartyApiConfig, "models">
): string[] {
  return [
    provider.models.mainModel,
    provider.models.haikuModel,
    provider.models.sonnetModel,
    provider.models.opusModel,
    provider.models.fableModel,
    provider.models.subagentModel
  ]
}

export function providerModelOptions(
  provider: Pick<ThirdPartyApiConfig, "models">
): string[] {
  return dedupeModelValues(mappedModelValues(provider))
}

export function providerComposerModelOptions(
  provider: Pick<ThirdPartyApiConfig, "models" | "modelSupports1m">
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = []
  if (provider.models.sonnetModel.trim()) {
    options.push({ value: "sonnet", label: "Sonnet" })
    if (provider.modelSupports1m.sonnet) {
      options.push({ value: "sonnet[1m]", label: "Sonnet 1M" })
    }
  }
  if (provider.models.opusModel.trim()) {
    options.push({ value: "opus", label: "Opus" })
    if (provider.modelSupports1m.opus) {
      options.push({ value: "opus[1m]", label: "Opus 1M" })
    }
  }
  if (provider.models.fableModel.trim()) {
    options.push({ value: "fable", label: "Fable" })
    if (provider.modelSupports1m.fable) {
      options.push({ value: "fable[1m]", label: "Fable 1M" })
    }
  }
  if (provider.models.haikuModel.trim()) {
    options.push({ value: "haiku", label: "Haiku" })
  }
  return options
}

export function resolveThirdPartyDefaultComposerModel(
  provider: Pick<ThirdPartyApiConfig, "models" | "modelSupports1m">
): string {
  const mainModel = provider.models.mainModel.trim()
  if (!mainModel) return ""
  if (
    mainModel === provider.models.opusModel.trim() &&
    provider.modelSupports1m.opus
  ) {
    return "opus[1m]"
  }
  if (
    mainModel === provider.models.fableModel.trim() &&
    provider.modelSupports1m.fable
  ) {
    return "fable[1m]"
  }
  if (
    mainModel === provider.models.sonnetModel.trim() &&
    provider.modelSupports1m.sonnet
  ) {
    return "sonnet[1m]"
  }
  return ""
}

const ONE_MILLION_CONTEXT_SUFFIX = "[1m]"

function hasOneMillionContextSuffix(model: string): boolean {
  return model.trim().toLowerCase().endsWith(ONE_MILLION_CONTEXT_SUFFIX)
}

function preserveComposerContextSuffix(
  mappedModel: string,
  composerModel: string
): string {
  const mapped = mappedModel.trim()
  if (!mapped) return composerModel.trim()
  if (!hasOneMillionContextSuffix(composerModel)) return mapped
  return hasOneMillionContextSuffix(mapped)
    ? mapped
    : `${mapped}${ONE_MILLION_CONTEXT_SUFFIX}`
}

export function resolveThirdPartyComposerLaunchModel(
  provider: Pick<ThirdPartyApiConfig, "models">,
  composerModel: string
): string {
  const model = composerModel.trim()
  if (!model) return ""
  if (model === "sonnet" || model === "sonnet[1m]") {
    return preserveComposerContextSuffix(provider.models.sonnetModel, model)
  }
  if (model === "opus" || model === "opus[1m]") {
    return preserveComposerContextSuffix(provider.models.opusModel, model)
  }
  if (model === "fable" || model === "fable[1m]") {
    return preserveComposerContextSuffix(provider.models.fableModel, model)
  }
  if (model === "haiku") {
    return provider.models.haikuModel.trim() || model
  }
  return model
}

export function resolveThirdPartyDefaultLaunchModel(
  provider: Pick<ThirdPartyApiConfig, "models" | "modelSupports1m">
): string {
  return resolveThirdPartyComposerLaunchModel(
    provider,
    resolveThirdPartyDefaultComposerModel(provider)
  )
}

export function providerModelInputOptions(
  provider: Pick<ThirdPartyApiConfig, "availableModels" | "models">
): string[] {
  return dedupeModelValues([
    ...provider.availableModels,
    ...mappedModelValues(provider)
  ])
}

export function selectClaudeModelAlias(
  config: ThirdPartyApiConfig
): ClaudeModelAlias {
  return config.mainAlias
}

export function selectClaudeStartupModel(config: ThirdPartyApiConfig): string {
  void config
  return ""
}

export function maskSecret(value: string): string {
  if (!value) return ""
  if (value.length <= 12) return "•".repeat(value.length)
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}
