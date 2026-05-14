import { describe, expect, it } from "vitest"
import {
  formatAttachmentType,
  isDocxFile,
  isLegacyWordDocFile,
  isPdfFile,
  isSupportedUploadFile,
  isTextLikeFile,
  pastedTextFileName,
  shouldAttachPastedText,
  splitUploadedFileText,
  supportedImageMime,
  SUPPORTED_ATTACHMENT_ACCEPT,
  utf8ByteLength
} from "./fileAttachments"

describe("fileAttachments.isTextLikeFile", () => {
  it("does not treat Office OpenXML files as text just because the MIME contains xml", () => {
    expect(
      isTextLikeFile({
        name: "会员管理系统 投标文件.docx",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ).toBe(false)
  })

  it("keeps binary document formats out of text uploads", () => {
    expect(isTextLikeFile({ name: "contract.pdf", type: "application/pdf" })).toBe(
      false
    )
    expect(isTextLikeFile({ name: "legacy.doc", type: "application/msword" })).toBe(
      false
    )
  })

  it("accepts common text files by MIME or extension", () => {
    expect(isTextLikeFile({ name: "notes.md", type: "" })).toBe(true)
    expect(isTextLikeFile({ name: "data", type: "application/json" })).toBe(true)
    expect(isTextLikeFile({ name: "feed", type: "application/rss+xml" })).toBe(true)
  })
})

describe("fileAttachments.isPdfFile", () => {
  it("detects PDFs by MIME or extension", () => {
    expect(isPdfFile({ name: "report", type: "application/pdf" })).toBe(true)
    expect(isPdfFile({ name: "report.PDF", type: "" })).toBe(true)
    expect(isPdfFile({ name: "report.docx", type: "" })).toBe(false)
  })
})

describe("fileAttachments.isDocxFile", () => {
  it("detects DOCX files by MIME or extension", () => {
    expect(
      isDocxFile({
        name: "测试",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ).toBe(true)
    expect(isDocxFile({ name: "测试.DOCX", type: "" })).toBe(true)
    expect(isDocxFile({ name: "legacy.doc", type: "application/msword" })).toBe(
      false
    )
  })
})

describe("fileAttachments.isLegacyWordDocFile", () => {
  it("detects old binary Word documents separately from DOCX", () => {
    expect(isLegacyWordDocFile({ name: "测试", type: "application/msword" })).toBe(
      true
    )
    expect(isLegacyWordDocFile({ name: "测试.DOC", type: "" })).toBe(true)
    expect(isLegacyWordDocFile({ name: "测试.docx", type: "" })).toBe(false)
  })
})

describe("fileAttachments.supportedImageMime", () => {
  it("allows only image formats supported by uploads", () => {
    expect(supportedImageMime({ name: "photo.jpg", type: "" })).toBe(
      "image/jpeg"
    )
    expect(supportedImageMime({ name: "photo.webp", type: "image/webp" })).toBe(
      "image/webp"
    )
    expect(supportedImageMime({ name: "vector.svg", type: "image/svg+xml" })).toBe(
      null
    )
  })
})

describe("fileAttachments.isSupportedUploadFile", () => {
  it("accepts current upload formats and rejects unsupported binaries", () => {
    expect(isSupportedUploadFile({ name: "notes.md", type: "" })).toBe(true)
    expect(isSupportedUploadFile({ name: "document.docx", type: "" })).toBe(true)
    expect(isSupportedUploadFile({ name: "paper.pdf", type: "" })).toBe(true)
    expect(isSupportedUploadFile({ name: "legacy.doc", type: "" })).toBe(false)
    expect(isSupportedUploadFile({ name: "archive.zip", type: "" })).toBe(false)
    expect(isSupportedUploadFile({ name: "vector.svg", type: "image/svg+xml" })).toBe(
      false
    )
  })
})

describe("fileAttachments.SUPPORTED_ATTACHMENT_ACCEPT", () => {
  it("advertises supported picker formats without legacy DOC", () => {
    expect(SUPPORTED_ATTACHMENT_ACCEPT).toContain(".docx")
    expect(SUPPORTED_ATTACHMENT_ACCEPT).toContain(".pdf")
    expect(SUPPORTED_ATTACHMENT_ACCEPT).toContain("image/png")
    expect(SUPPORTED_ATTACHMENT_ACCEPT).not.toContain(".doc,")
  })
})

describe("fileAttachments.formatAttachmentType", () => {
  it("uses user-facing labels instead of long Office MIME strings", () => {
    expect(
      formatAttachmentType(
        "测试.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toBe("Word 文档")
  })

  it("falls back to extension labels without exposing raw MIME", () => {
    expect(formatAttachmentType("archive.zip", "application/octet-stream")).toBe(
      "ZIP"
    )
  })

  it("labels legacy DOC files distinctly from DOCX", () => {
    expect(formatAttachmentType("legacy.doc", "application/msword")).toBe(
      "旧版 Word 文档"
    )
  })
})

describe("fileAttachments.pasted text helpers", () => {
  it("keeps ordinary pasted text inline", () => {
    expect(shouldAttachPastedText("short prompt")).toBe(false)
  })

  it("turns long or many-line pasted text into an attachment", () => {
    expect(shouldAttachPastedText("x".repeat(4000))).toBe(true)
    expect(
      shouldAttachPastedText(Array.from({ length: 80 }, () => "line").join("\n"))
    ).toBe(true)
  })

  it("computes UTF-8 byte size and stable pasted text names", () => {
    expect(utf8ByteLength("中文")).toBe(6)
    expect(pastedTextFileName(new Date("2026-05-14T03:04:05"))).toBe(
      "pasted-text-20260514-030405.txt"
    )
  })
})

describe("fileAttachments.splitUploadedFileText", () => {
  it("extracts uploaded file metadata into a separate block", () => {
    const blocks = splitUploadedFileText(
      [
        "请看文件",
        '<uploaded_file name="a&amp;b.txt" mime="text/plain" size="12">',
        "hello",
        "</uploaded_file>"
      ].join("\n")
    )

    expect(blocks).toEqual([
      { type: "text", text: "请看文件" },
      {
        type: "attachment",
        attachmentName: "a&b.txt",
        attachmentMime: "text/plain",
        attachmentSize: 12,
        attachmentText: "hello",
        attachmentContentMode: "inline"
      }
    ])
  })

  it("marks metadata-only attachments explicitly", () => {
    const blocks = splitUploadedFileText(
      '<uploaded_file name="测试.docx" mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document" size="33970" content="metadata-only">\n[binary file content not included]\n</uploaded_file>'
    )

    expect(blocks).toEqual([
      {
        type: "attachment",
        attachmentName: "测试.docx",
        attachmentMime:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        attachmentSize: 33970,
        attachmentText: "[binary file content not included]",
        attachmentContentMode: "metadata-only"
      }
    ])
  })

  it("marks document attachments explicitly", () => {
    const blocks = splitUploadedFileText(
      '<uploaded_file name="report.pdf" mime="application/pdf" size="1234" content="document">\n[pdf document attached separately]\n</uploaded_file>'
    )

    expect(blocks).toEqual([
      {
        type: "attachment",
        attachmentName: "report.pdf",
        attachmentMime: "application/pdf",
        attachmentSize: 1234,
        attachmentText: "[pdf document attached separately]",
        attachmentContentMode: "document"
      }
    ])
  })
})
