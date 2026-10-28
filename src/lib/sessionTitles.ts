const KEY = "claudinal.session-titles"
// App-generated titles live apart from user renames, which always win.
const GENERATED_KEY = "claudinal.session-generated-titles"
const ATTEMPTS_KEY = "claudinal.session-title-attempts"
const GENERATED_LIMIT = 2000

type TitleMap = Record<string, string>

function load(key = KEY): TitleMap {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    if (obj && typeof obj === "object" && !Array.isArray(obj))
      return obj as TitleMap
    return {}
  } catch {
    return {}
  }
}

function save(map: TitleMap, key = KEY) {
  try {
    localStorage.setItem(key, JSON.stringify(map))
  } catch {
    // ignore
  }
}

export function getSessionTitle(sessionId: string): string | null {
  if (!sessionId) return null
  const t = load()[sessionId]
  return typeof t === "string" && t.trim() ? t : null
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

function generatedTitleKey(sessionId: string, cwd: string): string {
  return JSON.stringify([cwd.replace(/\\/g, "/").replace(/\/+$/, ""), sessionId])
}

export function getGeneratedSessionTitle(sessionId: string, cwd: string): string | null {
  if (!sessionId || !cwd) return null
  const t = load(GENERATED_KEY)[generatedTitleKey(sessionId, cwd)]
  return typeof t === "string" && t.trim() ? t : null
}

export function setGeneratedSessionTitle(sessionId: string, title: string, cwd: string) {
  const trimmed = title.trim()
  if (!sessionId || !cwd || !trimmed) return
  saveBoundedTitleValue(GENERATED_KEY, generatedTitleKey(sessionId, cwd), trimmed.slice(0, 200))
}

/** Persist before the request so failures/restarts do not silently spend again. */
export function claimSessionTitleAttempt(sessionId: string, cwd: string): boolean {
  if (!sessionId || !cwd) return false
  const key = generatedTitleKey(sessionId, cwd)
  if (load(ATTEMPTS_KEY)[key]) return false
  saveBoundedTitleValue(ATTEMPTS_KEY, key, "attempted")
  return true
}

function saveBoundedTitleValue(storageKey: string, key: string, value: string) {
  const map = load(storageKey)
  delete map[key]
  map[key] = value
  // Bounded, oldest first: insertion order is preserved by JSON objects with string keys.
  const keys = Object.keys(map)
  for (const key of keys.slice(0, Math.max(0, keys.length - GENERATED_LIMIT))) delete map[key]
  save(map, storageKey)
}

export function clearSessionTitle(sessionId: string) {
  const map = load()
  if (map[sessionId]) {
    delete map[sessionId]
    save(map)
  }
}
