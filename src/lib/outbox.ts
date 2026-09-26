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
}

const CHANGED = "claudinal:outbox-changed"
let database: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("claudinal-input-recovery", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("inputs", { keyPath: "id" })
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined }; resolve(request.result) }
    request.onerror = () => { database = undefined; reject(request.error) }
  })
}

export async function listOutbox(): Promise<OutboxInput[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const request = db.transaction("inputs").objectStore("inputs").getAll()
    request.onsuccess = () => resolve((request.result as OutboxInput[]).filter((input) => input.schemaVersion === 1))
    request.onerror = () => reject(request.error)
  })
}

export async function saveOutbox(input: OutboxInput): Promise<void> {
  const db = await open()
  // IndexedDB transaction completion is the local acceptance boundary.
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("inputs", "readwrite")
    const store = tx.objectStore("inputs")
    const count = store.count()
    count.onsuccess = () => {
      const existing = store.getKey(input.id)
      existing.onsuccess = () => {
        if (count.result >= 50 && !existing.result) { tx.abort(); return }
        const all = store.getAll()
        all.onsuccess = () => {
          const bytes = (item: OutboxInput) => (item.text.length * 3) + [...item.images, ...item.documents].reduce((sum, file) => sum + file.data.length, 0)
          const total = (all.result as OutboxInput[]).filter((item) => item.id !== input.id).reduce((sum, item) => sum + bytes(item), bytes(input))
          if (total > 128 * 1024 * 1024) { tx.abort(); return }
          store.put(input)
        }
      }
    }
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("恢复区已满（最多 50 条 / 128 MB），请先处理已保存的输入"))
  })
  window.dispatchEvent(new Event(CHANGED))
}

export async function removeOutbox(id: string): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("inputs", "readwrite")
    tx.objectStore("inputs").delete(id)
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
  window.dispatchEvent(new Event(CHANGED))
}

/** Never recreate a recovery record already removed by a CLI acknowledgement. */
export async function updateOutboxState(id: string, state: DeliveryState): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("inputs", "readwrite")
    const store = tx.objectStore("inputs")
    const request = store.get(id)
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, state }) }
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
  window.dispatchEvent(new Event(CHANGED))
}

export function watchOutbox(handler: () => void): () => void {
  window.addEventListener(CHANGED, handler)
  return () => window.removeEventListener(CHANGED, handler)
}
