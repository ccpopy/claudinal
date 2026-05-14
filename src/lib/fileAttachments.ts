import type { UIBlock } from "@/types/ui"

const TEXT_EXTENSIONS = new Set([
  "css",
  "csv",
  "env",
  "go",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "properties",
  "py",
  "rs",
  "scss",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml"
])

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/x-javascript",
  "application/x-typescript",
  "application/x-yaml",
  "application/yaml",
  "text/xml"
])

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
])

export const LONG_PASTE_TEXT_MIN_CHARS = 4000
export const LONG_PASTE_TEXT_MIN_LINES = 80

const IMAGE_EXTENSION_MIME_TYPES = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"]
])

export const SUPPORTED_ATTACHMENT_ACCEPT = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  "application/pdf",
  ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docx",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/xml",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".properties",
  ".py",
  ".rs",
  ".scss",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
].join(",")

const MIME_TYPE_LABELS = new Map([
  ["application/pdf", "PDF"],
  ["application/msword", "旧版 Word 文档"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Word 文档"
  ],
  ["application/vnd.ms-excel", "Excel 表格"],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Excel 表格"
  ],
  ["application/vnd.ms-powerpoint", "PowerPoint 演示文稿"],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "PowerPoint 演示文稿"
  ],
  ["application/json", "JSON"],
  ["application/xml", "XML"],
  ["application/x-yaml", "YAML"],
  ["application/yaml", "YAML"],
  ["text/markdown", "Markdown"],
  ["text/plain", "文本文件"],
  ["text/csv", "CSV"],
  ["text/html", "HTML"],
  ["text/xml", "XML"]
])

const EXTENSION_TYPE_LABELS = new Map([
  ["csv", "CSV"],
  ["doc", "旧版 Word 文档"],
  ["docx", "Word 文档"],
  ["htm", "HTML"],
  ["html", "HTML"],
  ["json", "JSON"],
  ["md", "Markdown"],
  ["pdf", "PDF"],
  ["ppt", "PowerPoint 演示文稿"],
  ["pptx", "PowerPoint 演示文稿"],
  ["txt", "文本文件"],
  ["xls", "Excel 表格"],
  ["xlsx", "Excel 表格"],
  ["xml", "XML"],
  ["yaml", "YAML"],
  ["yml", "YAML"]
])

interface FileLike {
  name: string
  type: string
}

function fileExtension(name: string | undefined): string | undefined {
  return name?.split(".").pop()?.toLowerCase()
}

export function isPdfFile(file: FileLike): boolean {
  const type = file.type.toLowerCase()
  if (type === "application/pdf") return true
  return fileExtension(file.name) === "pdf"
}

export function supportedImageMime(file: FileLike): string | null {
  const type = file.type.toLowerCase()
  if (SUPPORTED_IMAGE_MIME_TYPES.has(type)) return type
  const ext = fileExtension(file.name)
  return ext ? (IMAGE_EXTENSION_MIME_TYPES.get(ext) ?? null) : null
}

export function isDocxFile(file: FileLike): boolean {
  const type = file.type.toLowerCase()
  if (
    type ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return true
  }
  return fileExtension(file.name) === "docx"
}

export function isLegacyWordDocFile(file: FileLike): boolean {
  const type = file.type.toLowerCase()
  if (type === "application/msword") return true
  return fileExtension(file.name) === "doc"
}

export function isTextLikeFile(file: FileLike): boolean {
  const type = file.type.toLowerCase()
  if (type.startsWith("text/")) return true
  if (TEXT_MIME_TYPES.has(type)) return true
  if (type.endsWith("+json") || type.endsWith("+xml")) return true
  if (type.includes("javascript") || type.includes("typescript")) return true

  const ext = fileExtension(file.name)
  return !!ext && TEXT_EXTENSIONS.has(ext)
}

export function isSupportedUploadFile(file: FileLike): boolean {
  if (file.type.toLowerCase().startsWith("image/")) {
    return supportedImageMime(file) !== null
  }
  return (
    supportedImageMime(file) !== null ||
    isPdfFile(file) ||
    isDocxFile(file) ||
    isTextLikeFile(file)
  )
}

export function formatAttachmentType(name?: string, mime?: string): string {
  const normalizedMime = mime?.trim().toLowerCase()
  if (normalizedMime) {
    const mimeLabel = MIME_TYPE_LABELS.get(normalizedMime)
    if (mimeLabel) return mimeLabel
  }

  const ext = fileExtension(name)
  if (ext) {
    const extLabel = EXTENSION_TYPE_LABELS.get(ext)
    return extLabel ?? ext.toUpperCase()
  }

  if (normalizedMime?.startsWith("text/")) return "文本文件"
  return "附件"
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function shouldAttachPastedText(text: string): boolean {
  if (!text.trim()) return false
  if (text.length >= LONG_PASTE_TEXT_MIN_CHARS) return true
  return text.split(/\r\n|\r|\n/).length >= LONG_PASTE_TEXT_MIN_LINES
}

export function pastedTextFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("")
  return `pasted-text-${stamp}.txt`
}

function decodeAttr(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&")
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    attrs[match[1]] = decodeAttr(match[2])
  }
  return attrs
}

function stripFramingNewline(text: string): string {
  let next = text
  if (next.startsWith("\r\n")) next = next.slice(2)
  else if (next.startsWith("\n")) next = next.slice(1)

  if (next.endsWith("\r\n")) next = next.slice(0, -2)
  else if (next.endsWith("\n")) next = next.slice(0, -1)
  return next
}

export function splitUploadedFileText(text: string): UIBlock[] {
  const blocks: UIBlock[] = []
  const re = /<uploaded_file\s+([^>]*)>([\s\S]*?)<\/uploaded_file>/gi
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index)
    if (before.trim()) {
      blocks.push({ type: "text", text: before.trim() })
    }

    const attrs = parseAttrs(match[1])
    const size = Number(attrs.size)
    const contentMode =
      attrs.content === "metadata-only" || attrs.content === "document"
        ? attrs.content
        : "inline"
    blocks.push({
      type: "attachment",
      attachmentName: attrs.name,
      attachmentMime: attrs.mime,
      attachmentSize: Number.isFinite(size) ? size : undefined,
      attachmentText: stripFramingNewline(match[2]),
      attachmentContentMode: contentMode
    })
    lastIndex = match.index + match[0].length
  }

  const rest = text.slice(lastIndex)
  if (rest.trim()) {
    blocks.push({ type: "text", text: rest.trim() })
  }
  return blocks
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
