import type { ReviewRunDiff } from "@/lib/diff"
import type { WorktreeFileDiff } from "@/lib/ipc"
import type { ClaudeEvent } from "@/types/events"

/** Persist the observed GUI boundary when CLI results omit wire timestamps. */
export function stampReviewResult(event: ClaudeEvent, observedAt = Date.now()): ClaudeEvent {
  const record = event as Record<string, unknown>
  if (event.type !== "result") return event
  const raw = record.timestamp ?? record.ts
  const valid = typeof raw === "number" ? Number.isFinite(raw) : typeof raw === "string" && Number.isFinite(Date.parse(raw))
  return valid ? event : { ...event, timestamp: new Date(observedAt).toISOString() } as ClaudeEvent
}

export function shouldSyncRunReviewToConversation(
  activeRuntimeId: string | null,
  runRuntimeId: string,
  selectedSessionId: string | null,
  runSessionId: string | null
): boolean {
  return (
    activeRuntimeId === runRuntimeId ||
    (runSessionId !== null && selectedSessionId === runSessionId)
  )
}

/**
 * sidecar.reviewDiffs 的兼容性读取。
 *
 * 从 App.tsx 抽出并加固：旧实现对任何一处字段非法都直接 throw，会让整个
 * 会话加载流程（composer 偏好还原等）跟着失败。这里改为：
 * - 结构损坏（reviewDiffs 不是数组）→ 返回 []，console.warn；
 * - 单条记录损坏 → 跳过该条保留其余，console.warn。
 * 写入侧数据结构不变，保持向后兼容（只做读取增强）。
 */

function recordFromUnknown(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function optionalRecordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  return recordFromUnknown(value, "sidecar")
}

function stringField(source: Record<string, unknown>, key: string, label: string) {
  const value = source[key]
  if (typeof value !== "string") throw new Error(`${label}.${key} 必须是字符串`)
  return value
}

function optionalStringField(
  source: Record<string, unknown>,
  key: string,
  label: string
) {
  const value = source[key]
  if (value == null) return null
  if (typeof value !== "string") throw new Error(`${label}.${key} 必须是字符串或 null`)
  return value
}

function numberField(source: Record<string, unknown>, key: string, label: string) {
  const value = source[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}.${key} 必须是数字`)
  }
  return value
}

function booleanField(source: Record<string, unknown>, key: string, label: string) {
  const value = source[key]
  if (typeof value !== "boolean") throw new Error(`${label}.${key} 必须是布尔值`)
  return value
}

function parseReviewHunk(
  value: unknown,
  label: string
): WorktreeFileDiff["hunks"][number] {
  const record = recordFromUnknown(value, label)
  const lines = record.lines
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
    throw new Error(`${label}.lines 必须是字符串数组`)
  }
  return {
    oldStart: numberField(record, "oldStart", label),
    oldLines: numberField(record, "oldLines", label),
    newStart: numberField(record, "newStart", label),
    newLines: numberField(record, "newLines", label),
    lines
  }
}

function parseReviewFileDiff(value: unknown, label: string): WorktreeFileDiff {
  const record = recordFromUnknown(value, label)
  const hunks = record.hunks
  if (!Array.isArray(hunks)) throw new Error(`${label}.hunks 必须是数组`)
  return {
    path: stringField(record, "path", label),
    oldPath: optionalStringField(record, "oldPath", label),
    status: stringField(record, "status", label),
    additions: numberField(record, "additions", label),
    deletions: numberField(record, "deletions", label),
    binary: booleanField(record, "binary", label),
    hunks: hunks.map((hunk, index) =>
      parseReviewHunk(hunk, `${label}.hunks[${index}]`)
    )
  }
}

function parseReviewDiff(value: unknown, label: string): ReviewRunDiff["diff"] {
  const record = recordFromUnknown(value, label)
  const files = record.files
  if (!Array.isArray(files)) throw new Error(`${label}.files 必须是数组`)
  const patchError = record.patchError
  if (patchError != null && typeof patchError !== "string") {
    throw new Error(`${label}.patchError 必须是字符串或 null`)
  }
  const state = ["pending", "ready", "partial", "unavailable"].includes(String(record.reviewState)) ? record.reviewState as ReviewRunDiff["diff"]["reviewState"] : undefined
  const interrupted = state === "pending"
  const reason = interrupted ? "上次文件审查未完成，轮次位置已保留" : optionalStringField(record, "reviewReason", label)
  const metrics = <T,>(value: unknown, keys: string[]): T | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const data = value as Record<string, unknown>
    if (!keys.every((key) => typeof data[key] === "number" && Number.isFinite(data[key]) && (data[key] as number) >= 0)) return undefined
    return Object.fromEntries(keys.map((key) => [key, data[key]])) as T
  }
  return {
    isRepo: booleanField(record, "isRepo", label),
    files: files.map((file, index) =>
      parseReviewFileDiff(file, `${label}.files[${index}]`)
    ),
    patchError: interrupted ? reason : patchError ?? null,
    reviewState: interrupted ? "unavailable" : state,
    reviewReason: reason,
    timings: metrics(record.timings, ["enumerationMs", "readMs", "hashMs", "writeMs", "totalMs", "freezeMs", "diffMs"]),
    stats: metrics(record.stats, ["capturedFiles", "skippedFiles", "capturedBytes", "enumeratedEntries"])
  }
}

function parseStoredReviewDiff(item: unknown, label: string): ReviewRunDiff {
  const entry = recordFromUnknown(item, label)
  return {
    id: stringField(entry, "id", label),
    createdAt: numberField(entry, "createdAt", label),
    diff: parseReviewDiff(entry.diff, `${label}.diff`)
  }
}

export function parseStoredReviewDiffs(sidecar: unknown): ReviewRunDiff[] {
  let record: Record<string, unknown> | null
  try {
    record = optionalRecordFromUnknown(sidecar)
  } catch (error) {
    console.warn("sidecar.reviewDiffs 读取失败，已忽略:", error)
    return []
  }
  if (!record || record.reviewDiffs == null) return []
  const raw = record.reviewDiffs
  if (!Array.isArray(raw)) {
    console.warn("sidecar.reviewDiffs 必须是数组，已忽略损坏数据")
    return []
  }
  const parsed: ReviewRunDiff[] = []
  raw.forEach((item, index) => {
    const label = `sidecar.reviewDiffs[${index}]`
    try {
      parsed.push(parseStoredReviewDiff(item, label))
    } catch (error) {
      // 单条损坏不连坐：跳过该条，保留其余记录与会话加载流程
      console.warn(`${label} 解析失败，已跳过:`, error)
    }
  })
  return parsed
}
