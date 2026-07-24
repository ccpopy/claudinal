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

const KNOWN_DOTFILE_NAMES = new Set([
  ".babelrc",
  ".browserslistrc",
  ".dockerignore",
  ".editorconfig",
  ".eslintignore",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".gitkeep",
  ".gitmodules",
  ".npmignore",
  ".npmrc",
  ".nvmrc",
  ".prettierignore",
  ".prettierrc",
  ".python-version",
  ".ruby-version",
  ".stylelintignore",
  ".stylelintrc",
  ".swcrc",
  ".tool-versions",
  ".yarnrc"
])

const CONFIG_DOTFILE_STEMS = new Set([
  ".babelrc",
  ".eslintrc",
  ".prettierrc",
  ".stylelintrc",
  ".yarnrc"
])

const CONFIG_DOTFILE_EXTENSIONS = new Set([
  "cjs",
  "js",
  "json",
  "jsonc",
  "mjs",
  "toml",
  "yaml",
  "yml"
])

// Bare inline-code tokens are ambiguous: `Math.round` and a filename have the
// same shape. Keep this list intentionally conservative. Explicit relative,
// absolute, and file:// paths are accepted before this allowlist is consulted.
const BARE_FILE_EXTENSION_GROUPS = [
  // Source code and web assets.
  "c cc cjs coffee cpp cs cts cxx dart go h hh hpp hxx java js jsx kt kts mjs mts php py pyw rb rs swift ts tsx",
  "astro cshtml css ejs handlebars hbs htm html json jsonc jsonl less markdown md mdx pug razor sass scss styl stylus svelte vue xhtml xml xsl xslt",
  // Archives, packages, and binaries.
  "7z apk bin bz bz2 cab class dat deb dll dmg dylib ear exe gz iso jar lz lz4 msi rar rpm so tar tgz war wasm xz zip zst",
  // Configuration, shell, credential, and data files.
  "asc bash bat cer cfg cmd conf config crt env fish gpg ini key lock p12 pem pfx properties ps1 psd1 psm1 pub sh toml yaml yml zsh",
  "db db3 ipynb mdb sql sqlite sqlite3",
  // Documents and media.
  "csv doc docm docx dot dotx numbers odp ods odt pages pdf ppt pptm pptx rtf text tsv txt xls xlsb xlsm xlsx",
  "aac ai avi avif bmp eot fig flac flv gif heic ico jpeg jpg m4a m4v mkv mov mp3 mp4 mpeg mpg ogg opus otf png psd sketch svg tif tiff ttf wav webm webp wma wmv woff woff2 xd",
  "azw azw3 epub mobi"
]

const BARE_FILE_EXTENSIONS = new Set(
  BARE_FILE_EXTENSION_GROUPS.flatMap((group) => group.split(" "))
)

function isKnownDotfileName(name: string): boolean {
  if (KNOWN_DOTFILE_NAMES.has(name)) return true
  if (/^\.env(?:\.[a-z\d_-]+)*$/i.test(name)) return true

  const separatorIndex = name.lastIndexOf(".")
  if (separatorIndex <= 0) return false
  return (
    CONFIG_DOTFILE_STEMS.has(name.slice(0, separatorIndex)) &&
    CONFIG_DOTFILE_EXTENSIONS.has(name.slice(separatorIndex + 1))
  )
}

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
  if (name.startsWith(".")) return isKnownDotfileName(name)
  if (EXTENSIONLESS_FILE_NAMES.has(name)) return true
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : ""
  return BARE_FILE_EXTENSIONS.has(extension)
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
