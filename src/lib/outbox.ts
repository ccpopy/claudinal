import type { DocumentPayload, ImagePayload } from "@/types/ui"
import type { DeliveryState } from "./submission"

export interface OutboxInput {
  schemaVersion: 1
  id: string
  cwd: string
  conversationId: string | null
  runtimeId?: string
  text: string
  images: ImagePayload[]
  documents: DocumentPayload[]
  mode: "normal" | "guide" | "followup"
  state: DeliveryState
  createdAt: number
  conversationKey?: string
  attemptId?: string
  inputRevision?: number
  profileRevision?: string
  attempts?: Array<{ id: string; revision: number; state: DeliveryState; error?: string }>
}

const CHANGED = "claudinal:outbox-changed"
let database: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("claudinal-input-recovery", 2)
    request.onupgradeneeded = () => {
      const db = request.result
      const inputs = db.objectStoreNames.contains("inputs") ? request.transaction!.objectStore("inputs") : db.createObjectStore("inputs", { keyPath: "id" })
      const metadata = db.createObjectStore("metadata", { keyPath: "id" })
      const cursor = inputs.openCursor()
      cursor.onsuccess = () => { const row = cursor.result; if (row) { metadata.put(inputMetadata(row.value)); row.continue() } }
    }
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined }; resolve(request.result) }
    request.onerror = () => { database = undefined; reject(request.error) }
  })
}

export async function listOutbox(): Promise<OutboxInput[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["inputs", "metadata"])
    const payloads = tx.objectStore("inputs").getAll()
    const metadata = tx.objectStore("metadata").getAll()
    tx.oncomplete = () => { const byId = new Map(metadata.result.map((item) => [item.id, item])); resolve((payloads.result as OutboxInput[]).filter((input) => input.schemaVersion === 1).map((input) => ({ ...input, ...byId.get(input.id) }))) }
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}

export async function saveOutbox(input: OutboxInput): Promise<void> {
  const db = await open()
  // Capacity checks read only small metadata, never every attachment payload.
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["inputs", "metadata"], "readwrite")
    const store = tx.objectStore("inputs")
    const meta = tx.objectStore("metadata")
    const all = meta.getAll()
    all.onsuccess = () => {
      const own = all.result.find((item) => item.id === input.id)
      const next = inputMetadata(input)
      if (all.result.length >= 50 && !own || all.result.filter((item) => item.id !== input.id).reduce((sum, item) => sum + item.bytes, next.bytes) > 128 * 1024 * 1024) { tx.abort(); return }
      // State transitions do not rewrite or structured-clone large payloads.
      if (!own || own.attemptId !== input.attemptId || own.inputRevision !== input.inputRevision) store.put(input)
      meta.put(next)
    }
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("恢复区已满（最多 50 条 / 128 MB），请先处理已保存的输入"))
  })
  window.dispatchEvent(new Event(CHANGED))
}

export async function removeOutbox(id: string): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["inputs", "metadata"], "readwrite")
    tx.objectStore("inputs").delete(id)
    tx.objectStore("metadata").delete(id)
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
  window.dispatchEvent(new Event(CHANGED))
}

/** Never recreate a recovery record already removed by a CLI acknowledgement. */
export async function updateOutboxState(id: string, state: DeliveryState, attemptId?: string): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("metadata", "readwrite")
    const store = tx.objectStore("metadata")
    const request = store.get(id)
    request.onsuccess = () => {
      if (request.result && (!attemptId || request.result.attemptId === attemptId)) store.put({ ...request.result, state,
        attempts: request.result.attempts?.map((attempt: { id: string }) => attempt.id === attemptId ? { ...attempt, state } : attempt) })
    }
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
  window.dispatchEvent(new Event(CHANGED))
}

export function watchOutbox(handler: () => void): () => void {
  window.addEventListener(CHANGED, handler)
  return () => window.removeEventListener(CHANGED, handler)
}

export type OutboxHeader = Omit<OutboxInput, "text" | "images" | "documents"> & { preview: string; attachments: number; bytes: number }
export async function listOutboxHeaders(): Promise<OutboxHeader[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const request = db.transaction("metadata").objectStore("metadata").getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function readOutbox(id: string): Promise<OutboxInput | undefined> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["inputs", "metadata"])
    const payload = tx.objectStore("inputs").get(id), meta = tx.objectStore("metadata").get(id)
    tx.oncomplete = () => resolve(payload.result ? { ...payload.result, ...meta.result } : undefined)
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}

function inputMetadata(input: OutboxInput) {
  const { images, documents, text, ...meta } = input
  return { ...meta, preview: text.slice(0, 240), attachments: images.length + documents.length, bytes: text.length * 3 + [...images, ...documents].reduce((sum, file) => sum + file.data.length, 0) }
}
