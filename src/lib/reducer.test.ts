import { describe, expect, it } from "vitest"
import { init, markInterruptedResult, reduce } from "./reducer"
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
  it("does not render streamed user meta skill prompts", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "meta-user", role: "user" }
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
          content_block: {
            type: "text",
            text: "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design"
          }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: { type: "message_stop" }
      })
    })
    expect(s.entries).toHaveLength(0)

    s = reduce(s, {
      kind: "event",
      event: event({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design\n\nARGUMENTS: 优化前端"
            }
          ]
        }
      } as never)
    })
    expect(s.entries).toHaveLength(0)
  })

  it("does not render streamed skill prompts when the partial stream omits the user role", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "meta-user-without-role" }
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
          delta: {
            type: "text_delta",
            text: "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design"
          }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: { type: "message_stop" }
      })
    })

    expect(s.entries).toHaveLength(0)
  })

  it("removes a streamed skill prompt if it was misclassified as assistant text", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "meta-as-assistant", role: "assistant" }
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
          delta: {
            type: "text_delta",
            text: "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design"
          }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: { type: "message_stop" }
      })
    })

    expect(s.entries).toHaveLength(0)
  })

  it("removes a leaked visible skill meta prompt when the final meta event arrives", () => {
    let s = reduce(init(), {
      kind: "user_local",
      blocks: [
        {
          type: "text",
          text: "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design"
        }
      ],
      localId: "leaked-meta"
    })
    expect(s.entries).toHaveLength(1)

    s = reduce(s, {
      kind: "event",
      event: event({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design\n\nARGUMENTS: 优化前端"
            }
          ]
        }
      } as never)
    })
    expect(s.entries).toHaveLength(0)
  })

  it("removes a leaked assistant-shaped skill prompt when the final meta event arrives", () => {
    let s = reduce(init(), {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "leaked-asst-meta",
          content: [
            {
              type: "text",
              text: "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design"
            }
          ]
        } as never
      })
    })
    expect(s.entries).toHaveLength(1)

    s = reduce(s, {
      kind: "event",
      event: event({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design\n\nARGUMENTS: 优化前端"
            }
          ]
        }
      } as never)
    })
    expect(s.entries).toHaveLength(0)
  })

  it("filters skill prompt user events even when isMeta is missing", () => {
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
                "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design\n\nARGUMENTS: 优化前端"
            }
          ]
        },
        sourceToolUseID: "toolu_skill"
      } as never)
    })

    expect(s.entries).toHaveLength(0)
  })

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

  it("does not let a stale same-id snapshot shorten streamed text", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m-stale", role: "assistant" }
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
          delta: { type: "text_delta", text: "完整的流式内容" }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "m-stale",
          content: [{ type: "text", text: "完整的" }]
        } as never
      })
    })

    const msg = lastMessage(s)
    expect(msg.blocks).toHaveLength(1)
    expect(msg.blocks[0].text).toBe("完整的流式内容")
    expect(msg.streaming).toBe(true)
  })

  it("keeps split same-id assistant blocks without duplicating cumulative snapshots", () => {
    const assistant = (content: unknown[]) =>
      event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "m-split",
          content
        } as never
      })

    let s = reduce(init(), {
      kind: "event",
      event: assistant([{ type: "thinking", thinking: "先分析" }])
    })
    s = reduce(s, {
      kind: "event",
      event: assistant([
        { type: "tool_use", id: "tool-1", name: "Read", input: { path: "a" } }
      ])
    })
    s = reduce(s, {
      kind: "event",
      event: assistant([
        { type: "thinking", thinking: "先分析" },
        { type: "tool_use", id: "tool-1", name: "Read", input: { path: "a" } }
      ])
    })

    const msg = lastMessage(s)
    expect(msg.blocks.map((block) => block.type)).toEqual(["thinking", "tool_use"])
    expect(msg.blocks[0].text).toBe("先分析")
    expect(msg.blocks[1].toolUseId).toBe("tool-1")
  })

  it("does not let a stale tool snapshot erase streamed input", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m-tool-stale", role: "assistant" }
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
          content_block: { type: "tool_use", id: "tool-stale", name: "Bash", input: {} }
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
          delta: { type: "input_json_delta", partial_json: '{"cmd":"pnpm test"}' }
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
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "m-tool-stale",
          content: [{ type: "tool_use", id: "tool-stale", name: "Bash", input: {} }]
        } as never
      })
    })

    const msg = lastMessage(s)
    expect(msg.blocks).toHaveLength(1)
    expect(msg.blocks[0].toolName).toBe("Bash")
    expect(msg.blocks[0].toolInput).toEqual({ cmd: "pnpm test" })
  })
})

