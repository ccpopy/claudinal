import { describe, expect, it } from "vitest"
import { buildRetrySidecarPatch } from "./retrySidecar"

const review = (id: string, createdAt: number) => ({
  id,
  createdAt,
  diff: { isRepo: false, patchError: null, files: [] }
})

const timestamp = (value: unknown): number | null => {
  if (!value || typeof value !== "object") return null
  const raw = (value as { timestamp?: unknown }).timestamp
  return typeof raw === "number" ? raw : null
}

describe("buildRetrySidecarPatch", () => {
  it("preserves a result older than the retry cutoff", () => {
    const { patch } = buildRetrySidecarPatch(
      { result: { timestamp: 100 }, unrelated: true },
      200,
      timestamp
    )

    expect(patch).toEqual({ reviewDiffs: null })
  })

  it("deletes a result at or after the cutoff and filters review diffs", () => {
    const { patch, keptReviews } = buildRetrySidecarPatch(
      {
        result: { timestamp: 200 },
        reviewDiffs: [
          review("keep", 100),
          review("drop", 200)
        ]
      },
      200,
      timestamp
    )

    expect(keptReviews.map((review) => review.id)).toEqual(["keep"])
    expect(patch).toEqual({
      result: null,
      reviewDiffs: [review("keep", 100)]
    })
  })

  it("deletes an undated result conservatively", () => {
    const { patch } = buildRetrySidecarPatch(
      { result: { type: "result" } },
      200,
      timestamp
    )

    expect(patch).toEqual({ result: null, reviewDiffs: null })
  })
})
