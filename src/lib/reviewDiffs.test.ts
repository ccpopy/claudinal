import { afterEach, describe, expect, it, vi } from "vitest"
import { parseStoredReviewDiffs } from "./reviewDiffs"

function validEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "snap-1",
    createdAt: 1_700_000_000_000,
    diff: {
      isRepo: false,
      patchError: null,
      files: [
        {
          path: "src/a.ts",
          oldPath: null,
          status: "M",
          additions: 1,
          deletions: 1,
          binary: false,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-old", "+new"]
            }
          ]
        }
      ]
    },
    ...overrides
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("parseStoredReviewDiffs", () => {
  it("parses a well-formed sidecar payload", () => {
    const parsed = parseStoredReviewDiffs({ reviewDiffs: [validEntry()] })
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe("snap-1")
    expect(parsed[0].diff.files[0].path).toBe("src/a.ts")
    expect(parsed[0].diff.files[0].hunks[0].lines).toEqual(["-old", "+new"])
  })

  it("returns empty for missing sidecar or missing field", () => {
    expect(parseStoredReviewDiffs(null)).toEqual([])
    expect(parseStoredReviewDiffs(undefined)).toEqual([])
    expect(parseStoredReviewDiffs({})).toEqual([])
    expect(parseStoredReviewDiffs({ reviewDiffs: null })).toEqual([])
  })

  it("tolerates a non-array reviewDiffs instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(parseStoredReviewDiffs({ reviewDiffs: "corrupt" })).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it("tolerates a non-object sidecar instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(parseStoredReviewDiffs("corrupt")).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it("skips corrupt entries but keeps valid siblings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const parsed = parseStoredReviewDiffs({
      reviewDiffs: [
        validEntry({ id: "ok-1" }),
        validEntry({ createdAt: "not-a-number" }),
        { totally: "broken" },
        validEntry({ id: "ok-2" })
      ]
    })
    expect(parsed.map((entry) => entry.id)).toEqual(["ok-1", "ok-2"])
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it("rejects entries with malformed nested hunks without dropping the rest", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const broken = validEntry({ id: "broken" })
    ;(
      (broken.diff as { files: Array<{ hunks: unknown }> }).files[0]
    ).hunks = [{ lines: [42] }]
    const parsed = parseStoredReviewDiffs({
      reviewDiffs: [broken, validEntry({ id: "ok" })]
    })
    expect(parsed.map((entry) => entry.id)).toEqual(["ok"])
  })
})
