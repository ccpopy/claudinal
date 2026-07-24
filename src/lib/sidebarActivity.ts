export interface SidebarSessionRef {
  projectId: string
  sessionId: string
}

interface SidebarActivityInput {
  streamingProjectId: string | null
  streamingSessionId: string | null
  streamingSessionRefs: readonly SidebarSessionRef[]
  waitingSessionRefs: readonly SidebarSessionRef[]
}

export interface SidebarActivity {
  streamingSessionKeys: Set<string>
  waitingSessionKeys: Set<string>
  busyProjectIds: Set<string>
}

export function sidebarSessionKey(projectId: string, sessionId: string): string {
  return `${projectId}::${sessionId}`
}

export function deriveSidebarActivity({
  streamingProjectId,
  streamingSessionId,
  streamingSessionRefs,
  waitingSessionRefs
}: SidebarActivityInput): SidebarActivity {
  const streamingSessionKeys = new Set<string>()
  const waitingSessionKeys = new Set<string>()
  const busyProjectIds = new Set<string>()

  if (streamingProjectId) {
    busyProjectIds.add(streamingProjectId)
    if (streamingSessionId) {
      streamingSessionKeys.add(
        sidebarSessionKey(streamingProjectId, streamingSessionId)
      )
    }
  }

  for (const ref of streamingSessionRefs) {
    if (!ref.projectId || !ref.sessionId) continue
    busyProjectIds.add(ref.projectId)
    streamingSessionKeys.add(sidebarSessionKey(ref.projectId, ref.sessionId))
  }

  for (const ref of waitingSessionRefs) {
    if (!ref.projectId || !ref.sessionId) continue
    busyProjectIds.add(ref.projectId)
    waitingSessionKeys.add(sidebarSessionKey(ref.projectId, ref.sessionId))
  }

  return { streamingSessionKeys, waitingSessionKeys, busyProjectIds }
}
