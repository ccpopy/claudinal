const MINUTE_SECONDS = 60
const HOUR_SECONDS = 60 * MINUTE_SECONDS
const DAY_SECONDS = 24 * HOUR_SECONDS
const MONTH_SECONDS = 30 * DAY_SECONDS
const YEAR_SECONDS = 365 * DAY_SECONDS

function elapsedSeconds(ts: number, nowMs = Date.now()): number {
  if (!ts) return 0
  return Math.max(0, Math.floor((nowMs - ts * 1000) / 1000))
}

function whole(value: number, unit: number): number {
  return Math.max(1, Math.floor(value / unit))
}

export function formatSessionRelativeTime(ts: number, nowMs = Date.now()): string {
  if (!ts) return ""
  const diff = elapsedSeconds(ts, nowMs)
  if (diff < MINUTE_SECONDS) return "刚刚"
  if (diff < HOUR_SECONDS) return `${whole(diff, MINUTE_SECONDS)} 分钟前`
  if (diff < DAY_SECONDS) return `${whole(diff, HOUR_SECONDS)} 小时前`
  if (diff < MONTH_SECONDS) return `${whole(diff, DAY_SECONDS)} 天前`
  if (diff < YEAR_SECONDS) return `${whole(diff, MONTH_SECONDS)} 个月前`
  return `${whole(diff, YEAR_SECONDS)} 年前`
}

export function formatSessionCompactTime(ts: number, nowMs = Date.now()): string {
  if (!ts) return ""
  const diff = elapsedSeconds(ts, nowMs)
  if (diff < MINUTE_SECONDS) return "刚刚"
  if (diff < HOUR_SECONDS) return `${whole(diff, MINUTE_SECONDS)} 分`
  if (diff < DAY_SECONDS) return `${whole(diff, HOUR_SECONDS)} 小时`
  if (diff < MONTH_SECONDS) return `${whole(diff, DAY_SECONDS)} 天`
  if (diff < YEAR_SECONDS) return `${whole(diff, MONTH_SECONDS)} 个月`
  return `${whole(diff, YEAR_SECONDS)} 年`
}

export function formatSessionAbsoluteTime(ts: number): string {
  if (!ts) return ""
  return new Date(ts * 1000).toLocaleString("zh-CN")
}
