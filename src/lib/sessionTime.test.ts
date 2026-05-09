import { describe, expect, it } from "vitest"
import {
  formatSessionCompactTime,
  formatSessionRelativeTime
} from "./sessionTime"

const now = Date.UTC(2026, 4, 9, 12, 0, 0)
const secondsAgo = (seconds: number) => Math.floor((now - seconds * 1000) / 1000)

describe("sessionTime", () => {
  it("keeps the existing minute and hour style", () => {
    expect(formatSessionCompactTime(secondsAgo(7 * 60), now)).toBe("7 分")
    expect(formatSessionRelativeTime(secondsAgo(7 * 60), now)).toBe("7 分钟前")
    expect(formatSessionCompactTime(secondsAgo(3 * 3600), now)).toBe("3 小时")
    expect(formatSessionRelativeTime(secondsAgo(3 * 3600), now)).toBe("3 小时前")
  })

  it("uses day and month durations instead of calendar month/day strings", () => {
    expect(formatSessionCompactTime(secondsAgo(8 * 86400), now)).toBe("8 天")
    expect(formatSessionRelativeTime(secondsAgo(8 * 86400), now)).toBe("8 天前")
    expect(formatSessionCompactTime(secondsAgo(45 * 86400), now)).toBe("1 个月")
    expect(formatSessionRelativeTime(secondsAgo(45 * 86400), now)).toBe("1 个月前")
  })
})
