import type { DocumentPayload, ImagePayload, UIMessage } from "@/types/ui"
import { compileUserInput } from "./compileUserInput"
import { decodeCliCommandEnvelope } from "./commandRegistry"

/** Reconstruct from the authoritative transcript; UI thumbnails alone are not retry payloads. */
export function retryInputFromTranscript(event: unknown, message: UIMessage) {
  const raw = event as { message?: { content?: unknown }; claudinalAuthoredText?: unknown } | null | undefined
  const content = raw?.message?.content
  if (typeof content !== "string" && !Array.isArray(content)) return null
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content as Array<Record<string, unknown>>
  const images: ImagePayload[] = []
  const documents: DocumentPayload[] = []
  const texts: string[] = []
  for (const [order, block] of blocks.entries()) {
    if (!block || typeof block !== "object" || Array.isArray(block)) return null
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text)
    else if (block.type === "image" || block.type === "document") {
      const source = block.source as { type?: unknown; data?: unknown; media_type?: unknown } | null | undefined
      if (source?.type !== "base64" || typeof source.data !== "string" || !source.data
        || typeof source.media_type !== "string" || !source.media_type) return null
      const payload = { data: source.data, mime: source.media_type, order }
      if (block.type === "image") images.push(payload)
      else documents.push({ ...payload, name: typeof block.title === "string" ? block.title : "document.pdf", size: Math.floor(source.data.length * 3 / 4) })
    } else return null
  }
  // Restored metadata is authoritative, including literal examples and empty text.
  const authoredText = typeof raw?.claudinalAuthoredText === "string" ? raw.claudinalAuthoredText : message.rawText
  const command = texts.length === 1 ? decodeCliCommandEnvelope(texts[0]) : null
  const text = authoredText ?? command ?? texts.join("\n")
  let cliBlocks = blocks
  if (typeof content === "string") cliBlocks = compileUserInput(text, [], [])
  else if ((authoredText !== undefined || command !== null) && text !== texts.join("\n")) {
    // Replace only text: retain the original media blocks, bytes and ordering.
    const firstText = blocks.findIndex((block) => block.type === "text")
    cliBlocks = blocks.flatMap((block, index) => block.type !== "text" ? [block]
      : index === firstText && text ? [{ ...block, text }] : [])
    if (firstText < 0 && text) cliBlocks.unshift({ type: "text", text })
  }
  return { localId: message.id, text, images, documents, cliBlocks, ts: message.ts }
}
