import { pathExists, resolveLocalPath, type LocalPathInfo } from "@/lib/ipc"
import type { LocalFileReference } from "@/lib/localPath"

const STATUS_CACHE_MS = 2_000
const STATUS_CACHE_LIMIT = 256
const cache = new Map<string, { info: LocalPathInfo; loadedAt: number }>()
const requests = new Map<string, Promise<LocalPathInfo>>()

/** Called only on explicit open/menu intent, never while parsing streaming text. */
export function loadLocalFileStatus(reference: LocalFileReference): Promise<LocalPathInfo> {
  const key = reference.path
  const cached = cache.get(key)
  if (cached && Date.now() - cached.loadedAt < STATUS_CACHE_MS) return Promise.resolve(cached.info)
  const pending = requests.get(key)
  if (pending) return pending
  const request = (async () => {
    const path = /^~[\\/]/.test(key) ? await resolveLocalPath(key) : key
    const info = await pathExists(path, true)
    cache.delete(key)
    cache.set(key, { info, loadedAt: Date.now() })
    if (cache.size > STATUS_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    return info
  })().finally(() => requests.delete(key))
  requests.set(key, request)
  return request
}

export function localFileUnavailableReason(info: LocalPathInfo | null, error?: string | null): string | null {
  if (error) return `无法检查路径：${error}`
  if (!info) return "正在检查本地路径…"
  if (!info.exists) return "路径已删除或当前不可用；仍可复制路径"
  if (info.kind === "other") return "此路径不是常规文件或目录"
  return null
}
