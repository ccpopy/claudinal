const KEY = "claudinal.third-party-api"

export type ProviderInputFormat = "anthropic" | "openai-chat-completions"
export type ProviderAuthField = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY"
export type ClaudeModelAlias = "sonnet" | "opus" | "haiku"

export interface ModelMapping {
  mainModel: string
  thinkingModel: string
  haikuModel: string
  sonnetModel: string
  opusModel: string
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

const CLAUDE_MODEL_OVERRIDE_KEYS: Record<ClaudeModelAlias, string[]> = {
  opus: [
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-opus-4-1-20250805",
    "claude-opus-4-20250514"
  ],
  sonnet: [
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-20250219"
  ],
  haiku: ["claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022"]
}

export const DEFAULT_THIRD_PARTY_API: ThirdPartyApiConfig = {
  enabled: true,
  providerName: "",
  remark: "",
  officialUrl: "",
  apiKey: "",
  requestUrl: "",
  useFullUrl: true,
  inputFormat: "anthropic",
  authField: "ANTHROPIC_AUTH_TOKEN",
  mainAlias: "sonnet",
  models: {
    mainModel: "",
    thinkingModel: "",
    haikuModel: "",
    sonnetModel: "",
    opusModel: ""
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
  "CLAUDINAL_PROXY_OPUS_MODEL"
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

function inferMainAlias(models: Partial<ModelMapping>): ClaudeModelAlias {
  const mainModel = cleanString(models.mainModel).trim()
  if (mainModel && mainModel === cleanString(models.opusModel).trim()) return "opus"
  if (mainModel && mainModel === cleanString(models.haikuModel).trim()) return "haiku"
  return "sonnet"
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
    models: {
      mainModel: cleanString(models.mainModel),
      thinkingModel: cleanString(models.thinkingModel),
      haikuModel: cleanString(models.haikuModel),
      sonnetModel: cleanString(models.sonnetModel),
      opusModel: cleanString(models.opusModel)
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
        const activeProviderId =
          typeof obj.activeProviderId === "string"
            ? obj.activeProviderId
            : providers[0]?.id ?? OFFICIAL_PROVIDER_ID
        return {
          activeProviderId,
          providers
        }
      }
      const migrated = createThirdPartyApiProvider(
        parsed as Partial<ThirdPartyApiProvider>
      )
      const hasProvider =
        migrated.providerName.trim() ||
        migrated.requestUrl.trim() ||
        migrated.apiKey.trim() ||
        migrated.models.mainModel.trim()
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
  const next = { ...(overrides ?? {}) }
  for (const keys of Object.values(CLAUDE_MODEL_OVERRIDE_KEYS)) {
    for (const key of keys) delete next[key]
  }
  return next
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

  next.ANTHROPIC_AUTH_TOKEN = "claudinal-proxy"
  if (baseUrl) next.CLAUDINAL_PROXY_TARGET_URL = baseUrl
  if (apiKey) next.CLAUDINAL_PROXY_API_KEY = apiKey
  next.CLAUDINAL_PROXY_AUTH_FIELD = config.authField
  next.CLAUDINAL_PROXY_USE_FULL_URL = config.useFullUrl ? "1" : "0"
  if (mainModel) next.CLAUDINAL_PROXY_MAIN_MODEL = mainModel

  return next
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
