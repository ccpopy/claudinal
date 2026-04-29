import { useState } from "react"
import { Network as NetworkIcon, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  describeProxy,
  formatProxyUrl,
  loadProxy,
  saveProxy,
  DEFAULT_PROXY,
  type ProxyConfig,
  type ProxyProtocol
} from "@/lib/proxy"

const PROTOCOL_OPTIONS: Array<{ value: ProxyProtocol; label: string }> = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "socks5", label: "SOCKS5" },
  { value: "socks5h", label: "SOCKS5h" }
]

export function Network() {
  const [config, setConfig] = useState<ProxyConfig>(() => loadProxy())
  const [dirty, setDirty] = useState(false)

  const update = (patch: Partial<ProxyConfig>) => {
    setConfig((c) => ({ ...c, ...patch }))
    setDirty(true)
  }

  const save = () => {
    saveProxy(config)
    setDirty(false)
    toast.success("已保存")
  }

  const previewUrl =
    config.host && config.port ? formatProxyUrl(config) : "—"

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <NetworkIcon className="size-5" />
          网络代理
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          给 Claude CLI 设置网络代理，修改后下次启动会话后生效。
        </p>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 pb-6 max-w-3xl space-y-6">
          <section className="space-y-4 rounded-lg border bg-card p-5">
            <div className="flex items-center justify-between">
              <Label htmlFor="proxy-enabled" className="text-sm">
                启用代理
              </Label>
              <Switch
                id="proxy-enabled"
                checked={config.enabled}
                onCheckedChange={(v) => update({ enabled: v })}
              />
            </div>

            <Separator />

            <Row label="协议">
              <Select
                value={config.protocol}
                onChange={(e) =>
                  update({ protocol: e.target.value as ProxyProtocol })
                }
                disabled={!config.enabled}
                options={PROTOCOL_OPTIONS}
                className="font-mono"
                triggerClassName="max-w-[260px]"
              />
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
                onChange={(e) =>
                  update({ port: e.target.value.replace(/\D/g, "") })
                }
                placeholder="7890"
                disabled={!config.enabled}
                className="font-mono text-xs w-32"
                inputMode="numeric"
              />
            </Row>

            <Separator />

            <Row label="用户名">
              <Input
                value={config.username}
                onChange={(e) => update({ username: e.target.value })}
                disabled={!config.enabled}
                className="font-mono text-xs flex-1"
                autoComplete="off"
              />
            </Row>

            <Row label="密码">
              <Input
                type="password"
                value={config.password}
                onChange={(e) => update({ password: e.target.value })}
                disabled={!config.enabled}
                className="font-mono text-xs flex-1"
                autoComplete="off"
              />
            </Row>

            <Separator />

            <div className="space-y-2">
              <Label className="text-xs">不走代理（NO_PROXY）</Label>
              <Textarea
                value={config.noProxy}
                onChange={(e) => update({ noProxy: e.target.value })}
                placeholder={DEFAULT_PROXY.noProxy}
                disabled={!config.enabled}
                rows={2}
                className="font-mono text-xs"
              />
            </div>
          </section>

          <section className="rounded-lg border bg-muted/40 p-5 space-y-2">
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
        </div>
      </ScrollArea>

      <div className="px-8 py-4 shrink-0 flex items-center gap-2">
        <Button onClick={save} disabled={!dirty}>
          <Save />
          保存
        </Button>
        {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
      </div>
    </div>
  )
}

function Row({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <Label className="w-16 text-xs shrink-0">{label}</Label>
      {children}
    </div>
  )
}
