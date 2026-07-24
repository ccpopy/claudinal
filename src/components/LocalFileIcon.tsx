import {
  Atom,
  Binary,
  BookOpen,
  Braces,
  Database,
  FileArchive,
  FileAudio,
  FileCode2,
  FileCog,
  FileImage,
  FileLock2,
  FileText,
  FileType2,
  FileVideo,
  Package,
  Terminal,
  type LucideIcon
} from "lucide-react"
import { basename } from "@/lib/localPath"
import { cn } from "@/lib/utils"

interface Props {
  path: string
  className?: string
}

export type LocalFileIconKind =
  | "archive"
  | "audio"
  | "binary"
  | "book"
  | "c"
  | "code"
  | "config"
  | "cpp"
  | "css"
  | "csharp"
  | "database"
  | "dart"
  | "document"
  | "font"
  | "go"
  | "html"
  | "image"
  | "javascript"
  | "java"
  | "json"
  | "kotlin"
  | "lock"
  | "markdown"
  | "package"
  | "pdf"
  | "php"
  | "presentation"
  | "python"
  | "react"
  | "ruby"
  | "rust"
  | "sass"
  | "spreadsheet"
  | "svelte"
  | "swift"
  | "terminal"
  | "text"
  | "typescript"
  | "video"
  | "vue"

const ARCHIVE_EXTENSIONS = new Set([
  "7z",
  "apk",
  "bz",
  "bz2",
  "cab",
  "deb",
  "dmg",
  "ear",
  "gz",
  "iso",
  "jar",
  "lz",
  "lz4",
  "rar",
  "rpm",
  "tar",
  "tgz",
  "war",
  "xz",
  "zip",
  "zst"
])
const AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "wav",
  "wma"
])
const BINARY_EXTENSIONS = new Set([
  "bin",
  "class",
  "dat",
  "dll",
  "dylib",
  "exe",
  "msi",
  "so",
  "wasm"
])
const BOOK_EXTENSIONS = new Set(["azw", "azw3", "epub", "mobi"])
const CONFIG_EXTENSIONS = new Set([
  "cfg",
  "conf",
  "config",
  "env",
  "ini",
  "properties",
  "toml",
  "yaml",
  "yml"
])
const DATABASE_EXTENSIONS = new Set([
  "db",
  "db3",
  "mdb",
  "sql",
  "sqlite",
  "sqlite3"
])
const DOCUMENT_EXTENSIONS = new Set([
  "doc",
  "docm",
  "docx",
  "dot",
  "dotx",
  "odt",
  "pages",
  "rtf"
])
const FONT_EXTENSIONS = new Set(["eot", "otf", "ttf", "woff", "woff2"])
const IMAGE_EXTENSIONS = new Set([
  "ai",
  "avif",
  "bmp",
  "fig",
  "gif",
  "heic",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "psd",
  "sketch",
  "svg",
  "tif",
  "tiff",
  "webp",
  "xd"
])
const LOCK_EXTENSIONS = new Set([
  "asc",
  "cer",
  "crt",
  "gpg",
  "key",
  "lock",
  "p12",
  "pem",
  "pfx",
  "pub"
])
const PRESENTATION_EXTENSIONS = new Set(["odp", "ppt", "pptm", "pptx"])
const SHEET_EXTENSIONS = new Set([
  "csv",
  "numbers",
  "ods",
  "tsv",
  "xls",
  "xlsb",
  "xlsm",
  "xlsx"
])
const TERMINAL_EXTENSIONS = new Set([
  "bash",
  "bat",
  "cmd",
  "fish",
  "ps1",
  "psd1",
  "psm1",
  "sh",
  "zsh"
])
const VIDEO_EXTENSIONS = new Set([
  "avi",
  "flv",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "webm",
  "wmv"
])

function extensionOf(name: string): string {
  return name.includes(".") ? name.split(".").pop() ?? "" : ""
}

export function localFileIconKind(path: string): LocalFileIconKind {
  const name = basename(path).toLowerCase()
  const extension = extensionOf(name)

  if (["dockerfile", "gemfile", "package-lock.json", "yarn.lock"].includes(name)) {
    return "package"
  }
  if (["makefile", "procfile"].includes(name)) return "terminal"
  if (name === "readme") return "book"
  if (["tsx", "jsx"].includes(extension)) return "react"
  if (["cts", "mts", "ts"].includes(extension)) return "typescript"
  if (["coffee", "js", "cjs", "mjs"].includes(extension)) return "javascript"
  if (extension === "rs") return "rust"
  if (["py", "pyw"].includes(extension)) return "python"
  if (extension === "go") return "go"
  if (extension === "rb") return "ruby"
  if (extension === "php") return "php"
  if (["c", "h"].includes(extension)) return "c"
  if (["cc", "cpp", "cxx", "hh", "hpp", "hxx"].includes(extension)) return "cpp"
  if (extension === "cs") return "csharp"
  if (extension === "java") return "java"
  if (["kt", "kts"].includes(extension)) return "kotlin"
  if (extension === "swift") return "swift"
  if (extension === "dart") return "dart"
  if (
    [
      "astro",
      "cshtml",
      "ejs",
      "handlebars",
      "hbs",
      "htm",
      "html",
      "pug",
      "razor",
      "xhtml",
      "xml",
      "xsl",
      "xslt"
    ].includes(extension)
  ) {
    return "html"
  }
  if (["css", "less", "styl", "stylus"].includes(extension)) return "css"
  if (["sass", "scss"].includes(extension)) return "sass"
  if (extension === "vue") return "vue"
  if (extension === "svelte") return "svelte"
  if (extension === "pdf") return "pdf"
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document"
  if (SHEET_EXTENSIONS.has(extension)) return "spreadsheet"
  if (PRESENTATION_EXTENSIONS.has(extension)) return "presentation"
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive"
  if (IMAGE_EXTENSIONS.has(extension)) return "image"
  if (AUDIO_EXTENSIONS.has(extension)) return "audio"
  if (VIDEO_EXTENSIONS.has(extension)) return "video"
  if (FONT_EXTENSIONS.has(extension)) return "font"
  if (DATABASE_EXTENSIONS.has(extension)) return "database"
  if (BOOK_EXTENSIONS.has(extension)) return "book"
  if (["json", "jsonc", "jsonl", "ipynb"].includes(extension)) return "json"
  if (["md", "markdown", "mdx"].includes(extension)) return "markdown"
  if (["log", "text", "txt"].includes(extension)) return "text"
  if (LOCK_EXTENSIONS.has(extension)) return "lock"
  if (TERMINAL_EXTENSIONS.has(extension)) return "terminal"
  if (
    CONFIG_EXTENSIONS.has(extension) ||
    name.startsWith(".") ||
    name.endsWith("rc")
  ) {
    return "config"
  }
  if (BINARY_EXTENSIONS.has(extension)) return "binary"
  return "code"
}

