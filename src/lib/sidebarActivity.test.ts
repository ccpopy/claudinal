import { describe, expect, it } from "vitest"
import { deriveSidebarActivity, sidebarSessionKey } from "./sidebarActivity"

describe("sidebarActivity", () => {
  it("combines the foreground and background streaming sessions", () => {
    const activity = deriveSidebarActivity({
      streamingProjectId: "project-a",
      streamingSessionId: "session-a",
      streamingSessionRefs: [
        { projectId: "project-b", sessionId: "session-b" },
        { projectId: "project-a", sessionId: "session-a" }
      ],
      waitingSessionRefs: []
    })

    expect(activity.streamingSessionKeys).toEqual(
      new Set([
        sidebarSessionKey("project-a", "session-a"),
        sidebarSessionKey("project-b", "session-b")
      ])
    )
    expect(activity.busyProjectIds).toEqual(
      new Set(["project-a", "project-b"])
    )
  })

  it("marks waiting child sessions as project activity", () => {
    const activity = deriveSidebarActivity({
      streamingProjectId: null,
      streamingSessionId: null,
      streamingSessionRefs: [],
      waitingSessionRefs: [
        { projectId: "project-a", sessionId: "session-a" },
        { projectId: "project-b", sessionId: "session-b" }
      ]
    })

    expect(activity.waitingSessionKeys).toEqual(
      new Set([
        sidebarSessionKey("project-a", "session-a"),
        sidebarSessionKey("project-b", "session-b")
      ])
    )
    expect(activity.busyProjectIds).toEqual(
      new Set(["project-a", "project-b"])
    )
  })

  it("keeps a newly-started project busy before a session id is known", () => {
    const activity = deriveSidebarActivity({
      streamingProjectId: "project-a",
      streamingSessionId: null,
      streamingSessionRefs: [],
      waitingSessionRefs: []
    })

    expect(activity.streamingSessionKeys).toEqual(new Set())
    expect(activity.busyProjectIds).toEqual(new Set(["project-a"]))
  })
})
