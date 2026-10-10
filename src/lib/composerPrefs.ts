import { readClaudeSettings, writeClaudeSettings } from "@/lib/ipc"
import { emitSettingsBus } from "@/lib/settingsBus"
import type { ClaudeEvent, ContentBlock } from "@/types/events"
import { hasInjectedProvenance } from "./messageOrigin"

// Composer 数据层（重新设计 2026-04-30）：
//
// 核心拆分：
// - **全局默认**（`loadGlobalDefault`）：从 ~/.claude/settings.json + 应用 settings 读取，
//   作为新会话的初始 model/effort。CLI 自己维护 settings.json 的写入（除非用户在 UI 里
//   勾选"同步为全局默认"）。
// - **会话覆盖**（sidecar.composer）：每个会话单独存自己的 model/effort 选择，
//   resume 同一会话时还原；新会话从全局默认起步。由 App.tsx 在 switchSession 时读、
//   在用户切换 Picker 时写（写入路径见 ipc.ts patchSessionSidecar）。
//
// 旧实现遗留：`claudinal.composer.prefs` 是全局共享的 localStorage，会让所有会话误共享
// max 等设置；本版仅做"一次性迁移读取"，读完即删，避免污染。

export interface ComposerPrefs {
  model: string
  effort: string
  ultracode?: boolean
  fastMode?: boolean
  autoCompactWindow?: AutoCompactWindow
  /** In-memory/session overrides, keyed by the selected model. */
  modelEfforts?: Record<string, string>
  modelAutoCompactWindows?: Record<string, AutoCompactWindow>
  modelSettings?: Record<string, ModelComposerSettings>
  settingsSources?: ComposerSettingsLayer[]
  /** Retained for diagnosis; never copy the user legacy value to every model. */
  legacyEffortLevel?: string
  defaultsKnowledge?: "runtime" | "files" | "legacy"
}

export type AutoCompactWindow = "auto" | number
export type PersistedEffort = "low" | "medium" | "high" | "xhigh"
export interface ModelComposerSettings {
  effortLevel?: PersistedEffort
  maxEffortLevel?: PersistedEffort | "max"
  autoCompactWindow?: AutoCompactWindow
}
export type ComposerSettingsScope = "userSettings" | "projectSettings" | "localSettings" | "flagSettings" | "policySettings"
export interface ComposerSettingsLayer {
  source: ComposerSettingsScope
  settings: {
    model?: string
    effortLevel?: PersistedEffort
    maxEffortLevel?: PersistedEffort | "max"
    modelSettings?: Record<string, ModelComposerSettings>
    ultracode?: boolean
    fastMode?: boolean
    autoCompactWindow?: AutoCompactWindow
  }
}
export interface ComposerRuntimeConfig {
  model?: string
  effort?: string
  ultracode?: boolean
  ultracodeRequested?: boolean
  ultracodeAvailable?: boolean
  /** From init fast_mode_state, never inferred from effective.fastMode. */
  fastModeState?: "off" | "cooldown" | "on"
  fastModeDisabledReason?: string
}
export interface ComposerFeatureCapabilities {
  independentUltracode?: boolean
  fastMode?: boolean
  autoCompactWindow?: boolean
  reason?: string
}
export interface ComposerModelCapabilities {
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
}

