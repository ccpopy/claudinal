import { claudeCapabilities, type CliCapabilities } from "./ipc"

export interface InstalledCliSnapshot {
  capabilities: CliCapabilities | null
  status: "idle" | "loading" | "ready" | "error"
  error?: "timeout" | "failed"
}

/** One bounded request per generation. An installation change revokes old results. */
export class InstalledCliCapabilityStore {
  private snapshot: InstalledCliSnapshot = { capabilities: null, status: "idle" }
  private generation = 0
  private listeners = new Set<() => void>()
  private pending: Promise<CliCapabilities | null> | null = null
  constructor(private fetchCapabilities: (refresh?: boolean) => Promise<CliCapabilities>, private timeoutMs = 15_000) {}
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(snapshot: InstalledCliSnapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener() }
  invalidate() {
    this.generation++
    this.pending = null
    this.publish({ capabilities: null, status: "idle" })
  }
  refresh = (force = false): Promise<CliCapabilities | null> => {
    // Diagnostics may join startup/selection detection; only an installation
    // invalidation creates a distinct in-flight generation.
    if (this.pending) return this.pending
    if (!force && this.snapshot.status === "ready") return Promise.resolve(this.snapshot.capabilities)
    const generation = ++this.generation
    this.publish({ capabilities: null, status: "loading" })
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("capability_timeout")), this.timeoutMs) })
    const pending = Promise.race([Promise.resolve().then(() => this.fetchCapabilities(force)), timeout]).then((capabilities) => {
      if (generation !== this.generation) return null
      this.publish({ capabilities, status: "ready" })
      return capabilities
    }).catch((error: unknown) => {
      if (generation === this.generation) this.publish({ capabilities: null, status: "error", error: error instanceof Error && error.message === "capability_timeout" ? "timeout" : "failed" })
      return null
    }).finally(() => { clearTimeout(timer); if (generation === this.generation) this.pending = null })
    this.pending = pending
    return pending
  }
}

export const installedCliCapabilities = new InstalledCliCapabilityStore((refresh) => claudeCapabilities(undefined, refresh))
/** Diagnostics shares the snapshot directly; no installation event or refresh loop. */
export const refreshInstalledCliCapabilities = () => installedCliCapabilities.refresh(true)
