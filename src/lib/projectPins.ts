const KEY = "claudinal.pinned-projects"

export interface PinnedProjectRef {
  projectId: string
  pinnedAt: number
}

function load(): PinnedProjectRef[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return normalizePinnedProjects(arr)
  } catch {
    return []
  }
}

function save(list: PinnedProjectRef[]) {
  localStorage.setItem(KEY, JSON.stringify(normalizePinnedProjects(list)))
}

function normalizePinnedProjects(values: unknown[]): PinnedProjectRef[] {
  const byProjectId = new Map<string, PinnedProjectRef>()
  for (const value of values) {
    if (!value || typeof value !== "object") continue
    const ref = value as Partial<PinnedProjectRef>
    if (typeof ref.projectId !== "string") continue
    const projectId = ref.projectId.trim()
    if (!projectId || typeof ref.pinnedAt !== "number") continue
    const existing = byProjectId.get(projectId)
    if (!existing || ref.pinnedAt > existing.pinnedAt) {
      byProjectId.set(projectId, { projectId, pinnedAt: ref.pinnedAt })
    }
  }
  return [...byProjectId.values()].sort((a, b) => b.pinnedAt - a.pinnedAt)
}

export function listPinnedProjects(): PinnedProjectRef[] {
  return load()
}

export function isProjectPinned(projectId: string): boolean {
  return load().some((p) => p.projectId === projectId)
}

export function pinProject(projectId: string) {
  const id = projectId.trim()
  if (!id || isProjectPinned(id)) return
  save([...load(), { projectId: id, pinnedAt: Date.now() }])
}

export function unpinProject(projectId: string) {
  save(load().filter((p) => p.projectId !== projectId))
}

export function toggleProjectPin(projectId: string): boolean {
  if (isProjectPinned(projectId)) {
    unpinProject(projectId)
    return false
  }
  pinProject(projectId)
  return true
}

export function prunePinnedProjects(validProjectIds: Iterable<string>): PinnedProjectRef[] {
  const valid = new Set(validProjectIds)
  const current = load()
  const next = current.filter((p) => valid.has(p.projectId))
  if (next.length !== current.length) save(next)
  return next
}
