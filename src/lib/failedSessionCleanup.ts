import type { UIEntry } from "@/types/ui"

type MessageIdLookup = {
  get(messageId: string): { text: string } | undefined
}

export function findFirstTurnFailedMessageId(
  entries: readonly UIEntry[],
  sentInputs: MessageIdLookup
): string | null {
  let sentMessageId: string | null = null
  let sentText: string | null = null
  const echoedUserTexts: string[] = []
  for (const entry of entries) {
    if (entry.kind !== "message") continue
    if (entry.role === "assistant") {
      if (isSyntheticAssistantMessage(entry)) continue
      return null
    }
    const input = sentInputs.get(entry.id)
    if (!input) {
      echoedUserTexts.push(uiMessageText(entry))
      continue
    }
    if (sentMessageId) return null
    sentMessageId = entry.id
    sentText = normalizeText(input.text)
  }
  if (!sentMessageId) return null
  if (
    echoedUserTexts.length > 0 &&
    (!sentText ||
      echoedUserTexts.some((text) => normalizeText(text) !== sentText))
  ) {
    return null
  }
  return sentMessageId
}

export function hasResumableUiConversationContext(
  entries: readonly UIEntry[]
): boolean {
  return entries.some(
    (entry) =>
      entry.kind === "message" &&
      entry.role === "assistant" &&
      !isSyntheticAssistantMessage(entry)
  )
}

function isSyntheticAssistantMessage(
  entry: Extract<UIEntry, { kind: "message" }>
): boolean {
  return entry.role === "assistant" && isSyntheticModel(entry.model)
}

function isSyntheticModel(model: unknown): boolean {
  return (
    typeof model === "string" &&
    model.replace(/\s+/g, "").toLowerCase() === "<synthetic>"
  )
}

function uiMessageText(
  entry: Extract<UIEntry, { kind: "message" }>
): string {
  return entry.blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
}

function normalizeText(text: string): string {
  return text.trim()
}