const PERSISTED_EFFORTS = new Set(["low", "medium", "high", "xhigh"])
const SETTINGS_PRIORITY: Record<ComposerSettingsScope, number> = { userSettings: 1, projectSettings: 2, localSettings: 3, flagSettings: 4, policySettings: 5 }
function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export function parseAutoCompactWindow(value: unknown): AutoCompactWindow | undefined {
  if (value === "auto") return value
  return typeof value === "number" && Number.isInteger(value) && value >= 100_000 && value <= 1_000_000 ? value : undefined
}
function pickModelSettings(raw: unknown): Record<string, ModelComposerSettings> {
  const result: Record<string, ModelComposerSettings> = {}
  for (const [model, value] of Object.entries(objectValue(raw) ?? {})) {
    const entry = objectValue(value)
    if (!entry || !model || /[\0\r\n]/.test(model)) continue
    const setting: ModelComposerSettings = {}
    if (typeof entry.effortLevel === "string" && PERSISTED_EFFORTS.has(entry.effortLevel)) setting.effortLevel = entry.effortLevel as PersistedEffort
    if (typeof entry.maxEffortLevel === "string" && (PERSISTED_EFFORTS.has(entry.maxEffortLevel) || entry.maxEffortLevel === "max")) setting.maxEffortLevel = entry.maxEffortLevel as PersistedEffort | "max"
    const window = parseAutoCompactWindow(entry.autoCompactWindow)
    if (window !== undefined) setting.autoCompactWindow = window
    result[model] = setting
  }
  return result
}
function pickComposerSettings(value: unknown): ComposerSettingsLayer["settings"] {
  const raw = objectValue(value) ?? {}
  const settings: ComposerSettingsLayer["settings"] = {}
  if (typeof raw.model === "string") settings.model = sanitizeComposerModel(raw.model)
  if (typeof raw.effortLevel === "string" && PERSISTED_EFFORTS.has(raw.effortLevel)) settings.effortLevel = raw.effortLevel as PersistedEffort
  if (typeof raw.maxEffortLevel === "string" && (PERSISTED_EFFORTS.has(raw.maxEffortLevel) || raw.maxEffortLevel === "max")) settings.maxEffortLevel = raw.maxEffortLevel as PersistedEffort | "max"
  if (raw.modelSettings !== undefined) settings.modelSettings = pickModelSettings(raw.modelSettings)
  if (typeof raw.ultracode === "boolean") settings.ultracode = raw.ultracode
  if (typeof raw.fastMode === "boolean") settings.fastMode = raw.fastMode
  const window = parseAutoCompactWindow(raw.autoCompactWindow)
  if (window !== undefined) settings.autoCompactWindow = window
  return settings
}

/** Exact native get_settings envelope, distinct from the SDK provenance API. */
export function pickComposerRuntimeSettings(value: unknown): { layers: ComposerSettingsLayer[]; actual: ComposerRuntimeConfig; effective: ComposerSettingsLayer["settings"] } | null {
  const raw = objectValue(value)
  const applied = objectValue(raw?.applied)
  if (!raw || !objectValue(raw.effective) || !Array.isArray(raw.sources) || !applied) return null
  const layers: ComposerSettingsLayer[] = raw.sources.flatMap((value) => {
    const row = objectValue(value)
    if (!row || typeof row.source !== "string" || !Object.hasOwn(SETTINGS_PRIORITY, row.source)) return []
    return [{ source: row.source as ComposerSettingsScope, settings: pickComposerSettings(row.settings) }]
  })
  const actual: ComposerRuntimeConfig = {}
  if (typeof applied.model === "string") actual.model = sanitizeComposerModel(applied.model)
  if (typeof applied.effort === "string") actual.effort = applied.effort
  for (const key of ["ultracode", "ultracodeRequested", "ultracodeAvailable"] as const) if (typeof applied[key] === "boolean") actual[key] = applied[key]
  return { layers, actual, effective: pickComposerSettings(raw.effective) }
}

/** Canonical mappings must come from the CLI/provider owner; never guess an alias generation. */
export function composerModelKey(model: string, canonicalModels?: Readonly<Record<string, string>>): string {
  const selected = sanitizeComposerModel(model)
  return canonicalModels?.[selected] ?? selected.replace(/\[1m\]$/i, "")
}

