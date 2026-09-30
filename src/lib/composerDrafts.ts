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

/** Stable editor identities, including a new conversation receiving its CLI id. */
export class ComposerDraftStore {
  private drafts = new Map<string, ComposerDraft>()
  private sessions = new Map<string, string>()
  private conversations = new Map<string, { key: string; session: string | null }>()

  keyFor(projectId: string, sessionId: string | null, conversationId: string): string {
    const conversation = composerDraftKey(projectId, `draft:${conversationId}`)
    const session = sessionId ? composerDraftKey(projectId, sessionId) : null
    const existing = this.conversations.get(conversation)
    // Only a new conversation may adopt its first CLI session id. A different
    // existing session always owns a separate draft, even during navigation.
    const conversationKey = existing && (!existing.session || existing.session === session)
      ? existing.key : undefined
    const key = (session ? this.sessions.get(session) : undefined)
      ?? conversationKey ?? session ?? conversation
    this.conversations.set(conversation, { key, session })
    if (session) this.sessions.set(session, key)
    return key
  }

  get(key: string): ComposerDraft | undefined {
    return this.drafts.get(key)
  }

  deleteSession(projectId: string, sessionId: string): void {
    const session = composerDraftKey(projectId, sessionId)
    const key = this.sessions.get(session) ?? session
    this.drafts.delete(key)
    this.sessions.delete(session)
    for (const [conversation, value] of this.conversations) {
      if (value.key === key) this.conversations.delete(conversation)
    }
  }

  set(key: string, draft: ComposerDraft): void {
    if (isComposerDraftEmpty(draft)) this.drafts.delete(key)
    else this.drafts.set(key, cloneComposerDraft(draft))
  }
}
