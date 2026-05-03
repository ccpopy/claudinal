import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Bot,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  XCircle
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  collabDetectProvider,
  openExternal,
  type CollabProviderStatus
} from "@/lib/ipc"
import {
  DEFAULT_COLLAB_SETTINGS,
  enabledProviderList,
  loadCollabSettings,
  providerPathEnv,
  saveCollabSettings,
  type CollabProviderId,
  type CollabSettings
} from "@/lib/collabSettings"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionFooter,
  SettingsSectionHeader
} from "./layout"

const PROVIDER_OPTIONS: Array<{ value: CollabProviderId; label: string }> = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "opencode", label: "opencode" }
]

export function Collaboration() {
  const [cfg, setCfg] = useState<CollabSettings>(() => loadCollabSettings())
  const [dirty, setDirty] = useState(false)
  const [checking, setChecking] = useState<Set<string>>(() => new Set())
  const [providers, setProviders] = useState<
    Partial<Record<CollabProviderId, CollabProviderStatus>>
  >({})
  const overrides = useMemo(
    () =>
      Object.entries(providerPathEnv(cfg)).map(([provider, path]) => ({
        provider,
        path
      })),
    [cfg.providerPaths]
  )

  const update = (patch: Partial<CollabSettings>) => {
    setCfg((cur) => ({ ...cur, ...patch }))
    setDirty(true)
  }

  const refresh = useCallback(async () => {
    const ids = PROVIDER_OPTIONS.map((provider) => provider.value)
    setChecking(new Set(ids))
    setProviders({})
    await Promise.all(
      ids.map(async (provider) => {
        try {
          const status = await collabDetectProvider(provider, overrides)
          setProviders((cur) => ({ ...cur, [provider]: status }))
        } catch (error) {
          toast.error(`探测 ${provider} 失败: ${String(error)}`)
        } finally {
          setChecking((cur) => {
            const next = new Set(cur)
            next.delete(provider)
            return next
          })
        }
      })
    )
  }, [overrides])

  useEffect(() => {
    refresh()
  }, [refresh])

  const save = () => {
    if (!cfg.enabledProviders[cfg.defaultProvider]) {
      toast.error("默认 Agent 必须先在 provider 列表中启用")
      return
    }
    saveCollabSettings(cfg)
    setDirty(false)
    toast.success("协同设置已保存；MCP 注入对新会话生效")
  }

  const allowedPathsText = cfg.defaultAllowedPaths.join("\n")
  const enabledProviders = enabledProviderList(cfg)
  const loading = checking.size > 0

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={Bot}
        title="协同"
        description="通过受控 MCP 工具调用外部 Agent，线性执行并记录每一步输出、变更和验证。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            刷新探测
          </Button>
        }
      />

      <SettingsSectionBody>
        <section className="space-y-4 rounded-lg border bg-card p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-sm">启用协同 MCP</Label>
              <div className="mt-0.5 text-xs text-muted-foreground">
                开启后，新 Claude 会话会加载 Claudinal 协同 MCP；当前已启动会话不会生效。
              </div>
            </div>
            <Switch
              checked={cfg.enabled}
              onCheckedChange={(enabled) => update({ enabled })}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm">默认 Agent</Label>
            <Select
              value={cfg.defaultProvider}
              onChange={(event) =>
                update({
                  defaultProvider: event.target.value as CollabProviderId
                })
              }
              options={PROVIDER_OPTIONS}
              triggerClassName="max-w-[260px]"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border bg-background px-3 py-2">
            <div>
              <Label className="text-sm">默认允许写入</Label>
              <div className="mt-0.5 text-xs text-muted-foreground">
                写入步骤仍必须声明责任范围和允许路径；未启用写入时只允许只读委派。
              </div>
            </div>
            <Switch
              checked={cfg.allowWrites}
              onCheckedChange={(allowWrites) => update({ allowWrites })}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm">默认责任范围</Label>
            <Textarea
              value={cfg.defaultResponsibilityScope}
              onChange={(event) =>
                update({ defaultResponsibilityScope: event.target.value })
              }
              className="min-h-20 text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm">默认允许路径</Label>
            <Textarea
              value={allowedPathsText}
              onChange={(event) =>
                update({
                  defaultAllowedPaths: event.target.value
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean)
                })
              }
              placeholder="每行一个相对路径，例如 src 或 src-tauri/src/collab"
              className="min-h-20 font-mono text-xs"
              disabled={!cfg.allowWrites}
            />
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Agent provider 探测</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                这里读取真实本机 CLI 和 help 参数；未安装、未启用或参数不匹配会直接显示。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-sans">
                已启用 {enabledProviders.length}
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  update({
                    providerResponsibilityScopes: {
                      ...DEFAULT_COLLAB_SETTINGS.providerResponsibilityScopes
                    }
                  })
                  toast.success("职责范围已重置为默认")
                }}
              >
                <RotateCcw />
                重置
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border bg-card">
            {PROVIDER_OPTIONS.map((option) => (
              <ProviderRow
                key={option.value}
                providerId={option.value}
                label={option.label}
                status={providers[option.value] ?? null}
                checking={checking.has(option.value)}
                enabled={cfg.enabledProviders[option.value]}
                path={cfg.providerPaths[option.value] ?? ""}
                responsibilityScope={
                  cfg.providerResponsibilityScopes[option.value] ?? ""
                }
                onEnabledChange={(enabled) =>
                  update({
                    enabledProviders: {
                      ...cfg.enabledProviders,
                      [option.value]: enabled
                    }
                  })
                }
                onPathChange={(path) =>
                  update({
                    providerPaths: {
                      ...cfg.providerPaths,
                      [option.value]: path
                    }
                  })
                }
                onResponsibilityScopeChange={(responsibilityScope) =>
                  update({
                    providerResponsibilityScopes: {
                      ...cfg.providerResponsibilityScopes,
                      [option.value]: responsibilityScope
                    }
                  })
                }
              />
            ))}
          </div>
        </section>
      </SettingsSectionBody>

      <SettingsSectionFooter>
        <Button onClick={save} disabled={!dirty}>
          <Save />
          保存
        </Button>
        {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
      </SettingsSectionFooter>
    </SettingsSection>
  )
}

