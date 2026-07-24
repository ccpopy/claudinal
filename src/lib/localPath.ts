const EXTENSIONLESS_FILE_NAMES = new Set([
  "authors",
  "changelog",
  "dockerfile",
  "gemfile",
  "license",
  "licence",
  "makefile",
  "notice",
  "procfile",
  "rakefile",
  "readme"
])

function trimPathReference(value: string): string {
  return value.trim().replace(/^<|>$/g, "")
}

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
  const trimmed = trimPathReference(value)
  return fileUrlToPath(trimmed) ?? (isLikelyLocalPath(trimmed) ? trimmed : null)
}

export function resolveOpenablePath(
  value: string,
  cwd?: string | null
): string | null {
  const direct = normalizeOpenablePath(value)
  if (direct) return direct
  const root = cwd ? normalizeOpenablePath(cwd) : null
  const relative = trimPathReference(value)
  const isPathLikeRelative =
    /^\.{1,2}[\\/]/.test(relative) ||
    /[\\/]/.test(relative) ||
    /^\.[a-zA-Z\d][a-zA-Z\d._-]*$/.test(relative) ||
    /^[^<>:"|?*\r\n]+\.[a-zA-Z\d]{1,12}$/.test(relative)
  if (
    !root ||
    !relative ||
    /^[#?]/.test(relative) ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(relative) ||
    !isPathLikeRelative
  ) {
    return null
  }
  const separator = root.includes("\\") ? "\\" : "/"
  const cleanRoot = root.replace(/[\\/]+$/, "")
  const cleanRelative = relative
    .replace(/^\.([\\/])/, "")
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]+/g, separator)
  return cleanRelative ? `${cleanRoot}${separator}${cleanRelative}` : cleanRoot
}

export function isLikelyMarkdownFileReference(value: string): boolean {
  const reference = trimPathReference(value)
  if (!reference || /^[#?]/.test(reference)) return false
  if (fileUrlToPath(reference) || isLikelyLocalPath(reference)) return true
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(reference)) return false
  if (/^\.{1,2}[\\/]/.test(reference)) return true

  const name = basename(reference).toLowerCase()
  if (!name) return false
  if (/^\.[a-z\d][a-z\d._-]*$/i.test(name)) return true
  if (EXTENSIONLESS_FILE_NAMES.has(name)) return true
  return /\.(?:[a-z][a-z\d]{0,11}|7z)$/i.test(name)
}

export function resolveMarkdownFilePath(
  value: string,
  cwd?: string | null
): string | null {
  if (!isLikelyMarkdownFileReference(value)) return null
  return resolveOpenablePath(value, cwd)
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] || path
}
