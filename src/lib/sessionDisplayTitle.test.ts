import { describe, expect, it } from "vitest"
import { cleanSessionTitleText } from "./sessionDisplayTitle"

describe("cleanSessionTitleText", () => {
  it("strips a leading slash command so titles read naturally", () => {
    expect(cleanSessionTitleText("/frontend-design 帮我重新调整下样式")).toBe(
      "帮我重新调整下样式"
    )
    expect(cleanSessionTitleText("/frontend-design:frontend-design 优化面板")).toBe(
      "优化面板"
    )
  })

  it("keeps a bare command as-is instead of blanking the title", () => {
    expect(cleanSessionTitleText("/effort")).toBe("/effort")
  })

  it("does not strip path-like leading text", () => {
    expect(cleanSessionTitleText("/usr/local/bin 这个目录看下")).toBe(
      "/usr/local/bin 这个目录看下"
    )
  })

  it("still rejects internal command payloads and collapses whitespace", () => {
    expect(
      cleanSessionTitleText("<command-name>/effort</command-name>x</command-name>")
    ).toBeNull()
    expect(cleanSessionTitleText("多行\n\n  标题  折叠")).toBe("多行 标题 折叠")
  })
})
