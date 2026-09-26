import type { DocumentPayload, ImagePayload, UIMessage } from "@/types/ui"
import { compileUserInput } from "./compileUserInput"

/** Reconstruct from the authoritative transcript; UI thumbnails alone are not retry payloads. */
export function retryInputFromTranscript(event: unknown, message: UIMessage) {
  const raw = event as { message?: { content?: unknown } } | undefined
  const content = raw?.message?.content
  if (typeof content !== "string" && !Array.isArray(content)) return null
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content as Array<Record<string, unknown>>
  const images: ImagePayload[] = []
  const documents: DocumentPayload[] = []
  const texts: string[] = []
  for (const [order, block] of blocks.entries()) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text)
    else if (block.type === "image" || block.type === "document") {
      const source = block.source as { type?: string; data?: string; media_type?: string } | undefined
      if (source?.type !== "base64" || !source.data || !source.media_type) return null
      const payload = { data: source.data, mime: source.media_type, order }
      if (block.type === "image") images.push(payload)
      else documents.push({ ...payload, name: typeof block.title === "string" ? block.title : "document.pdf", size: Math.floor(source.data.length * 3 / 4) })
    } else return null
  }
  const text = message.rawText ?? texts.join("\n")
  return { localId: message.id, text, images, documents, cliBlocks: typeof content === "string" ? compileUserInput(content, [], []) : blocks, ts: message.ts }
}
