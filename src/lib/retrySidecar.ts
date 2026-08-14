import type { ReviewRunDiff } from "@/lib/diff"
import { parseStoredReviewDiffs } from "@/lib/reviewDiffs"

export interface RetrySidecarPatch {
  patch: Record<string, unknown>
  keptReviews: ReviewRunDiff[]
}

export function buildRetrySidecarPatch(
  sidecar: Record<string, unknown>,
  cutoffTs: number,
  eventTimestampMillis: (value: unknown) => number | null
): RetrySidecarPatch {
  const keptReviews = parseStoredReviewDiffs(sidecar).filter(
    (review) => review.createdAt < cutoffTs
  )
  const patch: Record<string, unknown> = {
    reviewDiffs: keptReviews.length > 0 ? keptReviews : null
  }
  const result = sidecar.result
  const resultTs = eventTimestampMillis(result)
  if (result && (resultTs === null || resultTs >= cutoffTs)) patch.result = null
  return { patch, keptReviews }
}