function ProviderRow({
  providerId,
  label,
  status,
  checking,
  enabled,
  path,
  responsibilityScope,
  onEnabledChange,
  onPathChange,
  onResponsibilityScopeChange
}: {
  providerId: CollabProviderId
  label: string
  status: CollabProviderStatus | null
  checking: boolean
  enabled: boolean
  path: string
  responsibilityScope: string
  onEnabledChange: (enabled: boolean) => void
  onPathChange: (path: string) => void
  onResponsibilityScopeChange: (responsibilityScope: string) => void
}) {
  const ready = !!status?.installed && !!status?.helpOk
  const docsUrl = status?.docsUrl
  return (
    <div className="space-y-3 border-b px-5 py-4 last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {checking ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : ready ? (
            <CheckCircle2 className="size-4 text-primary" />
          ) : status ? (
            <XCircle className="size-4 text-destructive" />
          ) : (
            <Circle className="size-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{label}</span>
            <Badge variant={enabled ? "primary" : "outline"} className="font-sans">
              {enabled ? "已启用" : "未启用"}
            </Badge>
            <Badge
              variant={ready ? "primary" : status?.installed ? "warn" : "outline"}
              className="font-sans"
            >
              {checking
                ? "检测中"
                : ready
                  ? "可用"
                  : status?.installed
                    ? "参数不匹配"
                    : "未安装"}
            </Badge>
            {status?.version && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {status.version}
              </span>
            )}
          </div>
          <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {status?.path ?? status?.message ?? "等待探测"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {status?.message ?? "列表先渲染，探测结果会逐个更新。"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch checked={enabled} onCheckedChange={onEnabledChange} />
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={!docsUrl}
            onClick={() =>
              docsUrl && openExternal(docsUrl).catch((e) => toast.error(String(e)))
            }
            aria-label="打开官方文档"
            title="打开官方文档"
          >
            <ExternalLink className="size-4" />
          </Button>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-[120px_1fr] md:items-center">
        <Label className="text-xs text-muted-foreground">自定义路径</Label>
        <Input
          value={path}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder={status?.path ?? providerId}
          className="font-mono text-xs"
        />
      </div>
      <div className="grid gap-2 md:grid-cols-[120px_1fr] md:items-start">
        <Label className="pt-2 text-xs text-muted-foreground">职责范围</Label>
        <Textarea
          value={responsibilityScope}
          onChange={(event) =>
            onResponsibilityScopeChange(event.target.value)
          }
          className="min-h-16 text-xs"
        />
      </div>
      {status &&
        (status.detectedFlags.length > 0 || status.missingFlags.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {status.detectedFlags.map((flag) => (
            <Badge key={`ok-${providerId}-${flag}`} variant="primary">
              {flag}
            </Badge>
          ))}
          {status.missingFlags.map((flag) => (
            <Badge key={`missing-${providerId}-${flag}`} variant="warn">
              缺少 {flag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}
