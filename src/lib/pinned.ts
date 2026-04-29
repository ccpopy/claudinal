const KEY = "claudinal.pinned"

export interface PinnedRef {
  projectId: string
  sessionId: string
  pinnedAt: number
}

function load(): PinnedRef[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr as PinnedRef[]
  } catch {
    return []
  }
}

function save(list: PinnedRef[]) {
  localStorage.setItem(KEY, JSON.stringify(list))
}

export function listPinned(): PinnedRef[] {
  return load().sort((a, b) => b.pinnedAt - a.pinnedAt)
}

export function isPinned(projectId: string, sessionId: string): boolean {
  return load().some(
    (p) => p.projectId === projectId && p.sessionId === sessionId
  )
}

export function pin(projectId: string, sessionId: string) {
  const list = load()
  if (list.some((p) => p.projectId === projectId && p.sessionId === sessionId))
    return
  list.push({ projectId, sessionId, pinnedAt: Date.now() })
  save(list)
}

export function unpin(projectId: string, sessionId: string) {
  save(
    load().filter(
      (p) => !(p.projectId === projectId && p.sessionId === sessionId)
    )
  )
}

export function togglePin(projectId: string, sessionId: string): boolean {
  if (isPinned(projectId, sessionId)) {
    unpin(projectId, sessionId)
    return false
  }
  pin(projectId, sessionId)
  return true
}
