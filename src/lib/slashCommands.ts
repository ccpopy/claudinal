// 缓存最近一次 system/init.slash_commands 列表，给设置页 / Composer 复用。
// 设置页里给"高频命令 pin"做选项时不希望强制等待新会话来注入候选。

const KEY = "claudinal.slash-commands.scoped-cache.v2"
let generation = 0
export function slashCommandGeneration(): number { return generation }
export interface SlashCommandScope { cwd: string; cliFingerprint: string; configuration: string; generation?: number }
function scopeKey(scope: SlashCommandScope): string {
  const windows = /^[a-z]:|^\\\\/i.test(scope.cwd)
  const cwd = scope.cwd.replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  return JSON.stringify([windows ? cwd.toLowerCase() : cwd, scope.cliFingerprint, scope.configuration, scope.generation ?? 0])
}
export function invalidateSlashCommandsCache(): void {
  generation++
  try { localStorage.removeItem(KEY) } catch { /* cache is optional */ }
}

export interface SlashCommandSkill {
  name: string
  user_invocable: boolean
}

function cleanSlashCommand(value: string): string {
  return value.trim().replace(/^\/+/, "")
}

export function mergeSlashCommands(...lists: string[][]): string[] {
  return Array.from(
    new Set(
      lists
        .flat()
        .map(cleanSlashCommand)
        .filter(Boolean)
    )
  )
}

export function slashCommandsFromSkills(
  skills: SlashCommandSkill[]
): string[] {
  return mergeSlashCommands(
    skills
      .filter((skill) => skill.user_invocable)
      .map((skill) => skill.name)
  )
}

export function loadSlashCommandsCache(scope?: SlashCommandScope): string[] {
  if (!scope?.cliFingerprint) return []
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)[scopeKey(scope)]
    if (Array.isArray(arr) && arr.every((s) => typeof s === "string")) {
      return arr as string[]
    }
  } catch {
    // ignore
  }
  return []
}

export function saveSlashCommandsCache(commands: string[], scope?: SlashCommandScope) {
  if (!scope?.cliFingerprint) return
  try {
    const uniq = mergeSlashCommands(commands)
    const raw = localStorage.getItem(KEY)
    const previous = raw ? JSON.parse(raw) : {}
    const entries = Object.entries(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {})
      .filter(([key]) => key !== scopeKey(scope)).slice(-15)
    localStorage.setItem(KEY, JSON.stringify({ ...Object.fromEntries(entries), [scopeKey(scope)]: uniq }))
  } catch {
    // ignore
  }
}
