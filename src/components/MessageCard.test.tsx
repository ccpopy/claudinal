import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MessageCard } from "./MessageCard"
import type { UIMessage } from "@/types/ui"

describe("MessageCard status rendering", () => {
  it("renders an error result with subtype and humanized duration", () => {
    const html = renderToStaticMarkup(
      <MessageCard
        entry={{
          kind: "result",
          isError: true,
          subtype: "error_during_execution",
          durationMs: 1500,
          numTurns: 8,
          ts: 1
        }}
      />
    )
    expect(html).toContain("失败 · error_during_execution")
    expect(html).toContain("1.5s")
    expect(html).toContain("8 轮")
  })

  it("renders a success result", () => {
    const html = renderToStaticMarkup(
      <MessageCard
        entry={{ kind: "result", isError: false, durationMs: 95000, ts: 1 }}
      />
    )
    expect(html).toContain("完成")
    expect(html).toContain("1m35s")
  })

  it("renders API error assistant messages as an error card", () => {
    const msg: UIMessage = {
      kind: "message",
      id: "m-api",
      role: "assistant",
      streaming: false,
      apiError: true,
      ts: 1,
      blocks: [
        {
          type: "text",
          text: "API Error: 520 status code (no body). This is a server-side issue."
        }
      ]
    }
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MessageCard entry={msg} />
      </TooltipProvider>
    )
    expect(html).toContain("请求失败")
    expect(html).toContain("API Error: 520")
  })

  it("keeps an API error visible when the gateway returns no text", () => {
    const msg: UIMessage = {
      kind: "message",
      id: "m-api-empty",
      role: "assistant",
      streaming: false,
      apiError: true,
      ts: 1,
      blocks: []
    }
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MessageCard entry={msg} />
      </TooltipProvider>
    )
    expect(html).toContain("请求失败")
    expect(html).toContain("上游未返回可显示的错误详情")
  })

  it("shows the gateway error field on failed results", () => {
    const html = renderToStaticMarkup(
      <MessageCard
        entry={{
          kind: "result",
          isError: true,
          subtype: "error_during_execution",
          error: "upstream 520: no body",
          ts: 1
        }}
      />
    )
    expect(html).toContain("upstream 520: no body")
  })

  it("falls back to the result text for persisted API failures", () => {
    const html = renderToStaticMarkup(
      <MessageCard
        entry={{
          kind: "result",
          isError: true,
          terminalReason: "api_error",
          result: "API Error: 520 status code (no body).",
          ts: 1
        }}
      />
    )
    expect(html).toContain("API Error: 520 status code")
  })

  it("does not repeat result text when an API error card is already visible", () => {
    const html = renderToStaticMarkup(
      <MessageCard
        entry={{
          kind: "result",
          isError: true,
          terminalReason: "api_error",
          hasApiErrorMessage: true,
          result: "API Error: 520 status code (no body).",
          ts: 1
        }}
      />
    )
    expect(html).not.toContain("API Error: 520 status code")
  })

  it("does not label a failed API result as success", () => {
    const html = renderToStaticMarkup(
      <MessageCard
        entry={{
          kind: "result",
          isError: true,
          subtype: "success",
          terminalReason: "api_error",
          ts: 1
        }}
      />
    )
    expect(html).toContain("失败")
    expect(html).not.toContain("失败 · success")
  })

  it("treats terminal_reason api_error as a failure without is_error", () => {
    const html = renderToStaticMarkup(
      <MessageCard
        entry={{
          kind: "result",
          terminalReason: "api_error",
          result: "gateway failed",
          ts: 1
        }}
      />
    )
    expect(html).toContain("失败")
    expect(html).toContain("gateway failed")
    expect(html).not.toContain("完成")
  })

  it("warns when output was truncated by max_tokens", () => {
    const html = renderToStaticMarkup(
      <MessageCard
        entry={{
          kind: "result",
          isError: false,
          stopReason: "max_tokens",
          durationMs: 3000,
          ts: 1
        }}
      />
    )
    expect(html).toContain("max_tokens")
    expect(html).toContain("截断")
    expect(html).not.toContain("完成")
  })

  it("warns when terminal_reason reports max_tokens", () => {
    const html = renderToStaticMarkup(
      <MessageCard
        entry={{
          kind: "result",
          isError: false,
          terminalReason: "max_tokens",
          ts: 1
        }}
      />
    )
    expect(html).toContain("max_tokens")
  })
})
