import type { ContextUsageSummary } from "@/lib/agentFeatures"
import type { UIEntry } from "@/types/ui"

export interface LiveContextUsage {
  usedTokens: number
  contextWindow?: number
  percent?: number
  /** Tokens at which the CLI auto-compacts, when its local summary reported it. */
  compactThreshold?: number
}

const tokens = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * Same formula as the CLI status line's `context_window.used_percentage`:
 * input + cache creation + cache read from the latest response, output excluded.
 * The window comes from the CLI's local summary or exact-model result metadata.
 * A model name alone cannot establish its effective window (settings can cap it).
 */
export function liveContextUsage(
  entries: readonly UIEntry[],
  summary: ContextUsageSummary | null | undefined,
  model: string | null | undefined,
  official: boolean
): LiveContextUsage | null {
  let usedTokens: number | undefined
  let responseModel = model
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.kind === "unknown" && record(entry.raw)?.subtype === "compact_boundary") break
    if (entry.kind !== "message" || entry.role !== "assistant" || !entry.usage) continue
    const usage = entry.usage
    const input = tokens(usage.input_tokens)
    if (input === undefined) continue
    usedTokens = input + (tokens(usage.cache_creation_input_tokens) ?? 0) + (tokens(usage.cache_read_input_tokens) ?? 0)
    responseModel = entry.model ?? model
    break
  }
  const currentSummary = summary?.model && responseModel && summary.model !== responseModel ? null : summary
  if (usedTokens === undefined) {
    if (currentSummary?.usedTokens === undefined) return null
    usedTokens = currentSummary.usedTokens
  }
  let contextWindow = official && currentSummary?.windowKnown ? currentSummary.contextWindow : undefined
  if (!contextWindow && official && responseModel) {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (entry.kind !== "result") continue
      const window = tokens(record(entry.modelUsage?.[responseModel])?.contextWindow)
      if (window) { contextWindow = window; break }
    }
  }
  return {
    usedTokens,
    contextWindow,
    percent: contextWindow ? Math.max(0, Math.min(100, Math.round(usedTokens / contextWindow * 100))) : undefined,
    compactThreshold: official && currentSummary?.windowKnown && currentSummary.isAutoCompactEnabled !== false ? currentSummary.autoCompactThreshold : undefined
  }
}

/** "12.3k" / "1.2M" for compact rows. */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return String(value)
}
