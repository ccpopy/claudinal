import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { UIEntry, UIMessage } from "@/types/ui"
import { BlockView } from "./MessageBlocks"
import { buildGroups } from "./MessageStream"
import { RunGroup } from "./RunGroup"

function message(
  id: string,
  role: UIMessage["role"],
  text: string,
  options: Partial<UIMessage> = {}
): UIMessage {
  return {
    kind: "message",
    id,
    role,
    blocks: [{ type: "text", text }],
    streaming: false,
    ts: 1,
    ...options
  }
}

describe("MessageStream result hierarchy", () => {
  it("groups tool-use commentary as activity and leaves end-turn text as the reply", () => {
    const progress: UIMessage = {
      ...message("progress", "assistant", "I'll inspect the relevant files."),
      stopReason: "tool_use",
      blocks: [
        { type: "text", text: "I'll inspect the relevant files." },
        {
          type: "tool_use",
          toolName: "Read",
          toolUseId: "tool-1",
          toolInput: { path: "src/App.tsx" }
        }
      ]
    }
    const entries: UIEntry[] = [
      message("user", "user", "检查问题"),
      progress,
      { ...progress, id: "progress-duplicate" },
      message("final", "assistant", "最终结论", { stopReason: "end_turn" }),
      {
        kind: "result",
        subtype: "success",
        result: "最终结论",
        isError: false,
        ts: 2
      }
    ]

    const groups = buildGroups(entries, false)
    const run = groups.find((group) => group.kind === "run")
    const assistantReplies = groups.filter(
      (group) => group.kind === "msg" && group.msg.role === "assistant"
    )

    expect(run?.kind).toBe("run")
    expect(
      run?.kind === "run"
        ? run.steps.filter((step) => step.block.type === "text")
        : []
    ).toHaveLength(1)
    expect(assistantReplies).toHaveLength(1)
    expect(
      assistantReplies[0]?.kind === "msg"
        ? assistantReplies[0].msg.blocks[0].text
        : null
    ).toBe("最终结论")
  })

  it("uses a successful result body when no final assistant reply exists", () => {
    const groups = buildGroups(
      [
        message("user", "user", "给我最终答案"),
        message("progress", "assistant", "处理中", { stopReason: "tool_use" }),
        {
          kind: "result",
          subtype: "success",
          result: "来自 result 的最终答案",
          isError: false,
          ts: 2
        }
      ],
      false
    )

    const replies = groups.filter(
      (group) => group.kind === "msg" && group.msg.role === "assistant"
    )
    expect(replies).toHaveLength(1)
    expect(
      replies[0]?.kind === "msg" ? replies[0].msg.blocks[0].text : null
    ).toBe("来自 result 的最终答案")
  })

  it("does not duplicate an end-turn reply that matches result.result", () => {
    const groups = buildGroups(
      [
        message("user", "user", "总结"),
        message("final", "assistant", "同一份答案", { stopReason: "end_turn" }),
        {
          kind: "result",
          subtype: "success",
          result: "同一份答案",
          isError: false,
          ts: 2
        }
      ],
      false
    )

    expect(
      groups.filter(
        (group) => group.kind === "msg" && group.msg.role === "assistant"
      )
    ).toHaveLength(1)
  })

  it("renders activity text without the normal reply copy button", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <RunGroup
          steps={[
            {
              key: "progress",
              block: { type: "text", text: "正在检查相关实现" }
            }
          ]}
          running
          startTs={1}
        />
      </TooltipProvider>
    )

    expect(html).toContain("正在检查相关实现")
    expect(html).toContain('data-run-activity="true"')
    expect(html).toContain('data-run-activity-icon="true"')
    expect(html).toContain('data-markdown-variant="activity"')
    expect(html).toContain("grid-cols-[0.75rem_0.875rem_minmax(0,1fr)]")
    expect(html).not.toContain('aria-label="复制消息"')
  })

  it("keeps the copy affordance on an ordinary final reply", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <BlockView
          role="assistant"
          block={{ type: "text", text: "最终结论" }}
        />
      </TooltipProvider>
    )

    expect(html).toContain("最终结论")
    expect(html).toContain('aria-label="复制消息"')
    expect(html).not.toContain('data-run-activity="true"')
  })
})