export function resolveComposerModelDefaults(
  defaults: ComposerPrefs,
  model: string,
  options: { canonicalModels?: Readonly<Record<string, string>>; legacyUserEffortApplies?: boolean } = {}
): { effort: string; autoCompactWindow?: AutoCompactWindow; scope?: ComposerSettingsScope; maxEffortLevel?: string } {
  const key = composerModelKey(model || defaults.model, options.canonicalModels)
  const layers = [...(defaults.settingsSources ?? [])].sort((a, b) => SETTINGS_PRIORITY[b.source] - SETTINGS_PRIORITY[a.source])
  let effort = defaults.modelSettings?.[key]?.effortLevel ?? ""
  let window = defaults.modelSettings?.[key]?.autoCompactWindow
  let scope: ComposerSettingsScope | undefined
  let foundEffort = false
  let foundWindow = false
  let maxEffortLevel: string | undefined
  const rank = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }
  for (const layer of layers) {
    const own = layer.settings.modelSettings?.[key]
    const topApplies = layer.source !== "userSettings" || options.legacyUserEffortApplies === true
    const candidate = own?.effortLevel ?? (topApplies ? layer.settings.effortLevel : undefined)
    if (!foundEffort && candidate !== undefined) { effort = candidate; scope = layer.source; foundEffort = true }
    const ownWindow = own?.autoCompactWindow ?? layer.settings.autoCompactWindow
    if (!foundWindow && ownWindow !== undefined) { window = ownWindow; foundWindow = true }
    const cap = own?.maxEffortLevel ?? layer.settings.maxEffortLevel
    if (cap && (!maxEffortLevel || rank[cap] < rank[maxEffortLevel as keyof typeof rank])) maxEffortLevel = cap
  }
  // A legacy default with no scoped metadata may only apply to its own model.
  if (!layers.length && !effort && model === defaults.model && defaults.effort !== "max" && defaults.effort !== "ultracode") effort = defaults.effort
  return { effort, ...(window !== undefined ? { autoCompactWindow: window } : {}), ...(scope ? { scope } : {}), ...(maxEffortLevel ? { maxEffortLevel } : {}) }
}

export function selectComposerModel(current: ComposerPrefs, model: string, defaults: ComposerPrefs = EMPTY_COMPOSER_PREFS, canonicalModels?: Readonly<Record<string, string>>): ComposerPrefs {
  const selected = sanitizeComposerModel(model)
  const values = resolveComposerModelDefaults(defaults, selected, { canonicalModels })
  const modelEfforts = { ...current.modelEfforts, [current.model]: current.effort }
  const windows = { ...current.modelAutoCompactWindows, ...(current.autoCompactWindow !== undefined ? { [current.model]: current.autoCompactWindow } : {}) }
  return { ...current, model: selected, effort: modelEfforts[selected] ?? values.effort, modelEfforts, autoCompactWindow: windows[selected] ?? values.autoCompactWindow, ...(Object.keys(windows).length ? { modelAutoCompactWindows: windows } : {}) }
}

export function patchComposerPrefs(current: ComposerPrefs, patch: Partial<ComposerPrefs>, defaults: ComposerPrefs = EMPTY_COMPOSER_PREFS, canonicalModels?: Readonly<Record<string, string>>): ComposerPrefs {
  const next = patch.model !== undefined && patch.model !== current.model ? selectComposerModel(current, patch.model, defaults, canonicalModels) : { ...current }
  Object.assign(next, patch)
  if (patch.effort !== undefined) next.modelEfforts = { ...current.modelEfforts, ...patch.modelEfforts, [next.model]: patch.effort }
  if (patch.autoCompactWindow !== undefined) next.modelAutoCompactWindows = { ...current.modelAutoCompactWindows, ...patch.modelAutoCompactWindows, [next.model]: patch.autoCompactWindow }
  return next
}

/** Session sidecars may restore max; permanent defaults must never contain it. */
export function composerPrefsForPersistence(prefs: ComposerPrefs, scope: "session" | "default" = "session"): ComposerPrefs {
  if (scope === "session") return { ...prefs }
  const next = { ...prefs, effort: prefs.effort === "max" ? "" : prefs.effort }
  if (prefs.modelEfforts) next.modelEfforts = Object.fromEntries(Object.entries(prefs.modelEfforts).filter(([, value]) => value !== "max"))
  return next
}

/** 表示 effort 的来源；驱动 UI 的视觉提示 */
export type EffortSource = "session" | "default" | "auto"

export const EMPTY_COMPOSER_PREFS: ComposerPrefs = { model: "", effort: "" }

const LEGACY_KEY = "claudinal.composer.prefs"

export function fallbackComposerPrefsForApiProfile(
  apiProfileKey: string,
  globalDefault: ComposerPrefs
): ComposerPrefs {
  return apiProfileKey === "official" ? globalDefault : EMPTY_COMPOSER_PREFS
}

/**
 * 一次性迁移：把旧 localStorage 里的值读出来当 fallback，然后立刻删除。
 * 仅在没有更优数据源时使用。
 */
