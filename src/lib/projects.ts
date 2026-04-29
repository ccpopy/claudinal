const KEY = "claudecli.projects"

export interface Project {
  id: string
  cwd: string
  name: string
  lastUsedAt: number
}

function load(): Project[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr as Project[]
  } catch {
    return []
  }
}

function save(list: Project[]) {
  localStorage.setItem(KEY, JSON.stringify(list))
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "")
}

export function listProjects(): Project[] {
  return load().sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export function addProject(cwd: string): Project {
  const cwdNorm = normalize(cwd)
  const list = load()
  const existing = list.find((p) => p.cwd === cwdNorm)
  if (existing) {
    existing.lastUsedAt = Date.now()
    save(list)
    return existing
  }
  const proj: Project = {
    id: uuid(),
    cwd: cwdNorm,
    name: basename(cwdNorm),
    lastUsedAt: Date.now()
  }
  list.push(proj)
  save(list)
  return proj
}

export function touchProject(id: string) {
  const list = load()
  const p = list.find((x) => x.id === id)
  if (p) {
    p.lastUsedAt = Date.now()
    save(list)
  }
}

export function removeProject(id: string) {
  save(load().filter((p) => p.id !== id))
}
