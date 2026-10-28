import type { ThirdPartyApiConfig } from "@/lib/thirdPartyApi"
import type { UIEntry } from "@/types/ui"

const CONVERSATION_CHARS = 2000
const REPLY_CHARS = 600

/**
 * Title model order. Official: Claude's small model. Third-party: the provider's
 * haiku mapping, then the built-in haiku alias as a fallback, then any other
 * configured mapping. Aliases resolve through the session's own model env.
 */
export function titleModelCandidates(provider: Pick<ThirdPartyApiConfig, "models"> | null): string[] {
  if (!provider) return ["haiku"]
  const { sonnetModel, opusModel, mainModel } = provider.models
  // "haiku" covers both a configured haiku mapping and the unmapped fallback.
  const candidates = ["haiku", sonnetModel.trim() ? "sonnet" : "", opusModel.trim() ? "opus" : "", mainModel.trim()]
  return [...new Set(candidates.filter(Boolean))]
}

/** The first user prompt and the start of the first reply; enough to name the task. */
export function titleConversationExcerpt(entries: readonly UIEntry[]): string | null {
  let user: string | null = null
  let reply: string | null = null
  for (const entry of entries) {
    if (entry.kind !== "message") continue
    const text = entry.blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim()
    if (!text) continue
    if (entry.role === "user" && !user) user = text
    else if (entry.role === "assistant" && user && !reply) reply = text
    if (user && reply) break
  }
  if (!user) return null
  const parts = [`User: ${user}`]
  if (reply) parts.push(`Assistant: ${Array.from(reply).slice(0, REPLY_CHARS).join("")}`)
  return Array.from(parts.join("\n\n")).slice(0, CONVERSATION_CHARS).join("")
}

/** Try each candidate once; any failure falls through and the caller keeps the first prompt. */
export async function generateTitleWithFallback(
  candidates: readonly string[],
  generate: (model: string) => Promise<string>
): Promise<string | null> {
  for (const model of candidates) {
    try {
      const title = (await generate(model)).trim()
      if (title) return title
    } catch {
      // Next candidate.
    }
  }
  return null
}
