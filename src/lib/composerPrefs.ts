import { readClaudeSettings, writeClaudeSettings } from "@/lib/ipc"
import { loadSettings } from "@/lib/settings"
import { emitSettingsBus } from "@/lib/settingsBus"

// Composer 数据层（重新设计 2026-04-30）：
//
// 核心拆分：
// - **全局默认**（`loadGlobalDefault`）：从 ~/.claude/settings.json + 应用 settings 读取，
//   作为新会话的初始 model/effort。CLI 自己维护 settings.json 的写入（除非用户在 UI 里
//   勾选"同步为全局默认"）。
// - **会话覆盖**（sidecar.composer）：每个会话单独存自己的 model/effort 选择，
//   resume 同一会话时还原；新会话从全局默认起步。由 App.tsx 在 switchSession 时读、
//   在用户切换 Picker 时写（写入路径见 ipc.ts writeSessionSidecar）。
//
// 旧实现遗留：`claudinal.composer.prefs` 是全局共享的 localStorage，会让所有会话误共享
// max 等设置；本版仅做"一次性迁移读取"，读完即删，避免污染。

export interface ComposerPrefs {
  model: string
  effort: string
}

/** 表示 effort 的来源；驱动 UI 的视觉提示 */
export type EffortSource = "session" | "default" | "auto"

export const EMPTY_COMPOSER_PREFS: ComposerPrefs = { model: "", effort: "" }

const LEGACY_KEY = "claudinal.composer.prefs"

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
 * 读全局默认：~/.claude/settings.json 优先，其次 app settings。
 *
 * 注意：settings.json 的 effortLevel 仅接受 low/medium/high/xhigh（官方文档），
 * 故 max 不会出现在这里——max 必须从会话级 sidecar 来。
 */
export async function loadGlobalDefault(): Promise<ComposerPrefs> {
  // 优先读 ~/.claude/settings.json（CLI 权威）
  try {
    const raw = await readClaudeSettings("global")
    const obj = (raw ?? {}) as Record<string, unknown>
    const model = typeof obj.model === "string" ? obj.model.trim() : ""
    const effort =
      typeof obj.effortLevel === "string" ? obj.effortLevel.trim() : ""
    if (model || effort) {
      return { model, effort }
    }
  } catch {
    // 文件缺失/损坏不致命
  }
  // 回落 app settings
  const cfg = loadSettings()
  const fallback: ComposerPrefs = {
    model: cfg.defaultModel.trim(),
    effort: cfg.defaultEffort.trim()
  }
  // 兜底吸收旧 localStorage 一次（避免用户已有偏好突然全部归零）
  if (!fallback.model && !fallback.effort) {
    const legacy = consumeLegacyPrefs()
    if (legacy) {
      return {
        model: typeof legacy.model === "string" ? legacy.model.trim() : "",
        effort: typeof legacy.effort === "string" ? legacy.effort.trim() : ""
      }
    }
  }
  return fallback
}

/**
 * 把 effort 写到全局 settings.json。仅持久化级别允许（max 由官方约束不能写入）。
 * 返回 true = 成功；false = 不允许（max/auto/空）。
 */
export async function syncEffortToGlobal(effort: string): Promise<boolean> {
  const allowed = new Set(["low", "medium", "high", "xhigh"])
  if (!allowed.has(effort)) return false
  try {
    const raw = await readClaudeSettings("global")
    const next = { ...((raw ?? {}) as Record<string, unknown>) }
    next.effortLevel = effort
    await writeClaudeSettings("global", next)
    emitSettingsBus("composerPrefs")
    return true
  } catch {
    return false
  }
}

/** 从 sidecar payload 中提取 composer 偏好（resume 时调用）。 */
export function pickComposerFromSidecar(
  sidecar: unknown
): ComposerPrefs | null {
  if (!sidecar || typeof sidecar !== "object") return null
  const composer = (sidecar as { composer?: unknown }).composer
  if (!composer || typeof composer !== "object") return null
  const obj = composer as Record<string, unknown>
  const model = typeof obj.model === "string" ? obj.model.trim() : ""
  const effort = typeof obj.effort === "string" ? obj.effort.trim() : ""
  if (!model && !effort) return null
  return { model, effort }
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
  globalDefault: ComposerPrefs
): EffortSource {
  if (!current) return "auto"
  if (sessionPrefs && sessionPrefs.effort && sessionPrefs.effort === current) {
    return "session"
  }
  if (globalDefault.effort === current) return "default"
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
  { value: "sonnet[1m]", label: "Sonnet 1M", group: "Aliases" },
  { value: "opus[1m]", label: "Opus 1M", group: "Aliases" },
  { value: "opusplan", label: "Opus Plan", group: "Aliases" }
]

// ===== 思考强度 =====
// - "" 等价于 CLI 的 `auto`（不发 --effort，由 CLI 决定）

export type EffortLevel = "" | "low" | "medium" | "high" | "xhigh" | "max"

export const EFFORT_ORDER: EffortLevel[] = [
  "",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  "": "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
}

export interface EffortCapabilities {
  available: EffortLevel[]
  defaultEffort: EffortLevel
}

const GENERIC_EFFORT: EffortCapabilities = {
  available: ["", "low", "medium", "high", "xhigh", "max"],
  defaultEffort: ""
}

/** 返回 null 表示该模型不支持 effort（如 Haiku） */
export function effortLevelsForModel(model: string): EffortCapabilities | null {
  const m = (model || "").trim().toLowerCase()
  if (!m) {
    return GENERIC_EFFORT
  }
  if (m.includes("haiku") || m.startsWith("claude-haiku")) return null
  return GENERIC_EFFORT
}

export function modelDisplayLabel(model: string): string {
  const trimmed = (model || "").trim()
  if (!trimmed) return "Default"
  const found = BUILTIN_MODELS.find((m) => m.value === trimmed)
  return found?.label ?? trimmed
}
