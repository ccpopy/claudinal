import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
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
import { Breadcrumb, BreadcrumbItem, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  claudeSettingsPath,
  fetchProviderModels,
  openPath
} from "@/lib/ipc"
import {
  buildClaudeRuntimeSettingsPreview,
  cleanupManagedGlobalClaudeSettings,
  createThirdPartyApiProvider,
  deleteProviderApiKey,
  loadThirdPartyApiStoreAsync,
  maskSecret,
  OFFICIAL_PROVIDER_ID,
  parseRuntimeSettingsJson,
  providerModelInputOptions,
  saveThirdPartyApiStoreAsync,
  trimApiUrl,
  type ModelMapping,
  type ProviderAuthField,
  type ProviderInputFormat,
  type ThirdPartyApiProvider,
  type ThirdPartyApiStore
} from "@/lib/thirdPartyApi"
import { subscribeSettingsBus } from "@/lib/settingsBus"
import { formatProxyUrl, loadProxyAsync } from "@/lib/proxy"

interface ProviderEditorState {
  mode: "new" | "edit"
  originalId: string | null
  provider: ThirdPartyApiProvider
}

const INPUT_FORMAT_OPTIONS: Array<{ value: ProviderInputFormat; label: string }> = [
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" }
]

const AUTH_FIELD_OPTIONS: Array<{ value: ProviderAuthField; label: string }> = [
  { value: "ANTHROPIC_AUTH_TOKEN", label: "ANTHROPIC_AUTH_TOKEN（默认）" },
  { value: "ANTHROPIC_API_KEY", label: "ANTHROPIC_API_KEY" }
]

const ANTHROPIC_DOC_URL = "https://docs.anthropic.com"
const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com"
const OPENAI_API_BASE_URL = "https://api.openai.com/v1"

function requestUrlPlaceholder(
  inputFormat: ProviderInputFormat,
  useFullUrl: boolean
) {
  if (inputFormat === "anthropic") {
    void useFullUrl
    return ANTHROPIC_API_BASE_URL
  }
  return useFullUrl
    ? `${OPENAI_API_BASE_URL}/chat/completions`
    : OPENAI_API_BASE_URL
}

function providerExists(store: ThirdPartyApiStore, id: string | null) {
  if (!id) return false
  return (
    id === OFFICIAL_PROVIDER_ID ||
    store.providers.some((provider) => provider.id === id)
  )
}

function maskRuntimeSettingsValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    const upper = key.toUpperCase()
    return upper.includes("KEY") ||
      upper.includes("TOKEN") ||
      upper.includes("SECRET")
      ? maskSecret(value)
      : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskRuntimeSettingsValue(item, key))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        maskRuntimeSettingsValue(childValue, childKey)
      ])
    )
  }
  return value
}

