import type { ComposerDraftImage as Thumb, ComposerDraftDocument as DocumentThumb, ComposerDraftFileAttachment as FileAttachment } from "./composerDrafts"
import { formatBytes, isDocxFile, isLegacyWordDocFile, isPdfFile, isSupportedUploadFile, supportedImageMime } from "./fileAttachments"
import { extractDocxText } from "./docxText"
export const MAX_TEXT_FILE_BYTES = 1024 * 1024
export type PreparedBatch = { images: Thumb[]; documents: DocumentThumb[]; files: FileAttachment[] }
const makeId = () => crypto.randomUUID()

function readAsDataUrlPayload(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const result = reader.result as string
      const idx = result.indexOf("base64,")
      resolve(idx >= 0 ? result.slice(idx + 7) : result)
    }
    reader.readAsDataURL(file)
  })
}

function readAsTextPayload(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.readAsText(file)
  })
}

function readAsArrayBufferPayload(file: File) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(file)
  })
}

function escapeAttr(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

export function buildOutgoingText(text: string, files: FileAttachment[]) {
  const parts = [text.trim()].filter(Boolean)
  for (const file of files) {
    const mime = file.mime || "application/octet-stream"
    const contentAttr =
      file.contentMode === "inline" ? "" : ` content="${file.contentMode}"`
    const body =
      file.contentMode === "metadata-only"
        ? "[binary file content not included]"
        : file.contentMode === "document"
          ? "[pdf document attached separately]"
          : (file.text ?? "")
    parts.push(
      [
        `<uploaded_file name="${escapeAttr(file.name)}" mime="${escapeAttr(mime)}" size="${file.size}"${contentAttr}>`,
        body,
        "</uploaded_file>"
      ].join("\n")
    )
  }
  return parts.join("\n\n")
}

export interface OutgoingFileMarker {
  name: string
  mime: string
  size?: number
  mode: FileAttachment["contentMode"]
  /** 原样保留的 `<uploaded_file>` 片段，重新组装时逐字写回 */
  marker: string
}

/**
 * 把发送文本拆成「可编辑正文 + 文件标记」：就地编辑时正文进文本框、
 * 文件以 chip 展示，避免把 `<uploaded_file>` 原文暴露给用户。
 */
export function splitOutgoingText(text: string): { body: string; files: OutgoingFileMarker[] } {
  const files: OutgoingFileMarker[] = []
  const body = text.replace(/<uploaded_file\s+([^>]*)>[\s\S]*?<\/uploaded_file>/gi, (marker, attributes: string) => {
    const attr = (key: string) => new RegExp(`${key}="([^"]*)"`).exec(attributes)?.[1]
    const size = Number(attr("size"))
    const content = attr("content")
    files.push({
      name: unescapeAttr(attr("name") ?? ""),
      mime: unescapeAttr(attr("mime") ?? ""),
      size: Number.isFinite(size) ? size : undefined,
      mode: content === "document" || content === "metadata-only" ? content : "inline",
      marker
    })
    return ""
  })
  return { body: body.replace(/\n{3,}/g, "\n\n").trim(), files }
}

export function joinOutgoingText(body: string, files: OutgoingFileMarker[]): string {
  return [body.trim(), ...files.map((file) => file.marker)].filter(Boolean).join("\n\n")
}

function unescapeAttr(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
}

/** Removing a PDF also removes its generated text marker, preserving other raw input. */
export function removeDocumentMarker(text: string, name: string): string {
  return text.replace(/<uploaded_file\s+([^>]*)>[\s\S]*?<\/uploaded_file>/gi, (whole, attributes: string) =>
    attributes.includes(`name="${escapeAttr(name)}"`) && attributes.includes('content="document"') ? "" : whole).trim()
}

export async function prepareInputFiles(files: FileList | File[]): Promise<PreparedBatch> {
    const nextImages: Thumb[] = []
    const nextDocuments: DocumentThumb[] = []
    const nextFileAttachments: FileAttachment[] = []
    let skipped = 0
    const skippedDetails: string[] = []

    const batchOrder = Date.now()
    let batchIndex = 0
    for (const file of Array.from(files)) {
      const order = batchOrder + batchIndex++ / 1000
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("单个附件不能超过 20 MB")
        if (isLegacyWordDocFile(file)) {
          skipped += 1
          skippedDetails.push(
            `${file.name || "document.doc"} 是旧版 .doc 格式，请另存为 .docx 或 PDF 后上传`
          )
          continue
        }

        if (!isSupportedUploadFile(file)) {
          skipped += 1
          skippedDetails.push(
            `${file.name || "文件"} 类型不支持；仅支持图片、PDF、DOCX 和文本文件`
          )
          continue
        }

        const imageMime = supportedImageMime(file)
        if (imageMime) {
          const data = await readAsDataUrlPayload(file)
          nextImages.push({
            order,
            id: makeId(),
            data,
            mime: imageMime,
            name: file.name || "image",
            size: file.size
          })
          continue
        }

        if (isPdfFile(file)) {
          const id = makeId()
          const data = await readAsDataUrlPayload(file)
          const name = file.name || "document.pdf"
          const mime = "application/pdf"
          nextDocuments.push({
            order,
            id,
            data,
            mime,
            name,
            size: file.size
          })
          nextFileAttachments.push({
            id,
            name,
            mime,
            size: file.size,
            text: null,
            contentMode: "document"
          })
          continue
        }

        if (isDocxFile(file)) {
          const body = await extractDocxText(await readAsArrayBufferPayload(file))
          if (!body.trim()) {
            throw new Error("Word 文档中没有可提取的文本")
          }
          nextFileAttachments.push({
            id: makeId(),
            name: file.name || "document.docx",
            mime:
              file.type ||
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: file.size,
            text: body,
            contentMode: "inline"
          })
          continue
        }

        if (file.size > MAX_TEXT_FILE_BYTES) {
          skipped += 1
          skippedDetails.push(
            `${file.name || "文本文件"} 超过 ${formatBytes(MAX_TEXT_FILE_BYTES)}`
          )
          continue
        }

        const body = await readAsTextPayload(file)
        nextFileAttachments.push({
          id: makeId(),
          name: file.name || "file.txt",
          mime: file.type || "text/plain",
          size: file.size,
          text: body,
          contentMode: "inline"
        })
      } catch (error) {
        skipped += 1
        skippedDetails.push(`${file.name || "文件"}：${String(error)}`)
      }
    }

    if (skipped > 0) throw new Error(skippedDetails.join("；") || "附件无法读取")
    return { images: nextImages, documents: nextDocuments, files: nextFileAttachments }
    }
