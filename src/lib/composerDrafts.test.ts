import { describe, expect, it } from "vitest"
import {
  cloneComposerDraft,
  composerDraftKey,
  emptyComposerDraft,
  isComposerDraftEmpty,
  type ComposerDraft
} from "./composerDrafts"

describe("composerDrafts.composerDraftKey", () => {
  it("scopes drafts by project and session", () => {
    expect(composerDraftKey("project-a", "session-1")).toBe(
      "project-a::session:session-1"
    )
    expect(composerDraftKey("project-a", "session-2")).toBe(
      "project-a::session:session-2"
    )
    expect(composerDraftKey("project-b", "session-1")).toBe(
      "project-b::session:session-1"
    )
  })

  it("uses a project-scoped new-chat bucket before a session id exists", () => {
    expect(composerDraftKey("project-a", null)).toBe("project-a::new")
    expect(composerDraftKey("project-a", undefined)).toBe("project-a::new")
  })
})

describe("composerDrafts.isComposerDraftEmpty", () => {
  it("returns true for a fresh draft", () => {
    expect(isComposerDraftEmpty(emptyComposerDraft())).toBe(true)
  })

  it("keeps whitespace-only text as a real draft", () => {
    expect(
      isComposerDraftEmpty({
        ...emptyComposerDraft(),
        text: "   "
      })
    ).toBe(false)
  })

  it("returns false for image, document, or file attachments", () => {
    expect(
      isComposerDraftEmpty({
        ...emptyComposerDraft(),
        images: [{ id: "i", data: "abc", mime: "image/png", name: "a.png", size: 3 }]
      })
    ).toBe(false)
    expect(
      isComposerDraftEmpty({
        ...emptyComposerDraft(),
        documents: [
          {
            id: "d",
            data: "abc",
            mime: "application/pdf",
            name: "a.pdf",
            size: 3
          }
        ]
      })
    ).toBe(false)
    expect(
      isComposerDraftEmpty({
        ...emptyComposerDraft(),
        fileAttachments: [
          {
            id: "f",
            name: "a.txt",
            mime: "text/plain",
            size: 3,
            text: "abc",
            contentMode: "inline"
          }
        ]
      })
    ).toBe(false)
  })
})

describe("composerDrafts.cloneComposerDraft", () => {
  it("copies nested draft arrays so stored drafts are not mutated by callers", () => {
    const original: ComposerDraft = {
      text: "hello",
      images: [{ id: "i", data: "abc", mime: "image/png", name: "a.png", size: 3 }],
      documents: [
        {
          id: "d",
          data: "def",
          mime: "application/pdf",
          name: "a.pdf",
          size: 4
        }
      ],
      fileAttachments: [
        {
          id: "f",
          name: "a.txt",
          mime: "text/plain",
          size: 5,
          text: "body",
          contentMode: "inline"
        }
      ]
    }

    const cloned = cloneComposerDraft(original)
    expect(cloned).toEqual(original)
    expect(cloned).not.toBe(original)
    expect(cloned.images[0]).not.toBe(original.images[0])
    expect(cloned.documents[0]).not.toBe(original.documents[0])
    expect(cloned.fileAttachments[0]).not.toBe(original.fileAttachments[0])
  })
})
