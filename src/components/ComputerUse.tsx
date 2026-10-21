import { useRef, useState } from "react"
import { toast } from "sonner"
import { open } from "@tauri-apps/plugin-dialog"
import { ChevronDown, ChevronRight, Download, FolderOpen, Hand, Loader2, Monitor, RefreshCw, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { computerUse, computerUseStateLabel, computerUseTierLabel, type ComputerUseSnapshot } from "@/lib/computerUse"
import { useComputerUseSnapshot } from "@/hooks/useComputerUse"
import type { ComputerUsePermissionRequest } from "@/lib/ipc"

const BACKGROUND_CONTROL_LIMITATION = "初版使用后台控制，权限级别仅代表授权上限；无法可靠执行或结束后台输入时，相关操作会被拒绝。"

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
      <div className="flex items-center gap-2 font-medium"><Monitor className="size-4" />Windows 电脑使用</div>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void computerUse.refresh() }} aria-label="检查电脑使用状态"><RefreshCw className="size-3.5" /></Button>
    </div>
    <div role="status" className="text-muted-foreground">
      {!driver ? "正在检查可用性…" : !driver.supported ? "此系统暂不支持电脑使用" : driver.state === "ready" ? `CuaDriver ${driver.version ?? ""} · 已就绪${driver.managed ? " · 应用管理" : " · 本地文件"}` : driver.state === "checking" ? "正在验证 CuaDriver…" : driver.state === "notInstalled" ? "尚未安装 CuaDriver" : "CuaDriver 暂不可用"}
    </div>
    {driver?.reason && <div className="break-words text-muted-foreground">{driver.reason}</div>}
    {driver?.path && <div className="break-all text-muted-foreground">{driver.path}</div>}
    <p className="text-muted-foreground">安装经校验的固定版本 CuaDriver（0.37.0 预发布版），或选择兼容的本地文件。安装后仍需在每个对话中开启，并逐个授权应用。</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!driver?.supported || busy} onClick={() => { void computerUse.configureDriver() }}>
        {snapshot.busy === "driver" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}{snapshot.busy === "driver" ? "正在安装或验证…" : "安装固定版本"}
      </Button>
      <Button size="sm" variant="outline" disabled={!driver?.supported || busy} onClick={() => { void choosePath() }}><FolderOpen className="size-3.5" />选择本地文件</Button>
    </div>
    {snapshot.error && <div role="alert" className="break-words text-destructive">{snapshot.error}</div>}
    <p className="text-muted-foreground">更换驱动会收回现有电脑访问。应用授权仅在当前会话有效。</p>
    <p className="text-muted-foreground">{BACKGROUND_CONTROL_LIMITATION}</p>
  </div>
}

