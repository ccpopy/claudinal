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
/** Only selection/target metadata belongs here; runtime handles and payloads do not. */
export interface AttemptConfiguration {
  readonly conversationKey: string
  readonly profileRevision: string
  readonly context: unknown
}
export interface InputAttempt {
  readonly id: string
  readonly revision: number
  readonly createdAt: number
  readonly configuration: AttemptConfiguration
  state: DeliveryState
  error?: string
  acknowledgedAt?: number
  deliveryCertainty?: "not_sent" | "unknown" | "received"
}
export type QueuePauseReason = "not_sent" | "needs_decision" | "delivery_unknown" | "connection_lost" | "user_stop"
export interface QueuePause { reason: QueuePauseReason; blockerId?: string }
export interface SubmissionQueueState extends QueuePause {
  paused: boolean
  pendingIds: string[]
  pendingCount: number
}
export interface ArchivedInput {
  messageId: string
  conversationKey: string
  attemptId: string
  attempts: InputAttempt[]
  createdAt: number
  deliveryState: DeliveryState
  runState: RunState
}
export interface SubmissionRetention { archivedInputs: number; draftReceipts: number; archivedAttempts?: number }
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
  pause?: QueuePause
  context: C
  controller: AbortController
  timings: { registered: number; painted?: number; saved?: number; writeStarted?: number; written?: number; firstResponse?: number }
}
export interface SubmissionAdapter<C> {
  /** Return non-secret, serializable selected settings, excluding owner/history/CLI blocks. */
  captureAttemptContext?(context: C): unknown
  changed(task: SubmittedInput<C>): void
  persist(task: SubmittedInput<C>): Promise<void>
  prepare(task: SubmittedInput<C>): Promise<void>
  write(task: SubmittedInput<C>): Promise<void>
  settled(task: SubmittedInput<C>): void
  archived?(receipt: ArchivedInput): void
  /** Completed payloads are re-read on demand from transcript/durable storage. */
  restorePayload?(id: string): Promise<InputPayload | undefined>
}
const pending = new Set<DeliveryState>(["preparing", "needs_confirmation", "queued", "paused"])
export const isPendingInput = (task: SubmittedInput<unknown>) => pending.has(task.deliveryState)
export const isActiveInput = (task: SubmittedInput<unknown>) => isPendingInput(task) && task.deliveryState !== "paused" || task.runState === "running" || task.runState === "cancelling"
export const isAwaitingDefinitiveResult = (task: Pick<SubmittedInput<unknown>, "runState" | "deliveryState">) =>
  task.runState === "running" || task.runState === "cancelling"
  || task.deliveryState === "acknowledged" && (task.runState === "cancelled" || task.runState === "failed")

function immutableSnapshot(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return seen.get(value)
  // Configuration capture is deliberately plain data. Runtime handles must be omitted.
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return undefined
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {}
  seen.set(value, copy)
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "function") (copy as Record<string, unknown>)[key] = immutableSnapshot(item, seen)
  }
  return Object.freeze(copy)
}

/** Application-owned inputs, FIFO writers per conversation, no dependency on mounted editors. */
export class SubmissionCoordinator<C> {
  readonly tasks = new Map<string, SubmittedInput<C>>()
  readonly archivedInputs = new Map<string, ArchivedInput>()
  private attemptOwners = new Map<string, string>()
  private busy = new Map<string, string>()
  private paused = new Map<string, QueuePause>()
  private resumedInputs = new Set<string>()
  private drafts = new Map<string, string>()
  private settling = new Map<string, Promise<void>>()
  constructor(private adapter: SubmissionAdapter<C>, private defer: (fn: () => void) => void = (fn) => {
    // Yield a paint opportunity before persistence, compilation and other expensive work.
    if (typeof requestAnimationFrame === "function" && document.visibilityState === "visible") requestAnimationFrame(() => setTimeout(fn, 0))
    else setTimeout(fn, 0)
  }, private retention: SubmissionRetention = { archivedInputs: 256, draftReceipts: 512, archivedAttempts: 2048 }) {}