function consumeLegacyPrefs(): Partial<ComposerPrefs> | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    localStorage.removeItem(LEGACY_KEY)
    const obj = JSON.parse(raw)
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Partial<ComposerPrefs>
    }
  } catch {
    try {
      localStorage.removeItem(LEGACY_KEY)
    } catch {
      // ignore
    }
  }
  return null
}

/**
 * Read model defaults from an exact runtime source snapshot, or known local files.
 *
 * 注意：settings.json 的 effortLevel 仅接受 low/medium/high/xhigh（官方文档），
 * 故 max 不会出现在这里——max 必须从会话级 sidecar 来。
 */
export async function loadGlobalDefault(cwd?: string, runtimeSettings?: unknown): Promise<ComposerPrefs> {
  const runtime = pickComposerRuntimeSettings(runtimeSettings)
  let layers: ComposerSettingsLayer[]
  let legacyEffortLevel: string | undefined
  if (runtime) {
    layers = runtime.layers
  } else {
    const scopes = cwd ? ["global", "project", "project-local"] as const : ["global"] as const
    const responses = await Promise.allSettled(scopes.map((scope) => readClaudeSettings(scope, cwd)))
    layers = responses.flatMap((response, index) => {
      if (response.status !== "fulfilled" || !response.value) return []
      if (index === 0 && typeof response.value.effortLevel === "string") legacyEffortLevel = response.value.effortLevel
      const source = scopes[index] === "global" ? "userSettings" : scopes[index] === "project" ? "projectSettings" : "localSettings"
      return [{ source, settings: pickComposerSettings(response.value) } as ComposerSettingsLayer]
    })
  }
  if (!layers.length) {
    const legacy = consumeLegacyPrefs()
    return legacy ? { ...composerPrefsForPersistence(normalizeStoredComposerPrefs(legacy), "default"), defaultsKnowledge: "legacy" } : { ...EMPTY_COMPOSER_PREFS, defaultsKnowledge: "files", ...(legacyEffortLevel ? { legacyEffortLevel } : {}) }
  }
  const ordered = [...layers].sort((a, b) => SETTINGS_PRIORITY[a.source] - SETTINGS_PRIORITY[b.source])
  const defaults: ComposerPrefs = { model: "", effort: "", settingsSources: layers, modelSettings: {}, defaultsKnowledge: runtime ? "runtime" : "files", ...(legacyEffortLevel ? { legacyEffortLevel } : {}) }
  for (const layer of ordered) {
    if (layer.settings.model !== undefined) defaults.model = layer.settings.model
    if (layer.settings.ultracode !== undefined) defaults.ultracode = layer.settings.ultracode
    if (layer.settings.fastMode !== undefined) defaults.fastMode = layer.settings.fastMode
    for (const [key, value] of Object.entries(layer.settings.modelSettings ?? {})) defaults.modelSettings![key] = { ...defaults.modelSettings![key], ...value }
  }
  const key = runtime?.actual.model && !defaults.model ? runtime.actual.model : defaults.model
  const values = resolveComposerModelDefaults(defaults, key)
  defaults.effort = values.effort
  if (values.autoCompactWindow !== undefined) defaults.autoCompactWindow = values.autoCompactWindow
  return defaults
}

/**
 * Save only a canonical model's effort in user modelSettings, preserving other keys.
 * 返回 true = 成功；false = 不允许（max/auto/空）。
 */
export async function syncEffortToGlobal(effort: string, canonicalModel?: string): Promise<boolean> {
  if (!PERSISTED_EFFORTS.has(effort) || !canonicalModel || !/^claude-[^\s]+$/.test(canonicalModel) || sanitizeComposerModel(canonicalModel) !== canonicalModel || /[\0\r\n]/.test(canonicalModel)) return false
  try {
    const raw = await readClaudeSettings("global")
    const next = { ...((raw ?? {}) as Record<string, unknown>) }
    const modelSettings = { ...(objectValue(next.modelSettings) ?? {}) }
    modelSettings[canonicalModel] = { ...(objectValue(modelSettings[canonicalModel]) ?? {}), effortLevel: effort }
    next.modelSettings = modelSettings
    await writeClaudeSettings("global", next)
    emitSettingsBus("composerPrefs")
    return true
  } catch {
    return false
  }
}

