import { useRef } from "react"
import { toast } from "sonner"
import { open } from "@tauri-apps/plugin-dialog"
import { Download, FolderOpen, Hand, Loader2, Monitor, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { computerUse, computerUseTierLabel, type ComputerUseSnapshot } from "@/lib/computerUse"
import { useComputerUseSnapshot } from "@/hooks/useComputerUse"
import type { ComputerUsePermissionRequest, ComputerUseStatus } from "@/lib/ipc"
import { loadSettings, saveSettings } from "@/lib/settings"

function driverSummary(driver: ComputerUseStatus["driver"] | undefined) {
  if (!driver) return "正在检查…"
  if (!driver.supported) return "仅支持 Windows"
  return ({ ready: `CuaDriver ${driver.version ?? ""} · 已就绪`, checking: "正在验证 CuaDriver…", notInstalled: "未安装 CuaDriver", error: "CuaDriver 不可用", unavailable: "不可用" })[driver.state]
}

/** App-level switch: new conversations get on-demand tools; each app still needs consent. */
export function ComputerUseEnableSwitch({ snapshot }: { snapshot: ComputerUseSnapshot }) {
  const driver = snapshot.status?.driver
  const ready = !!driver?.supported && driver.state === "ready"
  return <div className="flex items-center justify-between gap-4">
    <div>
      <Label htmlFor="computer-use-enabled" className="text-sm">允许 Claude 按需使用电脑</Label>
      <div className="mt-0.5 text-xs text-muted-foreground">{ready || snapshot.selected ? "新会话生效，每个应用首次使用时需你确认。" : "请先安装 CuaDriver。"}</div>
    </div>
    <Switch id="computer-use-enabled" checked={snapshot.selected} disabled={!snapshot.selected && !ready}
      onCheckedChange={(enabled) => saveSettings({ ...loadSettings(), computerUseEnabled: enabled })} />
  </div>
}

export function ComputerUseDriverSetup() {
  const snapshot = useComputerUseSnapshot()
  const driver = snapshot.status?.driver
  const busy = !!snapshot.busy || driver?.state === "checking"
  const choosePath = async () => {
    try {
      const path = await open({ title: "选择 CuaDriver", multiple: false, directory: false, filters: [{ name: "CuaDriver", extensions: ["exe"] }] })
      if (typeof path === "string") await computerUse.configureDriver(path)
    } catch (error) { toast.error(`无法选择 CuaDriver：${String(error)}`) }
  }
  return <div className="space-y-3 text-xs">
    <div className="flex items-center justify-between gap-3">
      <div role="status" className="text-sm">{driverSummary(driver)}</div>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void computerUse.refresh() }} aria-label="刷新状态"><RefreshCw className="size-3.5" /></Button>
    </div>
    {driver?.path && <div className="break-all font-mono text-muted-foreground" title={driver.path}>{driver.path}</div>}
    {driver?.reason && <div className="break-words text-muted-foreground">{driver.reason}</div>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!driver?.supported || busy} onClick={() => { void computerUse.configureDriver() }}>
        {snapshot.busy === "driver" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        {snapshot.busy === "driver" ? "正在安装…" : driver?.state === "ready" && driver.managed ? "重新安装" : "安装"}
      </Button>
      <Button size="sm" variant="outline" disabled={!driver?.supported || busy} onClick={() => { void choosePath() }}><FolderOpen className="size-3.5" />选择本地文件</Button>
    </div>
    {snapshot.error && <div role="alert" className="break-words text-destructive">{snapshot.error}</div>}
  </div>
}

export function ComputerUseControllerStrip({ snapshot, controllerLabel, onShowController, onShowRuntime }: { snapshot: ComputerUseSnapshot; controllerLabel: string | null; onShowController?: () => void; onShowRuntime?: (runtimeId: string) => void }) {
  const status = snapshot.status
  if (!status?.controller && status?.cleanup.state !== "stopping" && status?.cleanup.state !== "failed" && !snapshot.waiting.length) return null
  const current = !!status?.controller && snapshot.runtimeId === status.controller.runtimeId
  const apps = current ? snapshot.runtime?.apps ?? [] : []
  const title = status?.cleanup.state === "stopping" ? "正在收回电脑访问…" : status?.cleanup.state === "failed" ? "电脑访问清理失败，请重试" : status?.controller ? snapshot.controllerState === "active" ? "Claude 正在使用电脑" : "Claude 可使用已授权应用" : "另一个对话正在等待应用授权"
  return <div role="status" className="flex shrink-0 items-center gap-3 border-b bg-primary/10 px-4 py-2 text-xs">
    <Monitor className="size-4 shrink-0 text-primary" />
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium">{title}</span>
      {status?.controller && <button type="button" onClick={onShowController} disabled={!onShowController} className="max-w-full truncate text-muted-foreground hover:underline disabled:no-underline">
        {controllerLabel ?? status.controller.cwd}{current ? "" : " · 另一个对话"}
      </button>}
      {apps.map((app) => <span key={app.appId} className="inline-flex items-center gap-1 rounded-full border bg-background/70 py-0.5 pr-1 pl-2" title={`${app.title || app.path} · ${computerUseTierLabel(app.tier)}`}>
        <span className="max-w-40 truncate">{app.name}</span>
        <button type="button" aria-label={`收回 ${app.name} 的访问`} className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => { void computerUse.revokeApp(app.appId) }}><X className="size-3" /></button>
      </span>)}
      {snapshot.waiting.map((waiting) => <button key={waiting.runtimeId} type="button" onClick={() => onShowRuntime?.(waiting.runtimeId)} disabled={!onShowRuntime} className="max-w-full truncate text-muted-foreground hover:underline">{waiting.cwd}</button>)}
    </div>
    <Button size="sm" variant="outline" onClick={() => { void computerUse.takeBack() }}><Hand className="size-3.5" />收回控制</Button>
  </div>
}

const TIER_ABILITY = { view: "仅可查看", click: "可查看和点击", full: "可查看、点击和输入" } as const

export function ComputerUsePermissionDialog({ request, viewEpoch }: { request: ComputerUsePermissionRequest; viewEpoch: number }) {
  const container = useRef<HTMLDivElement | null>(null)
  const deny = () => { void computerUse.respond(request, false, viewEpoch) }
  return <Dialog open onOpenChange={(open) => { if (!open) deny() }}>
    <DialogContent ref={container} tabIndex={-1} className="w-[calc(100%-2rem)] max-w-md" onOpenAutoFocus={(event) => { event.preventDefault(); container.current?.focus({ preventScroll: true }) }}
      onEscapeKeyDown={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()} onPointerDownOutside={(event) => event.preventDefault()}>
      <DialogHeader className="min-w-0 pr-6">
        <DialogTitle className="flex items-start gap-2"><Monitor className="size-5 shrink-0" /><span className="line-clamp-2 break-words">允许 Claude 使用 {request.app.name}？</span></DialogTitle>
        <DialogDescription>{TIER_ABILITY[request.tier]}，仅限本次会话。</DialogDescription>
      </DialogHeader>
      <div className="min-w-0 space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {request.app.title && <div className="truncate" title={request.app.title}>{request.app.title}</div>}
        <div className="break-all font-mono">{request.app.path}</div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={deny}>不允许</Button>
        <Button onClick={() => { void computerUse.respond(request, true, viewEpoch) }}>允许</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
