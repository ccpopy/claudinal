import { readClaudeSettings, writeClaudeSettings } from "@/lib/ipc"
import { emitSettingsBus } from "@/lib/settingsBus"
import type { ClaudeEvent, ContentBlock } from "@/types/events"

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
  // ~/.claude/settings.json 是 CLI 权威，作为全局默认的唯一事实源
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
  // 兜底吸收旧 localStorage 一次（避免用户已有偏好突然全部归零）
  const legacy = consumeLegacyPrefs()
  if (legacy) {
    return {
      model: typeof legacy.model === "string" ? legacy.model.trim() : "",
      effort: typeof legacy.effort === "string" ? legacy.effort.trim() : ""
    }
  }
  return { model: "", effort: "" }
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

/** 从 sidecar payload 中提取 composer 偏好（resume 时调用）。 */
export function pickComposerFromSidecar(
  sidecar: unknown
): ComposerPrefs | null {
  if (!sidecar || typeof sidecar !== "object") return null
  const composer = (sidecar as { composer?: unknown }).composer
  if (!composer || typeof composer !== "object") return null
  const obj = composer as Record<string, unknown>
  // 已污染的 sidecar（model=<synthetic>）读回时净化为 ""，下次写回即自愈
  const model = sanitizeComposerModel(
    typeof obj.model === "string" ? obj.model : ""
  )
  const effort = typeof obj.effort === "string" ? obj.effort.trim() : ""
  if (!model && !effort) return null
  return { model, effort }
}

export function mergeComposerPrefs(
  base: ComposerPrefs | null,
  override: ComposerPrefs | null
): ComposerPrefs | null {
  const model = override?.model || base?.model || ""
  const effort = override?.effort || base?.effort || ""
  if (!model && !effort) return null
  return { model, effort }
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
  for (const text of messageTextBlocks(ev)) {
    const commandName = readSimpleTag(text, "command-name")
    if (!commandName) continue
    const command = commandName.trim().replace(/^\//, "").toLowerCase()
    const args = readSimpleTag(text, "command-args") ?? ""
    if (command === "effort") {
      return { effort: normalizeEffort(args) }
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
      explicitModel = true
      hasValue = hasValue || !!patch.model
    }
    if (patch.effort !== undefined) {
      effort = patch.effort
      hasValue = hasValue || !!patch.effort
    }
  }

  if (!hasValue && !model && !effort) return null
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
    : isClaudeModelEntry(trimmed)
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
  // ultracode 是 GUI 手动追加的 sentinel（非 claude --help 档位），
  // 仅在官方 / 第三方 anthropic 路径展示，spawn 时翻译为 --settings {"ultracode":true}
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
 * ultracode 是 GUI 手动追加的 sentinel（由 ModelEffortPicker 末尾单独追加），不属于
 * claude --help 档位；这里显式剔除，避免 help 误带 ultracode 时与 picker 的追加项重复。
 * 空字符串是 auto sentinel（本函数固定前置），同样从动态源剔除以防重复。
 */
export function buildEffortOrder(dynamicLevels: string[]): EffortLevel[] {
  const src = (dynamicLevels.length ? dynamicLevels : BUILTIN_EFFORT_LEVELS)
    .map((l) => (l || "").trim().toLowerCase())
    .filter((l) => l && l !== "ultracode")
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
 * 返回 null 表示该模型不支持 effort（如 Haiku）。
 * available 由调用方传入的动态档位决定（含 auto）。
 */
export function effortLevelsForModel(
  model: string,
  availableLevels: EffortLevel[]
): EffortCapabilities | null {
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
