import { describe, expect, it } from "vitest"
import { collectChanges } from "./diff"
import type { WorktreeDiff } from "./ipc"
import type { UIEntry } from "@/types/ui"

describe("diff collection", () => {
  it("prefers snapshot changes over session tool patches for the same file", () => {
    const entries: UIEntry[] = [
      {
        kind: "message",
        id: "u1",
        role: "user",
        streaming: false,
        ts: 1,
        blocks: [
          {
            type: "tool_result",
            toolUseResult: {
              type: "update",
              filePath: "F:/project/demo/src/a.ts",
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-old", "+new"]
                }
              ]
            }
          }
        ]
      }
    ]
    const snapshot: WorktreeDiff = {
      isRepo: false,
      patchError: null,
      files: [
        {
          path: "src/a.ts",
          oldPath: null,
          status: "M",
          additions: 2,
          deletions: 1,
          binary: false,
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 3,
              lines: [" line", "-old", "+new", "+extra"]
            }
          ]
        }
      ]
    }

    const changes = collectChanges({
      entries,
      snapshotDiffs: [snapshot],
      cwd: "F:/project/demo"
    })

    expect(changes).toHaveLength(1)
    expect(changes[0].source).toBe("snapshot")
    expect(changes[0].adds).toBe(2)
  })
})

