import { emitSettingsBus } from "@/lib/settingsBus"

// 用户可配置的厂商/模型定价表，用于在 Statistics 重算 cost。
//
// 数据来源（2026-05-06 抓取的官方价，单位 USD per 1M tokens）：
// - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/pricing
// - OpenAI:    https://developers.openai.com/api/docs/pricing
// - DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
//
// 匹配语义：组内规则按定义顺序自上而下匹配 model id，命中即停。pattern 使用 glob：
// `*` 匹配任意字符序列、`?` 匹配单字符，大小写不敏感，需全字匹配（隐式 ^...$）。
// 这样 `*claude-opus-4.7*` 既能命中 `claude-opus-4.7-20260101`，也能命中
// `azure/claude-opus-4.7`、`openrouter/anthropic/claude-opus-4.7-thinking`。

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
  // 例：DeepSeek v4-pro 当前 75% 折扣 → 0.25；某厂商加价 10% → 1.1。
  multiplier: number
}

export interface PricingGroup {
  id: string
  name: string
  rules: PricingRule[]
}

export interface PricingConfig {
  version: 1
  groups: PricingGroup[]
}

export const DEFAULT_PRICING: PricingConfig = {
  version: 1,
  groups: [
    {
      id: "preset-anthropic",
      name: "Anthropic",
      rules: [
        // 官方 API id 用连字符版本号（claude-opus-4-7），不是点号；snapshot 形式
        // 例：claude-opus-4-5-20251101 也能被 *claude-opus-4-5* 命中
        {
          id: "preset-claude-opus-4-7",
          pattern: "*claude-opus-4-7*",
          input: 5,
          output: 25,
          cacheRead: 0.5,
          cacheWrite: 6.25,
          multiplier: 1
        },
        {
          id: "preset-claude-opus-4-6",
          pattern: "*claude-opus-4-6*",
          input: 5,
          output: 25,
          cacheRead: 0.5,
          cacheWrite: 6.25,
          multiplier: 1
        },
        {
          id: "preset-claude-sonnet-4-6",
          pattern: "*claude-sonnet-4-6*",
          input: 3,
          output: 15,
          cacheRead: 0.3,
          cacheWrite: 3.75,
          multiplier: 1
        },
        {
          id: "preset-claude-haiku-4-5",
          pattern: "*claude-haiku-4-5*",
          input: 1,
          output: 5,
          cacheRead: 0.1,
          cacheWrite: 1.25,
          multiplier: 1
        }
      ]
    },
    {
      id: "preset-openai",
      name: "OpenAI",
      // OpenAI 官方仅列 input / cached input / output 三档，没有「cache creation」单独计费。
      // 缓存创建价留 0（不按 input 推断），尊重官方数据。
      rules: [
        {
          id: "preset-gpt-5-5",
          pattern: "*gpt-5.5*",
          input: 5,
          output: 30,
          cacheRead: 0.5,
          cacheWrite: 0,
          multiplier: 1
        },
        // mini 必须排在 *gpt-5.4* 之前，否则会被 *gpt-5.4* 先命中按错价计算
        {
          id: "preset-gpt-5-4-mini",
          pattern: "*gpt-5.4-mini*",
          input: 0.75,
          output: 4.5,
          cacheRead: 0.075,
          cacheWrite: 0,
          multiplier: 1
        },
        {
          id: "preset-gpt-5-4",
          pattern: "*gpt-5.4*",
          input: 2.5,
          output: 15,
          cacheRead: 0.25,
          cacheWrite: 0,
          multiplier: 1
        }
      ]
    },
    {
      id: "preset-deepseek",
      name: "DeepSeek",
      // DeepSeek 官方仅列 input(cache miss) / input(cache hit) / output 三档，
      // 没有「cache creation」单独计费；标价填 cache miss，cacheWrite 留 0。
      rules: [
        {
          id: "preset-deepseek-v4-flash",
          pattern: "*deepseek-v4-flash*",
          input: 0.14,
          output: 0.28,
          cacheRead: 0.0028,
          cacheWrite: 0,
          multiplier: 1
        },
        {
          id: "preset-deepseek-v4-pro",
          pattern: "*deepseek-v4-pro*",
          input: 1.74,
          output: 3.48,
          cacheRead: 0.0145,
          cacheWrite: 0,
          multiplier: 1
        }
      ]
    }
  ]
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
      return {
        version: 1,
        groups: (obj as PricingConfig).groups.map((g) => ({
          ...g,
          rules: g.rules.map(normalizeRule)
        }))
      }
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

export function findRule(modelId: string, cfg: PricingConfig): RuleMatch | null {
  if (!modelId) return null
  for (const group of cfg.groups) {
    for (const rule of group.rules) {
      const re = compileGlob(rule.pattern)
      if (!re) continue
      if (re.test(modelId)) {
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
