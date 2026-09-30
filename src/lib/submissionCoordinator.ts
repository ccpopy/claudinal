import type { DocumentPayload, ImagePayload, UIBlock } from "@/types/ui"
import { deliveryAfterWriteError, type DeliveryState, type LocalState, type RunState, type SubmitOutcome } from "./submission"

export interface InputPayload {
  text: string
  images: ImagePayload[]
  documents: DocumentPayload[]
  /** Selection starts preparation; tasks can take ownership before it finishes. */
  prepare?: Promise<InputPayload>
  pendingNames?: string[]
  uiBlocks?: UIBlock[]
}
export interface InputAttempt { id: string; revision: number; state: DeliveryState; error?: string }
export interface SubmittedInput<C> {
  mode: "guide" | "followup"
  /** Follow-ups registered behind an earlier input stay outside the transcript until dispatch. */
  queuedBehindTurn: boolean
  messageId: string
  conversationKey: string
  inputRevision: number
  sourceDraftRevision: number
  payloadRef: InputPayload
  profileRevision: string
  localState: LocalState
  deliveryState: DeliveryState
  runState: RunState
  attemptId: string
  attempts: InputAttempt[]
  createdAt: number
  error?: string
  context: C
  controller: AbortController
  timings: { registered: number; painted?: number; saved?: number; writeStarted?: number; written?: number; firstResponse?: number }
}
export interface SubmissionAdapter<C> {
  changed(task: SubmittedInput<C>): void
  persist(task: SubmittedInput<C>): Promise<void>
  prepare(task: SubmittedInput<C>): Promise<void>
  write(task: SubmittedInput<C>): Promise<void>
  settled(task: SubmittedInput<C>): void
}
const pending = new Set<DeliveryState>(["preparing", "needs_confirmation", "queued", "paused"])
export const isPendingInput = (task: SubmittedInput<unknown>) => pending.has(task.deliveryState)
export const isActiveInput = (task: SubmittedInput<unknown>) => isPendingInput(task) && task.deliveryState !== "paused" || task.runState === "running" || task.runState === "cancelling"

/** Application-owned inputs, FIFO writers per conversation, no dependency on mounted editors. */
export class SubmissionCoordinator<C> {
  readonly tasks = new Map<string, SubmittedInput<C>>()
  private busy = new Map<string, string>()
  private paused = new Set<string>()
  private drafts = new Map<string, string>()
  private settling = new Map<string, Promise<void>>()
  constructor(private adapter: SubmissionAdapter<C>, private defer: (fn: () => void) => void = (fn) => {
    // Yield a paint opportunity before persistence, compilation and other expensive work.
    if (typeof requestAnimationFrame === "function" && document.visibilityState === "visible") requestAnimationFrame(() => setTimeout(fn, 0))
    else setTimeout(fn, 0)
  }) {}

