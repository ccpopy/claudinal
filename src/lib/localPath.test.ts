import { describe, expect, it } from "vitest"
import {
  fileUrlToPath,
  isLikelyMarkdownFileReference,
  isLikelyLocalPath,
  normalizeOpenablePath,
  resolveMarkdownFilePath,
  resolveOpenablePath
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

  it("resolves relative file rows against a windows project cwd", () => {
    expect(resolveOpenablePath("src/App.tsx", "F:\\project\\claudecli")).toBe(
      "F:\\project\\claudecli\\src\\App.tsx"
    )
  })

  it("keeps absolute paths and rejects relative paths without a cwd", () => {
    expect(resolveOpenablePath("D:/repo/file.ts", "F:/other")).toBe(
      "D:/repo/file.ts"
    )
    expect(resolveOpenablePath("src/App.tsx", null)).toBeNull()
  })

  it("does not turn ordinary inline code or links into local paths", () => {
    const cwd = "F:\\project\\claudecli"
    expect(resolveOpenablePath("git", cwd)).toBeNull()
    expect(resolveOpenablePath("#timeline", cwd)).toBeNull()
    expect(resolveOpenablePath("mailto:test@example.com", cwd)).toBeNull()
    expect(resolveOpenablePath("README.md", cwd)).toBe(
      "F:\\project\\claudecli\\README.md"
    )
  })

  it("rejects slash-delimited module and route names in markdown", () => {
    const cwd = "F:\\project\\claudecli"
    expect(isLikelyMarkdownFileReference("externalAgentConfig/detect")).toBe(
      false
    )
    expect(isLikelyMarkdownFileReference("openai/codex")).toBe(false)
    expect(
      resolveMarkdownFilePath("codex-rs/external-agent-migration", cwd)
    ).toBeNull()
  })

  it("keeps explicit and filename-shaped markdown file references", () => {
    const cwd = "F:\\project\\claudecli"
    expect(resolveMarkdownFilePath("src/App.tsx", cwd)).toBe(
      "F:\\project\\claudecli\\src\\App.tsx"
    )
    expect(resolveMarkdownFilePath("commands.rs", cwd)).toBe(
      "F:\\project\\claudecli\\commands.rs"
    )
    expect(resolveMarkdownFilePath(".gitignore", cwd)).toBe(
      "F:\\project\\claudecli\\.gitignore"
    )
    expect(resolveMarkdownFilePath("./scripts/release", cwd)).toBe(
      "F:\\project\\claudecli\\scripts\\release"
    )
    expect(resolveMarkdownFilePath("release.7z", cwd)).toBe(
      "F:\\project\\claudecli\\release.7z"
    )
  })
})
