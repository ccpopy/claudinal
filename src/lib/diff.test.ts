import { describe, expect, it } from "vitest"
import {
  collectChanges,
  matchReviewsToResults,
  sameDisplayPath,
  type ReviewRunDiff
} from "./diff"
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

describe("sameDisplayPath", () => {
  it("ignores slash direction and letter case (Windows)", () => {
    expect(sameDisplayPath("src\\App.tsx", "src/App.tsx")).toBe(true)
    expect(sameDisplayPath("Src/app.TSX", "src/App.tsx")).toBe(true)
    expect(sameDisplayPath("src/App.tsx", "src/Other.tsx")).toBe(false)
  })
})

function review(id: string, createdAt: number): ReviewRunDiff {
  return {
    id,
    createdAt,
    diff: { isRepo: false, files: [], patchError: null }
  }
}

describe("matchReviewsToResults", () => {
  it("keeps ordinal pairing when counts are equal (GUI-managed session)", () => {
    // createdAt 故意都落在最后一个 result 之后：若错误地走按时间归位会得到
    // [undefined, a]；数量一致的向后兼容主路径必须无视时间、严格按顺位返回 [a, b]
    const reviews = [review("a", 9_000), review("b", 9_500)]
    expect(matchReviewsToResults([1_000, 2_000], reviews)).toEqual([
      reviews[0],
      reviews[1]
    ])
  })

  it("attaches by createdAt when results outnumber reviews (resumed CLI session)", () => {
    // 三个历史 result 只有最后一轮经 GUI 产出 review：必须挂到最后一个 result，
    // 旧顺位逻辑会错挂到第一个 result 上
    const reviews = [review("only", 3_200)]
    expect(matchReviewsToResults([1_000, 2_000, 3_000], reviews)).toEqual([
      undefined,
      undefined,
      reviews[0]
    ])
  })

  it("handles interleaved GUI and CLI turns by time", () => {
    const reviews = [review("first", 1_100), review("last", 3_500)]
    expect(matchReviewsToResults([1_000, 2_000, 3_000], reviews)).toEqual([
      reviews[0],
      undefined,
      reviews[1]
    ])
  })

  it("drops reviews that predate every result instead of mis-attaching", () => {
    const reviews = [review("orphan", 500)]
    expect(matchReviewsToResults([1_000, 2_000], reviews)).toEqual([
      undefined,
      undefined
    ])
  })

  it("keeps the earliest review when two compete for the same result", () => {
    const reviews = [review("a", 1_100), review("b", 1_200)]
    expect(matchReviewsToResults([1_000, 5_000, 9_000], reviews)).toEqual([
      reviews[0],
      undefined,
      undefined
    ])
  })

  it("returns all-undefined for empty inputs", () => {
    expect(matchReviewsToResults([], [review("a", 1)])).toEqual([])
    expect(matchReviewsToResults([1_000], [])).toEqual([undefined])
  })
})