  submit(input: { conversationKey: string; sourceDraftRevision: number; payload: InputPayload; profileRevision: string; context: C; draftKey?: string; mode?: "guide" | "followup" }): SubmitOutcome {
    if (![...this.tasks.values()].some((task) => task.conversationKey === input.conversationKey && (isPendingInput(task) || task.deliveryState === "failed" || task.deliveryState === "delivery_unknown"))) this.paused.delete(input.conversationKey)
    const draftId = input.draftKey ? `${input.draftKey}:${input.sourceDraftRevision}` : undefined
    if (draftId && this.drafts.has(draftId)) return { kind: "registered_in_ui", messageId: this.drafts.get(draftId)! }
    const messageId = crypto.randomUUID(), attemptId = crypto.randomUUID()
    const task: SubmittedInput<C> = {
      ...input, mode: input.mode ?? "followup", messageId, inputRevision: 1, payloadRef: input.payload, localState: "saving",
      queuedBehindTurn: input.mode !== "guide" && (this.paused.has(input.conversationKey)
        || [...this.tasks.values()].some((task) => task.conversationKey === input.conversationKey && (isPendingInput(task) || isActiveInput(task)))),
      deliveryState: this.paused.has(input.conversationKey) ? "paused" : "preparing", runState: "idle", attemptId,
      attempts: [{ id: attemptId, revision: 1, state: "preparing" }], createdAt: Date.now(), controller: new AbortController(),
      timings: { registered: performance.now() }
    }
    this.tasks.set(messageId, task)
    if (draftId) this.drafts.set(draftId, messageId)
    this.emit(task)
    this.defer(() => { task.timings.painted = performance.now(); void this.save(task) })
    return { kind: "registered_in_ui", messageId }
  }
  private emit(task: SubmittedInput<C>) {
    const attempt = task.attempts.find((a) => a.id === task.attemptId)!
    attempt.state = task.deliveryState; attempt.error = task.error
    this.adapter.changed(task)
  }
  assertCurrent(task: SubmittedInput<C>, attemptId = task.attemptId) {
    if (task.controller.signal.aborted || task.attemptId !== attemptId) throw new DOMException("请求已取消", "AbortError")
  }
  status(task: SubmittedInput<C>, state: DeliveryState) {
    this.assertCurrent(task); task.deliveryState = state; this.emit(task)
  }
  private async save(task: SubmittedInput<C>) {
    const attempt = task.attemptId
    try {
      this.assertCurrent(task, attempt)
      if (task.payloadRef.prepare) {
        const payload = await task.payloadRef.prepare
        this.assertCurrent(task, attempt)
        task.payloadRef = payload; this.emit(task)
      }
      await this.adapter.persist(task)
      if (task.attemptId !== attempt) return
      if (task.controller.signal.aborted) { task.localState = "saved"; this.emit(task); this.adapter.settled(task); return }
      task.localState = "saved"; task.timings.saved = performance.now()
      task.deliveryState = this.paused.has(task.conversationKey) ? "paused" : "queued"
      this.emit(task); void this.pump(task.conversationKey)
    } catch (error) {
      if (task.attemptId !== attempt) return
      if (task.controller.signal.aborted) { this.adapter.settled(task); return }
      task.localState = "save_failed"; this.fail(task, error, false)
    }
  }
  private async pump(key: string) {
    if (this.busy.has(key) || this.paused.has(key) || this.settling.has(key)) return
    const tasks = [...this.tasks.values()].filter((t) => t.conversationKey === key)
    const running = this.hasRunning(key)
    // Guides may overtake local follow-ups, but share the same serialized writer.
    const task = tasks.find((t) => isPendingInput(t) && t.mode === "guide")
      ?? (!running ? tasks.find(isPendingInput) : undefined)
    if (!task || task.localState !== "saved") return
    this.busy.set(key, task.messageId)
    const attempt = task.attemptId
    let writing = false
    try {
      this.status(task, "preparing")
      await this.adapter.prepare(task)
      await this.waitForSettlement(key)
      this.assertCurrent(task, attempt)
      // Crash recovery must be conservative even in the short pre-write window.
      this.status(task, "writing")
      await this.adapter.persist(task)
      this.assertCurrent(task, attempt)
      writing = true; task.runState = "running"; task.timings.writeStarted = performance.now()
      this.emit(task)
      await this.adapter.write(task)
      if (task.attemptId !== attempt || task.controller.signal.aborted) return
      task.timings.written = performance.now()
      if (task.deliveryState === "writing") this.status(task, "awaiting_ack")
      this.adapter.settled(task)
    } catch (error) {
      if (task.attemptId === attempt && !task.controller.signal.aborted) this.fail(task, error, writing)
    } finally {
      if (task.attemptId === attempt && task.controller.signal.aborted) this.adapter.settled(task)
      this.busy.delete(key)
      void this.pump(key)
    }
  }
  private fail(task: SubmittedInput<C>, error: unknown, writing: boolean) {
    if (task.deliveryState === "acknowledged" || task.deliveryState === "responded") return
    task.error = error && typeof error === "object" && "message" in error ? String(error.message) : String(error)
    task.deliveryState = writing ? deliveryAfterWriteError(error) : "failed"; task.runState = "failed"
    this.emit(task); this.pause(task.conversationKey); this.adapter.settled(task)
  }
  acknowledge(attemptId: string): boolean {
    for (const task of this.tasks.values()) {
      const attempt = task.attempts.find((a) => a.id === attemptId)
      if (!attempt) continue
      attempt.state = "acknowledged"
      if (task.attemptId === attemptId) {
        task.deliveryState = task.deliveryState === "responded" ? "responded" : "acknowledged"
        this.emit(task); this.adapter.settled(task)
      } else this.emit(task)
      return true
    }
    return false
  }
  hasRunning(key: string) {
    return [...this.tasks.values()].some((t) => t.conversationKey === key && (t.runState === "running" || t.runState === "cancelling"))
  }
  async waitForSettlement(key: string) {
    await this.settling.get(key)
  }
  complete(key: string, failed: boolean, attemptIds?: readonly string[], beforeNext?: () => Promise<void>) {
    const active = [...this.tasks.values()].filter((t) => t.conversationKey === key && (t.runState === "running" || t.runState === "cancelling"))
    // A late guide can belong to the NEXT CLI turn. Settle only the IDs named by
    // this result, never every input that happens to have been written already.
    const completed = attemptIds ? active.filter((t) => attemptIds.includes(t.attemptId)) : active.slice(0, 1)
    for (const task of completed) {
      task.deliveryState = "responded"; task.runState = failed ? "failed" : "done"
      task.timings.firstResponse ??= performance.now()
      this.emit(task); this.adapter.settled(task)
    }
    if (failed) this.pause(key)
    if (!this.hasRunning(key) && beforeNext && !this.settling.has(key)) {
      const settlement = Promise.resolve().then(beforeNext)
      this.settling.set(key, settlement)
      void settlement.then(
        () => { this.settling.delete(key); void this.pump(key) },
        () => { this.settling.delete(key); this.pause(key) }
      )
    } else if (!failed) void this.pump(key)
  }
  response(key: string, attemptIds?: readonly string[]) {
    const active = [...this.tasks.values()].filter((t) => t.conversationKey === key && t.runState === "running")
    const responding = attemptIds ? active.filter((t) => attemptIds.includes(t.attemptId)) : active.slice(0, 1)
    for (const task of responding) if (task.timings.firstResponse === undefined) { task.timings.firstResponse = performance.now(); this.emit(task) }
  }
  connectionLost(key: string) {
    this.pause(key)
    for (const task of this.tasks.values()) if (task.conversationKey === key && task.runState === "running") {
      task.controller.abort()
      if (task.deliveryState !== "acknowledged") task.deliveryState = "delivery_unknown"
      task.runState = "failed"
      task.error = task.deliveryState === "acknowledged" ? undefined : "CLI 连接已结束，无法确认接收状态"
      this.emit(task); this.adapter.settled(task)
    }
  }
  pause(key: string) {
    this.paused.add(key)
    for (const task of this.tasks.values()) if (task.conversationKey === key && isPendingInput(task) && this.busy.get(key) !== task.messageId) {
      task.deliveryState = "paused"; this.emit(task); this.adapter.settled(task)
    }
  }
  resume(key: string) {
    this.paused.delete(key)
    for (const task of this.tasks.values()) if (task.conversationKey === key && task.deliveryState === "paused") { task.deliveryState = "queued"; this.emit(task) }
    void this.pump(key)
  }
  cancel(id: string) {
    const task = this.tasks.get(id)
    if (!task || task.runState === "done") return
    task.controller.abort()
    if (task.deliveryState !== "acknowledged" && task.deliveryState !== "responded") task.deliveryState = task.timings.writeStarted !== undefined ? "delivery_unknown" : "cancelled"
    task.runState = "cancelled"
    this.emit(task); this.adapter.settled(task)
  }
  stop(key: string) {
    this.pause(key)
    const active = [...this.tasks.values()].filter((t) => t.conversationKey === key && (t.runState === "running" || this.busy.get(key) === t.messageId))
    if (!active.length) {
      const pending = [...this.tasks.values()].find((t) => t.conversationKey === key && isPendingInput(t))
      if (pending) active.push(pending)
    }
    for (const task of active) this.cancel(task.messageId)
  }
  promote(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || task.deliveryState !== "queued" || this.paused.has(task.conversationKey) || this.busy.get(task.conversationKey) === id) return false
    task.mode = "guide"
    this.emit(task)
    void this.pump(task.conversationKey)
    return true
  }
  retry(id: string, payload?: InputPayload) {
    const task = this.tasks.get(id)
    if (!task || !["failed", "cancelled", "paused", "queued"].includes(task.deliveryState)) return false
    const preservePause = task.deliveryState === "paused"
    task.controller.abort(); task.controller = new AbortController()
    if (payload) { task.payloadRef = payload; task.inputRevision++ }
    task.attemptId = crypto.randomUUID()
    task.attempts.push({ id: task.attemptId, revision: task.inputRevision, state: "preparing" })
    task.localState = "saving"; task.deliveryState = "preparing"; task.runState = "idle"; task.error = undefined
    task.timings = { registered: performance.now() }
    if (!preservePause) this.paused.delete(task.conversationKey)
    this.emit(task); this.defer(() => void this.save(task))
    return true
  }
}
