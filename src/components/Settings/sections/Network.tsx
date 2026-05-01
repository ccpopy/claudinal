import { useEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Network as NetworkIcon,
  PlugZap,
  Save,
  ShieldAlert,
  XCircle
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  keychainAvailable,
  readClaudeSettings,
  testProxyConnection
} from "@/lib/ipc"
import {
  describeProxy,
  formatProxyUrl,
  loadProxyAsync,
  saveProxyAsync,
  DEFAULT_PROXY,
  type ProxyConfig,
  type ProxyProtocol
} from "@/lib/proxy"
import { subscribeSettingsBus } from "@/lib/settingsBus"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionFooter,
  SettingsSectionHeader
} from "./layout"

const PROTOCOL_OPTIONS: Array<{ value: ProxyProtocol; label: string }> = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "socks5", label: "SOCKS5" },
  { value: "socks5h", label: "SOCKS5h" }
]

type TestState =
  | { kind: "idle" }
  | { kind: "running"; target: string }
  | {
      kind: "done"
      ok: boolean
      status: number | null
      latency: number
      message: string
      target: string
      ts: number
    }

const TEST_TARGETS = [
  { value: "https://api.anthropic.com", label: "Anthropic API" },
  { value: "https://www.google.com", label: "Google" },
  { value: "https://github.com", label: "GitHub" }
]

type SecretStorage = "keychain" | "localstorage" | "empty" | "unknown"

