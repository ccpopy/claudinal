/**
 * Return the shortest trailing path labels that make every input distinguishable.
 * Unique basenames stay compact; duplicate trees grow one parent segment at a time.
 */
export function shortestUniquePathLabels(paths: readonly string[]): string[] {
  const parts = paths.map((path) =>
    path.replace(/\\/g, "/").split("/").filter(Boolean)
  )

  const labels = parts.map((segments, index) => {
    if (segments.length === 0) return paths[index]
    for (let depth = 1; depth <= segments.length; depth++) {
      const suffix = segments.slice(-depth).join("/")
      const unique = parts.every((other, otherIndex) => {
        if (otherIndex === index) return true
        return other.slice(-depth).join("/") !== suffix
      })
      if (unique) return suffix
    }
    return segments.join("/")
  })

  // The same path may legitimately appear under multiple diff sources. No path
  // suffix can distinguish those rows, so add a stable occurrence suffix.
  const totals = new Map<string, number>()
  for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + 1)
  const seen = new Map<string, number>()
  return labels.map((label) => {
    if ((totals.get(label) ?? 0) <= 1) return label
    const occurrence = (seen.get(label) ?? 0) + 1
    seen.set(label, occurrence)
    return `${label} (${occurrence})`
  })
}
