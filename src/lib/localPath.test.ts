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

  it("keeps common web, archive, office, and configuration files", () => {
    const cwd = "F:\\project\\claudecli"
    const references = [
      "index.html",
      "styles.css",
      "Component.vue",
      "theme.sass",
      "archive.zip",
      "report.docx",
      "sheet.xlsx",
      "guide.pdf",
      ".editorconfig",
      ".npmrc",
      ".env.local",
      ".eslintrc.json"
    ]

    for (const reference of references) {
      expect(isLikelyMarkdownFileReference(reference), reference).toBe(true)
      expect(resolveMarkdownFilePath(reference, cwd), reference).not.toBeNull()
    }
  })

  it("rejects domains, css values, and api members in inline code", () => {
    const cwd = "F:\\project\\claudecli"
    const references = [
      ".local",
      "api.localserver.com",
      "xx.local",
      "Math.round",
      "element.className",
      "classList.toggle",
      "Element.closest",
      "requestAnimationFrame",
      "setTimeout(16)",
      "matchMedia",
      "getBoundingClientRect()",
      "0.35",
      "-123.4px",
      "cubic-bezier",
      "border-radius",
      "rgba",
      "-webkit-"
    ]

    for (const reference of references) {
      expect(isLikelyMarkdownFileReference(reference), reference).toBe(false)
      expect(resolveMarkdownFilePath(reference, cwd), reference).toBeNull()
    }
  })

  it("requires an explicit path for unknown file extensions", () => {
    const cwd = "F:\\project\\claudecli"
    expect(resolveMarkdownFilePath("artifact.unknown", cwd)).toBeNull()
    expect(resolveMarkdownFilePath("src/artifact.unknown", cwd)).toBeNull()
    expect(resolveMarkdownFilePath(".random", cwd)).toBeNull()
    expect(resolveMarkdownFilePath(".json", cwd)).toBeNull()
    expect(resolveMarkdownFilePath("./artifact.unknown", cwd)).toBe(
      "F:\\project\\claudecli\\artifact.unknown"
    )
    expect(resolveMarkdownFilePath("./.random", cwd)).toBe(
      "F:\\project\\claudecli\\.random"
    )
    expect(resolveMarkdownFilePath("../artifact.unknown", cwd)).toBe(
      "F:\\project\\claudecli\\..\\artifact.unknown"
    )
  })
})
