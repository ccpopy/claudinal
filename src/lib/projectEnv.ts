const KEY = "claudinal.project-env"

export type EnvPlatform = "default" | "macos" | "linux" | "windows"

export interface PlatformScripts {
  default?: string
  macos?: string
  linux?: string
  windows?: string
}

export interface ProjectEnvAction {
  id: string
  label: string
  command: string
}

export interface ProjectEnvConfig {
  name?: string
  setupScripts?: PlatformScripts
  cleanupScripts?: PlatformScripts
  actions?: ProjectEnvAction[]
}

export type ProjectEnvStore = Record<string, ProjectEnvConfig>

export const EMPTY_SCRIPTS: Record<EnvPlatform, string> = {
  default: "",
  macos: "",
  linux: "",
  windows: ""
}

const PLATFORMS: EnvPlatform[] = ["default", "macos", "linux", "windows"]

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeScripts(value: unknown): PlatformScripts {
  if (!isObject(value)) return {}
  return Object.fromEntries(
    PLATFORMS.map((platform) => {
      const script = value[platform]
      return [platform, typeof script === "string" ? script : ""]
    }).filter(([, script]) => String(script).trim())
  )
}

function normalizeConfig(value: unknown): ProjectEnvConfig {
  if (!isObject(value)) return { actions: [] }
  const actions = Array.isArray(value.actions)
    ? value.actions
        .filter(
          (action): action is ProjectEnvAction =>
            isObject(action) &&
            typeof action.id === "string" &&
            typeof action.label === "string" &&
            typeof action.command === "string"
        )
        .map((action) => ({
          id: action.id.trim(),
          label: action.label.trim(),
          command: action.command.trim()
        }))
        .filter((action) => action.id && action.label && action.command)
    : []
  const config: ProjectEnvConfig = {
    setupScripts: normalizeScripts(value.setupScripts),
    cleanupScripts: normalizeScripts(value.cleanupScripts),
    actions
  }
  if (typeof value.name === "string" && value.name.trim()) {
    config.name = value.name.trim()
  }
  return config
}

export function completeScripts(
  value: PlatformScripts | undefined
): Record<EnvPlatform, string> {
  return { ...EMPTY_SCRIPTS, ...(value ?? {}) }
}

export function compactScripts(
  value: Record<EnvPlatform, string>
): PlatformScripts {
  return Object.fromEntries(
    PLATFORMS.map((platform) => [platform, value[platform].trimEnd()] as const)
      .filter(([, script]) => script.trim())
  )
}

export function loadProjectEnvStore(): ProjectEnvStore {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    if (!isObject(obj)) return {}
    return Object.fromEntries(
      Object.entries(obj).map(([projectId, value]) => [
        projectId,
        normalizeConfig(value)
      ])
    )
  } catch {
    return {}
  }
}

export function saveProjectEnvStore(store: ProjectEnvStore) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // ignore localStorage quota / private mode failures
  }
}

export function getProjectEnv(
  store: ProjectEnvStore,
  projectId: string
): ProjectEnvConfig {
  return store[projectId] ?? { actions: [] }
}

export function saveProjectEnv(
  projectId: string,
  config: ProjectEnvConfig
): ProjectEnvStore {
  const store = loadProjectEnvStore()
  store[projectId] = normalizeConfig(config)
  saveProjectEnvStore(store)
  return store
}

export function configuredScriptCount(config: ProjectEnvConfig): number {
  return (
    Object.keys(config.setupScripts ?? {}).length +
    Object.keys(config.cleanupScripts ?? {}).length
  )
}