/**
 * 净化 composer 模型值：trim 后整体匹配 `<...>` 哨兵形态的值归为 ""。
 *
 * Claude CLI 在 API 出错（重试耗尽、模型不可用等）时会向会话 jsonl 写入合成
 * assistant 消息，其 message.model 为字面量 "<synthetic>"——它不是真实模型 id，
 * 绝不能当成会话模型回传 `--model`（否则 CLI 报模型不存在、再写一条合成消息，
 * 形成自我强化的报错死循环）。正则覆盖未来同形哨兵（如 "<unknown>"）。
 * 注意：`sonnet[1m]` 这类方括号别名不是 `<...>` 形态，不受影响。
 */
export function sanitizeComposerModel(value: string): string {
  const trimmed = (value || "").trim()
  return /^<[^>]*>$/.test(trimmed) ? "" : trimmed
}

function normalizeStoredComposerPrefs(value: unknown): ComposerPrefs {
  const obj = objectValue(value) ?? {}
  const effort = typeof obj.effort === "string" ? normalizeEffort(obj.effort) : ""
  const legacyUltra = /^ultracode(?:\s+(on|off))?$/i.exec(effort)
  const prefs: ComposerPrefs = {
    model: sanitizeComposerModel(typeof obj.model === "string" ? obj.model : ""),
    effort: legacyUltra ? legacyUltra[1] === "off" ? "" : "xhigh" : effort
  }
  if (typeof obj.ultracode === "boolean") prefs.ultracode = obj.ultracode
  else if (legacyUltra) prefs.ultracode = legacyUltra[1] !== "off"
  if (typeof obj.fastMode === "boolean") prefs.fastMode = obj.fastMode
  const window = parseAutoCompactWindow(obj.autoCompactWindow)
  if (window !== undefined) prefs.autoCompactWindow = window
  const efforts = objectValue(obj.modelEfforts)
  if (efforts) prefs.modelEfforts = Object.fromEntries(Object.entries(efforts).filter(([, effort]) => typeof effort === "string" && !/^ultracode/.test(effort))) as Record<string, string>
  if (obj.modelSettings) prefs.modelSettings = pickModelSettings(obj.modelSettings)
  const windows = objectValue(obj.modelAutoCompactWindows)
  if (windows) prefs.modelAutoCompactWindows = Object.fromEntries(Object.entries(windows).flatMap(([model, value]) => {
    const window = parseAutoCompactWindow(value)
    return window !== undefined ? [[model, window]] : []
  }))
  return prefs
}

/** 从 sidecar payload 中提取 composer 偏好（resume 时调用）。 */
export function pickComposerFromSidecar(
  sidecar: unknown
): ComposerPrefs | null {
  if (!sidecar || typeof sidecar !== "object") return null
  const composer = (sidecar as { composer?: unknown }).composer
  if (!composer || typeof composer !== "object") return null
  const obj = composer as Record<string, unknown>
  // 已污染的 sidecar（model=<synthetic>）读回时净化为 ""，下次写回即自愈
  const prefs = normalizeStoredComposerPrefs(obj)
  if (!prefs.model && !prefs.effort && prefs.ultracode === undefined && prefs.fastMode === undefined && prefs.autoCompactWindow === undefined && !prefs.modelEfforts && !prefs.modelSettings) return null
  return prefs
}

export function mergeComposerPrefs(
  base: ComposerPrefs | null,
  override: ComposerPrefs | null
): ComposerPrefs | null {
  if (!base && !override) return null
  const next: ComposerPrefs = { ...base, ...override, model: override?.model || base?.model || "", effort: override?.effort || base?.effort || "" }
  if (base?.modelEfforts || override?.modelEfforts) next.modelEfforts = { ...base?.modelEfforts, ...override?.modelEfforts }
  if (base?.modelSettings || override?.modelSettings) next.modelSettings = { ...base?.modelSettings, ...override?.modelSettings }
  if (base?.modelAutoCompactWindows || override?.modelAutoCompactWindows) next.modelAutoCompactWindows = { ...base?.modelAutoCompactWindows, ...override?.modelAutoCompactWindows }
  if (!next.model && !next.effort && next.ultracode === undefined && next.fastMode === undefined && next.autoCompactWindow === undefined && !next.modelEfforts && !next.modelAutoCompactWindows && !next.modelSettings) return null
  return next
}

