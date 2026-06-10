import { describe, expect, it } from "vitest"
import {
  describeUpstreamStatus,
  proxyStatusErrorText,
  reduceProxyStatus,
  type UpstreamStatusState
} from "./proxyStatus"

const NOW = 1_000

describe("proxyStatus.reduceProxyStatus", () => {
  it("starts counting on first upstream error", () => {
    const next = reduceProxyStatus(
      null,
      { kind: "upstream-error", status: 429, message: "saturated", model: "claude-fable-5" },
      NOW
    )
    expect(next).toEqual({
      kind: "upstream-error",
      status: 429,
      message: "saturated",
      model: "claude-fable-5",
      count: 1,
      lastAt: NOW
    })
  })

  it("accumulates count for the same kind and status", () => {
    const first = reduceProxyStatus(
      null,
      { kind: "upstream-error", status: 429 },
      NOW
    )
    const second = reduceProxyStatus(
      first,
      { kind: "upstream-error", status: 429 },
      NOW + 1
    )
    expect(second?.count).toBe(2)
    expect(second?.lastAt).toBe(NOW + 1)
  })

  it("resets count when status changes", () => {
    const first = reduceProxyStatus(
      null,
      { kind: "upstream-error", status: 429 },
      NOW
    )
    const second = reduceProxyStatus(
      first,
      { kind: "upstream-error", status: 503 },
      NOW + 1
    )
    expect(second?.status).toBe(503)
    expect(second?.count).toBe(1)
  })

  it("clears on recovered", () => {
    const first = reduceProxyStatus(
      null,
      { kind: "network-error", message: "connection refused" },
      NOW
    )
    expect(reduceProxyStatus(first, { kind: "recovered" }, NOW + 1)).toBeNull()
  })

  it("ignores unknown kinds", () => {
    const first = reduceProxyStatus(
      null,
      { kind: "upstream-error", status: 429 },
      NOW
    )
    expect(reduceProxyStatus(first, { kind: "future-kind" }, NOW + 1)).toBe(first)
  })
})

describe("proxyStatus.describeUpstreamStatus", () => {
  it("formats upstream errors with status, model and count", () => {
    const state: UpstreamStatusState = {
      kind: "upstream-error",
      status: 429,
      message: "",
      model: "claude-fable-5",
      count: 3,
      lastAt: NOW
    }
    expect(describeUpstreamStatus(state)).toBe(
      "上游返回 429（claude-fable-5），Claude CLI 正在退避重试 · 已观察到 3 次"
    )
  })

  it("formats network errors without status", () => {
    const state: UpstreamStatusState = {
      kind: "network-error",
      status: null,
      message: "connection refused",
      model: null,
      count: 1,
      lastAt: NOW
    }
    expect(describeUpstreamStatus(state)).toBe(
      "上游连接失败，Claude CLI 正在退避重试 · 已观察到 1 次"
    )
  })
})

describe("proxyStatus.proxyStatusErrorText", () => {
  it("includes HTTP status so networkErrorHints can classify rate limits", () => {
    const text = proxyStatusErrorText({
      kind: "upstream-error",
      status: 429,
      message: "saturated",
      model: "claude-fable-5"
    })
    expect(text).toBe("HTTP status 429 · model claude-fable-5 · saturated")
  })

  it("falls back to message only for network errors", () => {
    expect(
      proxyStatusErrorText({ kind: "network-error", message: "connection refused" })
    ).toBe("connection refused")
  })
})
