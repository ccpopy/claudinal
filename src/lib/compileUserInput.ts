import type { DocumentPayload, ImagePayload, UIBlock } from "@/types/ui"
import { splitUploadedFileText } from "./fileAttachments"

// Leave room for the NDJSON envelope under the native 32 MiB limit.
export const MAX_COMPILED_INPUT_BYTES = 31 * 1024 * 1024

function orderedAttachments(images: ImagePayload[], documents: DocumentPayload[]) {
  return [
    ...images.map((image) => ({ kind: "image" as const, value: image })),
    ...documents.map((document) => ({ kind: "document" as const, value: document }))
  ].sort((a, b) => (a.value.order ?? 0) - (b.value.order ?? 0))
}

/** Every input path preserves the original slash token and uses the same payload. */
export function compileUserInput(text: string, images: ImagePayload[], documents: DocumentPayload[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = text ? [{ type: "text", text }] : []
  for (const attachment of orderedAttachments(images, documents)) {
    const value = attachment.value
    blocks.push({ type: attachment.kind, source: { type: "base64", media_type: value.mime, data: value.data },
      ...(attachment.kind === "document" ? { title: attachment.value.name } : {}) })
  }
  validateInputSize(blocks)
  return blocks
}

export function validateInputSize(blocks: Array<Record<string, unknown>>): void {
  if (new TextEncoder().encode(JSON.stringify(blocks)).byteLength > MAX_COMPILED_INPUT_BYTES) {
    throw new Error("输入与附件总量超过 31 MB，请减少附件后重试")
  }
}

export function inputUiBlocks(text: string, images: ImagePayload[], documents: DocumentPayload[]): UIBlock[] {
  const blocks: UIBlock[] = text ? splitUploadedFileText(text) : []
  for (const attachment of orderedAttachments(images, documents)) {
    if (attachment.kind === "image") blocks.push({ type: "image", imageMediaType: attachment.value.mime, imageData: attachment.value.data })
    else if (!blocks.some((block) => block.type === "attachment" && block.attachmentName === attachment.value.name)) {
      blocks.push({ type: "attachment", attachmentName: attachment.value.name, attachmentSize: attachment.value.size, attachmentMime: attachment.value.mime, attachmentContentMode: "document" })
    }
  }
  return blocks
}