export function ThirdPartyApi() {
  const [store, setStore] = useState<ThirdPartyApiStore>({
    activeProviderId: OFFICIAL_PROVIDER_ID,
    providers: []
  })
  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    OFFICIAL_PROVIDER_ID
  )
  const [editor, setEditor] = useState<ProviderEditorState | null>(null)
  const [filePath, setFilePath] = useState("")
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const activeProvider = useMemo(
    () => store.providers.find((p) => p.id === store.activeProviderId) ?? null,
    [store]
  )
  const activeConfig = activeProvider
    ? { ...activeProvider, enabled: true }
    : createThirdPartyApiProvider()
  const editorConfig = editor?.provider ?? null
  const activeOfficial = store.activeProviderId === OFFICIAL_PROVIDER_ID
  const hasLegacyKey = useMemo(
    () => store.providers.some((p) => p.legacyApiKey),
    [store]
  )
  const dirtyRef = useRef(dirty)
  const editorRef = useRef(editor)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const nextStore = await loadThirdPartyApiStoreAsync()
      setStore(nextStore)
      setSelectedProviderId(nextStore.activeProviderId)
      setEditor(null)
      setDirty(false)
      const path = await claudeSettingsPath("global")
      setFilePath(path)
    } catch (e) {
      toast.error(`读取配置失败: ${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    dirtyRef.current = dirty
    editorRef.current = editor
  }, [dirty, editor])

  useEffect(() => {
    return subscribeSettingsBus("thirdPartyApi", () => {
      if (dirtyRef.current || editorRef.current) return
      void load()
    })
  }, [load])

  const update = (patch: Partial<ThirdPartyApiProvider>) => {
    setEditor((cur) =>
      cur ? { ...cur, provider: { ...cur.provider, ...patch } } : cur
    )
    setDirty(true)
  }

  const updateModels = (patch: Partial<ModelMapping>) => {
    setEditor((cur) =>
      cur
        ? {
            ...cur,
            provider: {
              ...cur.provider,
              models: { ...cur.provider.models, ...patch }
            }
          }
        : cur
    )
    setDirty(true)
  }

  const persistStore = async (next: ThirdPartyApiStore) => {
    setStore(next)
    const result = await saveThirdPartyApiStoreAsync(next)
    setDirty(false)
    setSelectedProviderId((id) =>
      providerExists(next, id) ? id : next.activeProviderId
    )
    return result
  }

  const selectProvider = (id: string) => {
    setSelectedProviderId(id)
  }

  const editProvider = (id: string) => {
    if (id === OFFICIAL_PROVIDER_ID) return
    const provider = store.providers.find((p) => p.id === id)
    if (!provider) return
    setSelectedProviderId(id)
    setShowKey(false)
    setEditor({
      mode: "edit",
      originalId: id,
      provider: createThirdPartyApiProvider(provider)
    })
    setDirty(false)
  }

  const addProvider = () => {
    const provider = createThirdPartyApiProvider({
      enabled: true
    })
    setSelectedProviderId(provider.id)
    setShowKey(false)
    setEditor({
      mode: "new",
      originalId: null,
      provider
    })
    setDirty(false)
  }

  const removeProvider = async (id: string) => {
    const providers = store.providers.filter((p) => p.id !== id)
    const activeProviderId =
      store.activeProviderId === id
        ? providers[0]?.id ?? OFFICIAL_PROVIDER_ID
        : store.activeProviderId
    await deleteProviderApiKey(id)
    await persistStore({ activeProviderId, providers })
    setSelectedProviderId((cur) => (cur === id ? activeProviderId : cur))
    setEditor((cur) => (cur?.originalId === id ? null : cur))
  }

  const closeEditor = () => {
    setEditor(null)
    setSelectedProviderId((id) => (providerExists(store, id) ? id : store.activeProviderId))
    setShowKey(false)
    setDirty(false)
  }

  const announceSaveResult = (
    stored: "keychain" | "localstorage" | "empty"
  ) => {
    if (stored === "localstorage") {
      toast.warning("API Key 暂存为明文", {
        description:
          "系统钥匙串当前不可用，密钥写回了 localStorage 明文；可在系统中恢复钥匙串后再保存一次自动迁移。"
      })
    } else {
      toast.success("第三方 API 配置已保存")
    }
  }

  const saveLocal = async () => {
    if (editor) {
      const provider = createThirdPartyApiProvider(editor.provider)
      if (!provider.providerName.trim()) {
        toast.error("请填写供应商名称")
        return
      }
      if (!trimApiUrl(provider.requestUrl)) {
        toast.error("请填写请求地址")
        return
      }
      if (!provider.apiKey.trim()) {
        toast.error("请填写 API Key")
        return
      }
      try {
        parseRuntimeSettingsJson(provider.runtimeSettingsJson)
      } catch (error) {
        toast.error(String(error))
        return
      }
      const providers =
        editor.mode === "new"
          ? [...store.providers, provider]
          : store.providers.map((p) =>
              p.id === editor.originalId ? provider : p
            )
      const next = {
        activeProviderId: providerExists({ ...store, providers }, store.activeProviderId)
          ? store.activeProviderId
          : OFFICIAL_PROVIDER_ID,
        providers
      }
      setSaving(true)
      try {
        const result = await saveThirdPartyApiStoreAsync(next)
        // saveThirdPartyApiStoreAsync 内部已经把密钥从 localStorage 抹掉，
        // 这里重新读 store 以拿到同步状态下的 provider（apiKey 字段已清空）。
        const refreshed = await loadThirdPartyApiStoreAsync()
        setStore(refreshed)
        setSelectedProviderId(provider.id)
        const refreshedProvider =
          refreshed.providers.find((p) => p.id === provider.id) ?? provider
        setEditor({
          mode: "edit",
          originalId: provider.id,
          provider: refreshedProvider
        })
        setDirty(false)
        announceSaveResult(result.stored)
      } catch (e) {
        toast.error(`保存失败: ${String(e)}`)
      } finally {
        setSaving(false)
      }
      return
    }
    setSaving(true)
    try {
      const result = await saveThirdPartyApiStoreAsync(store)
      setDirty(false)
      announceSaveResult(result.stored)
    } catch (e) {
      toast.error(`保存失败: ${String(e)}`)
    } finally {
      setSaving(false)
    }
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
    try {
      parseRuntimeSettingsJson(target.runtimeSettingsJson)
    } catch (error) {
      toast.error(String(error))
      return false
    }
    return true
  }

  const activateProvider = async (providerId: string) => {
    setSaving(true)
    try {
      if (providerId === OFFICIAL_PROVIDER_ID) {
        await cleanupManagedGlobalClaudeSettings()
        await persistStore({ ...store, activeProviderId: OFFICIAL_PROVIDER_ID })
        toast.success("已恢复 Claude 官方，新会话不会注入第三方 API")
        return
      }

      const refreshed = await loadThirdPartyApiStoreAsync()
      const target = refreshed.providers.find((provider) => provider.id === providerId)
      if (!target) {
        toast.error("找不到要应用的供应商")
        return
      }
      if (!validate(target)) return

      await cleanupManagedGlobalClaudeSettings()
      await persistStore({ ...refreshed, activeProviderId: providerId })
      setSelectedProviderId(providerId)
      toast.success("已启用该供应商，新会话会使用运行时配置")
    } catch (e) {
      toast.error(`应用失败: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const loadModels = async () => {
    if (!editorConfig) return
    if (!validate(editorConfig)) return
    const originalId = editor?.originalId ?? null
    setModelsLoading(true)
    try {
      const proxy = await loadProxyAsync().catch(() => null)
      const proxyUrl =
        proxy?.enabled && proxy.host && proxy.port ? formatProxyUrl(proxy) : null
      const list = await fetchProviderModels({
        requestUrl: editorConfig.requestUrl,
        apiKey: editorConfig.apiKey,
        authField: editorConfig.authField,
        inputFormat: editorConfig.inputFormat,
        useFullUrl: editorConfig.useFullUrl,
        proxyUrl
      })
      setEditor((cur) =>
        cur
          ? {
              ...cur,
              provider: {
                ...cur.provider,
                availableModels: list
              }
            }
          : cur
      )
      if (originalId) {
        const nextStore = {
          ...store,
          providers: store.providers.map((provider) =>
            provider.id === originalId
              ? { ...provider, availableModels: list }
              : provider
          )
        }
        setStore(nextStore)
        // availableModels 列表无密钥，安全；走 async 写入会顺带把 apiKey 同步到 keychain。
        await saveThirdPartyApiStoreAsync(nextStore)
      }
      setDirty(true)
      toast.success(
        originalId
          ? `已获取并缓存 ${list.length} 个模型`
          : `已获取 ${list.length} 个模型，保存供应商后缓存`
      )
    } catch (e) {
      toast.error(`获取模型列表失败: ${String(e)}`)
    } finally {
      setModelsLoading(false)
    }
  }

  const preview = useMemo(() => {
    const target = editorConfig ?? activeConfig
    try {
      return JSON.stringify(
        maskRuntimeSettingsValue(buildClaudeRuntimeSettingsPreview(target)),
        null,
        2
      )
    } catch (error) {
      return `配置错误：${String(error)}`
    }
  }, [activeConfig, editorConfig])

  const activeTitle = activeOfficial
    ? "Claude Official"
    : activeProvider?.providerName.trim() || "未命名供应商"
  const activeSubtitle = activeOfficial
    ? "Claude CLI 官方登录"
    : activeProvider?.models.mainModel.trim() ||
      activeProvider?.requestUrl.trim() ||
      "第三方 API"
  const editorTitle = editorConfig?.providerName.trim() || "未命名供应商"
  const requestPlaceholder = editorConfig
    ? requestUrlPlaceholder(editorConfig.inputFormat, editorConfig.useFullUrl)
    : ANTHROPIC_API_BASE_URL
  const editorModelOptions = editorConfig
    ? providerModelInputOptions(editorConfig)
    : []
  const cachedModelCount = editorConfig?.availableModels.length ?? 0

  if (editor && editorConfig) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-8 pt-8 pb-4 shrink-0">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <button
              type="button"
              onClick={closeEditor}
              className="inline-flex items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              返回
            </button>
            <Breadcrumb>
              <BreadcrumbItem onClick={closeEditor}>第三方 API</BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem current>
                {editor.mode === "new" ? "新增供应商" : editorTitle}
              </BreadcrumbItem>
            </Breadcrumb>
          </div>
          <div className="mt-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Key className="size-5" />
                {editor.mode === "new" ? "新增供应商" : "编辑供应商"}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {editorTitle}
              </p>
            </div>
            {editor.originalId === store.activeProviderId && <CurrentBadge />}
          </div>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-4 px-8 pb-6 pt-2">
            <section className="rounded-lg border bg-card p-5 space-y-4">
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <StackField label="供应商名称">
                  <Input
                    value={editorConfig.providerName}
                    onChange={(e) =>
                      update({ providerName: e.target.value })
                    }
                    placeholder="Anthropic"
                    disabled={loading || saving}
                  />
                </StackField>
                <StackField label="备注">
                  <Input
                    value={editorConfig.remark}
                    onChange={(e) => update({ remark: e.target.value })}
                    placeholder="Claude API"
                    disabled={loading || saving}
                  />
                </StackField>
              </div>

              <StackField label="官网链接">
                <Input
                  value={editorConfig.officialUrl}
                  onChange={(e) => update({ officialUrl: e.target.value })}
                  placeholder={ANTHROPIC_DOC_URL}
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
                    className="no-native-password-reveal font-mono text-xs pr-10"
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
                    <span>完整端点 URL</span>
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
                  placeholder={requestPlaceholder}
                  className="font-mono text-xs"
                  disabled={loading || saving}
                />
                {editorConfig.inputFormat === "anthropic" && (
                  <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                    默认填写基础地址（如 {ANTHROPIC_API_BASE_URL}）。如需直接指向 messages 端点，请打开「完整端点 URL」。
                  </div>
                )}
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
              {editorConfig.inputFormat === "anthropic" && (
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
              )}
            </section>

            <section className="rounded-lg border bg-card p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    使用模型
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    映射到 Claude Code 官方环境变量，新会话启动时注入。
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
                列表会缓存到当前供应商。下方字段同时用于运行时配置与本地代理转发。
              </div>
              {cachedModelCount > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  已缓存 {cachedModelCount} 个模型，点击输入框可从列表中选择，也可以手动输入。
                </div>
              )}

              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <ModelField
                  label="ANTHROPIC_MODEL"
                  value={editorConfig.models.mainModel}
                  onChange={(mainModel) => updateModels({ mainModel })}
                  options={editorModelOptions}
                />
                <ModelField
                  label="ANTHROPIC_DEFAULT_HAIKU_MODEL"
                  value={editorConfig.models.haikuModel}
                  onChange={(haikuModel) => updateModels({ haikuModel })}
                  options={editorModelOptions}
                />
                <ModelField
                  label="ANTHROPIC_DEFAULT_SONNET_MODEL"
                  value={editorConfig.models.sonnetModel}
                  onChange={(sonnetModel) => updateModels({ sonnetModel })}
                  options={editorModelOptions}
                />
                <ModelField
                  label="ANTHROPIC_DEFAULT_OPUS_MODEL"
                  value={editorConfig.models.opusModel}
                  onChange={(opusModel) => updateModels({ opusModel })}
                  options={editorModelOptions}
                />
                <ModelField
                  label="CLAUDE_CODE_SUBAGENT_MODEL"
                  value={editorConfig.models.subagentModel}
                  onChange={(subagentModel) => updateModels({ subagentModel })}
                  options={editorModelOptions}
                />
              </div>
            </section>

            <section className="rounded-lg border bg-card p-5 space-y-4">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Claude settings 覆盖
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  通过 --settings 注入到本供应商的新会话。
                </div>
              </div>
              <Textarea
                value={editorConfig.runtimeSettingsJson}
                onChange={(e) => update({ runtimeSettingsJson: e.target.value })}
                placeholder={`{\n  "model": "opus[1m]",\n  "alwaysThinkingEnabled": true\n}`}
                className="min-h-32 font-mono text-xs"
                disabled={loading || saving}
              />
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                env 字段仅用于追加自定义环境变量。ANTHROPIC_*、CLAUDINAL_PROXY_* 及 API Key 由上方字段统一管理。
              </div>
            </section>

            <section className="rounded-lg border bg-muted/40 p-5 space-y-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Claude 运行时 settings 预览
              </div>
              <pre className="max-h-64 overflow-auto rounded-md bg-background border p-3 text-xs font-mono leading-relaxed">
                {preview}
              </pre>
            </section>
          </div>
        </ScrollArea>

        <div className="px-8 py-4 shrink-0 flex items-center gap-2 border-t">
          <Button type="button" variant="outline" onClick={closeEditor}>
            返回列表
          </Button>
          <Button
            type="button"
            onClick={saveLocal}
            disabled={!dirty || loading || saving}
          >
            <Save />
            保存供应商
          </Button>
          {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Key className="size-5" />
            第三方 API
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            保存供应商参数；启用后只影响 Claudinal 新会话，不写入全局 settings.json。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
        <div className="px-8 pb-6 pt-2 w-full space-y-6">
          <section className="rounded-lg border bg-card p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  供应商列表
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  管理可用供应商；启用后，新启动会话会通过运行时配置和本地代理转发。
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <div className="min-w-0">
                <span className="text-muted-foreground">Claude 当前映射：</span>
                <span className="font-medium">{activeTitle}</span>
                <span className="text-muted-foreground"> · {activeSubtitle}</span>
              </div>
            </div>
            {hasLegacyKey && (
              <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                部分供应商的 API Key 以明文存储（钥匙串不可用或上次保存失败）。请重新打开并保存这些供应商，将密钥写入系统钥匙串。
              </div>
            )}
            <div className="flex justify-end gap-2">
              {!activeOfficial && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => activateProvider(OFFICIAL_PROVIDER_ID)}
                  disabled={loading || saving}
                >
                  恢复默认
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={addProvider}>
                <Plus />
                新增供应商
              </Button>
            </div>
            <div className="space-y-3">
              {store.providers.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed text-center">
                  <Key className="mb-3 size-6 text-muted-foreground" />
                  <div className="text-sm font-medium">还没有第三方供应商</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    点击“新增供应商”后再填写并保存供应商配置。
                  </div>
                </div>
              ) : (
                store.providers.map((provider) => (
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
                    onApply={() => activateProvider(provider.id)}
                    applyLabel={
                      store.activeProviderId === provider.id
                        ? "重新启用"
                        : "启用"
                    }
                    busy={loading || saving}
                    onEdit={() => editProvider(provider.id)}
                    onRemove={() => removeProvider(provider.id)}
                  />
                ))
              )}
            </div>
          </section>

        </div>
      </ScrollArea>

      <div className="px-8 py-4 shrink-0 flex items-center gap-2">
        <Button onClick={saveLocal} disabled={!dirty || loading || saving}>
          <Save />
          保存供应商配置
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
  onSelect,
  onApply,
  applyLabel,
  busy,
  onEdit,
  onRemove
}: {
  title: string
  subtitle: string
  active: boolean
  selected: boolean
  onSelect: () => void
  onApply: () => void
  applyLabel: string
  busy?: boolean
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
          : "bg-card hover:border-primary/25 hover:bg-accent/45 focus-within:border-primary/25 focus-within:bg-accent/45"
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
          {initials || "API"}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{title}</div>
          <div className="text-xs text-muted-foreground truncate">
            {subtitle}
          </div>
        </div>
      </button>
      {active && (
        <div className="shrink-0 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
          <CurrentBadge />
        </div>
      )}
      <div
        className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2 pl-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Button type="button" size="sm" onClick={onApply} disabled={busy}>
          <Play className="size-3.5" />
          {applyLabel}
        </Button>
        {onEdit && (
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="size-3.5" />
            编辑
          </Button>
        )}
        {onRemove && (
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
  const filteredOptions = useMemo(
    () => filterModelOptions(options, value),
    [options, value]
  )

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
          placeholder="选择或输入供应商模型 ID"
          className="font-mono text-xs"
        />
        {open && options.length > 0 && (
          <div
            role="listbox"
            className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 shadow-lg"
          >
            {filteredOptions.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                没有匹配的模型
              </div>
            ) : (
              filteredOptions.map((model) => {
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
              })
            )}
          </div>
        )}
      </div>
    </StackField>
  )
}

function compactModelText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function fuzzyIncludes(model: string, query: string): boolean {
  const compactModel = compactModelText(model)
  const compactQuery = compactModelText(query)
  if (!compactQuery) return true
  if (compactModel.includes(compactQuery)) return true
  let index = 0
  for (const char of compactModel) {
    if (char === compactQuery[index]) index += 1
    if (index === compactQuery.length) return true
  }
  return false
}

function modelMatchScore(model: string, query: string): number {
  const normalizedModel = model.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 0
  if (normalizedModel === normalizedQuery) return 0
  if (normalizedModel.startsWith(normalizedQuery)) return 1
  if (normalizedModel.includes(normalizedQuery)) return 2
  if (compactModelText(model).includes(compactModelText(query))) return 3
  return 4
}

function filterModelOptions(options: string[], query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed) return options
  return options
    .map((model, index) => ({
      model,
      index,
      score: modelMatchScore(model, trimmed)
    }))
    .filter((item) => fuzzyIncludes(item.model, trimmed))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.model)
}
