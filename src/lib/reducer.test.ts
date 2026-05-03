import { describe, expect, it } from "vitest"
import { init, reduce } from "./reducer"
import type { ClaudeEvent } from "@/types/events"
import type { UIMessage } from "@/types/ui"

const event = (e: Partial<ClaudeEvent> & { type: string }): ClaudeEvent =>
  e as ClaudeEvent

function lastMessage(state: ReturnType<typeof init>): UIMessage {
  const last = state.entries[state.entries.length - 1]
  if (!last || last.kind !== "message") {
    throw new Error("expected last entry to be a message")
  }
  return last as UIMessage
}

describe("reducer.partial streaming", () => {
  it("accumulates text deltas and finalizes on message_stop", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m1", role: "assistant", model: "sonnet" }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello, " }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "world!" }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "content_block_stop",
          index: 0
        }
      })
    })

    const mid = lastMessage(s)
    expect(mid.streaming).toBe(true)
    expect(mid.blocks[0].type).toBe("text")
    expect(mid.blocks[0].text).toBe("Hello, world!")
    expect(mid.blocks[0].partial).toBe(false)

    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: { type: "message_stop" }
      })
    })
    const done = lastMessage(s)
    expect(done.streaming).toBe(false)
  })

  it("buffers tool_use input_json_delta and parses on stop", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m2", role: "assistant" }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"cmd":"ls' }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: ' -la"}' }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 }
      })
    })
    const msg = lastMessage(s)
    expect(msg.blocks[0].type).toBe("tool_use")
    expect(msg.blocks[0].toolInput).toEqual({ cmd: "ls -la" })
  })

  it("fills sparse content block indexes with placeholders", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m-sparse", role: "assistant" }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 2,
          content_block: { type: "text", text: "third" }
        }
      })
    })
    const msg = lastMessage(s)
    expect(msg.blocks).toHaveLength(3)
    expect(msg.blocks[0].type).toBe("unknown")
    expect(msg.blocks[1].type).toBe("unknown")
    expect(msg.blocks[2].type).toBe("text")
    expect(msg.blocks[2].text).toBe("third")
  })
})

describe("reducer.assistant snapshot overlay", () => {
  it("merges assistant snapshot into existing streaming message without closing it", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m3", role: "assistant" }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "m3",
          content: [{ type: "text", text: "snapshot" }],
          model: "opus",
          stop_reason: null
        } as never
      })
    })
    const msg = lastMessage(s)
    expect(msg.id).toBe("m3")
    expect(msg.streaming).toBe(true)
    expect(msg.blocks[0].type).toBe("text")
    expect(msg.blocks[0].text).toBe("snapshot")
    expect(msg.model).toBe("opus")
  })

  it("appends a new assistant message when id is unknown", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "m-fresh",
          content: [{ type: "text", text: "fresh" }]
        } as never
      })
    })
    expect(s.entries).toHaveLength(1)
    const msg = lastMessage(s)
    expect(msg.id).toBe("m-fresh")
    expect(msg.streaming).toBe(false)
  })
})

describe("reducer.tool_use_result attachment", () => {
  it("attaches tool_use_result payload onto matching tool_result block", () => {
    let s = init()
    // assistant 先发出 tool_use 块
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "m4",
          content: [
            { type: "tool_use", id: "tool-1", name: "Read", input: { path: "/x" } }
          ]
        } as never
      })
    })
    // user 事件回带 tool_result + 顶级 tool_use_result
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [{ type: "text", text: "file content" }]
            }
          ]
        },
        tool_use_result: { file: { path: "/x", content: "file content" } }
      } as never)
    })
    const userMsg = s.entries[s.entries.length - 1] as UIMessage
    const toolResultBlock = userMsg.blocks.find((b) => b.type === "tool_result")
    expect(toolResultBlock).toBeTruthy()
    expect(toolResultBlock?.toolUseId).toBe("tool-1")
    expect(toolResultBlock?.toolUseResult).toEqual({
      file: { path: "/x", content: "file content" }
    })
    // 同时上游 tool_use 块的 endedAt 被打上时间戳
    const assistantMsg = s.entries[0] as UIMessage
    const toolUseBlock = assistantMsg.blocks.find((b) => b.type === "tool_use")
    expect(toolUseBlock?.endedAt).toBeTypeOf("number")
  })

  it("filters internal command echo blocks from user messages", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<command-name>/help</command-name>"
            }
          ]
        }
      } as never)
    })
    expect(s.entries).toHaveLength(0)
  })

  it("strips collaboration prompt prefix from user text", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "[Claudinal 协同模式] rules\n\n用户需求：\n请帮我实现 X"
            }
          ]
        }
      } as never)
    })
    const msg = lastMessage(s)
    expect(msg.blocks[0].text).toBe("请帮我实现 X")
  })
})

