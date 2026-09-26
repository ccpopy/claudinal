import { splitUploadedFileText } from "./fileAttachments"
import type { UIMessage } from "@/types/ui"
import type { State } from "./reducer"
import { deliveryLabel } from "./submission"

export function inputMetadataPatch(state: State): Record<string, unknown> {
  const patch: Record<string, unknown> = { inputMetadataVersion: 1 }
  for (const entry of state.entries) {
    if (entry.kind !== "message" || entry.role !== "user" || !entry.deliveryState) continue
    patch[`input:${entry.id}`] = { intent: entry.delivery, deliveryState: entry.deliveryState, rawText: entry.rawText, ts: entry.ts }
  }
  return patch
}

export function restoreInputMetadata(state: State, sidecar: unknown): State {
  if (!sidecar || typeof sidecar !== "object") return state
  const stored = sidecar as Record<string, unknown>
  if (stored.inputMetadataVersion !== 1) return state
  return { ...state, entries: state.entries.map((entry) => {
    if (entry.kind !== "message" || entry.role !== "user") return entry
    const value = stored[`input:${entry.id}`]
    if (!value || typeof value !== "object") return entry
    const meta = value as Record<string, unknown>
    const deliveryState = typeof meta.deliveryState === "string" && Object.hasOwn(deliveryLabel, meta.deliveryState)
      ? meta.deliveryState as UIMessage["deliveryState"] : undefined
    const original = typeof meta.rawText === "string" ? splitUploadedFileText(meta.rawText) : null
    const restoredBlocks = original ? [...original, ...entry.blocks.filter((block) => block.type !== "text" && (block.type !== "attachment" || (block.attachmentContentMode !== "inline" && !original.some((part) => part.type === "attachment" && part.attachmentName === block.attachmentName))))] : entry.blocks
    return { ...entry, blocks: restoredBlocks, delivery: meta.intent === "guide" ? "guide" as const : undefined,
      deliveryState: deliveryState === "writing" || deliveryState === "awaiting_ack" ? "delivery_unknown" as const : deliveryState,
      rawText: typeof meta.rawText === "string" ? meta.rawText : undefined }
  }) }
}
