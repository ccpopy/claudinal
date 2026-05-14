import { describe, expect, it } from "vitest"
import type { UIMessage } from "@/types/ui"
import {
  chatTimelinePreview,
  chatTimelineRoleLabel,
  formatTimelineTime
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

  it("formats invalid timestamps as empty text", () => {
    expect(formatTimelineTime(Number.NaN)).toBe("")
    expect(formatTimelineTime(0)).toBe("")
  })
})
