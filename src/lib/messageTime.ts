/** Compact hover label like chat apps: today "12:21", this year "10月28日 12:21", else with year. */
export function formatMessageTime(ts: number | undefined, now = Date.now()): string {
  const date = timestampDate(ts)
  if (!date) return ""
  const today = new Date(now)
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
  if (date.toDateString() === today.toDateString()) return time
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === today.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}年${day} ${time}`
}

/** Full timestamp for the native tooltip. */
export function formatMessageTimeFull(ts: number | undefined): string {
  const date = timestampDate(ts)
  if (!date) return ""
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(date)
}

function timestampDate(ts: number | undefined): Date | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null
  const date = new Date(ts)
  return Number.isFinite(date.getTime()) ? date : null
}