function decodeTagText(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
}

function readSimpleTag(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(text)
  if (!match) return null
  return decodeTagText(match[1]).trim()
}

function normalizeEffort(value: string): EffortLevel {
  const compact = value.trim().toLowerCase().replace(/[\s_-]+/g, "")
  if (!compact || compact === "auto" || compact === "default") return ""
  if (compact === "extrahigh") return "xhigh"
  if (compact === "maximum") return "max"
  // 其余原样透传（接受 claude --help 动态档位与未来 sentinel，如 ultracode）
  return value.trim().toLowerCase()
}

function messageTextBlocks(ev: ClaudeEvent): string[] {
  if (!ev || typeof ev !== "object") return []
  const message = (ev as { message?: unknown }).message
  if (!message || typeof message !== "object") return []
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  return (content as ContentBlock[]).flatMap((block) => {
    const obj = block as unknown as Record<string, unknown>
    return obj.type === "text" && typeof obj.text === "string" ? [obj.text] : []
  })
}

export function composerPrefsPatchFromCommandEvent(
  ev: ClaudeEvent
): Partial<ComposerPrefs> | null {
  if (ev.type !== "user") return null
  // Only a known local slash input or a CLI-origin envelope may change preferences.
  const authored = ev.claudinalAuthored === true && typeof ev.claudinalAuthoredText === "string"
    ? /^\s*\/(model|effort|fast|autocompact)(?:\s+([^\r\n]*))?\s*$/.exec(ev.claudinalAuthoredText) : null
  if (!authored && !hasInjectedProvenance(ev)) return null
  const texts = authored ? [""] : messageTextBlocks(ev)
  for (const text of texts) {
    if (!authored && !/^\s*<command-(?:name|message)>/.test(text)) continue
    const commandName = authored?.[1] ?? readSimpleTag(text, "command-name")
    if (!commandName) continue
    const command = commandName.trim().replace(/^\//, "").toLowerCase()
    const args = authored?.[2] ?? (authored ? "" : readSimpleTag(text, "command-args")) ?? ""
    if (command === "effort") {
      const ultra = /^ultracode(?:\s+(on|off))?$/i.exec(args.trim())
      if (ultra) return { ultracode: ultra[1] !== "off" }
      return { effort: normalizeEffort(args) }
    }
    if (command === "fast" && /^(on|off)$/i.test(args.trim())) return { fastMode: args.trim().toLowerCase() === "on" }
    if (command === "autocompact") {
      const compact = args.trim().toLowerCase()
      const numeric = /^(\d+)(k)?$/.exec(compact)
      const window = parseAutoCompactWindow(compact === "auto" ? "auto" : numeric ? Number(numeric[1]) * (numeric[2] ? 1000 : 1) : undefined)
      return window !== undefined ? { autoCompactWindow: window } : null
    }
    if (command === "model") {
      // 防御性净化：哨兵形态（如 <synthetic>）等价于 default/auto，归为 ""
      const modelArg = sanitizeComposerModel(args)
      const model =
        !modelArg || ["default", "auto"].includes(modelArg.toLowerCase())
          ? ""
          : modelArg
      return { model }
    }
  }
  return null
}

export function pickComposerFromTranscript(
  events: ClaudeEvent[]
): ComposerPrefs | null {
  let model = ""
  let effort = ""
  let ultracode: boolean | undefined
  let fastMode: boolean | undefined
  let autoCompactWindow: AutoCompactWindow | undefined
  const modelEfforts: Record<string, string> = {}
  let explicitModel = false
  let hasValue = false

  for (const ev of events) {
    const t = (ev as { type?: string }).type
    if (t === "system") {
      const subtype = (ev as { subtype?: string }).subtype
      const initModel = (ev as { model?: unknown }).model
      if (subtype === "init" && !explicitModel && typeof initModel === "string") {
        // 防御性净化：init 正常不会是哨兵，但同样跳过 <...> 形态
        const sanitized = sanitizeComposerModel(initModel)
        if (sanitized) {
          model = sanitized
          hasValue = true
        }
      }
    } else if (t === "assistant") {
      const msgModel = (ev as { message?: { model?: unknown } }).message?.model
      if (!explicitModel && typeof msgModel === "string") {
        // CLI 合成消息（model=<synthetic>）跳过不采纳，
        // 保留此前采纳的真实 assistant/init 模型
        const sanitized = sanitizeComposerModel(msgModel)
        if (sanitized) {
          model = sanitized
          hasValue = true
        }
      }
    }

    const patch = composerPrefsPatchFromCommandEvent(ev)
    if (!patch) continue
    if (patch.model !== undefined) {
      model = patch.model
      effort = modelEfforts[model] ?? ""
      explicitModel = true
      hasValue = hasValue || !!patch.model
    }
    if (patch.effort !== undefined) {
      effort = patch.effort
      modelEfforts[model] = effort
      hasValue = hasValue || !!patch.effort
    }
    if (patch.ultracode !== undefined) { ultracode = patch.ultracode; hasValue = true }
    if (patch.fastMode !== undefined) { fastMode = patch.fastMode; hasValue = true }
    if (patch.autoCompactWindow !== undefined) { autoCompactWindow = patch.autoCompactWindow; hasValue = true }
  }

  if (!hasValue && !model && !effort) return null
  return { model, effort, ...(ultracode !== undefined ? { ultracode } : {}), ...(fastMode !== undefined ? { fastMode } : {}), ...(autoCompactWindow !== undefined ? { autoCompactWindow } : {}), ...(Object.keys(modelEfforts).length > 1 ? { modelEfforts } : {}) }
}

/**
 * 计算 effort 的来源：
 * - "auto"     当前 effort 为空（CLI 启动不传 --effort）
 * - "session"  当前 effort 与 sessionPrefs 不同 / sessionPrefs 有值
 * - "default"  当前 effort 与全局默认一致
 */
export function effortSource(
  current: string,
  sessionPrefs: ComposerPrefs | null,
  globalDefault: ComposerPrefs,
  model?: string
): EffortSource {
  if (!current) return "auto"
  if (sessionPrefs && sessionPrefs.effort && sessionPrefs.effort === current) {
    return "session"
  }
  if ((model === undefined ? globalDefault.effort : resolveComposerModelDefaults(globalDefault, model).effort) === current) return "default"
  return "session"
}

// ===== 模型清单 =====
// Claude Code 官方公开的稳定入口是 model alias 或完整模型名。
// 第三方 API 自定义模型由调用方通过 extraModels 注入。

export interface ModelOption {
  value: string
  label: string
  group: "Aliases" | "Provider"
}

export const BUILTIN_MODELS: ModelOption[] = [
  { value: "best", label: "Best", group: "Aliases" },
  { value: "sonnet", label: "Sonnet", group: "Aliases" },
  { value: "opus", label: "Opus", group: "Aliases" },
  { value: "haiku", label: "Haiku", group: "Aliases" },
  { value: "fable", label: "Fable", group: "Aliases" },
  { value: "sonnet[1m]", label: "Sonnet 1M", group: "Aliases" },
  { value: "opus[1m]", label: "Opus 1M", group: "Aliases" },
  { value: "opusplan", label: "Opus Plan", group: "Aliases" }
]

export function isClaudeModelEntry(model: string): boolean {
  const trimmed = (model || "").trim()
  return (
    !trimmed ||
    BUILTIN_MODELS.some((option) => option.value === trimmed) ||
    trimmed.startsWith("claude-") ||
    trimmed.startsWith("anthropic.")
  )
}

export function isComposerModelAllowed(
  model: string,
  allowedModelValues: ReadonlySet<string>,
  restrictToAllowedValues: boolean
): boolean {
  const trimmed = (model || "").trim()
  if (!trimmed) return true
  return restrictToAllowedValues
    ? allowedModelValues.has(trimmed)
    : sanitizeComposerModel(trimmed) === trimmed && !/[\r\n\0]/.test(trimmed)
}

// ===== 思考强度 =====
// - "" 等价于 CLI 的 `auto`（不发 --effort，由 CLI 决定）
// - 档位清单优先由 `claude --help` 动态解析（detectEffortLevels），失败回退 BUILTIN_EFFORT_LEVELS
// - EffortLevel 放宽：保留已知档位的 IDE 提示，同时接受 CLI 动态返回的新档位 / sentinel

export type EffortLevel =
  | ""
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | (string & {})

/** claude --help 解析失败时的内置回退档位（不含 auto） */
export const BUILTIN_EFFORT_LEVELS: string[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]

/**
 * OpenAI 兼容路径（input_format=openai-chat-completions）的 reasoning_effort 固定清单（不含 auto）。
 *
 * OpenAI 无 `claude --help` 这类本地枚举源、亦无枚举 API，故硬编码全集；
 * 具体支持取决于模型（如 GPT-5=minimal/low/medium/high、GPT-5.1=none/low/medium/high），
 * 端点不支持的档位由底层忽略 / 回退（见 api_proxy.rs::openai_reasoning_effort）。
 * 这里**不含 max / ultracode**——max 是 Claude 语义、ultracode 是 CC 设置，均不属于 OpenAI。
 */
export const OPENAI_EFFORT_LEVELS: string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]

