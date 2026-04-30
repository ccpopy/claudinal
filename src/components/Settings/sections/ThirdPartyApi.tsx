import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { loadSettings, saveSettings } from "@/lib/settings"
import {
  claudeSettingsPath,
  fetchProviderModels,
  openPath,
  readClaudeSettings,
  writeClaudeSettings
} from "@/lib/ipc"
import {
  buildClaudeEnv,
  clearManagedClaudeEnv,
  clearManagedModelOverrides,
  createThirdPartyApiProvider,
  loadThirdPartyApiStore,
  maskSecret,
  OFFICIAL_PROVIDER_ID,
  saveThirdPartyApiStore,
  trimApiUrl,
  type ModelMapping,
  type ProviderAuthField,
  type ProviderInputFormat,
  type ThirdPartyApiProvider,
  type ThirdPartyApiStore
} from "@/lib/thirdPartyApi"

interface CliSettings {
  model?: string
  env?: Record<string, string>
  modelOverrides?: Record<string, string>
  [k: string]: unknown
}

const INPUT_FORMAT_OPTIONS: Array<{ value: ProviderInputFormat; label: string }> = [
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" }
]

const AUTH_FIELD_OPTIONS: Array<{ value: ProviderAuthField; label: string }> = [
  { value: "ANTHROPIC_AUTH_TOKEN", label: "ANTHROPIC_AUTH_TOKEN（默认）" },
  { value: "ANTHROPIC_API_KEY", label: "ANTHROPIC_API_KEY" }
]

