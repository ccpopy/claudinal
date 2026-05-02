import { emitSettingsBus } from "@/lib/settingsBus"

const KEY = "claudinal.third-party-api"

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

function hasProviderContent(provider: ThirdPartyApiProvider): boolean {
  const requestUrl = provider.requestUrl.trim()
  return Boolean(
    provider.apiKey.trim() ||
      (requestUrl && provider.models.mainModel.trim())
  )
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
  return {
    id: patch.id || providerId(),
    ...normalizeThirdPartyApiConfig({
      ...DEFAULT_THIRD_PARTY_API,
      ...patch
    })
  }
}

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

export function saveThirdPartyApiStore(store: ThirdPartyApiStore) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
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

export function saveThirdPartyApiConfig(config: ThirdPartyApiConfig) {
  const provider = createThirdPartyApiProvider(config)
  saveThirdPartyApiStore({
    activeProviderId: provider.id,
    providers: [provider]
  })
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
