import { emitSettingsBus } from "@/lib/settingsBus"

// 用户可配置的厂商/模型定价表，用于在 Statistics 重算 cost。
//
// 数据来源（2026-09-26 核对的官方标准价，单位 USD per 1M tokens）：
// - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
// - OpenAI:    https://developers.openai.com/api/docs/pricing
// - DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
//
// 匹配语义：组内规则按定义顺序自上而下匹配 model id，命中即停。pattern 使用 glob：
// `*` 匹配任意字符序列、`?` 匹配单字符，大小写不敏感，需全字匹配（隐式 ^...$）。
// 预设精确匹配模型版本，同时识别厂商前缀、日期、thinking 和 [1m] 后缀。
// 自定义规则仍支持 glob；宽泛规则可能同时命中不同子版本。

const KEY = "claudinal.pricing"

export interface PricingRule {
  id: string
  pattern: string
  // 单位均为 USD / 1M tokens（标价）
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  // 折扣/加成倍率，最终计费 = 标价 × multiplier。默认 1。
  // 例：DeepSeek 非高峰时段 → 0.5；某厂商加价 10% → 1.1。
  multiplier: number
}

export interface PricingGroup {
  id: string
  name: string
  rules: PricingRule[]
}

export interface PricingConfig {
  version: 1
  presetRevision?: string
  groups: PricingGroup[]
}

export const PRICING_CHECKED_AT = "2026-09-26"

function preset(model: string, input: number, output: number, cacheRead: number, cacheWrite = 0): PricingRule {
  return { id: `preset-${model.replaceAll(".", "-")}`, pattern: model, input, output, cacheRead, cacheWrite, multiplier: 1 }
}

export const DEFAULT_PRICING: PricingConfig = {
  version: 1,
  presetRevision: PRICING_CHECKED_AT,
  groups: [
    {
      id: "preset-anthropic", name: "Anthropic",
      // Standard global pricing. Cache writes use the 5-minute rate.
      // Claude 4.6+ uses the same rate across the full 1M context window.
      rules: [
        preset("claude-fable-5-1", 10, 50, 0.25, 12.5),
        preset("claude-fable-5", 10, 50, 1, 12.5),
        preset("claude-opus-5-5", 4, 20, 0.2, 5),
        preset("claude-opus-5", 5, 25, 0.5, 6.25),
        preset("claude-opus-4-8", 5, 25, 0.5, 6.25),
        preset("claude-opus-4-7", 5, 25, 0.5, 6.25),
        preset("claude-opus-4-6", 5, 25, 0.5, 6.25),
        preset("claude-opus-4-5", 5, 25, 0.5, 6.25),
        preset("claude-sonnet-5", 2, 10, 0.2, 2.5),
        preset("claude-sonnet-4-6", 3, 15, 0.3, 3.75),
        preset("claude-sonnet-4-5", 3, 15, 0.3, 3.75),
        preset("claude-haiku-4-5", 1, 5, 0.1, 1.25),
        preset("claude-mythos-5-1", 10, 50, 0.25, 12.5),
        preset("claude-mythos-5", 10, 50, 1, 12.5),
      ],
    },
    {
      id: "preset-openai", name: "OpenAI",
      // Standard short-context rates. GPT-5.6 / GPT-6 have explicit cache writes.
      // Older models without a separate cache-write rate retain zero here.
      rules: [
        preset("gpt-6-astra", 10, 50, 1, 12.5),
        preset("gpt-6-sol", 2, 10, 0.2, 2.5),
        preset("gpt-6-luna", 0.1, 0.5, 0.01, 0.125),
        preset("gpt-5.6-sol", 4, 20, 0.4, 5),
        preset("gpt-5.6-terra", 2, 12, 0.2, 2.5),
        preset("gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25),
        preset("gpt-5.5-pro", 30, 180, 0),
        preset("gpt-5.5", 5, 30, 0.5),
        preset("gpt-5.4-pro", 30, 180, 0),
        preset("gpt-5.4-mini", 0.75, 4.5, 0.075),
        preset("gpt-5.4-nano", 0.2, 1.25, 0.02),
        preset("gpt-5.4", 2.5, 15, 0.25),
        preset("gpt-5.3-codex", 1.75, 14, 0.175),
      ],
    },
    {
      id: "preset-deepseek", name: "DeepSeek",
      // Peak rates. Off-peak is 0.5x; aggregate usage cannot determine the split.
      // Both legacy Flash aliases now route to V4.1-Flash at the Flash price.
      rules: [
        preset("deepseek-flash", 0.3, 1.2, 0.006),
        preset("deepseek-v4-flash-vision-exp", 0.3, 1.2, 0.006),
        preset("deepseek-v4-flash", 0.3, 1.2, 0.006),
        preset("deepseek-v4-pro", 1.32, 3.96, 0.044),
      ],
    },
  ],
}

// Exact old values identify untouched defaults; user prices/patterns/order win.
const LEGACY_PRESETS = [
  preset("claude-opus-4-7", 5, 25, 0.5, 6.25),
  preset("claude-opus-4-6", 5, 25, 0.5, 6.25),
  preset("claude-sonnet-4-6", 3, 15, 0.3, 3.75),
  preset("claude-haiku-4-5", 1, 5, 0.1, 1.25),
  preset("gpt-5.5", 5, 30, 0.5),
  preset("gpt-5.4-mini", 0.75, 4.5, 0.075),
  preset("gpt-5.4", 2.5, 15, 0.25),
  preset("deepseek-v4-flash", 0.14, 0.28, 0.0028),
  preset("deepseek-v4-pro", 1.74, 3.48, 0.0145),
].map((rule) => ({ ...rule, pattern: `*${rule.pattern}*` }))

function samePriceRule(a: PricingRule, b: PricingRule): boolean {
  return a.id === b.id && a.pattern === b.pattern && a.input === b.input
    && a.output === b.output && a.cacheRead === b.cacheRead
    && a.cacheWrite === b.cacheWrite && a.multiplier === b.multiplier
}

/** Migrate only shipped defaults. Deliberately deleted groups/rules stay deleted. */
export function migratePricing(config: PricingConfig): PricingConfig {
  if (config.presetRevision === PRICING_CHECKED_AT) return config
  const latestRules = DEFAULT_PRICING.groups.flatMap((group) => group.rules)
  const next: PricingConfig = {
    ...config, presetRevision: PRICING_CHECKED_AT,
    groups: config.groups.map((group) => ({
      ...group,
      rules: group.rules.map((rule) => {
        const old = LEGACY_PRESETS.find((preset) => samePriceRule(rule, preset))
        return old ? { ...latestRules.find((preset) => preset.id === old.id)! } : { ...rule }
      }),
    })),
  }
  for (const group of next.groups) {
    const presetGroup = DEFAULT_PRICING.groups.find((preset) => preset.id === group.id)
    if (!presetGroup) continue
    for (const rule of presetGroup.rules) {
      if (LEGACY_PRESETS.some((old) => old.id === rule.id)) continue
      if (next.groups.some((existing) => existing.rules.some((existingRule) => existingRule.id === rule.id))) continue
      // Respect existing custom rules, including a catch-all in another group.
      if (findRule(rule.pattern, next)) continue
      group.rules.push({ ...rule })
    }
  }
  return next
}

export function makePricingId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function clonePreset(): PricingConfig {
  return JSON.parse(JSON.stringify(DEFAULT_PRICING)) as PricingConfig
}

function isPricingRule(v: unknown): v is PricingRule {
  if (!v || typeof v !== "object") return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === "string" &&
    typeof r.pattern === "string" &&
    typeof r.input === "number" &&
    typeof r.output === "number" &&
    typeof r.cacheRead === "number" &&
    typeof r.cacheWrite === "number"
    // multiplier 在旧数据里可能缺失，loadPricing 时补默认 1
  )
}

