import type { UIBlock } from "@/types/ui"

// Keep these transport bounds in sync with api_proxy.rs. Header validation is
// deliberately separate from browser decoding; a decoder failure stays visible.
export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024
const MAX_IMAGE_EDGE = 16384
const MAX_CONTENT_PARTS = 256
const MAX_TOOL_IMAGES = 32

export type ToolResultPart = { type: "text"; text: string } | { type: "image"; block: UIBlock } | { type: "unavailable"; reason: string }
type ImageValidation = { ok: true; mediaType: string; data: string } | { ok: false; reason: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function dimensions(bytes: string, mime: string): [number, number] | undefined {
  const u8 = (i: number) => bytes.charCodeAt(i)
  const u16 = (i: number) => u8(i) * 256 + u8(i + 1)
  const le16 = (i: number) => u8(i) + u8(i + 1) * 256
  const le24 = (i: number) => le16(i) + u8(i + 2) * 65536
  const u32 = (i: number) => u16(i) * 65536 + u16(i + 2)
  if (mime === "image/png" && bytes.startsWith("\x89PNG\r\n\x1a\n") && bytes.length >= 33 && bytes.slice(12, 16) === "IHDR") return [u32(16), u32(20)]
  if (mime === "image/gif" && /^GIF8[79]a/.test(bytes) && bytes.length >= 13) return [le16(6), le16(8)]
  if (mime === "image/webp" && bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP") {
    const format = bytes.slice(12, 16)
    if (format === "VP8X" && bytes.length >= 30) return [le24(24) + 1, le24(27) + 1]
    if (format === "VP8 " && bytes.length >= 30 && bytes.slice(23, 26) === "\x9d\x01\x2a") return [le16(26) & 0x3fff, le16(28) & 0x3fff]
    if (format === "VP8L" && bytes.length >= 25 && u8(20) === 0x2f) return [1 + u8(21) + ((u8(22) & 0x3f) << 8), 1 + (u8(22) >> 6) + (u8(23) << 2) + ((u8(24) & 0xf) << 10)]
  }
  if (mime === "image/jpeg" && bytes.startsWith("\xff\xd8")) {
    let i = 2
    while (i + 3 < bytes.length) {
      if (u8(i++) !== 0xff) return
      while (u8(i) === 0xff) i++
      const marker = u8(i++)
      if (marker === 0xda || marker === 0xd9) return
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      const size = u16(i)
      if (size < 2 || i + size > bytes.length) return
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) return [u16(i + 5), u16(i + 3)]
      i += size
    }
  }
}

/** Accept only bounded inline raster bytes; never remote URLs, SVG, or data URIs. */
export function validateToolImage(mediaType: unknown, data: unknown): ImageValidation {
  if (typeof mediaType !== "string" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType)) return { ok: false, reason: "仅支持 PNG、JPEG、GIF、WebP 内嵌图片" }
  if (typeof data !== "string" || !data.length) return { ok: false, reason: "图片缺少 base64 数据" }
  if (data.length > Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4) return { ok: false, reason: "图片超过 5 MiB 限制" }
  if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return { ok: false, reason: "图片 base64 数据无效" }
  try {
    const bytes = atob(data)
    if (bytes.length > MAX_TOOL_IMAGE_BYTES) return { ok: false, reason: "图片超过 5 MiB 限制" }
    if (btoa(bytes) !== data) return { ok: false, reason: "图片 base64 数据无效" }
    const size = dimensions(bytes, mediaType)
    if (!size || !size.every((n) => Number.isFinite(n) && n > 0 && n <= MAX_IMAGE_EDGE) || size[0] * size[1] > MAX_IMAGE_PIXELS) return { ok: false, reason: "图片格式或尺寸无效（最多 32 百万像素）" }
    return { ok: true, mediaType, data }
  } catch {
    return { ok: false, reason: "图片 base64 数据无效" }
  }
}

/** Decode only content containers, retaining order and the original tool identity. */
export function toolResultParts(content: unknown, toolUseId?: string): ToolResultPart[] {
  const parts: ToolResultPart[] = []
  let visited = 0
  let imageBytes = 0
  let imageCount = 0
  let limited = false
  function visit(value: unknown, depth: number) {
    if (limited) return
    if (++visited > MAX_CONTENT_PARTS || depth > 16) {
      parts.push({ type: "unavailable", reason: "工具输出结构超过显示限制" })
      limited = true
      return
    }
    if (typeof value === "string") { parts.push({ type: "text", text: value }); return }
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return }
    const obj = record(value)
    if (obj?.type === "image") {
      const source = record(obj.source)
      const image = source && source.type !== "base64"
        ? { ok: false as const, reason: "仅支持 base64 内嵌图片" }
        : validateToolImage(source ? source.media_type : obj.mimeType, source ? source.data : obj.data)
      if (!image.ok) { parts.push({ type: "unavailable", reason: image.reason }); return }
      imageBytes += image.data.length / 4 * 3 - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0)
      if (++imageCount > MAX_TOOL_IMAGES || imageBytes > 20 * 1024 * 1024) { parts.push({ type: "unavailable", reason: "工具图片总量超过显示限制（32 张或 20 MiB）" }); return }
      parts.push({ type: "image", block: { type: "image", toolUseId, imageMediaType: image.mediaType, imageData: image.data, imageAlt: `工具图片 ${imageCount}` } })
      return
    }
    if (obj && typeof obj.text === "string") { parts.push({ type: "text", text: obj.text }); return }
    if (obj && "content" in obj) { visit(obj.content, depth + 1); return }
    if (value !== undefined && value !== null) parts.push({ type: "text", text: safeToolResultJson(value) })
  }
  visit(content, 0)
  return parts
}

/** Unknown structured fields must not spill image bytes into the transcript UI. */
function safeToolResultJson(value: unknown): string {
  let nodes = 0
  return JSON.stringify(value, (key, child: unknown) => {
    if (++nodes > 256) return "[输出已截断]"
    if (["data", "base64", "image_url", "blob"].includes(key)) return "[图像或二进制数据已省略]"
    if (typeof child === "string" && child.startsWith("data:image/")) return "[图像数据已省略]"
    if (typeof child === "string" && child.length > 8000) return `${child.slice(0, 8000)}…[输出已截断]`
    return child
  }, 2)?.slice(0, 16000) ?? ""
}
