import { describe, expect, it } from "vitest"
import {
  partitionSubagents,
  shouldAutoScrollSubagentTranscript
} from "./SubagentsPanel"
import type { SubagentTask } from "@/lib/subagents"

function agent(
  id: string,
  status: SubagentTask["status"],
  startedAt: number,
  endedAt?: number
): SubagentTask {
  return {
    id,
    toolUseId: null,
    description: id,
    status,
    startedAt,
    updatedAt: endedAt ?? startedAt,
    endedAt
  }
}

describe("SubagentsPanel list grouping", () => {
  it("keeps running agents in launch order and finished agents newest first", () => {
    const groups = partitionSubagents([
      agent("old done", "completed", 1, 4),
      agent("second running", "running", 3),
      agent("new done", "failed", 2, 8),
      agent("first running", "running", 1)
    ])
    expect(groups.running.map((item) => item.id)).toEqual([
      "first running",
      "second running"
    ])
    expect(groups.finished.map((item) => item.id)).toEqual([
      "new done",
      "old done"
    ])
  })

  it("follows live output but opens terminal Agent transcripts from the top", () => {
    expect(shouldAutoScrollSubagentTranscript("running")).toBe(true)
    expect(shouldAutoScrollSubagentTranscript("completed")).toBe(false)
    expect(shouldAutoScrollSubagentTranscript("failed")).toBe(false)
    expect(shouldAutoScrollSubagentTranscript("cancelled")).toBe(false)
  })
})
