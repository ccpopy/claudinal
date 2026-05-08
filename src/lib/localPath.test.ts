import { describe, expect, it } from "vitest"
import {
  fileUrlToPath,
  isLikelyLocalPath,
  normalizeOpenablePath
} from "./localPath"

describe("localPath", () => {
  it("detects windows paths", () => {
    expect(isLikelyLocalPath("D:/Desktop/开发工具/TECHNICAL_DOC.md")).toBe(true)
    expect(isLikelyLocalPath("D:\\Desktop\\TECHNICAL_DOC.md")).toBe(true)
  })

  it("converts file urls to local paths", () => {
    expect(fileUrlToPath("file:///D:/Desktop/test.md")).toBe("D:\\Desktop\\test.md")
    expect(normalizeOpenablePath("<file:///D:/Desktop/test.md>")).toBe(
      "D:\\Desktop\\test.md"
    )
  })

  it("does not treat urls as local paths", () => {
    expect(isLikelyLocalPath("https://example.com/file.md")).toBe(false)
  })
})

