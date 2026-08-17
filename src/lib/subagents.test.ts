import { describe, expect, it } from "vitest"
import type { ClaudeEvent } from "@/types/events"
import {
  initSubagentRegistry,
  reduceSubagentRegistry,
  runningSubagentCount,
  subagentRegistryBusy
} from "./subagents"

const event = (value: Record<string, unknown>) => value as ClaudeEvent

function launch(agentId = "agent-1", timestamp = "2026-08-17T01:00:00.000Z") {
  return event({
    type: "user",
    timestamp,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: [] }]
    },
    toolUseResult: {
      isAsync: true,
      status: "async_launched",
      agentId,
      description: "Delete atomic fox",
      outputFile: `C:\\temp\\${agentId}.output`
    }
  })
}

function notification(
  type: "queue-operation" | "user",
  status = "completed",
  timestamp = "2026-08-17T01:02:00.000Z"
) {
  return event({
    type,
    operation: type === "queue-operation" ? "enqueue" : undefined,
    origin: type === "user" ? { kind: "task-notification" } : undefined,
    timestamp,
    content:
      type === "queue-operation"
        ? `<task-notification><task-id>agent-1</task-id><status>${status}</status><summary>Agent finished</summary></task-notification>`
        : undefined,
    message:
      type === "user"
        ? {
            role: "user",
            content: `<task-notification><task-id>agent-1</task-id><status>${status}</status><summary>Agent finished</summary></task-notification>`
          }
        : undefined
  })
}

function result(extra: Record<string, unknown> = {}) {
  return event({
    type: "result",
    subtype: "success",
    timestamp: "2026-08-17T01:03:00.000Z",
    ...extra
  })
}

describe("subagent lifecycle", () => {
  it("keeps a successful foreground result intermediate until completion is delivered and summarized", () => {
    let registry = reduceSubagentRegistry(initSubagentRegistry(), launch()).registry
    expect(subagentRegistryBusy(registry)).toBe(true)
    expect(runningSubagentCount(registry)).toBe(1)

    let transition = reduceSubagentRegistry(registry, result())
    expect(transition.resultDisposition).toBe("intermediate")
    registry = transition.registry

    registry = reduceSubagentRegistry(
      registry,
      notification("queue-operation")
    ).registry
    expect(registry.agents[0].status).toBe("completed")
    expect(registry.agents[0].notificationDeliveredAt).toBeUndefined()
    expect(reduceSubagentRegistry(registry, result()).resultDisposition).toBe(
      "intermediate"
    )

    registry = reduceSubagentRegistry(registry, notification("user")).registry
    transition = reduceSubagentRegistry(registry, result())
    expect(transition.resultDisposition).toBe("final")
    expect(subagentRegistryBusy(transition.registry)).toBe(false)
  })

  it("treats interruption as final and cancels still-running agents", () => {
    const registry = reduceSubagentRegistry(initSubagentRegistry(), launch()).registry
    const transition = reduceSubagentRegistry(
      registry,
      result({ terminal_reason: "interrupted", is_error: true })
    )
    expect(transition.resultDisposition).toBe("final")
    expect(transition.registry.agents[0].status).toBe("cancelled")
    expect(subagentRegistryBusy(transition.registry)).toBe(false)
  })

  it("does not let a genuine failed result stay blocked by an agent", () => {
    const registry = reduceSubagentRegistry(initSubagentRegistry(), launch()).registry
    const transition = reduceSubagentRegistry(
      registry,
      result({ is_error: true, subtype: "error_during_execution" })
    )
    expect(transition.resultDisposition).toBe("final")
    expect(subagentRegistryBusy(transition.registry)).toBe(false)
  })

  it("ignores task notifications for background commands", () => {
    const transition = reduceSubagentRegistry(
      initSubagentRegistry(),
      event({
        type: "queue-operation",
        operation: "enqueue",
        content:
          "<task-notification><task-id>command-1</task-id><status>completed</status></task-notification>"
      })
    )
    expect(transition.changed).toBe(false)
    expect(transition.registry.agents).toEqual([])
  })
})
