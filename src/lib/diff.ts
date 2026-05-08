import type { GitWorktreeStatus, WorktreeDiff } from "@/lib/ipc"
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

export function kindFromStatus(status: string): FileChange["kind"] {
  if (status.includes("D")) return "delete"
  if (status.includes("?") || status.includes("A")) return "create"
  return "update"
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
      map.set(key, {
        path: file.path,
        oldPath: file.oldPath,
        basename: basename(file.path),
        kind: kindFromStatus(file.status),
        source: "snapshot",
        hunks: file.hunks,
        binary: file.binary,
        adds: file.additions,
        dels: file.deletions
      })
    }
  }
  if (worktreeDiff?.isRepo) {
    for (const file of worktreeDiff.files) {
      const key = keyPath(file.path)
      map.set(key, {
        path: file.path,
        oldPath: file.oldPath,
        basename: basename(file.path),
        kind: kindFromStatus(file.status),
        source: "git",
        hunks: file.hunks,
        binary: file.binary,
        adds: file.additions,
        dels: file.deletions
      })
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

export function collectRunToolChanges(entries: UIEntry[], cwd?: string | null): FileChange[] {
  return collectChanges({ entries, cwd }).filter((change) => change.source === "session")
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

