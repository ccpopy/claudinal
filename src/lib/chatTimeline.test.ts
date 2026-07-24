import { describe, expect, it } from "vitest"
import type { UIMessage } from "@/types/ui"
import {
  chatTimelineMarkerWidth,
  chatTimelinePreview,
  chatTimelineRoleLabel,
  formatTimelineTime,
  timelineTargetIntersectsViewport
} from "./chatTimeline"

function message(partial: Partial<UIMessage>): UIMessage {
  return {
    kind: "message",
    id: "m1",
    role: "user",
    blocks: [],
    streaming: false,
    ts: 1_700_000_000_000,
    ...partial
  }
}

describe("chatTimeline", () => {
  it("uses compact text from the first text block", () => {
    expect(
      chatTimelinePreview(
        message({
          blocks: [{ type: "text", text: " 第一行\n\n  第二行   " }]
        })
      )
    ).toBe("第一行 第二行")
  })

  it("normalizes markdown into a stable plain-text preview", () => {
    expect(
      chatTimelinePreview(
        message({
          blocks: [
            {
              type: "text",
              text: [
                "## 实现内容",
                "",
                "> 查看 **[文档](https://example.com/docs)**",
                "",
                "- [x] 打开 `src/App.tsx`",
                "- ~~旧方案~~ 改为 _新方案_"
              ].join("\n")
            }
          ]
        })
      )
    ).toBe("实现内容 查看 文档 打开 src/App.tsx 旧方案 改为 新方案")
  })

  it("keeps fenced code readable without exposing markdown fences", () => {
    expect(
      chatTimelinePreview(
        message({
          blocks: [
            {
              type: "text",
              text: "```ts\nconst ready = true\n```"
            }
          ]
        })
      )
    ).toBe("const ready = true")
  })

  it("falls back to attachment, image, tool, and streaming previews", () => {
    expect(
      chatTimelinePreview(
        message({
          blocks: [{ type: "attachment", attachmentName: "需求.md" }]
        })
      )
    ).toBe("附件：需求.md")
    expect(chatTimelinePreview(message({ blocks: [{ type: "image" }] }))).toBe(
      "图片"
    )
    expect(
      chatTimelinePreview(message({ blocks: [{ type: "tool_use", toolName: "Read" }] }))
    ).toBe("工具：Read")
    expect(chatTimelinePreview(message({ streaming: true }))).toBe("正在生成回复")
  })

  it("labels timeline roles", () => {
    expect(chatTimelineRoleLabel("user")).toBe("用户消息")
    expect(chatTimelineRoleLabel("assistant")).toBe("Claude 回复")
  })

  it("labels guide deliveries distinctly from plain user messages", () => {
    expect(chatTimelineRoleLabel("user", "guide")).toBe("引导消息")
    expect(chatTimelineRoleLabel("user", undefined)).toBe("用户消息")
    // assistant 不受 delivery 影响（防御：delivery 只在 user 上有意义）
    expect(chatTimelineRoleLabel("assistant", "guide")).toBe("Claude 回复")
  })

  it("formats invalid timestamps as empty text", () => {
    expect(formatTimelineTime(Number.NaN)).toBe("")
    expect(formatTimelineTime(0)).toBe("")
  })

  it("magnifies timeline markers smoothly around the pointer", () => {
    expect(chatTimelineMarkerWidth(null, 20)).toBe(6)
    expect(chatTimelineMarkerWidth(20, 20)).toBe(28)
    expect(chatTimelineMarkerWidth(64, 20)).toBe(6)
    expect(chatTimelineMarkerWidth(8, 20)).toBeCloseTo(
      chatTimelineMarkerWidth(32, 20)
    )
    expect(chatTimelineMarkerWidth(20, 20)).toBeGreaterThan(
      chatTimelineMarkerWidth(36, 20)
    )
  })

  it("detects timeline messages intersecting the scroll viewport", () => {
    expect(timelineTargetIntersectsViewport(20, 40, 0, 100)).toBe(true)
    expect(timelineTargetIntersectsViewport(-10, 20, 0, 100)).toBe(true)
    expect(timelineTargetIntersectsViewport(100, 20, 0, 100)).toBe(false)
    expect(timelineTargetIntersectsViewport(0, 20, 20, 100)).toBe(false)
  })
})
