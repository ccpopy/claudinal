/** Public CLI feature events have no input/turn correlation field. */
export interface AgentFeatureOwner {
  readonly conversationKey: string
  readonly runtimeId: string
  /** Locally allocated once per process/listener incarnation, never a wire field. */
  readonly generation: string
}

export interface PromptSuggestion {
  readonly uuid: string
  readonly text: string
  readonly sessionId: string
  readonly turnId: string
  readonly owner: AgentFeatureOwner
}

const MAX_SEEN_SUGGESTIONS = 128
const MAX_SUGGESTION_LENGTH = 16 * 1024

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}

function sameOwner(a: AgentFeatureOwner, b: AgentFeatureOwner): boolean {
  return a.conversationKey === b.conversationKey
    && a.runtimeId === b.runtimeId && a.generation === b.generation
}

/**
 * At most one suggestion in the current successful after-result interval.
 * Register input with beginTurn before asynchronous preparation/queueing. Since
 * the upstream event has no turn ID, arbitrarily delayed old events delivered
 * inside a later completed interval cannot be distinguished by this protocol.
 */
export class PromptSuggestionTracker {
  readonly owner: AgentFeatureOwner
  private enabled: boolean
  private turnId: string | null = null
  private sessionId: string | null = null
  private completed = false
  private accepted = false
  private suggestion: PromptSuggestion | null = null
  private readonly seen = new Set<string>()

  constructor(owner: AgentFeatureOwner, enabled = false) {
    this.owner = Object.freeze({ ...owner })
    this.enabled = enabled
  }

  get current(): PromptSuggestion | null { return this.suggestion }
  get retainedUuidCount(): number { return this.seen.size }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.suggestion = null
      this.completed = false
    }
  }

  beginTurn(turnId: string): void {
    this.turnId = turnId
    this.completed = false
    this.accepted = false
    this.suggestion = null
  }

  completeTurn(turnId: string, sessionId: string, succeeded = true): void {
    if (this.turnId !== turnId) return
    this.sessionId = identity(sessionId) ? sessionId : null
    this.completed = succeeded && this.sessionId !== null
    if (!succeeded) this.suggestion = null
  }

  accept(event: unknown, capturedOwner: AgentFeatureOwner): PromptSuggestion | null {
    const value = record(event)
    if (!value || value.type !== "prompt_suggestion" || !sameOwner(this.owner, capturedOwner)
      || !identity(value.uuid) || !identity(value.session_id)
      || typeof value.suggestion !== "string" || !value.suggestion.trim()
      || value.suggestion.length > MAX_SUGGESTION_LENGTH) return null
    if (this.seen.has(value.uuid)) return null
    // Remember rejected early/late frames as well, so replay cannot revive them.
    this.seen.add(value.uuid)
    if (this.seen.size > MAX_SEEN_SUGGESTIONS) this.seen.delete(this.seen.values().next().value!)
    if (!this.enabled || !this.completed || this.accepted || !this.turnId
      || value.session_id !== this.sessionId) return null
    this.accepted = true
    this.suggestion = Object.freeze({
      uuid: value.uuid, text: value.suggestion, sessionId: value.session_id,
      turnId: this.turnId, owner: this.owner
    })
    return this.suggestion
  }

  dismiss(): void { this.suggestion = null }
}

/** This changes text only; callers retain attachments and require explicit Send. */
export function appendPromptSuggestionToDraft(draft: string, suggestion: string): string {
  if (!suggestion.trim()) return draft
  if (!draft) return suggestion
  return `${draft}${draft.endsWith("\n") ? "" : "\n"}${suggestion}`
}

export interface ContextCategory {
  name: string
  tokens: number
  kind: "used" | "free" | "buffer" | "deferred"
}

export interface ContextUsageSummary {
  detail: "summary"
  measurement: "cli-local-estimate"
  source: string
  model?: string
  usedTokens?: number
  contextWindow?: number
  percentage?: number
  autoCompactThreshold?: number
  isAutoCompactEnabled?: boolean
  windowKnown: boolean
  categories: ContextCategory[]
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : undefined
}

