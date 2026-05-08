export function fileUrlToPath(value: string): string | null {
  if (!value.toLowerCase().startsWith("file://")) return null
  try {
    const url = new URL(value)
    let path = decodeURIComponent(url.pathname)
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1)
    if (/^[a-zA-Z]:\//.test(path)) return path.replace(/\//g, "\\")
    return path
  } catch {
    return null
  }
}

export function isLikelyLocalPath(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (fileUrlToPath(trimmed)) return true
  if (/^[a-zA-Z]:[\\/][^:*?"<>|]+/.test(trimmed)) return true
  if (/^\\\\[^\\]+\\[^\\]+/.test(trimmed)) return true
  if (/^\/(?:[^/\0]+\/)*[^/\0]+$/.test(trimmed)) return true
  return false
}

export function normalizeOpenablePath(value: string): string | null {
  const trimmed = value.trim().replace(/^<|>$/g, "")
  return fileUrlToPath(trimmed) ?? (isLikelyLocalPath(trimmed) ? trimmed : null)
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] || path
}
