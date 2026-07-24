import { describe, expect, it } from "vitest"
import { localFileIconKind } from "./LocalFileIcon"

describe("LocalFileIcon", () => {
  it("classifies web framework and stylesheet files", () => {
    expect(localFileIconKind("index.html")).toBe("html")
    expect(localFileIconKind("styles.css")).toBe("css")
    expect(localFileIconKind("legacy.less")).toBe("css")
    expect(localFileIconKind("theme.scss")).toBe("sass")
    expect(localFileIconKind("App.vue")).toBe("vue")
    expect(localFileIconKind("App.svelte")).toBe("svelte")
  })

  it("classifies archives and office documents", () => {
    expect(localFileIconKind("release.7z")).toBe("archive")
    expect(localFileIconKind("report.docx")).toBe("document")
    expect(localFileIconKind("budget.xlsx")).toBe("spreadsheet")
    expect(localFileIconKind("deck.pptx")).toBe("presentation")
    expect(localFileIconKind("manual.pdf")).toBe("pdf")
  })

  it("classifies common compiled and mobile languages", () => {
    expect(localFileIconKind("main.cpp")).toBe("cpp")
    expect(localFileIconKind("Program.cs")).toBe("csharp")
    expect(localFileIconKind("Main.java")).toBe("java")
    expect(localFileIconKind("App.kt")).toBe("kotlin")
    expect(localFileIconKind("View.swift")).toBe("swift")
    expect(localFileIconKind("main.dart")).toBe("dart")
  })

  it("classifies media, fonts, data, and configuration files", () => {
    expect(localFileIconKind("preview.webp")).toBe("image")
    expect(localFileIconKind("voice.flac")).toBe("audio")
    expect(localFileIconKind("demo.mp4")).toBe("video")
    expect(localFileIconKind("font.woff2")).toBe("font")
    expect(localFileIconKind("data.sqlite3")).toBe("database")
    expect(localFileIconKind(".editorconfig")).toBe("config")
  })
})
