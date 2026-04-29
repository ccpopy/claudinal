import { useState } from "react"
import { Eye, EyeOff, Network as NetworkIcon, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import {
  describeProxy,
  formatProxyUrl,
  loadProxy,
  saveProxy,
  type ProxyConfig,
  type ProxyProtocol
} from "@/lib/proxy"

const PROTOCOLS: ProxyProtocol[] = ["http", "https", "socks5", "socks5h"]

export function Network() {
  const [config, setConfig] = useState<ProxyConfig>(() => loadProxy())
  const [showPassword, setShowPassword] = useState(false)
  const [dirty, setDirty] = useState(false)

  const update = (patch: Partial<ProxyConfig>) => {
    setConfig((c) => ({ ...c, ...patch }))
    setDirty(true)
  }

  const save = () => {
    saveProxy(config)
    setDirty(false)
    toast.success("代理配置已保存，下次启动会话生效")
  }

  const previewUrl =
    config.host && config.port ? formatProxyUrl(config) : "（host:port 未填写）"

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <NetworkIcon className="size-5" />
          网络代理
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          为 claude CLI 子进程注入 <code className="font-mono text-xs">HTTP_PROXY</code> /{" "}
          <code className="font-mono text-xs">HTTPS_PROXY</code> /{" "}
          <code className="font-mono text-xs">ALL_PROXY</code> /{" "}
          <code className="font-mono text-xs">NO_PROXY</code> 环境变量。修改后下次启动会话生效（已运行的会话不受影响）。
        </p>
      </div>

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <ToggleRow
          label="启用代理"
          checked={config.enabled}
          onChange={(v) => update({ enabled: v })}
        />

        <Separator />

        <Row label="协议">
          <select
            value={config.protocol}
            onChange={(e) => update({ protocol: e.target.value as ProxyProtocol })}
            disabled={!config.enabled}
            className={cn(
              "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
              "font-mono"
            )}
          >
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground ml-2">
            socks5h 由代理服务器解析 DNS
          </span>
        </Row>

        <Row label="主机">
          <Input
            value={config.host}
            onChange={(e) => update({ host: e.target.value })}
            placeholder="127.0.0.1"
            disabled={!config.enabled}
            className="font-mono text-xs flex-1"
          />
        </Row>

        <Row label="端口">
          <Input
            value={config.port}
            onChange={(e) => update({ port: e.target.value.replace(/\D/g, "") })}
            placeholder="7890"
            disabled={!config.enabled}
            className="font-mono text-xs w-32"
            inputMode="numeric"
          />
        </Row>

        <Separator />

        <div className="text-xs text-muted-foreground">
          认证（可选）
        </div>

        <Row label="用户名">
          <Input
            value={config.username}
            onChange={(e) => update({ username: e.target.value })}
            placeholder=""
            disabled={!config.enabled}
            className="font-mono text-xs flex-1"
            autoComplete="off"
          />
        </Row>

        <Row label="密码">
          <div className="flex flex-1 gap-1">
            <Input
              type={showPassword ? "text" : "password"}
              value={config.password}
              onChange={(e) => update({ password: e.target.value })}
              placeholder=""
              disabled={!config.enabled}
              className="font-mono text-xs flex-1"
              autoComplete="off"
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              disabled={!config.enabled}
            >
              {showPassword ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        </Row>

        <Separator />

        <div className="space-y-1.5">
          <Label className="text-xs">不走代理（NO_PROXY）</Label>
          <textarea
            value={config.noProxy}
            onChange={(e) => update({ noProxy: e.target.value })}
            placeholder="localhost,127.0.0.1,::1"
            disabled={!config.enabled}
            rows={2}
            className={cn(
              "flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 resize-none scrollbar-thin"
            )}
          />
          <p className="text-[11px] text-muted-foreground">
            英文逗号分隔；支持 CIDR、域名后缀。
          </p>
        </div>
      </section>

      <section className="rounded-lg border bg-muted/40 p-4 space-y-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          当前预览
        </div>
        <div className="font-mono text-sm break-all">
          {config.enabled ? previewUrl : "未启用"}
        </div>
        <div className="text-xs text-muted-foreground">
          状态：{describeProxy(config)}
        </div>
      </section>

      <div className="sticky bottom-0 bg-background pt-4 pb-2 flex items-center gap-2 border-t -mx-8 px-8">
        <Button onClick={save} disabled={!dirty}>
          <Save />
          保存
        </Button>
        {dirty && (
          <span className="text-xs text-warn">有未保存的修改</span>
        )}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <Label className="w-16 text-xs shrink-0">{label}</Label>
      {children}
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm">{label}</Label>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
          checked ? "bg-primary" : "bg-muted"
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-block size-4 rounded-full bg-background shadow ring-0 transition-transform",
            checked ? "translate-x-4" : "translate-x-0"
          )}
        />
      </button>
    </div>
  )
}