/** 已知档位的展示顺序权重（auto 永远在最前） */
const KNOWN_EFFORT_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5
}

const KNOWN_EFFORT_LABELS: Record<string, string> = {
  "": "Auto",
  // OpenAI reasoning_effort 的低档位（仅 openai-chat-completions 路径展示）
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  // Retained only to label legacy history. Ultracode is now an independent boolean.
  ultracode: "Ultracode"
}

/** 档位展示 label；未知档位 fallback（连字符/下划线转空格 + 首字母大写） */
export function effortLabel(level: string): string {
  const key = (level || "").trim().toLowerCase()
  if (key in KNOWN_EFFORT_LABELS) return KNOWN_EFFORT_LABELS[key]
  const cleaned = key.replace(/[-_]+/g, " ").trim()
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "Auto"
}

/**
 * 由动态档位（claude --help）构建带 auto 的有序档位清单。
 * 空输入回退内置清单；已知档位按固定顺序，未知新档位追加在已知之后（保持出现顺序）。
 *
 * Ultracode is excluded even if a CLI help shorthand includes it.
 * 空字符串是 auto sentinel（本函数固定前置），同样从动态源剔除以防重复。
 */
export function buildEffortOrder(dynamicLevels: string[]): EffortLevel[] {
  const src = (dynamicLevels.length ? dynamicLevels : BUILTIN_EFFORT_LEVELS)
    .map((l) => (l || "").trim().toLowerCase())
    .filter((level) => !!level && !/^ultracode(?:\s|$)/.test(level))
  const unique = Array.from(new Set(src))
  const known = unique
    .filter((l) => l in KNOWN_EFFORT_RANK)
    .sort((a, b) => KNOWN_EFFORT_RANK[a] - KNOWN_EFFORT_RANK[b])
  const unknown = unique.filter((l) => !(l in KNOWN_EFFORT_RANK))
  return ["", ...known, ...unknown] as EffortLevel[]
}

export interface EffortCapabilities {
  available: EffortLevel[]
  defaultEffort: EffortLevel
}

/**
 * CLI per-model metadata outranks legacy name fallbacks. Null without explicit
 * supportsEffort:false is conservative/unknown for older Haiku, not certification.
 */
export function effortLevelsForModel(
  model: string,
  availableLevels: EffortLevel[],
  capability?: ComposerModelCapabilities
): EffortCapabilities | null {
  if (capability?.supportsEffort === false) return null
  if (capability?.supportedEffortLevels !== undefined) {
    const levels = capability.supportedEffortLevels.length
      ? buildEffortOrder([...capability.supportedEffortLevels]) : [""] as EffortLevel[]
    return { available: levels, defaultEffort: "" }
  }
  if (capability?.supportsEffort === true) return { available: availableLevels, defaultEffort: "" }
  const m = (model || "").trim().toLowerCase()
  if (m.includes("haiku") || m.startsWith("claude-haiku")) return null
  return { available: availableLevels, defaultEffort: "" }
}

export function modelDisplayLabel(model: string): string {
  const trimmed = (model || "").trim()
  if (!trimmed) return "Default"
  const found = BUILTIN_MODELS.find((m) => m.value === trimmed)
  return found?.label ?? trimmed
}
