export interface TimelineGeometry {
  id: string
  top: number
  height: number
}

/** Ordered, non-overlapping message targets; runs can occupy the gaps. */
export function timelineWindow(index: readonly TimelineGeometry[], top: number, height: number) {
  let lo = 0
  let hi = index.length
  const anchor = top + Math.max(height, 0) * 0.32
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (index[mid].top <= anchor) lo = mid + 1
    else hi = mid
  }
  const activeId = index[Math.max(lo - 1, 0)]?.id ?? null
  lo = 0
  hi = index.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (index[mid].top + Math.max(index[mid].height, 0) <= top) lo = mid + 1
    else hi = mid
  }
  const visibleIds: string[] = []
  const bottom = top + Math.max(height, 0)
  for (let i = lo; i < index.length && index[i].top < bottom; i++) {
    if (index[i].top + Math.max(index[i].height, 0) > top) visibleIds.push(index[i].id)
  }
  return { activeId, visibleIds }
}

export interface TimelineAnchor { id: string; offset: number }

export function timelineScrollAnchor(index: readonly TimelineGeometry[], top: number): TimelineAnchor | null {
  const { activeId } = timelineWindow(index, top, 0)
  if (!activeId) return null
  // The id lookup is only done when layout changes, never on the scroll path.
  const target = index.find((item) => item.id === activeId)!
  return { id: activeId, offset: top - target.top }
}

export function restoreTimelineAnchor(index: readonly TimelineGeometry[], anchor: TimelineAnchor | null): number | null {
  if (!anchor) return null
  const target = index.find((item) => item.id === anchor.id)
  return target ? Math.max(0, target.top + anchor.offset) : null
}