/** Never calculate an authoritative ratio from an unidentified gateway model. */
export function normalizeContextUsageSummary(
  value: unknown,
  options: { contextWindowKnown?: boolean } = {}
): ContextUsageSummary | null {
  const input = record(value)
  if (!input || input.detail !== "summary") return null
  const max = tokens(input.maxTokens)
  const windowKnown = options.contextWindowKnown === true && max !== undefined && max > 0
  const percentage = typeof input.percentage === "number" && Number.isFinite(input.percentage)
    && input.percentage >= 0 && input.percentage <= 100 ? input.percentage : undefined
  const categories: ContextCategory[] = []
  if (Array.isArray(input.categories)) {
    for (const entry of input.categories.slice(0, 32)) {
      const category = record(entry)
      if (!category || typeof category.name !== "string" || category.name.length > 256) continue
      const count = tokens(category.tokens)
      const kind = category.kind
      if (count === undefined || (kind !== "used" && kind !== "free" && kind !== "buffer" && kind !== "deferred")) continue
      categories.push({ name: category.name, tokens: count, kind })
    }
  }
  return {
    detail: "summary", measurement: "cli-local-estimate",
    source: typeof input.source === "string" ? input.source.slice(0, 256) : "CLI summary",
    model: typeof input.model === "string" ? input.model.slice(0, 256) : undefined,
    usedTokens: tokens(input.totalTokens),
    contextWindow: windowKnown ? max : undefined,
    percentage: windowKnown ? percentage : undefined,
    autoCompactThreshold: windowKnown ? tokens(input.autoCompactThreshold) : undefined,
    isAutoCompactEnabled: typeof input.isAutoCompactEnabled === "boolean" ? input.isAutoCompactEnabled : undefined,
    windowKnown, categories
  }
}

export interface CompactBoundary {
  uuid: string
  sessionId: string
  trigger: "manual" | "auto"
  preTokens: number
  postTokens?: number
  durationMs?: number
  preservedSegment?: { headUuid: string; anchorUuid: string; tailUuid: string }
  preservedMessages?: { anchorUuid: string; uuids: string[] }
}

/** Parse metadata without replacing, truncating or relinking original history. */
export function parseCompactBoundary(event: unknown): CompactBoundary | null {
  const input = record(event)
  if (!input || input.type !== "system" || input.subtype !== "compact_boundary"
    || !identity(input.uuid) || !identity(input.session_id)) return null
  const metadata = record(input.compact_metadata)
  if (!metadata || (metadata.trigger !== "manual" && metadata.trigger !== "auto")) return null
  const preTokens = tokens(metadata.pre_tokens)
  if (preTokens === undefined) return null
  const boundary: CompactBoundary = {
    uuid: input.uuid, sessionId: input.session_id, trigger: metadata.trigger,
    preTokens, postTokens: tokens(metadata.post_tokens), durationMs: tokens(metadata.duration_ms)
  }
  const segment = record(metadata.preserved_segment)
  if (segment && identity(segment.head_uuid) && identity(segment.anchor_uuid) && identity(segment.tail_uuid)) {
    boundary.preservedSegment = { headUuid: segment.head_uuid, anchorUuid: segment.anchor_uuid, tailUuid: segment.tail_uuid }
  }
  const messages = record(metadata.preserved_messages)
  if (messages && identity(messages.anchor_uuid) && Array.isArray(messages.uuids)
    && messages.uuids.length <= 10_000 && messages.uuids.every(identity)) {
    boundary.preservedMessages = { anchorUuid: messages.anchor_uuid, uuids: [...messages.uuids] }
  }
  return boundary
}

/** Preserve every user-provided argument byte; normal slash routing owns sending. */
export function buildCompactCommand(instructions: string): string {
  return instructions.length ? `/compact ${instructions}` : "/compact"
}