function normalizeRule(r: PricingRule): PricingRule {
  return {
    ...r,
    multiplier:
      typeof r.multiplier === "number" && r.multiplier >= 0 ? r.multiplier : 1
  }
}

function isPricingGroup(v: unknown): v is PricingGroup {
  if (!v || typeof v !== "object") return false
  const g = v as Record<string, unknown>
  return (
    typeof g.id === "string" &&
    typeof g.name === "string" &&
    Array.isArray(g.rules) &&
    g.rules.every(isPricingRule)
  )
}

export function loadPricing(): PricingConfig {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return clonePreset()
    const obj = JSON.parse(raw) as unknown
    if (
      obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      Array.isArray((obj as PricingConfig).groups) &&
      (obj as PricingConfig).groups.every(isPricingGroup)
    ) {
      const normalized: PricingConfig = {
        version: 1,
        presetRevision: (obj as PricingConfig).presetRevision,
        groups: (obj as PricingConfig).groups.map((g) => ({
          ...g,
          rules: g.rules.map(normalizeRule)
        }))
      }
      const migrated = migratePricing(normalized)
      if (migrated !== normalized) {
        try { localStorage.setItem(KEY, JSON.stringify(migrated)) }
        catch (error) { console.warn("默认定价迁移暂未保存，当前配置仍可使用", error) }
      }
      return migrated
    }
    console.error("定价配置格式无效，已使用默认定价")
  } catch (error) {
    console.error("读取定价配置失败:", error)
  }
  return clonePreset()
}

export function savePricing(cfg: PricingConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg))
  emitSettingsBus("pricing")
}

export function resetPricingToDefault(): PricingConfig {
  const next = clonePreset()
  savePricing(next)
  return next
}

// glob → RegExp。转义除 * ? 外的所有正则元字符；* → .*；? → .。
// 全字匹配（^...$），大小写不敏感（i flag）。
export function compileGlob(pattern: string): RegExp | null {
  if (typeof pattern !== "string" || pattern.length === 0) return null
  try {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    return new RegExp(`^${escaped}$`, "i")
  } catch {
    return null
  }
}

export interface RuleMatch {
  rule: PricingRule
  groupId: string
  groupName: string
}

/** Context capacity is not a billable tier. Keep version variants distinct. */
export function pricingModelId(modelId: string): string {
  return modelId.trim().split("/").at(-1)!.replace(/\[1m\]$/i, "")
    .replace(/-thinking$/i, "").replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "")
}

export function findRule(modelId: string, cfg: PricingConfig): RuleMatch | null {
  if (!modelId) return null
  for (const group of cfg.groups) {
    for (const rule of group.rules) {
      const re = compileGlob(rule.pattern)
      if (!re) continue
      if (re.test(modelId) || re.test(pricingModelId(modelId))) {
        return { rule, groupId: group.id, groupName: group.name }
      }
    }
  }
  return null
}

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

// 按规则重算 cost；规则缺失时返回 null（UI 显示 — + 警告）。
// 最终 cost = (标价 × tokens 求和) / 1M × multiplier。
export function recomputeCost(
  tokens: TokenCounts,
  rule: PricingRule | null
): number | null {
  if (!rule) return null
  const input = (tokens.input || 0) * rule.input
  const output = (tokens.output || 0) * rule.output
  const cacheRead = (tokens.cacheRead || 0) * rule.cacheRead
  const cacheCreate = (tokens.cacheCreate || 0) * rule.cacheWrite
  const m = typeof rule.multiplier === "number" ? rule.multiplier : 1
  return ((input + output + cacheRead + cacheCreate) / 1_000_000) * m
}
