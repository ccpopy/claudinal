import * as ipc from "./ipc"
import { loadSettings } from "./settings"
import { subscribeSettingsBus } from "./settingsBus"
import type { ComputerUseApp, ComputerUsePermissionRequest, ComputerUseRuntimeStatus, ComputerUseStatus } from "./ipc"

export interface ComputerUseApi {
  status: typeof ipc.computerUseStatus
  setEnabled: typeof ipc.computerUseSetEnabled
  setForegroundKeys: typeof ipc.computerUseSetForegroundKeys
  listApps: typeof ipc.computerUseListApps
  requestApp: typeof ipc.computerUseRequestApp
  respond: typeof ipc.computerUseRespond
  revokeApp: typeof ipc.computerUseRevokeApp
  takeBack: typeof ipc.computerUseTakeBack
  install: typeof ipc.computerUseInstallDriver
  setPath: typeof ipc.computerUseSetDriverPath
}
export interface ComputerUseSnapshot {
  status: ComputerUseStatus | null
  runtime: ComputerUseRuntimeStatus | null
  conversationKey: string
  runtimeId: string | null
  viewEpoch: number
  selected: boolean
  apps: ComputerUseApp[]
  pending: ComputerUsePermissionRequest | null
  waiting: Array<{ runtimeId: string; cwd: string }>
  controllerState: ComputerUseRuntimeStatus["state"] | null
  busy: string | null
  error: string | null
}

