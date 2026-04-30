import { loadThirdPartyApiConfig } from "@/lib/thirdPartyApi"
import type { OauthUsage } from "@/lib/ipc"

/** 当前是否走 Anthropic 官方端点（非第三方 API） */
export function isOfficialApi(): boolean {
  const cfg = loadThirdPartyApiConfig()
  return !cfg.enabled
}

/** 重置倒计时（两段精度）："1d4h" / "2h30m" / "42m" / "已重置" */
export function shortResets(resetsAt: string | undefined): string {
  if (!resetsAt) return ""
  const ms = Date.parse(resetsAt) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return "已重置"
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
  return Math.max(0, Math.min(100, Math.round(w.utilization)))
}
