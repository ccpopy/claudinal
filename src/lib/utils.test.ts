import { describe, expect, it } from "vitest"
import { formatRunDuration } from "./utils"

describe("formatRunDuration", () => {
  it("formats milliseconds, seconds, minutes, and hours", () => {
    expect(formatRunDuration(950)).toBe("950ms")
    expect(formatRunDuration(1500)).toBe("1.5s")
    expect(formatRunDuration(95_000)).toBe("1m35s")
    expect(formatRunDuration(3_661_000)).toBe("1h1m")
  })

  it("uses whole seconds while a run is active", () => {
    expect(formatRunDuration(1500, true)).toBe("1s")
  })

  it("guards invalid values", () => {
    expect(formatRunDuration(Number.NaN)).toBe("0s")
    expect(formatRunDuration(-1)).toBe("0s")
  })
})
