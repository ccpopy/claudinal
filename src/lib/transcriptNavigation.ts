import type { ClaudeEvent } from "@/types/events"
import type { UIEntry } from "@/types/ui"
import type { SessionSearchHit } from "./ipc"
import type { CompactBoundary } from "./agentFeatures"
import type { SubagentTask } from "./subagents"
import { init, reduce } from "./reducer"

/** Locators belong to one transcript; visual group IDs are resolved after replay. */
export interface TranscriptTarget {
  messageId?: string
  messageUuid?: string
  transcriptIndex?: number
  toolUseId?: string
  boundaryUuid?: string
  fallbackMessageUuid?: string
  role?: string
  timestamp?: string | null
  snippet?: string
}

export interface TranscriptNavigationRequest {
  id: string
  target: TranscriptTarget
}

export function searchHitTarget(hit: SessionSearchHit): TranscriptTarget {
  return { messageUuid: hit.messageUuid ?? undefined, transcriptIndex: hit.transcriptIndex,
    role: hit.role, timestamp: hit.ts, snippet: hit.snippet }
}

export function searchHitKey(hit: { project: { id: string }; session: { id: string }; target: TranscriptTarget }): string {
  return JSON.stringify([hit.project.id, hit.session.id, hit.target.messageUuid, hit.target.transcriptIndex])
}

export function compactHistoryTarget(boundary: CompactBoundary): TranscriptTarget {
  return { boundaryUuid: boundary.uuid,
    fallbackMessageUuid: boundary.preservedMessages?.anchorUuid ?? boundary.preservedSegment?.anchorUuid }
}

function eventRecord(event: ClaudeEvent): Record<string, unknown> {
  return event !== null && typeof event === "object" && !Array.isArray(event) ? event as Record<string, unknown> : {}
}

function fallbackMatches(event: ClaudeEvent, target: TranscriptTarget): boolean {
  const value = eventRecord(event)
  if (value.type !== target.role || (target.timestamp != null && value.timestamp !== target.timestamp)) return false
  const message = value.message as { content?: unknown } | undefined
  const content = message?.content
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.map((block) => typeof block?.text === "string" ? block.text
      : block?.type === "tool_use" && typeof block.name === "string" ? `[tool] ${block.name}` : "").join("\n") : ""
  // FTS marks matched words. Without a UUID, require content evidence as well
  // as position so a rewritten transcript cannot focus an unrelated record.
  const terms = [...(target.snippet ?? "").matchAll(/<<<([\s\S]*?)>>>/g)].map((match) => match[1].toLocaleLowerCase())
  return terms.length > 0 && terms.every((term) => text.toLocaleLowerCase().includes(term))
}

/** Resolve against source JSONL, never invent an accepted transcript UUID. */
export function resolveTranscriptTarget(events: ClaudeEvent[], target: TranscriptTarget): TranscriptTarget | null {
  if (target.toolUseId || target.messageId) return target
  const uuid = target.boundaryUuid ?? target.messageUuid
  let index = -1
  if (uuid) {
    const matches = events.flatMap((event, i) => eventRecord(event).uuid === uuid ? [i] : [])
    if (target.transcriptIndex !== undefined && matches.includes(target.transcriptIndex)) index = target.transcriptIndex
    else if (matches.length === 1) index = matches[0]
    else if (matches.length === 0 && target.boundaryUuid && target.fallbackMessageUuid) {
      return resolveTranscriptTarget(events, { messageUuid: target.fallbackMessageUuid })
    } else return null
  } else if (Number.isSafeInteger(target.transcriptIndex) && target.transcriptIndex! >= 0) {
    index = target.transcriptIndex!
    if (!events[index] || !fallbackMatches(events[index], target)) return null
  }
  if (index < 0) return null
  const prefix = reduce(init(), { kind: "load_transcript", events: events.slice(0, index + 1) })
  const value = eventRecord(events[index])
  const message = value.message as { id?: unknown } | undefined
  const sourceId = typeof message?.id === "string" ? message.id : typeof value.uuid === "string" ? value.uuid : null
  const previousIds = !sourceId && !target.boundaryUuid ? new Set(reduce(init(), { kind: "load_transcript", events: events.slice(0, index) }).entries
    .flatMap((entry) => entry.kind === "message" || entry.kind === "activity" ? [entry.id] : [])) : null
  const entry = target.boundaryUuid
    ? [...prefix.entries].reverse().find((candidate) => candidate.kind === "message" || candidate.kind === "activity")
    : (sourceId ? prefix.entries.find((candidate) => candidate.kind === "message" && candidate.id === sourceId) : undefined)
      ?? (uuid && events.filter((event) => eventRecord(event).uuid === uuid).length === 1
        ? prefix.entries.find((candidate) => candidate.kind === "message" && candidate.transcriptUuid === uuid) : undefined)
      ?? (uuid ? prefix.entries.find((candidate) => candidate.kind === "activity" && candidate.eventId === uuid) : undefined)
      ?? (previousIds ? [...prefix.entries].reverse().find((candidate) => (candidate.kind === "message" || candidate.kind === "activity") && !previousIds.has(candidate.id)) : undefined)
  if (!entry || (entry.kind !== "message" && entry.kind !== "activity")) return null
  const eventUuid = entry.kind === "message" ? entry.transcriptUuid : entry.eventId
  const uniqueUuid = eventUuid && events.filter((event) => eventRecord(event).uuid === eventUuid).length === 1 ? eventUuid : undefined
  return { messageId: entry.id, messageUuid: uniqueUuid, snippet: target.snippet }
}

export function entryMatchesTarget(entry: UIEntry, target: TranscriptTarget): boolean {
  if (entry.kind === "message") return (target.messageId !== undefined && entry.id === target.messageId)
    || (target.messageUuid !== undefined && (entry.transcriptUuid === target.messageUuid || entry.id === target.messageUuid))
    || (target.toolUseId !== undefined && entry.blocks.some((block) => block.type === "tool_use" && block.toolUseId === target.toolUseId))
  return entry.kind === "activity" && ((target.messageId !== undefined && entry.id === target.messageId)
    || (target.messageUuid !== undefined && entry.eventId === target.messageUuid))
}

/** A nested child is called in its parent's transcript, not the main stream. */
export function subagentMainToolTarget(agent: SubagentTask, agents: SubagentTask[]): string | null {
  const seen = new Set<string>()
  let current = agent
  while (current.parentTaskId) {
    if (seen.has(current.id)) return null
    seen.add(current.id)
    const parent = agents.find((candidate) => candidate.id === current.parentTaskId || candidate.aliases?.includes(current.parentTaskId!))
    if (!parent) return null
    current = parent
  }
  return current.toolUseId
}
