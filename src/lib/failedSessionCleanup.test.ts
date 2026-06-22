import { describe, expect, it } from "vitest"
import {
  findFirstTurnFailedMessageId,
  hasResumableUiConversationContext
} from "./failedSessionCleanup"
import type { UIEntry, UIMessage } from "@/types/ui"

function message(
  id: string,
  role: UIMessage["role"],
  text = "",
  model?: string
): UIEntry {
  return {
    kind: "message",
    id,
    role,
    blocks: text ? [{ type: "text", text }] : [],
    model,
    streaming: false,
    ts: 1
  }
}

function sent(text: string) {
  return new Map([["local-1", { text }]])
}

describe("findFirstTurnFailedMessageId", () => {
  it("returns the sent user message id when it is the only visible message", () => {
    const entries: UIEntry[] = [
      {
        kind: "system_init",
        sessionId: "session-1",
        mcpServers: [],
        tools: [],
        skills: [],
        slashCommands: [],
        agents: [],
        ts: 0
      },
      message("local-1", "user", "给我讲讲这个项目"),
      { kind: "stderr", line: "API Error: Request rejected (429)", ts: 2 },
      { kind: "result", isError: true, ts: 3 }
    ]

    expect(findFirstTurnFailedMessageId(entries, sent("给我讲讲这个项目"))).toBe(
      "local-1"
    )
  })

  it("allows the echoed user event and synthetic API error assistant from a failed first turn", () => {
    const entries = [
      message("local-1", "user", "给我讲讲这个项目"),
      message("echo-user", "user", "给我讲讲这个项目"),
      message(
        "synthetic-error",
        "assistant",
        "API Error: Request rejected (429) · Service Unavailable",
        "<synthetic>"
      ),
      { kind: "result", isError: true, ts: 3 } satisfies UIEntry
    ]

    expect(findFirstTurnFailedMessageId(entries, sent("给我讲讲这个项目"))).toBe(
      "local-1"
    )
  })

  it("does not match when a real assistant message exists", () => {
    const entries = [
      message("local-1", "user", "给我讲讲这个项目"),
      message("assistant-1", "assistant", "真实回复", "claude-sonnet"),
      { kind: "result", isError: true, ts: 3 } satisfies UIEntry
    ]

    expect(findFirstTurnFailedMessageId(entries, sent("给我讲讲这个项目"))).toBeNull()
  })

  it("does not match an unknown user message", () => {
    expect(
      findFirstTurnFailedMessageId(
        [message("transcript-user", "user", "历史消息")],
        new Map()
      )
    ).toBeNull()
  })

  it("does not match multiple sent user messages", () => {
    const entries = [
      message("local-1", "user", "第一条"),
      message("local-2", "user", "第二条")
    ]

    expect(
      findFirstTurnFailedMessageId(
        entries,
        new Map([
          ["local-1", { text: "第一条" }],
          ["local-2", { text: "第二条" }]
        ])
      )
    ).toBeNull()
  })
})

describe("hasResumableUiConversationContext", () => {
  it("ignores synthetic API error assistant messages", () => {
    expect(
      hasResumableUiConversationContext([
        message("local-1", "user", "给我讲讲这个项目"),
        message(
          "synthetic-error",
          "assistant",
          "API Error: Request rejected (429)",
          "<synthetic>"
        )
      ])
    ).toBe(false)
  })

  it("accepts real assistant messages as resumable context", () => {
    expect(
      hasResumableUiConversationContext([
        message("local-1", "user", "给我讲讲这个项目"),
        message("assistant-1", "assistant", "真实回复", "claude-sonnet")
      ])
    ).toBe(true)
  })
})