export interface ComputerUseImageSupport { provider: string; model: string; transport: "anthropic" | "openai-chat-completions" }
export function ComputerUseImageStatus({ support }: { support: ComputerUseImageSupport }) {
  return <div className="space-y-1 text-muted-foreground">
    <div>{support.provider}{support.model ? ` · ${support.model}` : " · 模型由会话确定"}</div>
    <div>截图传输：{support.transport === "openai-chat-completions" ? "OpenAI Chat 图像转换；不兼容的图像会显示错误" : "Anthropic 格式透传"}</div>
    <div>模型图像理解能力：未验证。驱动就绪仅表示本地应用访问可用。</div>
  </div>
}
export function ComputerUseControl({ snapshot, conversationKey, runtimeId, imageSupport }: { snapshot: ComputerUseSnapshot; conversationKey: string; runtimeId: string | null; imageSupport?: ComputerUseImageSupport }) {
  const [expanded, setExpanded] = useState(false)
  const [setup, setSetup] = useState(false)
  const [catalogRequested, setCatalogRequested] = useState(false)
  // A render between view selection and the effect must not expose the old chat's choice or grants.
  const matches = snapshot.conversationKey === conversationKey && snapshot.runtimeId === runtimeId
  const selected = matches ? snapshot.selected : computerUse.getChoice(conversationKey)
  const runtime = matches ? snapshot.runtime : null
  const driver = snapshot.status?.driver
  const ready = driver?.supported && driver.state === "ready"
  return <div className="rounded-lg border bg-card/95 text-xs">
    <div className="flex h-9 items-center gap-2 px-3">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-muted-foreground hover:text-foreground">
        {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}<Monitor className="size-3.5 shrink-0" />电脑使用
        <span className="truncate">· {ready ? computerUseStateLabel(runtime, selected) : driver?.supported === false ? "此系统暂不支持" : "需要设置"}</span>
      </button>
      <Switch aria-label="为此对话开启电脑使用" checked={runtime ? runtime.enabled : selected} disabled={!ready || !!snapshot.busy || !matches}
        onCheckedChange={(enabled) => { void computerUse.setChoice(conversationKey, runtimeId, enabled); if (enabled) setExpanded(true) }} />
    </div>
    {expanded && <div className="space-y-3 border-t px-3 py-3">
      <div className="text-muted-foreground">只允许此对话使用你授权的应用。浏览器仅可查看；终端和代码编辑器仅可查看和点击。优先使用现有连接器与浏览器工具。</div>
      <div className="text-muted-foreground">{BACKGROUND_CONTROL_LIMITATION}</div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setSetup(true)}>驱动设置</Button>
        <Button size="sm" variant="outline" disabled={!ready || !runtime?.enabled || !!snapshot.busy} onClick={() => { setCatalogRequested(true); void computerUse.loadApps() }}>
          <RefreshCw className={`size-3 ${snapshot.busy === "apps" ? "animate-spin" : ""}`} />选择应用
        </Button>
        {runtime?.enabled && <Button size="sm" variant="ghost" onClick={() => { void computerUse.takeBack(runtime.runtimeId) }}><Hand className="size-3" />收回访问</Button>}
      </div>
      {!runtimeId && selected && <div className="text-muted-foreground">已为此对话选择。发送消息后可以授权具体应用。</div>}
      {imageSupport && <ComputerUseImageStatus support={imageSupport} />}
      {runtime?.reason && <div className="break-words text-muted-foreground">{runtime.reason}</div>}
      {!!runtime?.apps.length && <div className="space-y-1"><div className="text-muted-foreground">此会话已授权</div>{runtime.apps.map((app) => <div key={app.appId} className="flex items-center gap-2"><ShieldCheck className="size-3.5 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate" title={app.title || app.path}>{app.name}</span><span className="shrink-0 text-muted-foreground">{computerUseTierLabel(app.tier)}</span>
        <Button size="sm" variant="ghost" className="h-6 px-2" disabled={!!snapshot.busy} aria-label={`收回 ${app.name} 的访问`} onClick={() => { void computerUse.revokeApp(app.appId) }}>收回</Button></div>)}</div>}
      {matches && !!snapshot.apps.length && <ScrollArea className="max-h-48" viewportClassName="max-h-48"><div className="space-y-1">{snapshot.apps.map((app) => { const granted = !!runtime?.apps.some((approved) => approved.appId === app.appId)
        return <button key={app.appId} type="button" className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent disabled:opacity-50" disabled={granted || !runtime?.enabled || !!snapshot.pending} onClick={() => { void computerUse.requestApp(app.appId) }}><div className="min-w-0 flex-1"><div className="truncate">{app.name}</div><div className="truncate text-muted-foreground">{app.title || app.path}</div></div><span className="shrink-0 text-muted-foreground">{granted ? "已授权" : computerUseTierLabel(app.tier)}</span></button> })}</div></ScrollArea>}
      {catalogRequested && matches && runtime?.enabled && !snapshot.busy && !snapshot.error && !snapshot.apps.length && <div className="text-muted-foreground">当前没有可授权的应用窗口。打开目标应用后重新选择。</div>}
      {matches && snapshot.error && <div role="alert" className="break-words text-destructive">{snapshot.error}</div>}
    </div>}
    <Dialog open={setup} onOpenChange={setSetup}><DialogContent><DialogHeader><DialogTitle>设置电脑使用</DialogTitle><DialogDescription>Windows 应用访问由你逐个授权。</DialogDescription></DialogHeader><ComputerUseDriverSetup /></DialogContent></Dialog>
  </div>
}

export function ComputerUseControllerStrip({ snapshot, controllerLabel, onShowController, onShowRuntime }: { snapshot: ComputerUseSnapshot; controllerLabel: string | null; onShowController?: () => void; onShowRuntime?: (runtimeId: string) => void }) {
  const status = snapshot.status
  if (!status?.controller && status?.cleanup.state !== "stopping" && status?.cleanup.state !== "failed" && !snapshot.waiting.length) return null
  return <div role="status" className="flex shrink-0 items-center gap-3 border-b bg-primary/10 px-4 py-2 text-xs">
    <Monitor className="size-4 shrink-0 text-primary" />
    <div className="min-w-0 flex-1"><div className="font-medium">{status?.cleanup.state === "stopping" ? "正在收回电脑访问…" : status?.cleanup.state === "failed" ? "电脑访问清理需要重试" : status?.controller ? snapshot.controllerState === "active" ? "Claude 正在使用电脑" : "此对话持有电脑控制权" : "另一个对话正在等待应用授权"}</div>
      {status?.controller && <button type="button" onClick={onShowController} disabled={!onShowController} className="block max-w-full truncate text-left text-muted-foreground hover:underline">{controllerLabel ?? status.controller.cwd}{snapshot.runtimeId !== status.controller.runtimeId ? " · 另一个对话" : " · 当前对话"}</button>}
      {status?.cleanup.reason && <div className="break-words text-muted-foreground">{status.cleanup.reason}</div>}
      {snapshot.waiting.map((waiting) => <button key={waiting.runtimeId} type="button" onClick={() => onShowRuntime?.(waiting.runtimeId)} disabled={!onShowRuntime} className="block max-w-full truncate text-left text-muted-foreground hover:underline">{waiting.cwd} · 等待应用授权</button>)}
    </div>
    <Button size="sm" variant="outline" onClick={() => { void computerUse.takeBack() }}><Hand className="size-3.5" />{status?.controller ? "立即收回控制" : "收回电脑访问"}</Button>
  </div>
}

export function ComputerUsePermissionDialog({ request, viewEpoch }: { request: ComputerUsePermissionRequest; viewEpoch: number }) {
  const container = useRef<HTMLDivElement | null>(null)
  const deny = () => { void computerUse.respond(request, false, viewEpoch) }
  return <Dialog open onOpenChange={(open) => { if (!open) deny() }}>
    <DialogContent ref={container} tabIndex={-1} className="grid max-h-[85vh] w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden" onOpenAutoFocus={(event) => { event.preventDefault(); container.current?.focus({ preventScroll: true }) }}
      onEscapeKeyDown={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()} onPointerDownOutside={(event) => event.preventDefault()}>
      <DialogHeader className="min-w-0 pr-6"><DialogTitle className="flex items-start gap-2"><Monitor className="size-5 shrink-0" /><span className="line-clamp-2 break-words">允许此对话访问 {request.app.name}？</span></DialogTitle><DialogDescription>仅在当前会话有效。你随时可以收回电脑访问。</DialogDescription></DialogHeader>
      <ScrollArea className="min-h-0 overflow-hidden"><div className="space-y-2 rounded-md border bg-muted/40 p-3 text-xs"><div className="break-words font-medium">{request.app.name} · {computerUseTierLabel(request.tier)}</div><div className="text-muted-foreground">{request.tier === "view" ? "可以查看此应用，不能点击或输入。" : request.tier === "click" ? "可以查看和点击此应用，不能输入文字或按键。" : "可以查看、点击并向此应用输入内容。"}</div><div className="break-all text-muted-foreground">{request.app.path}</div>{request.app.title && <div className="break-words text-muted-foreground">窗口：{request.app.title}</div>}{request.reason && <div className="break-words">{request.reason}</div>}</div></ScrollArea>
      <DialogFooter className="shrink-0"><Button variant="ghost" onClick={deny}>取消</Button><Button variant="outline" onClick={deny}>不允许</Button><Button onClick={() => { void computerUse.respond(request, true, viewEpoch) }}>允许此会话</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