  private newAttempt(task: Pick<SubmittedInput<C>, "conversationKey" | "profileRevision" | "context" | "inputRevision">, id: string): InputAttempt {
    return {
      id, revision: task.inputRevision, createdAt: Date.now(), state: "preparing", deliveryCertainty: "not_sent",
      configuration: Object.freeze({ conversationKey: task.conversationKey, profileRevision: task.profileRevision,
        context: immutableSnapshot(this.adapter.captureAttemptContext?.(task.context) ?? task.context) })
    }
  }
  private attemptView(task: SubmittedInput<C>): SubmittedInput<C> {
    // An old asynchronous callback cannot adopt a later attempt's controller/context.
    const view = { ...task }
    const attemptId = task.attemptId
    // ACK/result can arrive before the write Promise returns. Preparation identity
    // stays captured, while delivery state follows this same attempt's receipt.
    const state = task.deliveryState
    Object.defineProperty(view, "deliveryState", { enumerable: true,
      get: () => task.attemptId === attemptId ? task.deliveryState : state })
    return view
  }
  private isQueuePaused(task: SubmittedInput<C>) {
    return this.paused.has(task.conversationKey) && !this.resumedInputs.has(task.messageId)
  }

  submit(input: { conversationKey: string; sourceDraftRevision: number; payload: InputPayload; profileRevision: string; context: C; draftKey?: string; mode?: "guide" | "followup" }): SubmitOutcome {
    const draftId = input.draftKey ? `${input.draftKey}:${input.sourceDraftRevision}` : undefined
    if (draftId && this.drafts.has(draftId)) return { kind: "registered_in_ui", messageId: this.drafts.get(draftId)! }
    const messageId = crypto.randomUUID(), attemptId = crypto.randomUUID()
    const task: SubmittedInput<C> = {
      ...input, mode: input.mode ?? "followup", messageId, inputRevision: 1, payloadRef: input.payload, localState: "saving",
      queuedBehindTurn: input.mode !== "guide" && (this.paused.has(input.conversationKey)
        || [...this.tasks.values()].some((task) => task.conversationKey === input.conversationKey && (isPendingInput(task) || isActiveInput(task)))),
      deliveryState: this.paused.has(input.conversationKey) ? "paused" : "preparing", runState: "idle", attemptId,
      attempts: [], createdAt: Date.now(), controller: new AbortController(), pause: this.paused.get(input.conversationKey),
      timings: { registered: performance.now() }
    }
    task.attempts.push(this.newAttempt(task, attemptId))
    this.tasks.set(messageId, task)
    this.attemptOwners.set(attemptId, messageId)
    if (draftId) {
      this.drafts.set(draftId, messageId)
      while (this.drafts.size > this.retention.draftReceipts) this.drafts.delete(this.drafts.keys().next().value!)
    }
    this.emit(task)
    this.defer(() => {
      if (task.attemptId !== attemptId) return
      task.timings.painted = performance.now(); void this.save(task)
    })
    return { kind: "registered_in_ui", messageId }
  }
  private emit(task: SubmittedInput<C>) {
    const attempt = task.attempts.find((a) => a.id === task.attemptId)!
    attempt.state = task.deliveryState; attempt.error = task.error
    this.adapter.changed(task)
  }
  assertCurrent(task: SubmittedInput<C>, attemptId = task.attemptId) {
    if (task.controller.signal.aborted || this.tasks.get(task.messageId)?.attemptId !== attemptId) throw new DOMException("请求已取消", "AbortError")
  }
  status(task: SubmittedInput<C>, state: DeliveryState) {
    this.assertCurrent(task)
    const current = this.tasks.get(task.messageId)!
    current.deliveryState = state; this.emit(current)
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
      await this.adapter.persist(this.attemptView(task))
      if (task.attemptId !== attempt) return
      if (task.controller.signal.aborted) { task.localState = "saved"; this.emit(task); this.adapter.settled(task); return }
      task.localState = "saved"; task.timings.saved = performance.now()
      task.deliveryState = this.isQueuePaused(task) ? "paused" : "queued"
      task.pause = this.isQueuePaused(task) ? this.paused.get(task.conversationKey) : undefined
      this.emit(task); void this.pump(task.conversationKey)
    } catch (error) {
      if (task.attemptId !== attempt) return
      if (task.controller.signal.aborted) { this.adapter.settled(task); return }
      task.localState = "save_failed"; this.fail(task, error, false)
    }
  }
  private async pump(key: string) {
    if (this.busy.has(key) || this.settling.has(key)) return
    const tasks = [...this.tasks.values()].filter((t) => t.conversationKey === key)
    const running = this.hasRunning(key)
    // Guides may overtake local follow-ups, but share the same serialized writer.
    const eligible = (t: SubmittedInput<C>) => isPendingInput(t) && !this.isQueuePaused(t)
    const task = tasks.find((t) => eligible(t) && t.mode === "guide")
      ?? (!running ? tasks.find(eligible) : undefined)
    if (!task || task.localState !== "saved") return
    this.busy.set(key, task.messageId)
    const attempt = task.attemptId
    let writing = false
    try {
      this.status(task, "preparing")
      await this.adapter.prepare(this.attemptView(task))
      await this.waitForSettlement(key)
      this.assertCurrent(task, attempt)
      // Crash recovery must be conservative even in the short pre-write window.
      this.status(task, "writing")
      await this.adapter.persist(this.attemptView(task))
      this.assertCurrent(task, attempt)
      writing = true; task.runState = "running"; task.timings.writeStarted = performance.now()
      task.attempts.find((a) => a.id === attempt)!.deliveryCertainty = "unknown"
      this.emit(task)
      await this.adapter.write(this.attemptView(task))
      if (task.attemptId !== attempt || task.controller.signal.aborted) return
      task.timings.written = performance.now()
      if (task.deliveryState === "writing") this.status(task, "awaiting_ack")
      this.adapter.settled(task)
    } catch (error) {
      if (task.attemptId === attempt && !task.controller.signal.aborted) this.fail(task, error, writing)
    } finally {
      if (task.attemptId === attempt && task.controller.signal.aborted) this.adapter.settled(task)
      this.busy.delete(key)
      if (task.attemptId === attempt) this.resumedInputs.delete(task.messageId)
      this.archiveCompleted(task)
      void this.pump(key)
    }
  }
  private fail(task: SubmittedInput<C>, error: unknown, writing: boolean) {
    if (task.deliveryState === "acknowledged" || task.deliveryState === "responded") return
    task.error = error && typeof error === "object" && "message" in error ? String(error.message) : String(error)
    task.deliveryState = writing ? deliveryAfterWriteError(error) : "failed"; task.runState = "failed"
    task.attempts.find((a) => a.id === task.attemptId)!.deliveryCertainty = task.deliveryState === "failed" ? "not_sent" : "unknown"
    this.emit(task); this.pause(task.conversationKey, task.deliveryState === "delivery_unknown" ? "delivery_unknown" : "not_sent", task.messageId); this.adapter.settled(task)
  }
  acknowledge(attemptId: string): boolean {
    const ownerId = this.attemptOwners.get(attemptId)
    if (!ownerId) return false
    const task = this.tasks.get(ownerId)
    const receipt = task ?? this.archivedInputs.get(ownerId)
    const attempt = receipt?.attempts.find((a) => a.id === attemptId)
    if (!attempt) return false
    if (attempt.state !== "responded") attempt.state = "acknowledged"
    attempt.acknowledgedAt ??= Date.now(); attempt.deliveryCertainty = "received"
    if (task) {
      if (task.attemptId === attemptId) {
        task.deliveryState = task.deliveryState === "responded" ? "responded" : "acknowledged"
        this.emit(task); this.adapter.settled(task)
      } else {
        // Notify history only. Never settle/remove the current attempt's outbox.
        this.adapter.changed(task)
      }
    }
    return true
  }
  hasRunning(key: string) {
    return [...this.tasks.values()].some((t) => t.conversationKey === key && (t.runState === "running" || t.runState === "cancelling"))
  }
  async waitForSettlement(key: string) {
    await this.settling.get(key)
  }
  complete(key: string, failed: boolean, attemptIds?: readonly string[], beforeNext?: () => Promise<void>) {
    const active = [...this.tasks.values()].filter((t) => t.conversationKey === key && isAwaitingDefinitiveResult(t))
    // A late guide can belong to the NEXT CLI turn. Settle only the IDs named by
    // this result, never every input that happens to have been written already.
    const completed = attemptIds ? active.filter((t) => attemptIds.includes(t.attemptId)) : active.slice(0, 1)
    for (const task of completed) {
      task.deliveryState = "responded"; task.runState = failed ? "failed" : "done"
      task.attempts.find((a) => a.id === task.attemptId)!.deliveryCertainty = "received"
      task.timings.firstResponse ??= performance.now()
      this.emit(task); this.adapter.settled(task)
      this.archiveCompleted(task)
    }
    if (failed) this.pause(key, "needs_decision", completed[0]?.messageId)
    if (!this.hasRunning(key) && beforeNext && !this.settling.has(key)) {
      const settlement = Promise.resolve().then(beforeNext)
      this.settling.set(key, settlement)
      void settlement.then(
        () => { this.settling.delete(key); void this.pump(key) },
        () => { this.settling.delete(key); this.pause(key, "needs_decision") }
      )
    } else if (!failed) void this.pump(key)
  }
  response(key: string, attemptIds?: readonly string[]) {
    const active = [...this.tasks.values()].filter((t) => t.conversationKey === key && t.runState === "running")
    const responding = attemptIds ? active.filter((t) => attemptIds.includes(t.attemptId)) : active.slice(0, 1)
    for (const task of responding) if (task.timings.firstResponse === undefined) { task.timings.firstResponse = performance.now(); this.emit(task) }
  }
  connectionLost(key: string) {
    const active = [...this.tasks.values()].filter((task) => task.conversationKey === key && (task.runState === "running" || task.runState === "cancelling"))
    this.pause(key, "connection_lost", active[0]?.messageId)
    for (const task of active) {
      task.controller.abort()
      if (task.deliveryState !== "acknowledged") task.deliveryState = "delivery_unknown"
      task.runState = "failed"
      task.error = task.deliveryState === "acknowledged" ? undefined : "CLI 连接已结束，无法确认接收状态"
      this.emit(task); this.adapter.settled(task)
    }
  }
  queueState(key: string): SubmissionQueueState {
    const pause = this.paused.get(key)
    const pendingIds = [...this.tasks.values()].filter((task) => task.conversationKey === key && isPendingInput(task)).map((task) => task.messageId)
    return { reason: pause?.reason ?? "needs_decision", blockerId: pause?.blockerId, paused: !!pause, pendingIds, pendingCount: pendingIds.length }
  }
  pause(key: string, reason: QueuePauseReason = "needs_decision", blockerId?: string) {
    const previous = this.paused.get(key)
    // Late failures/results cannot erase an explicit user stop.
    const pause = previous?.reason === "user_stop" && reason !== "user_stop" ? previous : { reason, blockerId }
    this.paused.set(key, pause)
    for (const task of this.tasks.values()) if (task.conversationKey === key) this.resumedInputs.delete(task.messageId)
    for (const task of this.tasks.values()) if (task.conversationKey === key && isPendingInput(task) && this.busy.get(key) !== task.messageId) {
      task.deliveryState = "paused"; task.pause = pause; this.emit(task); this.adapter.settled(task)
    }
  }
  /** Explicitly continue every pending input in FIFO order; failed/unknown inputs are excluded. */
  resumeQueue(key: string) {
    this.paused.delete(key)
    for (const task of this.tasks.values()) if (task.conversationKey === key && task.deliveryState === "paused") {
      task.deliveryState = "queued"; task.pause = undefined; this.emit(task)
    }
    void this.pump(key)
  }
  /** This input overtakes earlier paused inputs; those remain paused and are never replayed. */
  resumeInput(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || task.deliveryState !== "paused" || task.controller.signal.aborted) return false
    this.resumedInputs.add(id); task.deliveryState = "queued"; task.pause = undefined
    this.emit(task); void this.pump(task.conversationKey)
    return true
  }
  /** Compatibility alias. New UI must label this operation as continuing the entire queue. */
  resume(key: string) {
    this.resumeQueue(key)
  }
  cancel(id: string) {
    const task = this.tasks.get(id)
    if (!task || task.runState === "done") return
    task.controller.abort()
    if (task.deliveryState !== "acknowledged" && task.deliveryState !== "responded") {
      const attempt = task.attempts.find((a) => a.id === task.attemptId)!
      task.deliveryState = attempt.deliveryCertainty === "not_sent" ? "cancelled" : "delivery_unknown"
    }
    this.resumedInputs.delete(id)
    task.runState = "cancelled"
    this.emit(task); this.adapter.settled(task)
  }
  stop(key: string) {
    this.pause(key, "user_stop")
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
    if (!task) return false
    return this.retryWithContext(id, { context: task.context, profileRevision: task.profileRevision, payload })
  }
  retryWithContext(id: string, input: { context: C; profileRevision: string; payload?: InputPayload }) {
    const task = this.tasks.get(id)
    if (!task || !["failed", "cancelled", "paused", "queued"].includes(task.deliveryState)) return false
    if (task.attempts.find((a) => a.id === task.attemptId)?.deliveryCertainty !== "not_sent") return false
    const preservePause = task.deliveryState === "paused"
    task.controller.abort(); task.controller = new AbortController()
    if (input.payload) { task.payloadRef = input.payload; task.inputRevision++ }
    // Clone the mutable execution shell; outputs from an old preparation stay isolated.
    task.context = input.context && typeof input.context === "object" ? { ...input.context } : input.context
    task.profileRevision = input.profileRevision
    task.attemptId = crypto.randomUUID()
    task.attempts.push(this.newAttempt(task, task.attemptId))
    this.attemptOwners.set(task.attemptId, id)
    task.localState = "saving"; task.deliveryState = "preparing"; task.runState = "idle"; task.error = undefined
    task.timings = { registered: performance.now() }
    // Retrying a failed blocker may release its dependencies. A user stop stays explicit.
    const pause = this.paused.get(task.conversationKey)
    if (!preservePause && pause?.reason !== "user_stop" && (!pause?.blockerId || pause.blockerId === id)) this.resumeQueue(task.conversationKey)
    task.pause = this.isQueuePaused(task) ? this.paused.get(task.conversationKey) : undefined
    this.emit(task)
    const attempt = task.attemptId
    this.defer(() => { if (task.attemptId === attempt) void this.save(task) })
    return true
  }
  /** Remove a definitely unwritten blocker and explicitly continue its dependants. */
  abandon(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || task.attempts.find((a) => a.id === task.attemptId)?.deliveryCertainty !== "not_sent") return false
    const pause = this.paused.get(task.conversationKey)
    this.cancel(id)
    if (pause?.reason === "not_sent" && pause.blockerId === id) this.resumeQueue(task.conversationKey)
    return true
  }
  async payload(id: string): Promise<InputPayload | undefined> {
    return this.tasks.get(id)?.payloadRef ?? this.adapter.restorePayload?.(id)
  }
  private archiveCompleted(task: SubmittedInput<C>) {
    if (task.deliveryState !== "responded" || this.busy.get(task.conversationKey) === task.messageId || !this.tasks.has(task.messageId)) return
    const attemptLimit = Math.max(1, this.retention.archivedAttempts ?? 2048)
    const kept = task.attempts.slice(-attemptLimit)
    for (const attempt of task.attempts.slice(0, -attemptLimit)) this.attemptOwners.delete(attempt.id)
    const receipt: ArchivedInput = { messageId: task.messageId, conversationKey: task.conversationKey, attemptId: task.attemptId,
      attempts: kept.map((attempt) => ({ ...attempt })), createdAt: task.createdAt, deliveryState: task.deliveryState, runState: task.runState }
    this.tasks.delete(task.messageId); this.archivedInputs.set(task.messageId, receipt)
    while (this.archivedInputs.size > this.retention.archivedInputs || [...this.archivedInputs.values()].reduce((total, item) => total + item.attempts.length, 0) > attemptLimit) {
      const oldest = this.archivedInputs.keys().next().value!
      for (const attempt of this.archivedInputs.get(oldest)!.attempts) this.attemptOwners.delete(attempt.id)
      this.archivedInputs.delete(oldest)
    }
    this.adapter.archived?.(receipt)
  }
  /** Owners can be released only after no unresolved job or writer references the conversation. */
  canReleaseConversation(key: string): boolean {
    return !this.busy.has(key) && !this.settling.has(key) && ![...this.tasks.values()].some((task) => task.conversationKey === key)
  }
  releaseConversation(key: string): boolean {
    if (!this.canReleaseConversation(key)) return false
    this.paused.delete(key)
    return true
  }
  retentionStats() {
    return { payloads: this.tasks.size, archivedInputs: this.archivedInputs.size,
      archivedAttempts: [...this.archivedInputs.values()].reduce((total, item) => total + item.attempts.length, 0),
      attemptIndices: this.attemptOwners.size, draftReceipts: this.drafts.size }
  }
}
