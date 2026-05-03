import {
  keychainAvailable,
  keychainDelete,
  keychainGet,
  keychainSet
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
export type ClaudeModelAlias = "sonnet" | "opus" | "haiku"

export interface ModelMapping {
  mainModel: string
  haikuModel: string
  sonnetModel: string
  opusModel: string
  subagentModel: string
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
  mainAlias: ClaudeModelAlias
  availableModels: string[]
  models: ModelMapping
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
  mainAlias: "sonnet",
  availableModels: [],
  models: {
    mainModel: "",
    haikuModel: "",
    sonnetModel: "",
    opusModel: "",
    subagentModel: ""
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
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "CLAUDINAL_PROXY_TARGET_URL",
  "CLAUDINAL_PROXY_API_KEY",
  "CLAUDINAL_PROXY_AUTH_FIELD",
  "CLAUDINAL_PROXY_USE_FULL_URL",
  "CLAUDINAL_PROXY_MAIN_MODEL",
  "CLAUDINAL_PROXY_HAIKU_MODEL",
  "CLAUDINAL_PROXY_SONNET_MODEL",
  "CLAUDINAL_PROXY_OPUS_MODEL",
  "CLAUDINAL_PROXY_AVAILABLE_MODELS"
]

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

function asClaudeModelAlias(value: unknown): ClaudeModelAlias | null {
  if (value === "opus" || value === "haiku" || value === "sonnet") return value
  return null
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
  return Array.from(new Set(out))
}

function inferMainAlias(models: Partial<ModelMapping>): ClaudeModelAlias {
  const mainModel = cleanString(models.mainModel).trim()
  if (mainModel && mainModel === cleanString(models.opusModel).trim()) return "opus"
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
    mainAlias: asClaudeModelAlias(raw?.mainAlias) ?? inferMainAlias(models),
    availableModels: cleanStringArray(raw?.availableModels),
    models: {
      mainModel: cleanString(models.mainModel),
      haikuModel: cleanString(models.haikuModel),
      sonnetModel: cleanString(models.sonnetModel),
      opusModel: cleanString(models.opusModel),
      subagentModel: cleanString(models.subagentModel)
    }
  }
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
    store.providers.map(async (provider) => {
      // 先有明文（legacy / keychain 不可用）就保留，不再去 keychain 读，避免覆盖
      if (provider.apiKey) return provider
      let secret = ""
      try {
        secret = (await keychainGet(keychainAccountForProvider(provider.id))) ?? ""
      } catch {
        secret = ""
      }
      return secret ? { ...provider, apiKey: secret, legacyApiKey: false } : provider
    })
  )
  return { ...store, providers }
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
      models: { ...DEFAULT_THIRD_PARTY_API.models }
    }
  }
  const active = store.providers.find((p) => p.id === store.activeProviderId)
  if (!active) {
    return {
      ...DEFAULT_THIRD_PARTY_API,
      enabled: false,
      models: { ...DEFAULT_THIRD_PARTY_API.models }
    }
  }
  return { ...normalizeThirdPartyApiConfig(active), enabled: true }
}

export async function loadThirdPartyApiConfigAsync(): Promise<ThirdPartyApiConfig> {
  const store = await loadThirdPartyApiStoreAsync()
  if (store.activeProviderId === OFFICIAL_PROVIDER_ID) {
    return {
      ...DEFAULT_THIRD_PARTY_API,
      enabled: false,
      models: { ...DEFAULT_THIRD_PARTY_API.models }
    }
  }
  const active = store.providers.find((p) => p.id === store.activeProviderId)
  if (!active) {
    return {
      ...DEFAULT_THIRD_PARTY_API,
      enabled: false,
      models: { ...DEFAULT_THIRD_PARTY_API.models }
    }
  }
  return { ...normalizeThirdPartyApiConfig(active), enabled: true }
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
  const subagentModel = config.models.subagentModel.trim()
  const availableModels = config.availableModels
    .map((model) => model.trim())
    .filter(Boolean)

  next.ANTHROPIC_AUTH_TOKEN = "claudinal-proxy"
  if (baseUrl) next.CLAUDINAL_PROXY_TARGET_URL = baseUrl
  if (apiKey) next.CLAUDINAL_PROXY_API_KEY = apiKey
  next.CLAUDINAL_PROXY_AUTH_FIELD = config.authField
  next.CLAUDINAL_PROXY_USE_FULL_URL = config.useFullUrl ? "1" : "0"
  if (mainModel) {
    next.ANTHROPIC_MODEL = mainModel
    next.CLAUDINAL_PROXY_MAIN_MODEL = mainModel
  }
  if (haikuModel) {
    next.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel
    next.CLAUDINAL_PROXY_HAIKU_MODEL = haikuModel
  }
  if (sonnetModel) {
    next.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel
    next.CLAUDINAL_PROXY_SONNET_MODEL = sonnetModel
  }
  if (opusModel) {
    next.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel
    next.CLAUDINAL_PROXY_OPUS_MODEL = opusModel
  }
  if (availableModels.length > 0) {
    next.CLAUDINAL_PROXY_AVAILABLE_MODELS = JSON.stringify(availableModels)
  }
  if (subagentModel) next.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel

  return next
}

export function providerModelOptions(
  provider: Pick<ThirdPartyApiConfig, "availableModels" | "models">
): string[] {
  const values = [
    ...provider.availableModels,
    provider.models.mainModel,
    provider.models.haikuModel,
    provider.models.sonnetModel,
    provider.models.opusModel,
    provider.models.subagentModel
  ]
    .map((value) => value.trim())
    .filter(Boolean)
  return Array.from(new Set(values))
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
