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

export type ReferenceSource = "inline_code" | "markdown_link" | "code_block" | "tool" | "git" | "attachment" | "explicit"
export type PathPlatform = "windows" | "posix"

export interface LocalFileReference {
  path: string
  line?: number
  column?: number
  kind: "file" | "directory" | "unknown"
  source: ReferenceSource
  original: string
  /** A bare POSIX root name needs user-initiated filesystem confirmation. */
  needsConfirmation?: boolean
}

export interface ReferenceOptions {
  source: ReferenceSource
  cwd?: string | null
  platform?: PathPlatform
  home?: string | null
  commands?: readonly string[]
}

export type ReferenceClassification =
  | { kind: "local"; reference: LocalFileReference }
  | { kind: "command" | "external" | "code"; original: string; source: ReferenceSource }

const BUILTIN_COMMANDS = new Set("compact model clear reset permissions help cost context config status login logout resume fork rewind rename memory review init doctor agents skills plugin plugins mcp hooks tasks fast effort plan output-style terminal-setup theme vim export copy add-dir insights usage ultrathink ultracode".split(" "))

function trimPathReference(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed
}

function platformFor(value: string, options: Pick<ReferenceOptions, "cwd" | "platform">): PathPlatform {
  // file:///C:/… is a Windows path too; without a cwd only the reference itself can tell.
  return options.platform ?? (/^[a-z]:[\\/]|^\\\\|^file:\/\/\/[a-z]:\//i.test(options.cwd ?? value) ? "windows" : "posix")
}

export function fileUrlToPath(value: string, platform?: PathPlatform): string | null {
  if (!/^file:\/\//i.test(value)) return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.port || url.search) return null
    let path = decodeURIComponent(url.pathname)
    const windows = platform === "windows" || (!platform && /^\/[a-z]:\//i.test(path))
    if (url.hostname && url.hostname !== "localhost") {
      return windows ? `\\\\${url.hostname}${path.replace(/\//g, "\\")}` : `//${url.hostname}${path}`
    }
    if (windows && /^\/[a-z]:\//i.test(path)) path = path.slice(1)
    return windows ? path.replace(/\//g, "\\") : path
  } catch {
    return null
  }
}

function isAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]|^\\\\[^\\]+\\[^\\]+|^\//i.test(value)
}

/** Lexical normalization: does not query disk or decode ordinary filenames. */
function normalizePath(value: string, platform: PathPlatform): string {
  const windows = platform === "windows"
  const separator = windows ? "\\" : "/"
  const path = windows ? value.replace(/\//g, "\\") : value
  const rootMatch = windows ? /^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\?)/i.exec(path) : /^(?:\/\/[^/]+\/[^/]+\/?|\/)/.exec(path)
  const root = rootMatch?.[0] ?? ""
  const parts: string[] = []
  for (const part of path.slice(root.length).split(separator)) {
    if (!part || part === ".") continue
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop()
    else if (part !== ".." || !root) parts.push(part)
  }
  return root + (root && !root.endsWith(separator) && parts.length ? separator : "") + parts.join(separator)
}

function fileShaped(value: string): boolean {
  const name = basename(value).toLowerCase()
  if (name.startsWith(".")) return isKnownDotfileName(name)
  if (EXTENSIONLESS_FILE_NAMES.has(name)) return true
  return BARE_FILE_EXTENSIONS.has(name.split(".").pop() ?? "")
}

function splitLocation(value: string): { path: string; line?: number; column?: number } {
  const fragment = /#L([1-9]\d*)(?:C([1-9]\d*))?$/.exec(value)
  const suffix = fragment ?? /:([1-9]\d*)(?::([1-9]\d*))?$/.exec(value)
  if (!suffix) return { path: value }
  const line = Number(suffix[1])
  const column = suffix[2] ? Number(suffix[2]) : undefined
  if (!Number.isSafeInteger(line) || (column !== undefined && !Number.isSafeInteger(column))) return { path: value }
  return { path: value.slice(0, suffix.index), line, column }
}

export function classifyReference(value: string, options: ReferenceOptions): ReferenceClassification {
  const ordinary = (kind: "command" | "external" | "code"): ReferenceClassification => ({ kind, original: value, source: options.source })
  if (options.source === "code_block") return ordinary("code")
  const raw = trimPathReference(value)
  if (!raw || /[\0\r\n]/.test(raw)) {
    return ordinary(/^\/[\w.:-]+(?:\s|$)/.test(raw) ? "command" : "code")
  }
  const guaranteed = ["tool", "git", "attachment", "explicit"].includes(options.source)
  if (!guaranteed && /^(?:[a-z][a-z\d+.-]*:(?![\\/])|https?:\/\/|\/\/)/i.test(raw) && !/^file:\/\//i.test(raw)) {
    return ordinary("external")
  }
  const location = options.source === "git" || options.source === "attachment" ? { path: raw } : splitLocation(raw)
  let pathValue = location.path
  // Markdown destinations are URLs. Decode their path once, after splitting the
  // explicit location fragment, while preserving percent signs in inline filenames.
  if (options.source === "markdown_link" && !/^file:\/\//i.test(pathValue)) {
    try { pathValue = decodeURIComponent(pathValue) } catch { return ordinary("code") }
  }
  const token = /^\/([\w.:-]+)(?=\s|$)/.exec(pathValue)
  if (!guaranteed && token) {
    const name = token[1]
    const known = BUILTIN_COMMANDS.has(name) || options.commands?.some((command) => command.replace(/^\//, "") === name)
    if (known || name.includes(":") || pathValue.slice(token[0].length).trim()) return ordinary("command")
    // An unknown dotted slash command stays ordinary unless its basename is file-shaped.
    if (name.includes(".") && !fileShaped(pathValue)) return ordinary("code")
  }
  if (!guaranteed && /\s(?:--?\w|&&|\|\||[|;])|^(?:npm|pnpm|yarn|git|node|python|bash|sh|cmd|powershell|cargo|rg|echo|cd)\s|^\S+\.(?:sh|bash|cmd|bat|ps1|exe)\s+\S/.test(pathValue)) return ordinary("code")
  if (/^[#?]/.test(pathValue) || /^[a-z][a-z\d+.-]*:/i.test(pathValue) && !/^[a-z]:[\\/]|^file:\/\//i.test(pathValue) && (!guaranteed || /^[a-z][a-z\d+.-]*:\/\//i.test(pathValue))) return ordinary("external")
  const platform = platformFor(pathValue, options)
  const filePath = /^file:\/\//i.test(pathValue) ? fileUrlToPath(pathValue, platform) : pathValue
  if (!filePath || /[\0\r\n]/.test(filePath)) return ordinary("code")
  const home = /^~[\\/]/.test(filePath)
  const explicit = isAbsolutePath(filePath) || /^\.{1,2}[\\/]/.test(filePath) || home
  if (!guaranteed && !explicit && !fileShaped(filePath)) return ordinary("code")
  let path = filePath
  if (home) {
    if (options.home) path = `${options.home.replace(/[\\/]+$/, "")}/${filePath.slice(2)}`
    // Native runtime resolves ~ on user intent; it must never join the project cwd.
  } else if (!isAbsolutePath(path)) {
    if (!options.cwd || !isAbsolutePath(options.cwd)) return ordinary("code")
    path = `${options.cwd.replace(/[\\/]+$/, "")}/${path}`
  }
  path = normalizePath(path, platform)
  const needsConfirmation = !guaranteed && /^\/[^/]+$/.test(filePath) && !fileShaped(filePath)
  return { kind: "local", reference: { path, ...("line" in location ? { line: location.line, column: location.column } : {}), kind: /[\\/]$/.test(filePath) || filePath === "/" ? "directory" : fileShaped(filePath) ? "file" : "unknown", source: options.source, original: value, ...(needsConfirmation ? { needsConfirmation: true } : {}) } }
}

export function parseLocalFileReference(value: string, options: ReferenceOptions): LocalFileReference | null {
  const result = classifyReference(value, options)
  return result.kind === "local" ? result.reference : null
}

export function isLikelyLocalPath(value: string): boolean {
  return !!normalizeOpenablePath(value)
}

export function normalizeOpenablePath(value: string): string | null {
  const path = trimPathReference(value)
  if (!isAbsolutePath(path) && !/^file:\/\//i.test(path)) return null
  return parseLocalFileReference(path, { source: "explicit" })?.path ?? null
}

export function resolveOpenablePath(value: string, cwd?: string | null): string | null {
  return parseLocalFileReference(value, { source: "explicit", cwd })?.path ?? null
}

export function isLikelyMarkdownFileReference(value: string): boolean {
  return !!parseLocalFileReference(value, { source: "inline_code", cwd: "/" })
}

export function resolveMarkdownFilePath(value: string, cwd?: string | null): string | null {
  return parseLocalFileReference(value, { source: "inline_code", cwd })?.path ?? null
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] || path
}
