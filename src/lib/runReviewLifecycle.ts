import type { ReviewRunDiff } from "./diff"
import type { ReviewPreparationState, ReviewSnapshotFinish, ReviewSnapshotStart } from "./ipc"

export interface ReviewStatus { state: ReviewPreparationState; reason: string | null; id: string | null }
interface ReviewRound {
  id: string
  createdAt: number
  cancelled: boolean
  status: ReviewStatus
  baseline: Promise<void>
  reserved?: boolean
}
export interface RunReviewAdapter {
  start(cwd: string, id: string): Promise<ReviewSnapshotStart>
  freeze(id: string): Promise<ReviewSnapshotStart>
  finish(id: string): Promise<ReviewSnapshotFinish>
  cancel(id: string): Promise<void>
  changed(status: ReviewStatus): void
  publish(review: ReviewRunDiff): void
}

/** Result correlation follows the coordinator's ordered definitive-result set. */
export function crossesWrittenInputBoundary(inputs: readonly { attemptId: string }[], resultIds?: readonly string[]): boolean {
  const completed = resultIds ?? inputs.slice(0, 1).map((input) => input.attemptId)
  return inputs.some((input) => !completed.includes(input.attemptId))
}

/** A round owns its pre-send baseline and frozen endpoint. Heavy diff work never
 * controls queue advancement, and late/expired work cannot publish as a new round. */
export class RunReviewLifecycle {
  private current?: ReviewRound
  private latestId?: string
  private boundary?: Promise<void>
  private freezing?: ReviewRound
  private rounds = new Map<string, ReviewRound>()
  constructor(private cwd: string, private adapter: RunReviewAdapter,
    private budgets = { captureMs: 500, finishMs: 3500 }) {}
  private async bounded<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("文件审查超过准备预算")), ms) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private update(round: ReviewRound, state: ReviewPreparationState, reason: string | null) {
    round.status = { id: round.id, state, reason }
    if (!round.cancelled && this.latestId === round.id) this.adapter.changed(round.status)
  }
  async begin(): Promise<void> {
    await this.boundary
    if (this.current) return this.current.baseline
    const id = crypto.randomUUID()
    const round: ReviewRound = { id, createdAt: Date.now(), cancelled: false, status: { id, state: "pending", reason: null }, baseline: Promise.resolve() }
    this.current = round; this.latestId = id; this.adapter.changed(round.status)
    this.rounds.set(id, round)
    round.baseline = (async () => {
      try {
        const snapshot = await this.bounded(this.adapter.start(this.cwd, id), this.budgets.captureMs)
        if (!round.cancelled) this.update(round, snapshot.state, snapshot.reason)
      } catch (error) {
        if (!round.cancelled) this.update(round, "unavailable", String(error))
        void this.adapter.cancel(id).catch(() => {})
      }
    })()
    return round.baseline
  }
  /** Resolves after only bounded endpoint capture; finish continues independently. */
  freeze(): Promise<void> {
    if (this.boundary) return this.boundary
    const round = this.current
    if (!round) return Promise.resolve()
    this.current = undefined
    this.freezing = round
    round.createdAt = Date.now()
    round.reserved = true
    this.adapter.publish({ id: round.id, createdAt: round.createdAt, diff: { isRepo: false, files: [],
      patchError: "文件审查仍在生成", reviewState: "pending", reviewReason: null } })
    const boundary = (async () => {
      await round.baseline
      if (round.cancelled) return
      if (round.status.state !== "unavailable") {
        try {
          const frozen = await this.bounded(this.adapter.freeze(round.id), this.budgets.captureMs)
          if (!round.cancelled) this.update(round, frozen.state, frozen.reason)
        } catch (error) {
          this.update(round, "unavailable", String(error))
          void this.adapter.cancel(round.id).catch(() => {})
        }
      }
      if (!round.cancelled) void this.finish(round).finally(() => this.rounds.delete(round.id))
    })()
    this.boundary = boundary
    void boundary.finally(() => {
      if (this.boundary === boundary) this.boundary = undefined
      if (this.freezing === round) this.freezing = undefined
    })
    return boundary
  }
  /** A next-turn guide was already written, so the live endpoint is no longer
   * attributable. Record the result boundary without pretending to freeze it. */
  rejectBoundary(reason: string): Promise<void> {
    const round = this.current ?? { id: crypto.randomUUID(), createdAt: Date.now(), cancelled: false,
      status: { id: null, state: "unavailable" as const, reason }, baseline: Promise.resolve() }
    this.current = undefined
    round.createdAt = Date.now()
    round.cancelled = true
    this.rounds.delete(round.id)
    this.latestId = round.id
    this.adapter.changed({ id: round.id, state: "unavailable", reason })
    this.adapter.publish(this.unavailable(round, reason))
    void this.adapter.cancel(round.id).catch(() => {})
    return Promise.resolve()
  }
  private unavailable(round: ReviewRound, reason: string | null): ReviewRunDiff {
    return { id: round.id, createdAt: round.createdAt, diff: { isRepo: false, files: [], patchError: reason,
      reviewState: "unavailable", reviewReason: reason } }
  }
  private async finish(round: ReviewRound) {
    if (round.status.state === "unavailable") {
      this.adapter.publish(this.unavailable(round, round.status.reason))
      void this.adapter.cancel(round.id).catch(() => {})
      return
    }
    try {
      const diff = await this.bounded(this.adapter.finish(round.id), this.budgets.finishMs)
      if (round.cancelled) return
      const reason = diff.reviewReason ?? round.status.reason
      const reviewState = diff.reviewState === "ready" && round.status.state === "partial" ? "partial" : diff.reviewState
      this.update(round, reviewState, reason)
      this.adapter.publish({ id: round.id, createdAt: round.createdAt, diff: { ...diff, reviewState, reviewReason: reason,
        patchError: [diff.patchError, reviewState !== "ready" ? reason : null].filter(Boolean).join("；") || null } })
    } catch (error) {
      if (!round.cancelled) {
        this.update(round, "unavailable", String(error))
        this.adapter.publish(this.unavailable(round, String(error)))
      }
      void this.adapter.cancel(round.id).catch(() => {})
    }
  }
  async discard(reason = "本轮审查已取消", archiveUnavailable = false, all = false): Promise<void> {
    const active = this.current ?? this.freezing
    const rounds = all ? [...this.rounds.values()] : active ? [active] : []
    if (all || active === this.current) this.current = undefined
    for (const round of rounds) {
      round.cancelled = true
      this.rounds.delete(round.id)
      if (this.latestId === round.id) this.adapter.changed({ id: round.id, state: "unavailable", reason })
      if (archiveUnavailable && round.reserved) this.adapter.publish(this.unavailable(round, reason))
    }
    await Promise.all(rounds.map((round) => this.adapter.cancel(round.id).catch(() => {})))
  }
}
