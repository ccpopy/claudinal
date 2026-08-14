import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPathForDisplay(path: string | null | undefined) {
  const value = (path ?? "").trim()
  if (!value) return ""
  return value.replace(/\\/g, "/")
}

/**
 * 运行耗时的人类可读格式：<1s 用 ms；<1min 用秒（流式取整，完成保留 1 位小数）；
 * ≥1min 用 `XmYs`；≥1h 用 `XhYm`。聊天时间线（RunGroup / ResultView）统一走这里。
 */
export function formatRunDuration(ms: number, running = false): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  if (running) return `${totalSec}s`
  const sec = ms / 1000
  return Number.isInteger(sec) ? `${sec}s` : `${sec.toFixed(1)}s`
}
