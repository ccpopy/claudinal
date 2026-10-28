import { fetchOauthUsage, getAuthStatus, invalidateOauthUsageRequest, type AuthStatus, type OauthUsage, type OauthUsageWindow } from "@/lib/ipc"
import { isOfficialApi } from "@/lib/oauthUsage"

/** CLI events refresh windows on every response; the usage API is only a seed. */
const FRESH_MS = 5 * 60_000
const MIN_API_INTERVAL_MS = 60_000
const MIN_FORCED_INTERVAL_MS = 10_000
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000

export interface PlanUsageSnapshot {
  usage: OauthUsage | null
  source: "cli" | "api" | null
  updatedAt: number
  loading: boolean
  error: string | null
}

type Clock = () => number

/**
 * `rate_limit_event.rate_limit_info.unifiedWindows` carries both plan windows
 * with utilization as a 0-1 fraction and resetsAt in Unix seconds (verified
 * against the usage API: 0.46 ↔ 47, 0.26 ↔ 26, same reset instant).
 */
export function windowsFromRateLimitInfo(info: unknown): Partial<Pick<OauthUsage, "five_hour" | "seven_day">> | null {
  const windows = record(record(info)?.unifiedWindows)
  if (!windows) return null
  const out: Partial<Pick<OauthUsage, "five_hour" | "seven_day">> = {}
  for (const key of ["five_hour", "seven_day"] as const) {
    const window = record(windows[key])
    const utilization = window?.utilization
    const resetsAt = window?.resetsAt
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue
    const resetDate = typeof resetsAt === "number" ? new Date(resetsAt * 1000) : null
    out[key] = {
      utilization: Math.max(0, Math.min(100, utilization * 100)),
      resets_at: resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null
    } satisfies OauthUsageWindow
  }
  return Object.keys(out).length ? out : null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export class PlanUsageStore {
  private snapshot: PlanUsageSnapshot = { usage: null, source: null, updatedAt: 0, loading: false, error: null }
  private listeners = new Set<() => void>()
  private lastApiAt = -Infinity
  private backoffUntil = 0
  private inflight: Promise<void> | null = null
  private epoch = 0
  private requestEpoch = 0
  private accountKey: string | null | undefined
  private accountRevision = 0
  private cliRevision = { five_hour: 0, seven_day: 0 }

  constructor(
    private load: () => Promise<OauthUsage> = fetchOauthUsage,
    private official: () => boolean = isOfficialApi,
    private now: Clock = Date.now
  ) {}

  getSnapshot = () => this.snapshot
  getEpoch = () => this.epoch
  getAccountRevision = () => this.accountRevision
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<PlanUsageSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** Merge CLI windows, keeping API-only rows (per-model weekly, extra usage). */
  acceptRateLimitInfo = (info: unknown, sourceEpoch: number) => {
    const windows = windowsFromRateLimitInfo(info)
    if (!windows || !this.official() || this.accountKey === null || sourceEpoch !== this.epoch) return
    for (const key of ["five_hour", "seven_day"] as const) if (windows[key]) this.cliRevision[key]++
    this.publish({ usage: { ...this.snapshot.usage, ...windows }, source: "cli", updatedAt: this.now(), error: null })
  }

  /** Shared identity survives the Account page being closed/reopened. */
  setAccount = (key: string | null): boolean => {
    if (this.accountKey === key) return false
    const initialized = this.accountKey !== undefined
    this.accountKey = key
    this.accountRevision++
    // The initial resolution may adopt events from a runtime started at boot.
    if (initialized || key === null) this.clear()
    this.lastApiAt = -Infinity
    this.backoffUntil = 0
    return true
  }

  /** Account or provider changed: retire API responses and old runtime events. */
  clear = () => {
    this.epoch++
    this.invalidateUsage()
  }

  /** A quota reset invalidates numbers, but the same account's runtimes survive. */
  invalidateUsage = () => {
    this.requestEpoch++
    invalidateOauthUsageRequest()
    this.inflight = null
    this.publish({ usage: null, source: null, updatedAt: 0, loading: false, error: null })
  }

  refresh = (options: { force?: boolean } = {}): Promise<void> => {
    if (!this.official() || this.accountKey === null) {
      if (this.snapshot.usage || this.inflight) this.clear()
      return Promise.resolve()
    }
    if (this.inflight) return this.inflight
    const now = this.now()
    const fresh = !!this.snapshot.usage && now - this.snapshot.updatedAt < FRESH_MS
    if (now < this.backoffUntil) return Promise.resolve()
    if (options.force ? now - this.lastApiAt < MIN_FORCED_INTERVAL_MS : fresh || now - this.lastApiAt < MIN_API_INTERVAL_MS) {
      return Promise.resolve()
    }
    this.lastApiAt = now
    const epoch = this.requestEpoch
    const cliRevision = { ...this.cliRevision }
    this.publish({ loading: true })
    const request = this.load().then((usage) => {
      if (epoch !== this.requestEpoch || !this.official()) return
      // Per-window revisions also handle partial events and equal clock ticks.
      const newer: Partial<OauthUsage> = {}
      for (const key of ["five_hour", "seven_day"] as const) {
        if (this.cliRevision[key] !== cliRevision[key] && this.snapshot.usage?.[key]) newer[key] = this.snapshot.usage[key]
      }
      const cliNewer = Object.keys(newer).length > 0
      this.publish({
        usage: { ...usage, ...newer },
        source: cliNewer ? "cli" : "api",
        updatedAt: cliNewer ? this.snapshot.updatedAt : this.now(),
        error: null
      })
    }, (error: unknown) => {
      if (epoch !== this.requestEpoch || !this.official()) return
      const message = String(error)
      if (/HTTP 429/.test(message)) this.backoffUntil = this.now() + RATE_LIMIT_BACKOFF_MS
      // Keep the last known numbers; only surface why they did not refresh.
      if (this.cliRevision.five_hour === cliRevision.five_hour && this.cliRevision.seven_day === cliRevision.seven_day) this.publish({ error: message })
    }).finally(() => {
      if (epoch !== this.requestEpoch) return
      this.inflight = null
      this.publish({ loading: false })
    })
    this.inflight = request
    return request
  }
}

export function planUsageAccountKey(status: AuthStatus): string | null {
  return status.loggedIn ? JSON.stringify([status.orgId, status.email, status.authMethod ?? status.apiProvider ?? "Anthropic"]) : null
}

export const planUsage = new PlanUsageStore()

/** Resolve ownership once at startup/provider selection; never poll credentials. */
export async function seedPlanUsage(): Promise<void> {
  if (!isOfficialApi()) return
  const epoch = planUsage.getEpoch()
  const accountRevision = planUsage.getAccountRevision()
  try {
    const status = await getAuthStatus()
    if (epoch !== planUsage.getEpoch() || accountRevision !== planUsage.getAccountRevision() || !isOfficialApi()) return
    planUsage.setAccount(planUsageAccountKey(status))
    await planUsage.refresh()
  } catch {
    // CLI events can still supply usage when the local auth probe is unavailable.
  }
}