function TypeBadge({
  label,
  className
}: {
  label: string
  className: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-[2px] text-[7px] font-bold leading-none tracking-[-0.04em]",
        className
      )}
    >
      {label}
    </span>
  )
}

function Glyph({
  icon: Icon,
  className
}: {
  icon: LucideIcon
  className?: string
}) {
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />
}

export function LocalFileIcon({ path, className }: Props) {
  const kind = localFileIconKind(path)
  const badge = (label: string, tone: string) => (
    <TypeBadge label={label} className={cn(tone, className)} />
  )
  const glyph = (icon: LucideIcon, tone: string) => (
    <Glyph icon={icon} className={cn(tone, className)} />
  )

  if (kind === "react") return glyph(Atom, "text-sky-600 dark:text-sky-400")
  if (kind === "typescript") return badge("TS", "bg-sky-600 text-white dark:bg-sky-500")
  if (kind === "javascript") return badge("JS", "bg-amber-300 text-amber-950")
  if (kind === "rust") return badge("RS", "bg-orange-600 text-white dark:bg-orange-500")
  if (kind === "python") return badge("PY", "bg-blue-600 text-white dark:bg-blue-500")
  if (kind === "go") return badge("GO", "bg-cyan-600 text-white dark:bg-cyan-500")
  if (kind === "ruby") return badge("RB", "bg-red-600 text-white dark:bg-red-500")
  if (kind === "php") return badge("PHP", "bg-indigo-500 text-white")
  if (kind === "c") return badge("C", "bg-slate-600 text-white dark:bg-slate-500")
  if (kind === "cpp") return badge("C+", "bg-blue-700 text-white dark:bg-blue-600")
  if (kind === "csharp") return badge("C#", "bg-violet-700 text-white dark:bg-violet-600")
  if (kind === "java") return badge("JV", "bg-red-700 text-white dark:bg-red-600")
  if (kind === "kotlin") return badge("KT", "bg-violet-600 text-white dark:bg-violet-500")
  if (kind === "swift") return badge("SW", "bg-orange-600 text-white dark:bg-orange-500")
  if (kind === "dart") return badge("D", "bg-cyan-700 text-white dark:bg-cyan-600")
  if (kind === "html") return badge("<>", "bg-orange-600 text-white dark:bg-orange-500")
  if (kind === "css") return badge("#", "bg-blue-600 text-white dark:bg-blue-500")
  if (kind === "sass") return badge("S", "bg-pink-600 text-white dark:bg-pink-500")
  if (kind === "vue") return badge("V", "bg-emerald-600 text-white dark:bg-emerald-500")
  if (kind === "svelte") return badge("S", "bg-orange-500 text-white")
  if (kind === "pdf") return badge("PDF", "bg-red-600 text-white dark:bg-red-500")
  if (kind === "document") return badge("W", "bg-blue-700 text-white dark:bg-blue-600")
  if (kind === "spreadsheet") return badge("X", "bg-emerald-700 text-white dark:bg-emerald-600")
  if (kind === "presentation") return badge("P", "bg-orange-700 text-white dark:bg-orange-600")
  if (kind === "archive") return glyph(FileArchive, "text-amber-700 dark:text-amber-400")
  if (kind === "image") return glyph(FileImage, "text-emerald-600 dark:text-emerald-400")
  if (kind === "audio") return glyph(FileAudio, "text-fuchsia-600 dark:text-fuchsia-400")
  if (kind === "video") return glyph(FileVideo, "text-rose-600 dark:text-rose-400")
  if (kind === "font") return glyph(FileType2, "text-violet-600 dark:text-violet-400")
  if (kind === "database") return glyph(Database, "text-cyan-700 dark:text-cyan-400")
  if (kind === "book") return glyph(BookOpen, "text-blue-600 dark:text-blue-400")
  if (kind === "json") return glyph(Braces, "text-amber-600 dark:text-amber-400")
  if (kind === "markdown") return glyph(FileText, "text-sky-700 dark:text-sky-400")
  if (kind === "text") return glyph(FileText, "text-muted-foreground")
  if (kind === "lock") return glyph(FileLock2, "text-amber-700 dark:text-amber-400")
  if (kind === "terminal") return glyph(Terminal, "text-emerald-700 dark:text-emerald-400")
  if (kind === "config") return glyph(FileCog, "text-muted-foreground")
  if (kind === "package") return glyph(Package, "text-orange-600 dark:text-orange-400")
  if (kind === "binary") return glyph(Binary, "text-muted-foreground")
  return glyph(FileCode2, "text-orange-600 dark:text-orange-400")
}