export function ThirdPartyApi() {
  const [store, setStore] = useState<ThirdPartyApiStore>(() =>
    loadThirdPartyApiStore()
  )
  const [cliSettings, setCliSettings] = useState<CliSettings>({})
  const [filePath, setFilePath] = useState("")
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const activeProvider = useMemo(
    () => store.providers.find((p) => p.id === store.activeProviderId) ?? null,
    [store]
  )
  const config = activeProvider
    ? { ...activeProvider, enabled: true }
    : createThirdPartyApiProvider()
  const officialSelected = store.activeProviderId === OFFICIAL_PROVIDER_ID

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setStore(loadThirdPartyApiStore())
      setDirty(false)
      const path = await claudeSettingsPath("global")
      setFilePath(path)
      const raw = (await readClaudeSettings("global")) as CliSettings | null
      setCliSettings(raw ?? {})
    } catch (e) {
      toast.error(`读取配置失败: ${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const update = (patch: Partial<ThirdPartyApiProvider>) => {
    if (!activeProvider) return
    setStore((cur) => ({
      ...cur,
      providers: cur.providers.map((p) =>
        p.id === activeProvider.id ? { ...p, ...patch } : p
      )
    }))
    setDirty(true)
  }

  const updateModels = (patch: Partial<ModelMapping>) => {
    if (!activeProvider) return
    setStore((cur) => ({
      ...cur,
      providers: cur.providers.map((p) =>
        p.id === activeProvider.id
          ? { ...p, models: { ...p.models, ...patch } }
          : p
      )
    }))
    setDirty(true)
  }

  const persistStore = (next: ThirdPartyApiStore) => {
    setStore(next)
    saveThirdPartyApiStore(next)
    setDirty(false)
  }

  const selectProvider = (id: string) => {
    persistStore({ ...store, activeProviderId: id })
  }

  const addProvider = () => {
    const provider = createThirdPartyApiProvider({
      providerName: `供应商 ${store.providers.length + 1}`,
      enabled: true
    })
    persistStore({
      activeProviderId: provider.id,
      providers: [...store.providers, provider]
    })
  }

  const removeProvider = (id: string) => {
    const providers = store.providers.filter((p) => p.id !== id)
    const activeProviderId =
      store.activeProviderId === id
        ? providers[0]?.id ?? OFFICIAL_PROVIDER_ID
        : store.activeProviderId
    persistStore({ activeProviderId, providers })
  }

  const saveLocal = () => {
    saveThirdPartyApiStore(store)
    setDirty(false)
    toast.success("第三方 API 配置已保存")
  }

  const validate = (): boolean => {
    if (officialSelected) return true
    if (!trimApiUrl(config.requestUrl)) {
      toast.error("请填写请求地址")
      return false
    }
    if (!config.apiKey.trim()) {
      toast.error("请填写 API Key")
      return false
    }
    return true
  }

  const applyToClaude = async () => {
    if (!validate()) return
    setSaving(true)
    try {
      if (officialSelected) {
        const nextSettings: CliSettings = {
          ...cliSettings,
          env: clearManagedClaudeEnv(cliSettings.env),
          modelOverrides: clearManagedModelOverrides(cliSettings.modelOverrides)
        }
        delete nextSettings.model
        await writeClaudeSettings("global", nextSettings as Record<string, unknown>)
        const appSettings = loadSettings()
        if (appSettings.defaultModel.trim()) {
          saveSettings({ ...appSettings, defaultModel: "" })
        }
        saveThirdPartyApiStore(store)
        setCliSettings(nextSettings)
        setDirty(false)
        toast.success("已切换为 Claude Official")
        return
      }
      const nextEnv = buildClaudeEnv(config, cliSettings.env)
      const nextSettings: CliSettings = {
        ...cliSettings,
        env: nextEnv,
        modelOverrides: clearManagedModelOverrides(cliSettings.modelOverrides)
      }
      delete nextSettings.model
      await writeClaudeSettings("global", nextSettings as Record<string, unknown>)
      const appSettings = loadSettings()
      if (appSettings.defaultModel.trim()) {
        saveSettings({ ...appSettings, defaultModel: "" })
      }
      saveThirdPartyApiStore(store)
      setCliSettings(nextSettings)
      setDirty(false)
      toast.success("已应用到 Claude，下次启动会话生效")
    } catch (e) {
      toast.error(`应用失败: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const clearClaudeMapping = async () => {
    setSaving(true)
    try {
      const nextSettings: CliSettings = {
        ...cliSettings,
        env: clearManagedClaudeEnv(cliSettings.env),
        modelOverrides: clearManagedModelOverrides(cliSettings.modelOverrides)
      }
      await writeClaudeSettings("global", nextSettings as Record<string, unknown>)
      setCliSettings(nextSettings)
      toast.success("已清除 Claude 中的第三方 API 映射")
    } catch (e) {
      toast.error(`清除失败: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const loadModels = async () => {
    if (officialSelected) return
    if (!validate()) return
    setModelsLoading(true)
    try {
      const list = await fetchProviderModels({
        requestUrl: config.requestUrl,
        apiKey: config.apiKey,
        authField: config.authField,
        inputFormat: config.inputFormat,
        useFullUrl: config.useFullUrl
      })
      setModelOptions(list)
      toast.success(`已获取 ${list.length} 个模型`)
    } catch (e) {
      toast.error(`获取模型列表失败: ${String(e)}`)
    } finally {
      setModelsLoading(false)
    }
  }

  const preview = useMemo(() => {
    const env = buildClaudeEnv(config, cliSettings.env)
    const maskedEnv = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        key,
        key.includes("KEY") || key.includes("TOKEN") ? maskSecret(value) : value
      ])
    )
    return JSON.stringify(
      {
        env: maskedEnv
      },
      null,
      2
    )
  }, [cliSettings.env, config])

  const providerTitle = officialSelected
    ? "Claude Official"
    : config.providerName.trim() || "未命名供应商"
  const activeSubtitle = officialSelected
    ? "Claude CLI 官方登录"
    : config.models.mainModel.trim() || config.requestUrl.trim() || "第三方 API"

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Key className="size-5" />
            第三方 API
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            保存供应商参数，并映射到 Claude settings.json 的 env / model。
          </p>
        </div>
        <div className="flex items-center gap-2 mt-6 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading || saving}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              filePath && openPath(filePath).catch((e) => toast.error(String(e)))
            }
            disabled={!filePath}
          >
            <ExternalLink className="size-3.5" />
            打开 settings.json
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 pb-6 w-full space-y-6">
          <section className="rounded-lg border bg-card p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  供应商列表
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  选择当前会话使用的供应商；第三方供应商会通过本地代理转发。
                </div>
              </div>
              <Badge variant={officialSelected ? "secondary" : "success"}>
                当前使用：{providerTitle}
              </Badge>
            </div>
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">当前会话将使用：</span>
              <span className="font-medium">{providerTitle}</span>
              <span className="text-muted-foreground"> · {activeSubtitle}</span>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={addProvider}>
                <Plus />
                新增供应商
              </Button>
            </div>
            <div className="space-y-3">
              <ProviderCard
                title="Claude Official"
                subtitle="https://www.anthropic.com/claude-code"
                active={officialSelected}
                fixed
                onSelect={() => selectProvider(OFFICIAL_PROVIDER_ID)}
              />
              {store.providers.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  title={provider.providerName || "未命名供应商"}
                  subtitle={provider.remark || provider.officialUrl || provider.requestUrl || "第三方 API"}
                  active={store.activeProviderId === provider.id}
                  onSelect={() => selectProvider(provider.id)}
                  onRemove={() => removeProvider(provider.id)}
                />
              ))}
            </div>
          </section>

          {officialSelected ? (
            <section className="rounded-lg border bg-card p-5 space-y-2">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                当前供应商
              </div>
              <div className="text-sm font-medium">Claude Official</div>
              <div className="text-xs text-muted-foreground">
                使用 Claude CLI 自身登录与默认模型，不启用第三方 API 本地代理。
              </div>
            </section>
          ) : (
            <>
          <section className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  供应商
                </div>
                <div className="text-sm font-medium mt-1">{providerTitle}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="success">
                  当前使用
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-5">
              <StackField label="供应商名称">
                <Input
                  value={config.providerName}
                  onChange={(e) => update({ providerName: e.target.value })}
                  placeholder="CLI"
                  disabled={loading || saving}
                />
              </StackField>
              <StackField label="备注">
                <Input
                  value={config.remark}
                  onChange={(e) => update({ remark: e.target.value })}
                  placeholder="gpt"
                  disabled={loading || saving}
                />
              </StackField>
            </div>

            <StackField label="官网链接">
              <Input
                value={config.officialUrl}
                onChange={(e) => update({ officialUrl: e.target.value })}
                placeholder="https://cli.addy777.com"
                className="font-mono text-xs"
                disabled={loading || saving}
              />
            </StackField>

            <StackField label="API Key">
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={config.apiKey}
                  onChange={(e) => update({ apiKey: e.target.value })}
                  className="font-mono text-xs pr-10"
                  autoComplete="off"
                  disabled={loading || saving}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 size-9 text-muted-foreground"
                  onClick={() => setShowKey((v) => !v)}
                  disabled={!config.apiKey}
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                >
                  {showKey ? <EyeOff /> : <Eye />}
                </Button>
              </div>
            </StackField>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm font-medium">请求地址</Label>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>完整 URL</span>
                  <Switch
                    checked={config.useFullUrl}
                    onCheckedChange={(useFullUrl) => update({ useFullUrl })}
                    disabled={loading || saving}
                  />
                </div>
              </div>
              <Input
                value={config.requestUrl}
                onChange={(e) => update({ requestUrl: e.target.value })}
                placeholder="https://cli.addy777.com/v1"
                className="font-mono text-xs"
                disabled={loading || saving}
              />
              <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                填写供应商兼容端点地址，保存到 Claude 时会写入 ANTHROPIC_BASE_URL。
              </div>
            </div>
          </section>

          <section className="rounded-lg border bg-card p-5 space-y-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              协议映射
            </div>
            <Row label="输入格式">
              <Select
                value={config.inputFormat}
                onChange={(e) =>
                  update({ inputFormat: e.target.value as ProviderInputFormat })
                }
                options={INPUT_FORMAT_OPTIONS}
                disabled={loading || saving}
                triggerClassName="max-w-[360px]"
              />
            </Row>
            <Row label="认证字段">
              <Select
                value={config.authField}
                onChange={(e) =>
                  update({ authField: e.target.value as ProviderAuthField })
                }
                options={AUTH_FIELD_OPTIONS}
                disabled={loading || saving}
                triggerClassName="max-w-[360px]"
              />
            </Row>
            {config.inputFormat === "openai-chat-completions" && (
              <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                Claude CLI 原生发送 Anthropic Messages。OpenAI Chat Completions
                端点需要供应商侧兼容 Claude 请求，或前面有转换代理。
              </div>
            )}
          </section>

          <section className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  使用模型
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Claude 会通过本地代理转发请求，实际发送给供应商的是这里配置的模型。
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={loadModels}
                disabled={loading || saving || modelsLoading}
              >
                <Download className={modelsLoading ? "animate-pulse" : ""} />
                获取模型列表
              </Button>
            </div>

            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Claude 启动时不指定模型；本地代理会在请求转发前把模型替换为下面的供应商模型。
            </div>
            {modelOptions.length > 0 && (
              <div className="text-[11px] text-muted-foreground">
                已获取 {modelOptions.length} 个模型，点击输入框可从完整列表中选择，也可以手动输入。
              </div>
            )}

            <div className="grid grid-cols-1 max-w-[520px] gap-5">
              <ModelField
                label="供应商模型"
                value={config.models.mainModel}
                onChange={(mainModel) => updateModels({ mainModel })}
                options={modelOptions}
              />
            </div>
          </section>

          <section className="rounded-lg border bg-muted/40 p-5 space-y-3">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Claude 映射预览
            </div>
            <pre className="max-h-72 overflow-auto rounded-md bg-background border p-3 text-xs font-mono leading-relaxed">
              {preview}
            </pre>
          </section>
            </>
          )}
        </div>
      </ScrollArea>

      <div className="px-8 py-4 shrink-0 flex items-center gap-2">
        <Button onClick={saveLocal} disabled={!dirty || loading || saving}>
          <Save />
          保存配置
        </Button>
        <Button onClick={applyToClaude} disabled={loading || saving}>
          <Key />
          应用到 Claude
        </Button>
        <Button
          variant="outline"
          onClick={clearClaudeMapping}
          disabled={loading || saving}
        >
          <Trash2 />
          清除 Claude 映射
        </Button>
        {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
      </div>
    </div>
  )
}

function StackField({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      {children}
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
      <Label className="w-24 text-xs shrink-0">{label}</Label>
      {children}
    </div>
  )
}

function ProviderCard({
  title,
  subtitle,
  active,
  fixed,
  onSelect,
  onRemove
}: {
  title: string
  subtitle: string
  active: boolean
  fixed?: boolean
  onSelect: () => void
  onRemove?: () => void
}) {
  const initials = title
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
  return (
    <div
      className={
        active
          ? "group relative flex items-center gap-3 rounded-lg border border-connected bg-connected/10 p-3 shadow-sm"
          : "group flex items-center gap-3 rounded-lg border bg-background p-3 hover:bg-accent/40"
      }
    >
      {active && (
        <div className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-connected" />
      )}
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 flex items-center gap-3 text-left"
      >
        <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-xs font-semibold text-muted-foreground">
          {fixed ? "AI" : initials || "API"}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{title}</div>
          <div className="text-xs text-muted-foreground truncate">
            {subtitle}
          </div>
        </div>
      </button>
      {active && (
        <Badge variant="success" className="shrink-0">
          当前使用
        </Badge>
      )}
      {!active && (
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={onSelect}
        >
          <Play className="size-3.5" />
          启用
        </Button>
      )}
      {!fixed && onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 opacity-70 group-hover:opacity-100"
          onClick={onRemove}
          aria-label={`删除供应商 ${title}`}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  )
}

function ModelField({
  label,
  value,
  onChange,
  options
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: string[]
}) {
  const [open, setOpen] = useState(false)

  return (
    <StackField label={label}>
      <div className="relative">
        <Input
          value={value}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
          }}
          placeholder="gpt-5.4"
          className="font-mono text-xs"
        />
        {open && options.length > 0 && (
          <div
            role="listbox"
            className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 shadow-lg"
          >
            {options.map((model) => {
              const active = model === value
              return (
                <button
                  key={model}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onChange(model)
                    setOpen(false)
                  }}
                  className={
                    active
                      ? "w-full rounded-sm bg-accent px-2 py-2 text-left font-mono text-xs text-accent-foreground"
                      : "w-full rounded-sm px-2 py-2 text-left font-mono text-xs hover:bg-accent hover:text-accent-foreground"
                  }
                >
                  {model}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </StackField>
  )
}