/** One app-level switch exposes on-demand tools; native state stays the authority for app grants. */
export class ComputerUseController {
  private snapshot: ComputerUseSnapshot = { status: null, runtime: null, conversationKey: "", runtimeId: null, viewEpoch: 0, selected: false, apps: [], pending: null, waiting: [], controllerState: null, busy: null, error: null }
  private listeners = new Set<() => void>()
  private globalEnabled = false
  private runtimeOwners = new Map<string, string>()
  private runtimes = new Map<string, ComputerUseRuntimeStatus>()
  private invalidated = new Map<string, number>()
  private retired = new Set<string>()
  private settled = new Set<string>()
  private answering = new Set<string>()
  private runtimeRevisions = new Map<string, number>()
  private resumeEpochs = new Map<string, number>()
  private resuming = new Map<string, { epoch: number; promise: Promise<void> }>()
  private revocations = new Set<{ runtimeId?: string; promise: Promise<void> }>()
  private revision = 0
  private cancellation = 0
  private catalogOperation = 0
  isRuntimeAlive = (_runtimeId: string) => true
  isViewCurrent = (_key: string, _runtimeId: string) => true
  constructor(private api: ComputerUseApi) {}
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<ComputerUseSnapshot> = {}) {
    const next = { ...this.snapshot, ...patch }
    next.runtime = next.runtimeId ? this.runtimes.get(next.runtimeId) ?? null : null
    next.controllerState = next.status?.controller ? this.runtimes.get(next.status.controller.runtimeId)?.state ?? null : null
    next.selected = this.globalEnabled
    next.pending = next.runtime?.pendingRequests.find((request) => !this.settled.has(this.requestKey(request)) && !this.answering.has(this.requestKey(request))) ?? null
    next.waiting = [...this.runtimes.values()].filter((runtime) => runtime.runtimeId !== next.runtimeId && runtime.enabled && this.isRuntimeAlive(runtime.runtimeId)
      && !this.invalidated.has(runtime.runtimeId) && runtime.pendingRequests.some((request) => !this.settled.has(this.requestKey(request)) && !this.answering.has(this.requestKey(request))))
      .map(({ runtimeId, cwd }) => ({ runtimeId, cwd }))
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
  private requestKey(request: ComputerUsePermissionRequest) { return `${request.runtimeId}:${request.generation}:${request.requestId}` }
  isEnabled = () => this.globalEnabled
  /** Settings switch. Turning it off takes back every runtime immediately. */
  setGlobalEnabled = (enabled: boolean) => {
    if (this.globalEnabled === enabled) return
    this.globalEnabled = enabled
    this.publish({ error: null })
    if (!enabled) void this.takeBack()
  }
  registerRuntime = (runtimeId: string, conversationKey: string) => { this.runtimeOwners.set(runtimeId, conversationKey) }
  selectView = (conversationKey: string, runtimeId: string | null) => {
    if (this.snapshot.conversationKey === conversationKey && this.snapshot.runtimeId === runtimeId) return
    if (runtimeId) this.registerRuntime(runtimeId, conversationKey)
    this.catalogOperation++
    this.publish({ conversationKey, runtimeId, viewEpoch: this.snapshot.viewEpoch + 1, apps: [], error: null, ...(this.snapshot.busy === "apps" ? { busy: null } : {}) })
    void this.refresh()
  }
  acceptStatus = (status: ComputerUseStatus) => {
    const staleGlobal = !!this.snapshot.status && status.revision < this.snapshot.status.revision
    this.revision++
    const runtime = status.runtime
    if (runtime && status.revision >= (this.runtimeRevisions.get(runtime.runtimeId) ?? -1)
      && !this.retired.has(runtime.runtimeId) && this.isRuntimeAlive(runtime.runtimeId)) {
      const old = this.runtimes.get(runtime.runtimeId)
      const floor = this.invalidated.get(runtime.runtimeId)
      if ((!old || runtime.generation >= old.generation) && (floor === undefined || (runtime.generation > floor && !runtime.enabled))) {
        this.runtimes.set(runtime.runtimeId, runtime)
        this.runtimeRevisions.set(runtime.runtimeId, status.revision)
        if (floor !== undefined) this.invalidated.set(runtime.runtimeId, runtime.generation)
      }
    }
    // Replies for different runtimes can arrive out of order. Keep their own
    // projections current without rolling back the global driver/controller.
    if (staleGlobal) this.publish()
    else {
      const controller = status.controller && !this.retired.has(status.controller.runtimeId) && !this.invalidated.has(status.controller.runtimeId)
        ? status.controller : null
      this.publish({ status: { ...status, controller } })
    }
    if (!this.globalEnabled && runtime?.enabled && !this.retired.has(runtime.runtimeId)
      && ![...this.revocations].some((work) => !work.runtimeId || work.runtimeId === runtime.runtimeId)) {
      void this.takeBack(runtime.runtimeId)
    }
  }
  acceptRequest = (request: ComputerUsePermissionRequest) => {
    if (this.retired.has(request.runtimeId) || !this.isRuntimeAlive(request.runtimeId) || this.settled.has(this.requestKey(request))) return
    const runtime = this.runtimes.get(request.runtimeId)
    if (!runtime?.enabled || runtime.generation !== request.generation || this.invalidated.has(request.runtimeId)) return
    if (!runtime.pendingRequests.some((pending) => this.requestKey(pending) === this.requestKey(request))) {
      this.runtimes.set(request.runtimeId, { ...runtime, state: "requested", pendingRequests: [...runtime.pendingRequests, request] })
    }
    this.publish()
  }
  private acceptMutationStatus(status: ComputerUseStatus) {
    this.acceptStatus(status)
    // Commands can settle after the user changed views. Refresh that view's
    // projection without treating an unrelated command reply as its query.
    if (this.snapshot.runtimeId && status.runtime?.runtimeId !== this.snapshot.runtimeId) void this.refresh()
  }
  refresh = async () => {
    const revision = this.revision
    const cancellation = this.cancellation
    const viewEpoch = this.snapshot.viewEpoch
    const runtimeId = this.snapshot.runtimeId ?? undefined
    try {
      const status = await this.api.status(runtimeId)
      if (cancellation !== this.cancellation || viewEpoch !== this.snapshot.viewEpoch) return
      this.acceptStatus(status)
    } catch (error) { if (revision === this.revision && viewEpoch === this.snapshot.viewEpoch) this.publish({ error: String(error) }) }
  }
  /** A new user turn restores on-demand access that an earlier stop or take-back revoked. */
  resumeRuntime = async (runtimeId: string) => {
    const epoch = this.resumeEpochs.get(runtimeId) ?? 0
    const current = () => this.globalEnabled && !this.retired.has(runtimeId) && this.isRuntimeAlive(runtimeId)
      && (this.resumeEpochs.get(runtimeId) ?? 0) === epoch
    if (!current()) return
    const previous = this.resuming.get(runtimeId)
    if (previous) {
      if (previous.epoch === epoch) return previous.promise
      await previous.promise
    }
    const barriers = [...this.revocations].filter((work) => !work.runtimeId || work.runtimeId === runtimeId)
    if (barriers.length) await Promise.all(barriers.map((work) => work.promise))
    const runtime = this.runtimes.get(runtimeId)
    if (!current() || !runtime || runtime.enabled) return
    // Another caller may have recovered this runtime while the barrier settled.
    const pending = this.resuming.get(runtimeId)
    if (pending) return pending.promise
    const promise = (async () => {
      try {
        const status = await this.api.setEnabled(runtimeId, true)
        if (!current()) {
          // Ignoring a reply only hides it in the UI. Undo the native enable as
          // well, before a subsequent turn can recover this runtime again.
          await this.revokeNative(runtimeId)
          return
        }
        this.invalidated.delete(runtimeId)
        this.acceptMutationStatus(status)
      } catch {
        // Ordinary conversation remains available if computer tools cannot resume.
      }
    })()
    this.resuming.set(runtimeId, { epoch, promise })
    try { await promise }
    finally { if (this.resuming.get(runtimeId)?.promise === promise) this.resuming.delete(runtimeId) }
  }
  /** Synchronous barrier used before stop, disconnect and asynchronous cleanup. */
  invalidateRuntime = (runtimeId: string, retire = false) => {
    this.revision++
    this.cancellation++
    this.resumeEpochs.set(runtimeId, (this.resumeEpochs.get(runtimeId) ?? 0) + 1)
    const runtime = this.runtimes.get(runtimeId)
    this.invalidated.set(runtimeId, runtime?.generation ?? -1)
    if (retire) {
      this.retired.add(runtimeId)
      this.runtimeOwners.delete(runtimeId)
      for (const key of this.settled) if (key.startsWith(`${runtimeId}:`)) this.settled.delete(key)
      // Live ownership is checked independently; keep only bounded late-event tombstones.
      while (this.retired.size > 256) {
        const oldest = this.retired.values().next().value!
        this.retired.delete(oldest)
        this.invalidated.delete(oldest)
        this.runtimes.delete(oldest)
        this.runtimeRevisions.delete(oldest)
        this.resumeEpochs.delete(oldest)
      }
    }
    if (runtime) this.runtimes.set(runtimeId, { ...runtime, enabled: false, state: "revoked", apps: [], pendingRequests: [], reason: "电脑访问已收回" })
    const status = this.snapshot.status
    this.publish({ apps: [], ...(status ? { status: { ...status, controller: status.controller?.runtimeId === runtimeId ? null : status.controller } } : {}) })
  }
  takeBack = async (runtimeId?: string) => {
    const target = runtimeId ?? this.snapshot.status?.controller?.runtimeId
    if (target) this.invalidateRuntime(target)
    if (!runtimeId) for (const id of new Set([...this.runtimes.keys(), ...this.resuming.keys()])) this.invalidateRuntime(id)
    await this.revokeNative(runtimeId)
  }
  private revokeNative = async (runtimeId?: string) => {
    const status = this.snapshot.status
    this.publish({ error: null, ...(status ? { status: { ...status, cleanup: { state: "stopping", reason: null } } } : {}) })
    const promise = (async () => {
      try { this.acceptMutationStatus(await this.api.takeBack(runtimeId)) }
      catch (error) {
        const currentStatus = this.snapshot.status
        this.publish({ error: String(error), ...(currentStatus ? { status: { ...currentStatus, cleanup: { state: "failed", reason: "未能确认电脑访问已收回，请重试。" } } } : {}) })
      }
    })()
    const work = { runtimeId, promise }
    this.revocations.add(work)
    try { await promise }
    finally { this.revocations.delete(work) }
  }
  /** Withdraw one approved window; other grants and control stay intact. */
  revokeApp = async (appId: string) => {
    const { runtimeId, viewEpoch } = this.snapshot
    if (!runtimeId || !this.snapshot.runtime?.apps.some((app) => app.appId === appId)) return
    this.publish({ error: null })
    try { this.acceptMutationStatus(await this.api.revokeApp(runtimeId, appId)) }
    catch (error) { if (this.snapshot.viewEpoch === viewEpoch) this.publish({ error: String(error) }) }
  }
  loadApps = async () => {
    const { runtimeId, viewEpoch, runtime } = this.snapshot
    if (!runtimeId || !runtime?.enabled) return
    const operation = ++this.catalogOperation
    this.publish({ busy: "apps", error: null })
    try {
      const apps = await this.api.listApps(runtimeId)
      if (this.snapshot.viewEpoch === viewEpoch && !this.invalidated.has(runtimeId) && this.isRuntimeAlive(runtimeId)) this.publish({ apps })
    } catch (error) { if (this.snapshot.viewEpoch === viewEpoch) this.publish({ error: String(error) }) }
    finally { if (operation === this.catalogOperation) this.publish({ busy: null }) }
  }
  requestApp = async (appId: string) => {
    const { runtimeId, viewEpoch } = this.snapshot
    if (!runtimeId || !this.snapshot.runtime?.enabled) return
    this.publish({ error: null })
    try {
      const request = await this.api.requestApp(runtimeId, appId)
      if (this.snapshot.viewEpoch === viewEpoch) this.acceptRequest(request)
    } catch (error) { if (this.snapshot.viewEpoch === viewEpoch) this.publish({ error: String(error) }) }
  }
  canRespond = (request: ComputerUsePermissionRequest, viewEpoch: number) => {
    const current = this.snapshot
    return current.viewEpoch === viewEpoch && current.runtimeId === request.runtimeId && this.isRuntimeAlive(request.runtimeId)
      && this.isViewCurrent(current.conversationKey, request.runtimeId)
      && this.globalEnabled
      && !this.retired.has(request.runtimeId) && !this.invalidated.has(request.runtimeId)
      && current.runtime?.generation === request.generation && current.runtime.enabled
      && !this.settled.has(this.requestKey(request)) && !this.answering.has(this.requestKey(request))
      && current.runtime.pendingRequests.some((pending) => this.requestKey(pending) === this.requestKey(request))
  }
  respond = async (request: ComputerUsePermissionRequest, allow: boolean, viewEpoch: number) => {
    if (!this.canRespond(request, viewEpoch)) return
    const key = this.requestKey(request)
    this.answering.add(key)
    this.publish({ error: null })
    try {
      const status = await this.api.respond(request.runtimeId, request.requestId, allow)
      this.settled.add(key)
      this.acceptMutationStatus(status)
    } catch (error) {
      if (this.snapshot.viewEpoch === viewEpoch && !this.invalidated.has(request.runtimeId) && this.isRuntimeAlive(request.runtimeId)) this.publish({ error: String(error) })
    } finally { this.answering.delete(key); this.publish() }
  }
  configureDriver = async (path?: string) => {
    if (this.snapshot.busy) return
    // Replacing driver evidence retires all local permission callbacks immediately.
    for (const id of this.runtimes.keys()) this.invalidateRuntime(id)
    this.publish({ busy: "driver", error: null })
    try { this.acceptMutationStatus(await (path === undefined ? this.api.install() : this.api.setPath(path))) }
    catch (error) { this.publish({ error: String(error) }) }
    finally { this.publish({ busy: null }) }
  }
  setForegroundKeys = async (enabled: boolean) => {
    if (this.snapshot.busy) return
    if (!enabled && this.snapshot.status?.controller) this.invalidateRuntime(this.snapshot.status.controller.runtimeId)
    this.publish({ busy: "foreground-keys", error: null })
    const promise = (async () => {
      try { this.acceptMutationStatus(await this.api.setForegroundKeys(enabled)) }
      catch (error) { this.publish({ error: String(error) }); void this.refresh() }
    })()
    // A new user turn must wait for the native revoke before restoring access.
    const barrier = { promise }
    if (!enabled) this.revocations.add(barrier)
    try { await promise }
    finally { this.revocations.delete(barrier); this.publish({ busy: null }) }
  }
}

export const computerUse = new ComputerUseController({ status: ipc.computerUseStatus, setEnabled: ipc.computerUseSetEnabled, listApps: ipc.computerUseListApps,
  setForegroundKeys: ipc.computerUseSetForegroundKeys,
  requestApp: ipc.computerUseRequestApp, respond: ipc.computerUseRespond, revokeApp: ipc.computerUseRevokeApp, takeBack: ipc.computerUseTakeBack, install: ipc.computerUseInstallDriver, setPath: ipc.computerUseSetDriverPath })

const syncSetting = () => computerUse.setGlobalEnabled(loadSettings().computerUseEnabled === true)
syncSetting()
subscribeSettingsBus("settings", syncSetting)

export const computerUseTierLabel = (tier: ipc.ComputerUseTier) => ({ view: "仅查看", click: "查看和点击", full: "完整控制" })[tier]