describe("reducer.interruption artifacts", () => {
  const interrupted = event({
    type: "user",
    promptId: "prompt-interrupted",
    userType: "external",
    entrypoint: "sdk-cli",
    message: {
      role: "user",
      content: [{ type: "text", text: "[Request interrupted by user]" }]
    }
  } as never)
  const noResponse = event({
    type: "assistant",
    userType: "external",
    isApiErrorMessage: false,
    message: {
      role: "assistant",
      model: "<synthetic>",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "No response requested." }]
    }
  } as never)

  it("hides Claude's synthetic interruption pair from live and replayed chat", () => {
    let live = reduce(init(), { kind: "event", event: interrupted })
    live = reduce(live, { kind: "event", event: noResponse })
    expect(live.entries).toHaveLength(0)

    const replay = reduce(init(), {
      kind: "load_transcript",
      events: [
        event({
          type: "assistant",
          message: {
            role: "assistant",
            id: "partial-before-stop",
            model: "claude-opus",
            content: [{ type: "text", text: "已完成的部分" }]
          }
        } as never),
        interrupted,
        noResponse
      ]
    })
    expect(replay.entries).toHaveLength(1)
    expect(replay.entries[0].kind).toBe("message")
    expect((replay.entries[0] as UIMessage).blocks[0].text).toBe("已完成的部分")
  })

  it("ignores repeated interruption artifacts", () => {
    let s = reduce(init(), { kind: "event", event: interrupted })
    s = reduce(s, { kind: "event", event: interrupted })
    expect(s.entries).toHaveLength(0)
  })

  it("reconciles the persisted SDK sentinel with an older aborted sidecar result", () => {
    const s = reduce(init(), {
      kind: "load_transcript",
      events: [
        event({
          type: "user",
          message: { role: "user", content: "审查这些改动" }
        } as never),
        interrupted,
        noResponse,
        event({
          type: "result",
          subtype: "error_during_execution",
          terminal_reason: "aborted_streaming",
          is_error: true,
          duration_ms: 2064
        } as never)
      ]
    })

    expect(s.entries).toHaveLength(2)
    const result = s.entries[1]
    expect(result.kind === "result" && result.terminalReason).toBe("interrupted")
    expect(result.kind === "result" && result.durationMs).toBe(2064)
  })

  it("preserves partial streaming content while hiding the interruption artifact", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m-cancel", role: "assistant" }
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
          content_block: { type: "text", text: "写到一半" }
        }
      })
    })
    s = reduce(s, { kind: "event", event: interrupted })

    expect(s.entries).toHaveLength(1)
    const msg = s.entries[0] as UIMessage
    expect(msg.streaming).toBe(true)
    expect(msg.blocks[0].text).toBe("写到一半")
  })

  it("hides a metadata-light sentinel in an unresolved turn and normalizes replayed result", () => {
    const replay = reduce(init(), {
      kind: "load_transcript",
      events: [
        event({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "检查未提交改动" }]
          }
        } as never),
        event({
          type: "assistant",
          message: {
            role: "assistant",
            id: "partial-before-cancel",
            stop_reason: "tool_use",
            content: [{ type: "text", text: "已经检查到一部分" }]
          }
        } as never),
        event({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "[Request interrupted by user]" }]
          }
        } as never),
        event({
          type: "result",
          subtype: "error_during_execution",
          terminal_reason: "aborted_streaming",
          is_error: true
        } as never)
      ]
    })

    const visibleText = replay.entries
      .filter((entry): entry is UIMessage => entry.kind === "message")
      .flatMap((entry) => entry.blocks.map((block) => block.text ?? ""))
    expect(visibleText).toContain("已经检查到一部分")
    expect(visibleText).not.toContain("[Request interrupted by user]")
    const result = replay.entries[replay.entries.length - 1]
    expect(result.kind).toBe("result")
    expect(result.kind === "result" && result.terminalReason).toBe("interrupted")
    expect(result.kind === "result" && result.isError).toBe(true)
  })

  it("preserves the literal sentinel when it is a genuine first prompt", () => {
    const s = reduce(init(), {
      kind: "event",
      event: event({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }]
        }
      } as never)
    })

    expect(s.entries).toHaveLength(1)
    expect((s.entries[0] as UIMessage).blocks[0].text).toBe(
      "[Request interrupted by user]"
    )
  })

  it("marks a result before reduction when the live run is interrupting", () => {
    let s = reduce(init(), {
      kind: "event",
      event: event({
        type: "user",
        message: { role: "user", content: "停止这个任务" }
      } as never)
    })
    const resultEvent = markInterruptedResult(
      event({
        type: "result",
        subtype: "error_during_execution",
        terminal_reason: "aborted_streaming",
        is_error: true
      } as never),
      true
    )
    s = reduce(s, { kind: "event", event: resultEvent })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }]
        }
      } as never)
    })

    expect(s.entries).toHaveLength(2)
    const result = s.entries[1]
    expect(result.kind === "result" && result.terminalReason).toBe("interrupted")
  })

  it("reconciles a late snapshot after the hidden interruption artifact", () => {
    let s = reduce(init(), {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "m-late",
          model: "claude-opus",
          content: [{ type: "text", text: "前半" }]
        }
      } as never)
    })
    s = reduce(s, { kind: "event", event: interrupted })
    // 取消后迟到的同 id 快照：原位合并到标记之前的消息，不在标记后另起新消息
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "m-late",
          model: "claude-opus",
          content: [{ type: "text", text: "前半部分更全的内容" }]
        }
      } as never)
    })

    expect(s.entries).toHaveLength(1)
    expect((s.entries[0] as UIMessage).blocks[0].text).toBe("前半部分更全的内容")
  })

  it("flags API error assistant messages for error rendering", () => {
    const s = reduce(init(), {
      kind: "event",
      event: event({
        type: "assistant",
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          id: "m-api-error",
          model: "glm-5",
          content: [
            { type: "text", text: "API Error: 520 status code (no body)." }
          ]
        }
      } as never)
    })
    expect(s.entries).toHaveLength(1)
    expect((s.entries[0] as UIMessage).apiError).toBe(true)
  })

  it("closes lingering streaming messages when result arrives without message_stop", () => {
    // 兼容网关漏发 message_stop:result 到达必须收尾,否则"思考中…"永远残留
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m-no-stop", role: "assistant" }
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
          content_block: { type: "text", text: "半截输出" }
        }
      })
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "result",
        subtype: "success",
        duration_ms: 800,
        is_error: false
      } as never)
    })

    const msg = s.entries[0] as UIMessage
    expect(msg.streaming).toBe(false)
    expect(msg.blocks[0].partial).toBe(false)
    expect(msg.blocks[0].text).toBe("半截输出")
    expect(s.entries[s.entries.length - 1].kind).toBe("result")
  })

  it("captures the error field some gateways use for failure details", () => {
    const s = reduce(init(), {
      kind: "event",
      event: event({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        error: "upstream 520: no body"
      } as never)
    })
    const result = s.entries[s.entries.length - 1]
    expect(result.kind).toBe("result")
    expect((result as { error?: string }).error).toBe("upstream 520: no body")
  })

  it("captures terminal_reason from persisted gateway results", () => {
    const s = reduce(init(), {
      kind: "event",
      event: event({
        type: "result",
        is_error: true,
        terminal_reason: "api_error"
      } as never)
    })
    const result = s.entries[s.entries.length - 1]
    expect(result.kind).toBe("result")
    expect((result as { terminalReason?: string }).terminalReason).toBe("api_error")
  })

  it("carries an assistant max_tokens stop into a generic result", () => {
    let s = reduce(init(), {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "m-max",
          stop_reason: "max_tokens",
          content: [{ type: "text", text: "截断内容" }]
        }
      } as never)
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "result",
        stop_reason: "stop_sequence",
        is_error: false
      } as never)
    })
    const result = s.entries[s.entries.length - 1]
    expect(result.kind).toBe("result")
    expect((result as { stopReason?: string }).stopReason).toBe("max_tokens")
  })

  it("marks a result when an API error card is already visible", () => {
    let s = reduce(init(), {
      kind: "event",
      event: event({
        type: "assistant",
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          id: "m-api-visible",
          content: [{ type: "text", text: "API Error: 520" }]
        }
      } as never)
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "result",
        terminal_reason: "api_error",
        is_error: true
      } as never)
    })
    const result = s.entries[s.entries.length - 1]
    expect(result.kind).toBe("result")
    expect((result as { hasApiErrorMessage?: boolean }).hasApiErrorMessage).toBe(true)
  })

  it("retains genuine content that only resembles the interruption artifacts", () => {
    let s = reduce(init(), {
      kind: "event",
      event: event({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "解释 [Request interrupted by user] 的含义" }]
        }
      } as never)
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        message: {
          role: "assistant",
          id: "real-no-response",
          model: "claude-opus",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "No response requested." }]
        }
      } as never)
    })

    expect(s.entries).toHaveLength(2)

    s = reduce(s, {
      kind: "event",
      event: event({
        type: "user",
        userType: "external",
        entrypoint: "sdk-cli",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }]
        }
      } as never)
    })
    expect(s.entries).toHaveLength(3)
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

  it("renders skill command echo blocks as visible slash commands", () => {
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
                "<command-message>frontend-design:frontend-design</command-message>\n<command-name>/frontend-design:frontend-design</command-name>\n<command-args>可以主题切换，因为有用户反映：眼要瞎了</command-args>"
            }
          ]
        }
      } as never)
    })
    const msg = lastMessage(s)
    expect(msg.blocks[0].text).toBe(
      "/frontend-design 可以主题切换，因为有用户反映：眼要瞎了"
    )
  })

  it("filters sidechain user prompts from the visible transcript", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "user",
        isSidechain: true,
        message: {
          role: "user",
          content: "Explore the source tree and report an architecture map."
        }
      } as never)
    })
    expect(s.entries).toHaveLength(0)
  })

  it("filters meta skill prompts from live events", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design\n\nARGUMENTS: 优化前端"
            }
          ]
        }
      } as never)
    })
    expect(s.entries).toHaveLength(0)
  })

  it("strips system reminder sections from mixed user text", () => {
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
              text: "用户可见\n<system-reminder>internal hint</system-reminder>"
            }
          ]
        }
      } as never)
    })
    const msg = lastMessage(s)
    expect(msg.blocks[0].text).toBe("用户可见")
  })

  it("extracts uploaded file tags from user text into attachment blocks", () => {
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
                '请看\n\n<uploaded_file name="report.txt" mime="text/plain" size="5">\nhello\n</uploaded_file>'
            }
          ]
        }
      } as never)
    })
    const msg = lastMessage(s)
    expect(msg.blocks).toMatchObject([
      { type: "text", text: "请看" },
      {
        type: "attachment",
        attachmentName: "report.txt",
        attachmentMime: "text/plain",
        attachmentSize: 5
      }
    ])
  })

  it("skips queued command attachments because pending input is not chat history", () => {
    let s = init()
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "attachment",
        uuid: "queued-visible",
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          prompt: "继续按这个方向做"
        }
      } as never)
    })
    expect(s.entries).toHaveLength(0)

    s = reduce(s, {
      kind: "event",
      event: event({
        type: "attachment",
        uuid: "queued-task",
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          prompt: "<task-notification><summary>done</summary></task-notification>"
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

  it("ignores control_response protocol acks (soft-interrupt receipt)", () => {
    // GUI 软中断写入 interrupt control_request 后，CLI 在 stdout 回一条
    // control_response 回执：纯协议事件，不应落进 unknown 渲染
    const ack = event({
      type: "control_response",
      response: { subtype: "success", request_id: "req-1" }
    } as never)
    let s = reduce(init(), { kind: "event", event: ack })
    expect(s.entries).toHaveLength(0)

    // 历史 transcript 重放同样忽略
    s = reduce(init(), { kind: "load_transcript", events: [ack] })
    expect(s.entries).toHaveLength(0)
  })
})

describe("reducer.local message lifecycle", () => {
  it("user_local appends the visible submitted message", () => {
    const s = reduce(init(), {
      kind: "user_local",
      blocks: [{ type: "text", text: "hi" }],
      localId: "local-1"
    })
    expect(s.entries).toHaveLength(1)
    expect(lastMessage(s).id).toBe("local-1")
  })

  it("uses provided local timestamp", () => {
    const s = reduce(init(), {
      kind: "user_local",
      blocks: [{ type: "text", text: "hi" }],
      localId: "local-1",
      ts: 123
    })
    expect(lastMessage(s).ts).toBe(123)
  })

  it("truncates visible history before a retried local message", () => {
    let s = reduce(init(), {
      kind: "user_local",
      blocks: [{ type: "text", text: "first" }],
      localId: "local-1"
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "result",
        is_error: false,
        timestamp: "2026-06-20T01:00:00.000Z"
      } as never)
    })
    s = reduce(s, {
      kind: "user_local",
      blocks: [{ type: "text", text: "retry me" }],
      localId: "local-2"
    })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "result",
        is_error: true,
        timestamp: "2026-06-20T01:00:01.000Z"
      } as never)
    })

    const truncated = reduce(s, {
      kind: "truncate_after_message",
      messageId: "local-2"
    })
    expect(truncated.entries.map((entry) => entry.kind)).toEqual([
      "message",
      "result"
    ])
    expect((truncated.entries[0] as { id?: string }).id).toBe("local-1")
  })

  it("preserves guide delivery metadata for same-turn input", () => {
    const s = reduce(init(), {
      kind: "user_local",
      blocks: [{ type: "text", text: "steer now" }],
      delivery: "guide",
      localId: "guide-1"
    })
    expect(lastMessage(s).delivery).toBe("guide")
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

  it("ignores meta skill prompts from historical transcripts", () => {
    const events: ClaudeEvent[] = [
      event({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design\n\nARGUMENTS: 优化前端"
            }
          ]
        }
      } as never),
      event({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "/frontend-design 优化前端" }]
        }
      } as never)
    ]
    const s = reduce(init(), { kind: "load_transcript", events })
    expect(s.entries).toHaveLength(1)
    const msg = s.entries[0] as UIMessage
    expect(msg.blocks[0].text).toBe("/frontend-design 优化前端")
  })
})

