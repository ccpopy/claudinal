// 缓存最近一次 system/init.slash_commands 列表，给设置页 / Composer 复用。
// 设置页里给"高频命令 pin"做选项时不希望强制等待新会话来注入候选。

const KEY = "claudinal.slash-commands.cache"

export function loadSlashCommandsCache(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.every((s) => typeof s === "string")) {
      return arr as string[]
    }
  } catch {
    // ignore
  }
  return []
}

export function saveSlashCommandsCache(commands: string[]) {
  try {
    const uniq = Array.from(new Set(commands.map((s) => s.trim()).filter(Boolean)))
    localStorage.setItem(KEY, JSON.stringify(uniq))
  } catch {
    // ignore
  }
}
