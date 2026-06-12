import { describe, expect, it } from "vitest"
import { parseTrigger, triggerSignature } from "./suggestionTrigger"

describe("parseTrigger", () => {
  it("matches slash command at text start", () => {
    expect(parseTrigger("/com", 4)).toEqual({
      kind: "/",
      start: 0,
      query: "com"
    })
  })

  it("matches @ file trigger after whitespace", () => {
    expect(parseTrigger("see @src", 8)).toEqual({
      kind: "@",
      start: 4,
      query: "src"
    })
  })

  it("closes @ trigger once query contains a path separator", () => {
    // 现状行为：向前扫描先碰到 query 里的 "/"，其前一个字符非空白 → null。
    // @ 补全面板在进入子目录路径时关闭，属既有语义，本任务不改。
    expect(parseTrigger("see @src/ap", 11)).toBeNull()
  })

  it("matches trigger after newline and tab", () => {
    expect(parseTrigger("line\n/cl", 8)).toEqual({
      kind: "/",
      start: 5,
      query: "cl"
    })
    expect(parseTrigger("a\t@f", 4)).toEqual({
      kind: "@",
      start: 2,
      query: "f"
    })
  })

  it("rejects trigger glued to a word (a/b)", () => {
    expect(parseTrigger("a/b", 3)).toBeNull()
    expect(parseTrigger("path@host", 9)).toBeNull()
  })

  it("stops scanning at whitespace between caret and trigger", () => {
    expect(parseTrigger("/cmd arg", 8)).toBeNull()
    expect(parseTrigger("@dir name", 9)).toBeNull()
  })

  it("slices query by caret position", () => {
    expect(parseTrigger("/commit", 4)).toEqual({
      kind: "/",
      start: 0,
      query: "com"
    })
  })

  it("returns null for empty text or caret at start", () => {
    expect(parseTrigger("", 0)).toBeNull()
    expect(parseTrigger("/cmd", 0)).toBeNull()
  })
})

describe("triggerSignature", () => {
  it("is stable for identical triggers", () => {
    expect(triggerSignature({ kind: "/", start: 0, query: "com" })).toBe(
      triggerSignature({ kind: "/", start: 0, query: "com" })
    )
  })

  it("changes when any field changes", () => {
    const base = { kind: "/" as const, start: 0, query: "com" }
    expect(triggerSignature({ ...base, query: "comm" })).not.toBe(
      triggerSignature(base)
    )
    expect(triggerSignature({ ...base, start: 3 })).not.toBe(
      triggerSignature(base)
    )
    expect(triggerSignature({ ...base, kind: "@" })).not.toBe(
      triggerSignature(base)
    )
  })

  it("does not collide across field boundaries", () => {
    // start=1,query="2" 与 start=12,query="" 不得拼出同一签名
    expect(triggerSignature({ kind: "/", start: 1, query: "2" })).not.toBe(
      triggerSignature({ kind: "/", start: 12, query: "" })
    )
    // query 自带分隔符也不产生歧义
    expect(triggerSignature({ kind: "@", start: 1, query: "2:x" })).not.toBe(
      triggerSignature({ kind: "@", start: 12, query: "x" })
    )
  })
})
