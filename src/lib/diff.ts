import type {
  GitWorktreeStatus,
  WorktreeDiff,
  WorktreeFileDiff
} from "@/lib/ipc"
import { basename } from "@/lib/localPath"
import type { UIEntry, UIMessage } from "@/types/ui"

export interface StructuredHunk {
  oldStart?: number
  oldLines?: number
  newStart?: number
  newLines?: number
  lines?: string[]
}

export interface FileChange {
  path: string
  oldPath?: string | null
  basename: string
  kind: "create" | "update" | "delete"
  source: "session" | "git" | "status" | "snapshot"
  hunks: StructuredHunk[]
  content?: string
  binary?: boolean
  adds: number
  dels: number
}

export interface ReviewRunDiff {
  id: string
  createdAt: number
  diff: WorktreeDiff
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

export function relPath(path: string, cwd?: string | null): string {
  const normalized = normalizePath(path)
  const root = cwd ? normalizePath(cwd).replace(/\/+$/, "") : ""
  if (root && normalized.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return normalized.slice(root.length + 1)
  }
  return normalized
}

function keyPath(path: string): string {
  return normalizePath(path).toLowerCase()
}

/**
 * 展示路径等价判断：统一正反斜杠并忽略大小写（Windows 盘符 / 路径大小写不稳定，
 * 工具入参、git 输出与快照 rel path 可能只差大小写或分隔符）。
 */
export function sameDisplayPath(a: string, b: string): boolean {
  return keyPath(a) === keyPath(b)
}

/**
 * 把审查 diff（reviewDiffs）归位到时间线上的 result 条目。
 *
 * - 数量一致：保持既有顺位配对——GUI 全程管理的会话每个 result 恰好落一条
 *   review（finishRunReview 失败也会补空记录），这是已验证的对齐方式。
 * - 数量不一致（resume 了 CLI 跑过的旧会话、sidecar 丢失部分记录等）：按时间
 *   归位。review.createdAt 总在其 result 之后产生（diff 在 result 到达后才算），
 *   因此归到「ts <= createdAt 的最后一个 result」；找不到宿主或宿主已被更早的
 *   review 占用时不强行挂载（宁缺勿错）。
 *
 * 返回数组与 resultTs 等长，下标 i 即第 i 个 result 应展示的 review。
 */
export function matchReviewsToResults(
  resultTs: number[],
  reviews: ReviewRunDiff[]
): Array<ReviewRunDiff | undefined> {
  const matched: Array<ReviewRunDiff | undefined> = new Array(
    resultTs.length
  ).fill(undefined)
  if (reviews.length === 0 || resultTs.length === 0) return matched
  if (reviews.length === resultTs.length) {
    for (let i = 0; i < reviews.length; i++) matched[i] = reviews[i]
    return matched
  }
  for (const review of reviews) {
    const createdAt = review.createdAt
    if (!Number.isFinite(createdAt)) continue
    let target = -1
    for (let i = 0; i < resultTs.length; i++) {
      const ts = resultTs[i]
      if (Number.isFinite(ts) && ts <= createdAt) target = i
    }
    if (target >= 0 && !matched[target]) matched[target] = review
  }
  return matched
}

export function kindFromStatus(status: string): FileChange["kind"] {
  if (status.includes("D")) return "delete"
  if (status.includes("?") || status.includes("A")) return "create"
  return "update"
}

export function fileChangeFromWorktreeFile(
  file: WorktreeFileDiff,
  source: Extract<FileChange["source"], "git" | "snapshot">
): FileChange {
  return {
    path: file.path,
    oldPath: file.oldPath,
    basename: basename(file.path),
    kind: kindFromStatus(file.status),
    source,
    hunks: file.hunks,
    binary: file.binary,
    adds: file.additions,
    dels: file.deletions
  }
}

export function collectChanges(args: {
  entries: UIEntry[]
  gitStatus?: GitWorktreeStatus | null
  worktreeDiff?: WorktreeDiff | null
  snapshotDiffs?: WorktreeDiff[]
  cwd?: string | null
}): FileChange[] {
  const { entries, gitStatus, worktreeDiff, snapshotDiffs, cwd } = args
  const map = new Map<string, FileChange>()
  for (const e of entries) {
    if (e.kind !== "message") continue
    const m = e as UIMessage
    if (m.role !== "user") continue
    for (const b of m.blocks) {
      if (b.type !== "tool_result") continue
      const tur = b.toolUseResult as
        | {
            type?: string
            filePath?: string
            content?: string
            structuredPatch?: StructuredHunk[]
          }
        | undefined
      if (!tur?.filePath) continue
      const displayPath = relPath(tur.filePath, cwd)
      const key = keyPath(displayPath)
      const existing = map.get(key)
      if (tur.type === "update" && tur.structuredPatch) {
        const adds = countPatchLines(tur.structuredPatch, "+")
        const dels = countPatchLines(tur.structuredPatch, "-")
        if (existing && existing.kind !== "create") {
          existing.hunks.push(...tur.structuredPatch)
          existing.adds += adds
          existing.dels += dels
        } else if (!existing) {
          map.set(key, {
            path: displayPath,
            basename: basename(displayPath),
            kind: "update",
            source: "session",
            hunks: tur.structuredPatch,
            adds,
            dels
          })
        }
      } else if (tur.type === "create") {
        map.set(key, {
          path: displayPath,
          basename: basename(displayPath),
          kind: "create",
          source: "session",
          hunks: [],
          content: tur.content,
          adds: (tur.content ?? "").split("\n").length,
          dels: 0
        })
      }
    }
  }
  for (const diff of snapshotDiffs ?? []) {
    for (const file of diff.files) {
      const key = keyPath(file.path)
      map.set(key, fileChangeFromWorktreeFile(file, "snapshot"))
    }
  }
  if (worktreeDiff?.isRepo) {
    for (const file of worktreeDiff.files) {
      const key = keyPath(file.path)
      map.set(key, fileChangeFromWorktreeFile(file, "git"))
    }
  }
  if (gitStatus?.isRepo) {
    for (const file of gitStatus.files) {
      const key = keyPath(file.path)
      if (map.has(key)) continue
      map.set(key, {
        path: file.path,
        basename: basename(file.path),
        kind: kindFromStatus(file.status),
        source: "status",
        hunks: [],
        adds: file.additions,
        dels: file.deletions
      })
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.basename.localeCompare(b.basename)
  )
}

export function collectRunToolChanges(
  entries: UIEntry[],
  cwd?: string | null
): FileChange[] {
  return collectChanges({ entries, cwd }).filter(
    (change) => change.source === "session"
  )
}

export function collectLatestRunToolChanges(
  entries: UIEntry[],
  cwd?: string | null
): FileChange[] {
  let start = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "result") {
      start = i + 1
      break
    }
  }
  return collectRunToolChanges(entries.slice(start), cwd)
}

export function formatHunksAsPatch(change: FileChange): string {
  if (change.binary) {
    return `Binary file ${change.path} differs\n`
  }
  if (change.kind === "create" && change.content && change.hunks.length === 0) {
    const lines = change.content.split("\n").map((line) => `+${line}`).join("\n")
    return `--- /dev/null\n+++ b/${change.path}\n@@ -0,0 +1,${
      change.content.split("\n").length
    } @@\n${lines}\n`
  }
  if (change.hunks.length === 0) return ""
  const header = `--- a/${change.oldPath ?? change.path}\n+++ b/${change.path}\n`
  const body = change.hunks
    .map((hunk) => {
      const head = `@@ -${hunk.oldStart ?? 0},${hunk.oldLines ?? 0} +${
        hunk.newStart ?? 0
      },${hunk.newLines ?? 0} @@`
      const lines = (hunk.lines ?? []).join("\n")
      return `${head}\n${lines}`
    })
    .join("\n")
  return `${header}${body}\n`
}

export function countPatchLines(hunks: StructuredHunk[], prefix: "+" | "-"): number {
  return hunks.reduce(
    (acc, hunk) =>
      acc + (hunk.lines ?? []).filter((line) => line.startsWith(prefix)).length,
    0
  )
}
