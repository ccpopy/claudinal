import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Key,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
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

function providerExists(store: ThirdPartyApiStore, id: string | null) {
  if (!id) return false
  return (
    id === OFFICIAL_PROVIDER_ID ||
    store.providers.some((provider) => provider.id === id)
  )
}

export function ThirdPartyApi() {
  const [store, setStore] = useState<ThirdPartyApiStore>(() =>
    loadThirdPartyApiStore()
  )
  const [selectedProviderId, setSelectedProviderId] = useState(
    store.activeProviderId
  )
  const [editingProviderId, setEditingProviderId] = useState<string | null>(
    null
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
  const editingProvider = useMemo(
    () => store.providers.find((p) => p.id === editingProviderId) ?? null,
    [editingProviderId, store]
  )
  const activeConfig = activeProvider
    ? { ...activeProvider, enabled: true }
    : createThirdPartyApiProvider()
  const editorConfig = editingProvider
    ? { ...editingProvider, enabled: true }
    : null
  const activeOfficial = store.activeProviderId === OFFICIAL_PROVIDER_ID

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const nextStore = loadThirdPartyApiStore()
      setStore(nextStore)
      setSelectedProviderId(nextStore.activeProviderId)
      setEditingProviderId(null)
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
    if (!editingProvider) return
    setStore((cur) => ({
      ...cur,
      providers: cur.providers.map((p) =>
        p.id === editingProvider.id ? { ...p, ...patch } : p
      )
    }))
    setDirty(true)
  }

  const updateModels = (patch: Partial<ModelMapping>) => {
    if (!editingProvider) return
    setStore((cur) => ({
      ...cur,
      providers: cur.providers.map((p) =>
        p.id === editingProvider.id
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
    setSelectedProviderId((id) =>
      providerExists(next, id) ? id : next.activeProviderId
    )
    setEditingProviderId((id) => (providerExists(next, id) ? id : null))
  }

  const selectProvider = (id: string) => {
    setSelectedProviderId(id)
    if (id === OFFICIAL_PROVIDER_ID) {
      setEditingProviderId(null)
    } else {
      setEditingProviderId((cur) => (cur === id ? cur : null))
    }
  }

  const activateProvider = (id: string) => {
    persistStore({ ...store, activeProviderId: id })
    setSelectedProviderId(id)
  }

  const editProvider = (id: string) => {
    if (id === OFFICIAL_PROVIDER_ID) return
    setSelectedProviderId(id)
    setShowKey(false)
    setModelOptions([])
    setEditingProviderId(id)
  }

  const addProvider = () => {
    const provider = createThirdPartyApiProvider({
      providerName: `供应商 ${store.providers.length + 1}`,
      enabled: true
    })
    persistStore({
      activeProviderId: store.activeProviderId,
      providers: [...store.providers, provider]
    })
    setSelectedProviderId(provider.id)
    setShowKey(false)
    setModelOptions([])
    setEditingProviderId(provider.id)
  }

  const removeProvider = (id: string) => {
    const providers = store.providers.filter((p) => p.id !== id)
    const activeProviderId =
      store.activeProviderId === id
        ? providers[0]?.id ?? OFFICIAL_PROVIDER_ID
        : store.activeProviderId
    persistStore({ activeProviderId, providers })
    setSelectedProviderId((cur) => (cur === id ? activeProviderId : cur))
    setEditingProviderId((cur) => (cur === id ? null : cur))
  }

  const closeEditor = () => {
    setEditingProviderId(null)
    setShowKey(false)
  }

  const saveLocal = () => {
    saveThirdPartyApiStore(store)
    setDirty(false)
    toast.success("第三方 API 配置已保存")
  }

  const validate = (
    target: ThirdPartyApiProvider,
    official = false
  ): boolean => {
    if (official) return true
    if (!trimApiUrl(target.requestUrl)) {
      toast.error("请填写请求地址")
      return false
    }
    if (!target.apiKey.trim()) {
      toast.error("请填写 API Key")
      return false
    }
    return true
  }

  const applyToClaude = async () => {
    if (!validate(activeConfig, activeOfficial)) return
    setSaving(true)
    try {
      if (activeOfficial) {
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
      const nextEnv = buildClaudeEnv(activeConfig, cliSettings.env)
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
    if (!editorConfig) return
    if (!validate(editorConfig)) return
    setModelsLoading(true)
    try {
      const list = await fetchProviderModels({
        requestUrl: editorConfig.requestUrl,
        apiKey: editorConfig.apiKey,
        authField: editorConfig.authField,
        inputFormat: editorConfig.inputFormat,
        useFullUrl: editorConfig.useFullUrl
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
    const target = editorConfig ?? activeConfig
    const env = buildClaudeEnv(target, cliSettings.env)
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
  }, [activeConfig, cliSettings.env, editorConfig])

  const activeTitle = activeOfficial
    ? "Claude Official"
    : activeProvider?.providerName.trim() || "未命名供应商"
  const activeSubtitle = activeOfficial
    ? "Claude CLI 官方登录"
    : activeProvider?.models.mainModel.trim() ||
      activeProvider?.requestUrl.trim() ||
      "第三方 API"
  const editorTitle = editorConfig?.providerName.trim() || "未命名供应商"

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
            </div>
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">当前会话将使用：</span>
              <span className="font-medium">{activeTitle}</span>
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
                active={activeOfficial}
                selected={selectedProviderId === OFFICIAL_PROVIDER_ID}
                fixed
                onSelect={() => selectProvider(OFFICIAL_PROVIDER_ID)}
                onActivate={() => activateProvider(OFFICIAL_PROVIDER_ID)}
              />
              {store.providers.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  title={provider.providerName || "未命名供应商"}
                  subtitle={
                    provider.remark ||
                    provider.officialUrl ||
                    provider.requestUrl ||
                    "第三方 API"
                  }
                  active={store.activeProviderId === provider.id}
                  selected={selectedProviderId === provider.id}
                  onSelect={() => selectProvider(provider.id)}
                  onActivate={() => activateProvider(provider.id)}
                  onEdit={() => editProvider(provider.id)}
                  onRemove={() => removeProvider(provider.id)}
                />
              ))}
            </div>
          </section>

        </div>
      </ScrollArea>

      <Dialog
        open={Boolean(editorConfig)}
        onOpenChange={(open) => {
          if (!open) closeEditor()
        }}
      >
        {editorConfig && (
          <DialogContent className="h-[86vh] w-[min(100vw-2rem,980px)] max-w-none grid-rows-[auto_1fr_auto] gap-0 overflow-hidden p-0">
            <DialogHeader className="border-b px-6 py-5 pr-12">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <DialogTitle>编辑供应商</DialogTitle>
                  <DialogDescription className="mt-1">
                    {editorTitle}
                  </DialogDescription>
                </div>
                {editingProviderId === store.activeProviderId && (
                  <CurrentBadge />
                )}
              </div>
            </DialogHeader>

            <ScrollArea className="min-h-0">
              <div className="space-y-4 p-6">
                <section className="rounded-lg border bg-card p-5 space-y-4">
                  <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                    <StackField label="供应商名称">
                      <Input
                        value={editorConfig.providerName}
                        onChange={(e) =>
                          update({ providerName: e.target.value })
                        }
                        placeholder="CLI"
                        disabled={loading || saving}
                      />
                    </StackField>
                    <StackField label="备注">
                      <Input
                        value={editorConfig.remark}
                        onChange={(e) => update({ remark: e.target.value })}
                        placeholder="gpt"
                        disabled={loading || saving}
                      />
                    </StackField>
                  </div>

                  <StackField label="官网链接">
                    <Input
                      value={editorConfig.officialUrl}
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
                        value={editorConfig.apiKey}
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
                        disabled={!editorConfig.apiKey}
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
                          checked={editorConfig.useFullUrl}
                          onCheckedChange={(useFullUrl) =>
                            update({ useFullUrl })
                          }
                          disabled={loading || saving}
                        />
                      </div>
                    </div>
                    <Input
                      value={editorConfig.requestUrl}
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
                      value={editorConfig.inputFormat}
                      onChange={(e) =>
                        update({
                          inputFormat: e.target.value as ProviderInputFormat
                        })
                      }
                      options={INPUT_FORMAT_OPTIONS}
                      disabled={loading || saving}
                      triggerClassName="max-w-[360px]"
                    />
                  </Row>
                  <Row label="认证字段">
                    <Select
                      value={editorConfig.authField}
                      onChange={(e) =>
                        update({
                          authField: e.target.value as ProviderAuthField
                        })
                      }
                      options={AUTH_FIELD_OPTIONS}
                      disabled={loading || saving}
                      triggerClassName="max-w-[360px]"
                    />
                  </Row>
                  {editorConfig.inputFormat === "openai-chat-completions" && (
                    <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                      Claude CLI 原生发送 Anthropic Messages。OpenAI Chat
                      Completions 端点需要供应商侧兼容 Claude 请求，或前面有转换代理。
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
                      <Download
                        className={modelsLoading ? "animate-pulse" : ""}
                      />
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
                      value={editorConfig.models.mainModel}
                      onChange={(mainModel) => updateModels({ mainModel })}
                      options={modelOptions}
                    />
                  </div>
                </section>

                <section className="rounded-lg border bg-muted/40 p-5 space-y-3">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Claude 映射预览
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-md bg-background border p-3 text-xs font-mono leading-relaxed">
                    {preview}
                  </pre>
                </section>
              </div>
            </ScrollArea>

            <DialogFooter className="border-t bg-card px-6 py-4">
              <Button type="button" variant="outline" onClick={closeEditor}>
                关闭
              </Button>
              <Button
                type="button"
                onClick={saveLocal}
                disabled={!dirty || loading || saving}
              >
                <Save />
                保存配置
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

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
  selected,
  fixed,
  onSelect,
  onActivate,
  onEdit,
  onRemove
}: {
  title: string
  subtitle: string
  active: boolean
  selected: boolean
  fixed?: boolean
  onSelect: () => void
  onActivate: () => void
  onEdit?: () => void
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
      className={cn(
        "group relative flex min-h-[66px] items-center gap-3 rounded-lg border p-3 transition-colors",
        selected
          ? "border-primary/45 bg-primary/5 shadow-sm"
          : "bg-card hover:border-primary/25 hover:bg-accent/45"
      )}
    >
      {selected && (
        <div className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-primary" />
      )}
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 flex items-center gap-3 text-left"
      >
        <div
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-md border text-xs font-semibold",
            selected
              ? "border-primary/20 bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground"
          )}
        >
          {fixed ? "AI" : initials || "API"}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{title}</div>
          <div className="text-xs text-muted-foreground truncate">
            {subtitle}
          </div>
        </div>
      </button>
      {selected && (
        <div className="flex shrink-0 items-center gap-2">
          {active ? (
            <CurrentBadge />
          ) : (
            <Button type="button" size="sm" onClick={onActivate}>
              <Play className="size-3.5" />
              启用
            </Button>
          )}
          {!fixed && onEdit && (
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              <Pencil className="size-3.5" />
              编辑
            </Button>
          )}
          {!fixed && onRemove && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              aria-label={`删除供应商 ${title}`}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function CurrentBadge() {
  return (
    <Badge
      variant="outline"
      className="border-primary/30 bg-primary/10 font-sans text-primary"
    >
      当前使用
    </Badge>
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