export function Network() {
  // 初始用 DEFAULT_PROXY 占位，避免渲染同步从 localStorage 读漏密码导致的闪烁
  const [config, setConfig] = useState<ProxyConfig>(() => ({ ...DEFAULT_PROXY }))
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<{
    https?: string
    http?: string
  } | null>(null)
  const [test, setTest] = useState<TestState>({ kind: "idle" })
  const [target, setTarget] = useState<string>(TEST_TARGETS[0].value)
  const [kcOk, setKcOk] = useState<boolean | null>(null)
  const [secretStored, setSecretStored] = useState<SecretStorage>("unknown")
  const dirtyRef = useRef(dirty)

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  useEffect(() => {
    // 检测 settings.json env 是否已设代理 —— CLI 会优先合并 env 覆盖 spawn 注入
    readClaudeSettings("global")
      .then((s) => {
        const env = ((s as { env?: Record<string, string> } | null)?.env) ?? {}
        const c: { https?: string; http?: string } = {}
        if (env.HTTPS_PROXY) c.https = env.HTTPS_PROXY
        if (env.HTTP_PROXY) c.http = env.HTTP_PROXY
        setConflict(c.https || c.http ? c : null)
      })
      .catch(() => setConflict(null))

    // 异步：探测 keychain 可用性 + 加载完整配置（含从 keychain 拿 password）
    let cancelled = false
    keychainAvailable()
      .then((ok) => {
        if (!cancelled) setKcOk(ok)
      })
      .catch(() => {
        if (!cancelled) setKcOk(false)
      })
    loadProxyAsync()
      .then((c) => {
        if (cancelled) return
        setConfig(c)
        setSecretStored(c.password ? "unknown" : "empty")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const reload = () => {
      if (dirtyRef.current) return
      loadProxyAsync()
        .then((c) => {
          if (cancelled) return
          setConfig(c)
          setSecretStored(c.password ? "unknown" : "empty")
        })
        .catch((error) => {
          if (!cancelled) {
            toast.error(`读取代理配置失败: ${String(error)}`)
          }
        })
    }
    const off = subscribeSettingsBus("proxy", reload)
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const update = (patch: Partial<ProxyConfig>) => {
    setConfig((c) => ({ ...c, ...patch }))
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const stored = await saveProxyAsync(config)
      setSecretStored(stored)
      setDirty(false)
      if (stored === "localstorage") {
        toast.warning("已保存，但密码以明文存储（钥匙串不可用）")
      } else {
        toast.success("已保存")
      }
    } catch (e) {
      toast.error(`保存失败: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const previewUrl =
    config.host && config.port ? formatProxyUrl(config) : "—"

  const canTest =
    config.enabled && !!config.host && !!config.port && test.kind !== "running"

  const runTest = async () => {
    if (!canTest) return
    const url = formatProxyUrl(config)
    setTest({ kind: "running", target })
    try {
      const r = await testProxyConnection({ url, target })
      setTest({
        kind: "done",
        ok: r.ok,
        status: r.status,
        latency: r.latency_ms,
        message: r.message,
        target,
        ts: Date.now()
      })
    } catch (e) {
      setTest({
        kind: "done",
        ok: false,
        status: null,
        latency: 0,
        message: String(e),
        target,
        ts: Date.now()
      })
    }
  }

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={NetworkIcon}
        title="网络代理"
        description="给 Claude CLI 设置网络代理，修改后下次启动会话后生效。"
      />

      <SettingsSectionBody>
          {conflict && (
            <section className="rounded-lg border border-warn/40 bg-warn/10 p-4 flex items-start gap-2">
              <AlertTriangle className="size-4 text-warn shrink-0 mt-0.5" />
              <div className="text-xs text-foreground/90 space-y-1">
                <div className="font-medium">
                  如果 settings.json 中 env 字段属性值配置了代理的话，会覆盖此处配置
                </div>
                {conflict.https && (
                  <div className="font-mono">"HTTPS_PROXY": "{conflict.https}"</div>
                )}
                {conflict.http && (
                  <div className="font-mono">"HTTP_PROXY": "{conflict.http}"</div>
                )}
                <div className="text-muted-foreground">
                  CLI 启动时会把 settings.json 中的 env 属性值合并到进程环境，优先级高于 spawn 注入。要让此处生效，请打开 settings.json 删除上述字段。
                </div>
              </div>
            </section>
          )}
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

            <Row label="密码" align="input">
              <div className="flex flex-1 flex-col gap-1.5">
                <Input
                  type="password"
                  value={config.password}
                  onChange={(e) => update({ password: e.target.value })}
                  disabled={!config.enabled || loading}
                  className="font-mono text-xs"
                  placeholder={loading ? "正在从钥匙串读取…" : ""}
                  autoComplete="off"
                />
                {!loading && (
                  <SecretBadge stored={secretStored} kcOk={kcOk} hasPwd={!!config.password} />
                )}
              </div>
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

          <section className="rounded-lg border bg-card p-5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label className="text-sm">测试连接</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  通过当前代理 HEAD 一次目标 URL，验证能否访问 Claude / 外网。不影响保存。
                </p>
              </div>
              <Button
                size="sm"
                onClick={runTest}
                disabled={!canTest}
                title={!canTest ? "需先启用代理并填写主机/端口" : undefined}
              >
                {test.kind === "running" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <PlugZap className="size-3.5" />
                )}
                测试
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Label className="text-xs text-muted-foreground">目标</Label>
              <Select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                options={TEST_TARGETS}
                disabled={test.kind === "running"}
                triggerClassName="max-w-[260px]"
              />
            </div>
            {test.kind === "done" && (
              <div
                className={
                  test.ok
                    ? "flex items-start gap-2 rounded-md border border-connected/30 bg-connected/10 p-3 text-xs"
                    : "flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs"
                }
              >
                {test.ok ? (
                  <CheckCircle2 className="size-4 shrink-0 text-connected" />
                ) : (
                  <XCircle className="size-4 shrink-0 text-destructive" />
                )}
                <div className="min-w-0 space-y-0.5">
                  <div className={test.ok ? "text-connected" : "text-destructive"}>
                    {test.message}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {test.target} · {test.latency} ms
                    {test.status !== null && ` · HTTP ${test.status}`}
                  </div>
                </div>
              </div>
            )}
          </section>
      </SettingsSectionBody>

      <SettingsSectionFooter>
        <Button onClick={save} disabled={!dirty || saving || loading}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          保存
        </Button>
        {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
      </SettingsSectionFooter>
    </SettingsSection>
  )
}

function Row({
  label,
  children,
  align = "center"
}: {
  label: string
  children: React.ReactNode
  align?: "center" | "input"
}) {
  return (
    <div className={`flex gap-3 ${align === "input" ? "items-start" : "items-center"}`}>
      <Label className={`w-16 text-xs shrink-0 ${align === "input" ? "flex h-9 items-center" : ""}`}>
        {label}
      </Label>
      {children}
    </div>
  )
}

function SecretBadge({
  stored,
  kcOk,
  hasPwd
}: {
  stored: SecretStorage
  kcOk: boolean | null
  hasPwd: boolean
}) {
  if (!hasPwd) {
    return (
      <span className="text-[11px] text-muted-foreground">
        留空表示无需认证
      </span>
    )
  }
  if (stored === "localstorage" || (kcOk === false && stored !== "keychain")) {
    return (
      <Badge variant="warn" className="font-sans">
        <ShieldAlert className="size-3" />
        明文存储 · 钥匙串不可用
      </Badge>
    )
  }
  if (stored === "keychain" || kcOk) {
    return (
      <Badge variant="success" className="font-sans">
        <KeyRound className="size-3" />
        系统钥匙串加密
      </Badge>
    )
  }
  return (
    <span className="text-[11px] text-muted-foreground">
      尚未保存到钥匙串，点击保存以加密
    </span>
  )
}
