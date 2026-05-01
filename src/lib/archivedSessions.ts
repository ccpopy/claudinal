const KEY = "claudinal.archived-sessions"

export interface ArchivedRef {
  projectId: string
  sessionId: string
  archivedAt: number
}

function load(): ArchivedRef[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr as ArchivedRef[]
  } catch {
    return []
  }
}

function save(list: ArchivedRef[]) {
  localStorage.setItem(KEY, JSON.stringify(list))
}

export function listArchived(): ArchivedRef[] {
  return load().sort((a, b) => b.archivedAt - a.archivedAt)
}

export function isArchived(projectId: string, sessionId: string): boolean {
  return load().some(
    (a) => a.projectId === projectId && a.sessionId === sessionId
  )
}

export function archive(projectId: string, sessionId: string) {
  const list = load()
  if (
    list.some((a) => a.projectId === projectId && a.sessionId === sessionId)
  )
    return
  list.push({ projectId, sessionId, archivedAt: Date.now() })
  save(list)
}

export function unarchive(projectId: string, sessionId: string) {
  save(
    load().filter(
      (a) => !(a.projectId === projectId && a.sessionId === sessionId)
    )
  )
}

export function toggleArchive(projectId: string, sessionId: string): boolean {
  if (isArchived(projectId, sessionId)) {
    unarchive(projectId, sessionId)
    return false
  }
  archive(projectId, sessionId)
  return true
}

export function unarchiveAllForProject(projectId: string) {
  save(load().filter((a) => a.projectId !== projectId))
}
