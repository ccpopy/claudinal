import type { UIEntry, UISkillContent, UISkillLoad } from "@/types/ui"
import { hasInjectedProvenance } from "./messageOrigin"

export const SKILL_META_PROMPT_PREFIX = "Base directory for this skill:"

/** Parse the CLI envelope, not arbitrary mentions of a skill in user text. */
export function parseSkillContent(text: string): UISkillContent | null {
  const match = /^\s*Base directory for this skill:[ \t]*([^\r\n]+)(?:\r?\n|$)/.exec(text)
  if (!match) return null
  const directory = match[1].trim().replace(/^(["'])(.*)\1$/, "$2")
  if (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(directory)) return null
  const name = directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
  if (!name) return null
  return { name, directory, content: text.slice(match[0].length).trim() }
}

export function skillLoadFromEvent(
  event: Record<string, unknown>, entries: UIEntry[], ts: number
): UISkillLoad | null {
  if (event.type !== "user" || event.claudinalAuthored === true || event.isSidechain === true || event.parent_tool_use_id) return null
  const uuid = typeof event.uuid === "string" ? event.uuid : undefined
  // An authored input echoed by the CLI always remains a user message, even
  // when it contains a literal copy of the skill envelope.
  if (uuid && entries.some((entry) => entry.kind === "message" && entry.role === "user"
    && (entry.id === uuid || entry.attemptIds?.includes(uuid)))) return null
  const message = event.message as { content?: unknown } | undefined
  const content = message?.content
  const texts = typeof content === "string" ? [content]
    : Array.isArray(content) && content.every((block) => block?.type === "text" && typeof block.text === "string")
      ? content.map((block) => block.text as string) : []
  const skill = parseSkillContent(texts.join("\n"))
  if (!skill) return null
  const replay = uuid ? entries.find((entry) => entry.kind === "skill_load" && entry.id === uuid) : undefined
  if (replay?.kind === "skill_load") return { ...replay, ...skill, name: replay.name }

  const sourceId = [event.sourceToolUseID, event.source_tool_use_id].find(
    (value): value is string => typeof value === "string" && !!value
  )
  let toolUseId = sourceId
  let invokedName: string | undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    // Without an explicit source, only correlate within this turn.
    // Local queued/guide inputs may appear while the Skill tool is still
    // running; they do not end the current CLI turn.
    if (!sourceId && (entry.kind === "result" || (entry.kind === "message" && entry.role === "user"
      && !entry.deliveryState && entry.delivery !== "guide"
      && entry.blocks.some((block) => block.type !== "tool_result")))) break
    if (entry.kind !== "message" || entry.role !== "assistant") continue
    const tool = entry.blocks.find((block) => {
      if (block.type !== "tool_use" || block.toolName !== "Skill") return false
      const name = (block.toolInput as { skill?: unknown } | undefined)?.skill
      return sourceId ? block.toolUseId === sourceId
        : typeof name === "string" && name.split(":").pop() === skill.name
    })
    if (!tool) continue
    toolUseId = tool.toolUseId
    const name = (tool.toolInput as { skill?: unknown } | undefined)?.skill
    if (typeof name === "string" && name.trim()) invokedName = name
    break
  }
  const injected = hasInjectedProvenance(event)
  // SDK user replays may omit transcript-only isMeta/sourceToolUseID. Require
  // the SDK envelope plus the matching Skill invocation in that case.
  if (!injected && !(typeof event.session_id === "string" && toolUseId)) return null
  return {
    kind: "skill_load", ...skill, name: invokedName ?? skill.name,
    id: uuid ?? `skill-${toolUseId ?? entries.length}`, toolUseId, ts
  }
}