describe("reducer.unknown preservation", () => {
  it("keeps unknown event types as raw entries instead of dropping them", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({ type: "totally-unknown-type", payload: 42 })
    })
    expect(s.entries).toHaveLength(1)
    expect(s.entries[0].kind).toBe("unknown")
  })

  it("routes raw and stderr events into dedicated entries", () => {
    let s = init()
    s = reduce(s, { kind: "event", event: event({ type: "raw", line: "$ ls" }) })
    s = reduce(s, {
      kind: "event",
      event: event({ type: "stderr", line: "boom" })
    })
    expect(s.entries.map((e) => e.kind)).toEqual(["raw", "stderr"])
  })
})

describe("reducer.local message lifecycle", () => {
  it("user_local appends and drop_local removes the message", () => {
    let s = init()
    s = reduce(s, {
      kind: "user_local",
      blocks: [{ type: "text", text: "hi" }],
      localId: "local-1"
    })
    expect(s.entries).toHaveLength(1)
    s = reduce(s, { kind: "drop_local", localId: "local-1" })
    expect(s.entries).toHaveLength(0)
  })

  it("unqueue_local moves queued message ahead of the next assistant turn", () => {
    let s = init()
    // 先有一段 assistant 输出
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "asst-old",
          content: [{ type: "text", text: "previous reply" }]
        } as never
      })
    })
    // 用户排队插入消息
    s = reduce(s, {
      kind: "user_local",
      blocks: [{ type: "text", text: "next ask" }],
      localId: "local-2",
      queued: true
    })
    // 假设后续 assistant 正在输出（未真正完成 unqueue）
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "asst-new",
          content: [{ type: "text", text: "new reply" }]
        } as never
      })
    })
    s = reduce(s, { kind: "unqueue_local", localId: "local-2" })

    // queued 标记应被清除，且 local message 排在 asst-new 之前
    const idsAndQueued = s.entries.map((e) => {
      if (e.kind !== "message") return null
      const m = e as UIMessage
      return [m.id, m.queued ?? false] as const
    })
    expect(idsAndQueued).toEqual([
      ["asst-old", false],
      ["local-2", false],
      ["asst-new", false]
    ])
  })

  it("reset wipes the entire entry list", () => {
    let s = init()
    s = reduce(s, {
      kind: "user_local",
      blocks: [{ type: "text", text: "x" }],
      localId: "l1"
    })
    s = reduce(s, { kind: "reset" })
    expect(s.entries).toEqual([])
  })
})

describe("reducer.load_transcript filters internal events", () => {
  it("ignores ai-title / queue-operation / permission-mode and similar markers", () => {
    const events: ClaudeEvent[] = [
      event({ type: "ai-title", title: "x" }),
      event({ type: "queue-operation" }),
      event({ type: "permission-mode", mode: "plan" }),
      event({ type: "deferred_tools_delta" }),
      event({ type: "skill_listing" }),
      event({ type: "tools_changed" }),
      event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "kept",
          content: [{ type: "text", text: "kept" }]
        }
      } as never)
    ]
    const s = reduce(init(), { kind: "load_transcript", events })
    expect(s.entries).toHaveLength(1)
    const msg = s.entries[0] as UIMessage
    expect(msg.id).toBe("kept")
    // load_transcript 收尾时所有 message 的 streaming 都置 false
    expect(msg.streaming).toBe(false)
  })
})
