import type { DocumentPayload, ImagePayload } from "@/types/ui"

export interface ComposerDraftImage extends ImagePayload {
  id: string
  name: string
  size: number
}

export interface ComposerDraftDocument extends DocumentPayload {
  id: string
}

export interface ComposerDraftFileAttachment {
  id: string
  name: string
  mime: string
  size: number
  text: string | null
  contentMode: "inline" | "document" | "metadata-only"
}

export interface ComposerDraft {
  text: string
  images: ComposerDraftImage[]
  documents: ComposerDraftDocument[]
  fileAttachments: ComposerDraftFileAttachment[]
}

export function emptyComposerDraft(): ComposerDraft {
  return {
    text: "",
    images: [],
    documents: [],
    fileAttachments: []
  }
}

export function cloneComposerDraft(draft: ComposerDraft): ComposerDraft {
  return {
    text: draft.text,
    images: draft.images.map((image) => ({ ...image })),
    documents: draft.documents.map((document) => ({ ...document })),
    fileAttachments: draft.fileAttachments.map((file) => ({ ...file }))
  }
}

export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.images.length === 0 &&
    draft.documents.length === 0 &&
    draft.fileAttachments.length === 0
  )
}

export function composerDraftKey(
  projectId: string,
  sessionId: string | null | undefined
): string {
  return `${projectId}::${sessionId ? `session:${sessionId}` : "new"}`
}