describe("reducer async Agent lifecycle", () => {
  const agentLaunch = () =>
    event({
      type: "user",
      timestamp: "2026-08-17T01:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: [] }]
      },
      toolUseResult: {
        isAsync: true,
        status: "async_launched",
        agentId: "agent-1",
        description: "Delete atomic fox"
      }
    } as never)

  const taskNotification = (type: "queue-operation" | "user") =>
    event({
      type,
      operation: type === "queue-operation" ? "enqueue" : undefined,
      origin: type === "user" ? { kind: "task-notification" } : undefined,
      content:
        type === "queue-operation"
          ? "<task-notification><task-id>agent-1</task-id><status>completed</status><summary>Agent finished</summary></task-notification>"
          : undefined,
      message:
        type === "user"
          ? {
              role: "user",
              content:
                "<task-notification><task-id>agent-1</task-id><status>completed</status><summary>Agent finished</summary></task-notification>"
            }
          : undefined
    } as never)

  it("hides foreground result boundaries until Agent notifications are summarized", () => {
    let s = reduce(init(), {
      kind: "event",
      event: agentLaunch()
    })

    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        timestamp: "2026-08-17T01:00:30.000Z",
        message: {
          id: "waiting-message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "还在等待一个代理。" }]
        }
      } as never)
    })
    const waitingMessage = s.entries.find(
      (entry) => entry.kind === "message" && entry.id === "waiting-message"
    )
    expect(waitingMessage).toMatchObject({ backgroundActivity: true })

    s = reduce(s, {
      kind: "event",
      event: event({ type: "result", subtype: "success", num_turns: 19 })
    })
    expect(s.entries.some((entry) => entry.kind === "result")).toBe(false)
    expect(s.subagents.cycleActive).toBe(true)

    s = reduce(s, { kind: "event", event: taskNotification("queue-operation") })
    s = reduce(s, { kind: "event", event: taskNotification("user") })
    s = reduce(s, {
      kind: "event",
      event: event({
        type: "assistant",
        timestamp: "2026-08-17T01:02:30.000Z",
        message: {
          id: "final-message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "最终总结" }]
        }
      } as never)
    })
    const finalMessage = s.entries.find(
      (entry) => entry.kind === "message" && entry.id === "final-message"
    )
    expect(finalMessage).toMatchObject({ backgroundActivity: undefined })
    s = reduce(s, {
      kind: "event",
      event: event({ type: "result", subtype: "success", result: "最终总结" })
    })
    const results = s.entries.filter((entry) => entry.kind === "result")
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ result: "最终总结" })
    expect(s.subagents.cycleActive).toBe(false)
    expect(s.subagents.agents[0]).toMatchObject({
      description: "Delete atomic fox",
      status: "completed"
    })
  })

  it("reconstructs the same Agent lifecycle from transcript replay", () => {
    const state = reduce(init(), {
      kind: "load_transcript",
      events: [
        agentLaunch(),
        event({
          type: "assistant",
          timestamp: "2026-08-17T01:00:30.000Z",
          message: {
            id: "historical-waiting",
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "等待子智能体完成。" }]
          }
        } as never),
        taskNotification("queue-operation"),
        taskNotification("user"),
        event({
          type: "assistant",
          timestamp: "2026-08-17T01:03:30.000Z",
          message: {
            id: "historical-final",
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "最终答复" }]
          }
        } as never)
      ]
    })

    expect(state.entries.some((entry) => entry.kind === "unknown")).toBe(false)
    expect(state.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          id: "historical-waiting",
          backgroundActivity: true
        }),
        expect.objectContaining({
          kind: "message",
          id: "historical-final",
          backgroundActivity: undefined
        })
      ])
    )
    expect(state.subagents.agents[0]).toMatchObject({
      id: "agent-1",
      status: "completed"
    })
  })
})
