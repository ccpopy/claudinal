import { loadThirdPartyApiConfig } from "@/lib/thirdPartyApi"
import type { OauthUsage } from "@/lib/ipc"

/** 当前是否走 Anthropic 官方端点（非第三方 API） */
export function isOfficialApi(): boolean {
  const cfg = loadThirdPartyApiConfig()
  return !cfg.enabled
}

/** 重置倒计时（两段精度）："1d4h" / "2h30m" / "42m" / "等待更新" */
export function shortResets(resetsAt: string | null | undefined, now = Date.now()): string {
  if (!resetsAt) return ""
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms)) return ""
  if (ms <= 0) return "等待更新"
  if (ms < 60_000) return "不到1m"
  const totalMin = Math.floor(ms / 60_000)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`
  return `${mins}m`
}

export function fiveHourPercent(usage: OauthUsage | null | undefined): number | null {
  const w = usage?.five_hour
  if (!w) return null
  if (!Number.isFinite(w.utilization)) return null
  return Math.max(0, Math.min(100, Math.round(w.utilization)))
}

export const CLAUDE_USAGE_URL = "https://claude.ai/new#settings/usage"

export function resetTime(resetsAt: string | null | undefined): string {
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) return ""
  return new Date(resetsAt).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  })
}

export function resetCountdown(resetsAt: string | null | undefined, now = Date.now()): string {
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) return "重置时间暂未提供"
  const ms = Date.parse(resetsAt) - now
  if (ms <= 0) return "已到重置时间，等待更新"
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟后重置`
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`
  return `${hours} 小时 ${minutes % 60} 分钟后重置`
}

export interface LimitResetGrant {
  id: string
  remaining: number
  endsAt: string | null
  startsAt: string | null
  limits: string[]
  usable: boolean
  paused: boolean
}

export type LimitResets = { kind: "unknown" } | { kind: "known"; remaining: number; grants: LimitResetGrant[] }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const optionalDate = (value: unknown) => value == null
  || typeof value === "string" && Number.isFinite(Date.parse(value))

/** CLI's cedar_ember status is authoritative. Missing/unsupported is not zero. */
export function limitResets(data: OauthUsage | null, now = Date.now()): LimitResets {
  const status = data?.cedar_ember
  if (!record(status) || status.eligible !== true || !Array.isArray(status.grants)) return { kind: "unknown" }
  const grants: LimitResetGrant[] = []
  const cooldown = status.cooldown_until
  const cooldownClear = optionalDate(cooldown) && (cooldown == null || Date.parse(String(cooldown)) <= now)
  const ids = new Set<string>()
  for (const value of status.grants) {
    if (!record(value) || typeof value.id !== "string" || !value.id || ids.has(value.id)
      || typeof value.resets_left !== "number" || !Number.isSafeInteger(value.resets_left) || value.resets_left < 0
      || value.resets_total != null && (typeof value.resets_total !== "number"
        || !Number.isSafeInteger(value.resets_total) || value.resets_total < value.resets_left)
      || typeof value.paused !== "boolean"
      || !optionalDate(value.ends_at) || !optionalDate(value.starts_at)) return { kind: "unknown" }
    ids.add(value.id)
    const endsAt = typeof value.ends_at === "string" ? value.ends_at : null
    const startsAt = typeof value.starts_at === "string" ? value.starts_at : null
    if (value.paused || endsAt && Date.parse(endsAt) <= now || startsAt && Date.parse(startsAt) > now) continue
    const labels: Record<string, string> = {
      five_hour: "5 小时会话额度", seven_day: "每周额度",
      seven_day_opus: "Opus 每周额度", seven_day_sonnet: "Sonnet 每周额度"
    }
    grants.push({
      id: value.id, remaining: value.resets_left, endsAt,
      startsAt,
      limits: Array.isArray(value.clears) ? value.clears.flatMap(key =>
        typeof key === "string" && Object.hasOwn(labels, key) ? [labels[key]] : []) : [],
      usable: value.usable_now === true && cooldownClear
        && (value.use_requires_limit === false || status.at_limit === true), paused: value.paused,
    })
  }
  const remaining = grants.reduce((total, grant) => total + grant.remaining, 0)
  return Number.isSafeInteger(remaining) ? { kind: "known", remaining, grants } : { kind: "unknown" }
}
