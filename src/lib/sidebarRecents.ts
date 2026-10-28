import type { SessionMeta } from "@/lib/ipc"
import type { Project } from "@/lib/projects"
import type { ArchivedRef } from "@/lib/archivedSessions"
import { sidebarSessionKey } from "@/lib/sidebarActivity"

export type SessionListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; items: SessionMeta[] }
  | { kind: "error"; message: string }

export function recentSidebarSessions(
  projects: readonly Project[],
  sessions: Readonly<Record<string, SessionListState>>,
  archived: readonly ArchivedRef[],
  limit = 20
): Array<{ project: Project; session: SessionMeta }> {
  const excluded = new Set(archived.map((ref) => sidebarSessionKey(ref.projectId, ref.sessionId)))
  const byKey = new Map<string, { project: Project; session: SessionMeta }>()
  for (const project of projects) {
    const state = sessions[project.id]
    if (state?.kind !== "ok") continue
    for (const session of state.items) {
      const key = sidebarSessionKey(project.id, session.id)
      if (excluded.has(key)) continue
      const existing = byKey.get(key)
      if (!existing || session.modified_ts > existing.session.modified_ts) {
        byKey.set(key, { project, session })
      }
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.session.modified_ts - a.session.modified_ts
      || a.project.id.localeCompare(b.project.id) || a.session.id.localeCompare(b.session.id))
    .slice(0, Math.max(0, limit))
}
