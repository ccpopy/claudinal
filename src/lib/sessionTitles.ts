const KEY = "claudinal.session-titles"

type TitleMap = Record<string, string>

function load(): TitleMap {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    if (obj && typeof obj === "object" && !Array.isArray(obj))
      return obj as TitleMap
    return {}
  } catch {
    return {}
  }
}

function save(map: TitleMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

export function getSessionTitle(sessionId: string): string | null {
  if (!sessionId) return null
  const t = load()[sessionId]
  return t && t.trim() ? t : null
}

export function setSessionTitle(sessionId: string, title: string) {
  const map = load()
  const trimmed = title.trim()
  if (!trimmed) {
    delete map[sessionId]
  } else {
    map[sessionId] = trimmed.slice(0, 200)
  }
  save(map)
}

export function clearSessionTitle(sessionId: string) {
  const map = load()
  if (map[sessionId]) {
    delete map[sessionId]
    save(map)
  }
}
