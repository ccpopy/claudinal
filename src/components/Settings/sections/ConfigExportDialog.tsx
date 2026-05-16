import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, Clipboard, Download, EyeOff } from "lucide-react"
import { save as saveDialog } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import { Breadcrumb, BreadcrumbItem, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { writeTextFile } from "@/lib/ipc"

interface Props {
  settings: Record<string, unknown>
  onBack: () => void
}

interface GroupDef {
  id: string
  label: string
  keys: string[]
}

// 分组定义参考官方 settings.json：https://code.claude.com/docs/en/settings
const GROUPS: GroupDef[] = [
  {
    id: "credentials",
    label: "凭据 / 环境（敏感）",
    keys: [
      "env",
      "apiKeyHelper",
      "otelHeadersHelper",
      "awsAuthRefresh",
      "awsCredentialExport"
    ]
  },
  {
    id: "model",
    label: "模型与行为",
    keys: [
      "model",
      "effortLevel",
      "alwaysThinkingEnabled",
      "language",
      "outputStyle",
      "autoCompactEnabled",
      "editorMode",
      "tui",
      "viewMode",
      "modelOverrides",
      "availableModels"
    ]
  },
  {
    id: "git",
    label: "Git 提交",
    keys: [
      "attribution",
      "includeGitInstructions",
      "prUrlTemplate"
    ]
  },
  {
    id: "statusline",
    label: "状态栏 / 钩子",
    keys: [
      "statusLine",
      "hooks",
      "disableAllHooks",
      "allowedHttpHookUrls",
      "httpHookAllowedEnvVars",
      "spinnerTipsEnabled",
      "spinnerTipsOverride",
      "spinnerVerbs",
      "terminalProgressBarEnabled"
    ]
  },
  {
    id: "permissions",
    label: "权限",
    keys: [
      "permissions",
      "skipDangerousModePermissionPrompt",
      "disableAutoMode",
      "autoMode",
      "useAutoModeDuringPlan"
    ]
  },
  {
    id: "mcp",
    label: "MCP / Plugin / Agents",
    keys: [
      "enableAllProjectMcpServers",
      "enabledMcpjsonServers",
      "disabledMcpjsonServers",
      "agent",
      "enabledPlugins",
      "extraKnownMarketplaces"
    ]
  },
  {
    id: "misc",
    label: "沙箱 / 更新 / 登录 / 其他",
    keys: [
      "sandbox",
      "autoUpdatesChannel",
      "minimumVersion",
      "fastModePerSessionOptIn",
      "forceLoginMethod",
      "forceLoginOrgUUID",
      "cleanupPeriodDays",
      "defaultShell",
      "disableDeepLinkRegistration",
      "showClearContextOnPlanAccept",
      "sshConfigs",
      "teammateMode",
      "worktree"
    ]
  }
]

// 默认不勾选的敏感顶层字段 — 用户需手动开启
const SENSITIVE_TOP_KEYS = new Set([
  "apiKeyHelper",
  "otelHeadersHelper",
  "awsAuthRefresh",
  "awsCredentialExport"
])
const DEPRECATED_TOP_KEYS = new Set(["includeCoAuthoredBy"])

// env 下默认勾选的字段（其余默认不勾选）
const DEFAULT_ENV_KEYS = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"])

// 启用脱敏时，需要被遮盖的字段集合
const MASK_TOP_KEYS = new Set(["apiKeyHelper", "otelHeadersHelper"])
const MASK_ENV_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "ANTHROPIC_API_KEY"
])

function maskString(value: string): string {
  if (!value) return value
  // URL：保留协议 + 主机前缀
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value)
      const host = u.host
      const hostHead = host.length > 4 ? host.slice(0, 4) : host
      return `${u.protocol}//${hostHead}***`
    } catch {
      // URL 解析失败 → 走通用逻辑
    }
  }
  if (value.length <= 8) return "***"
  return `${value.slice(0, 4)}***${value.slice(-4)}`
}

function maskValue(v: unknown): unknown {
  if (typeof v === "string") return maskString(v)
  return v
}

function previewOf(v: unknown): string {
  if (v == null) return "—"
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function ConfigExportPage({ settings, onBack }: Props) {
  const settingsKeys = useMemo(
    () => Object.keys(settings).filter((k) => !DEPRECATED_TOP_KEYS.has(k)).sort(),
    [settings]
  )

  const envObj = useMemo(() => {
    const e = (settings as { env?: unknown }).env
    return e && typeof e === "object" ? (e as Record<string, unknown>) : null
  }, [settings])

  const envKeys = useMemo(
    () => (envObj ? Object.keys(envObj).sort() : []),
    [envObj]
  )

  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [envSelected, setEnvSelected] = useState<Record<string, boolean>>({})
  const [maskSensitive, setMaskSensitive] = useState(true)

  // 进入导出页时按规则初始化默认勾选
  useEffect(() => {
    const next: Record<string, boolean> = {}
    for (const k of settingsKeys) {
      next[k] = !SENSITIVE_TOP_KEYS.has(k)
    }
    setSelected(next)
    const envNext: Record<string, boolean> = {}
    for (const k of envKeys) {
      envNext[k] = DEFAULT_ENV_KEYS.has(k)
    }
    setEnvSelected(envNext)
    setMaskSensitive(true)
  }, [settingsKeys, envKeys])

  // 已知字段按分组归类，未识别的统一放「其他」分组
  const groupedKeys = useMemo(() => {
    const known = new Set(GROUPS.flatMap((g) => g.keys))
    const groups = GROUPS.map((g) => ({
      ...g,
      keys: g.keys.filter((k) => settingsKeys.includes(k))
    })).filter((g) => g.keys.length > 0)
    const others = settingsKeys.filter((k) => !known.has(k))
    if (others.length > 0) {
      groups.push({ id: "_other", label: "其他", keys: others })
    }
    return groups
  }, [settingsKeys])

  const setAll = (value: boolean) => {
    setSelected(Object.fromEntries(settingsKeys.map((k) => [k, value])))
    if (envObj) {
      setEnvSelected(Object.fromEntries(envKeys.map((k) => [k, value])))
    }
  }

  const buildPayload = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const k of settingsKeys) {
      if (!selected[k]) continue
      // env：仅保留勾选的子键
      if (k === "env" && envObj) {
        const sub: Record<string, unknown> = {}
        for (const ek of envKeys) {
          if (!envSelected[ek]) continue
          let v = envObj[ek]
          if (maskSensitive && MASK_ENV_KEYS.has(ek)) v = maskValue(v)
          sub[ek] = v
        }
        if (Object.keys(sub).length > 0) out.env = sub
        continue
      }
      let v = (settings as Record<string, unknown>)[k]
      if (maskSensitive && MASK_TOP_KEYS.has(k)) v = maskValue(v)
      // 深拷贝其余复合值，避免外部引用被改
      if (v !== null && typeof v === "object") {
        try {
          v = JSON.parse(JSON.stringify(v))
        } catch {
          // 序列化失败 → 原样保留
        }
      }
      out[k] = v
    }
    return out
  }

  const exportJson = (): string => JSON.stringify(buildPayload(), null, 2)

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(exportJson())
      toast.success("已复制到剪贴板")
    } catch (e) {
      toast.error(`复制失败: ${String(e)}`)
    }
  }

  const exportToFile = async () => {
    try {
      const path = await saveDialog({
        defaultPath: "claudinal-settings.json",
        filters: [{ name: "JSON", extensions: ["json"] }]
      })
      if (!path) return
      await writeTextFile(path, exportJson())
      toast.success(`已导出到 ${path}`)
    } catch (e) {
      toast.error(`导出失败: ${String(e)}`)
    }
  }

  const totalSelected =
    Object.values(selected).filter(Boolean).length +
    Object.values(envSelected).filter(Boolean).length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-8 pb-4 pt-8">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            返回
          </button>
          <Breadcrumb>
            <BreadcrumbItem onClick={onBack}>配置</BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem current>导出配置</BreadcrumbItem>
          </Breadcrumb>
        </div>
        <div className="mt-4 min-w-0">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Download className="size-4" />
            导出配置
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            勾选要分享的字段。敏感字段（base url / token / 密钥助手）默认脱敏处理。
          </p>
          <div className="flex items-center justify-between gap-3 mt-4 flex-wrap">
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
                全选
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAll(false)}>
                全不选
              </Button>
            </div>
            <label className="flex items-center gap-2 text-xs cursor-pointer min-w-0">
              <EyeOff className="size-3.5 text-muted-foreground" />
              <span>脱敏敏感字段</span>
              <Switch
                checked={maskSensitive}
                onCheckedChange={setMaskSensitive}
              />
            </label>
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="min-w-0 px-8 pb-6 space-y-4">
          {groupedKeys.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-8">
              settings.json 中没有任何字段。
            </div>
          )}
          {groupedKeys.map((g) => (
            <section
              key={g.id}
              className="min-w-0 overflow-hidden rounded-lg border bg-card p-4 space-y-3"
            >
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {g.label}
              </div>
              <div className="space-y-2">
                {g.keys.map((k) =>
                  k === "env" && envObj ? (
                    <EnvBlock
                      key={k}
                      envObj={envObj}
                      envKeys={envKeys}
                      envSelected={envSelected}
                      setEnvSelected={setEnvSelected}
                      topSelected={!!selected.env}
                      setTopSelected={(v) =>
                        setSelected((s) => ({ ...s, env: v }))
                      }
                      maskSensitive={maskSensitive}
                    />
                  ) : (
                    <FieldRow
                      key={k}
                      name={k}
                      value={(settings as Record<string, unknown>)[k]}
                      checked={!!selected[k]}
                      onCheckedChange={(v) =>
                        setSelected((s) => ({ ...s, [k]: v }))
                      }
                      sensitive={MASK_TOP_KEYS.has(k)}
                      masked={maskSensitive && MASK_TOP_KEYS.has(k)}
                    />
                  )
                )}
              </div>
            </section>
          ))}
        </div>
      </ScrollArea>

      <div className="min-w-0 px-8 py-4 border-t flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">
          已选 {totalSelected} 项
        </span>
        <div className="flex items-center justify-end gap-2 flex-wrap">
          <Button variant="outline" onClick={copyToClipboard}>
            <Clipboard className="size-3.5" />
            复制到剪贴板
          </Button>
          <Button onClick={exportToFile}>
            <Download className="size-3.5" />
            导出为 JSON
          </Button>
        </div>
      </div>
    </div>
  )
}

function FieldRow({
  name,
  value,
  checked,
  onCheckedChange,
  sensitive,
  masked
}: {
  name: string
  value: unknown
  checked: boolean
  onCheckedChange: (v: boolean) => void
  sensitive?: boolean
  masked?: boolean
}) {
  const previewRaw = previewOf(value)
  const preview = masked && typeof value === "string" ? maskString(value) : previewRaw
  return (
    <div className="flex items-center gap-3 min-w-0">
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
      <Label className="font-mono text-xs flex-1 min-w-0 truncate">
        {name}
        {sensitive && (
          <span className="ml-1 inline-block rounded bg-warn/20 text-warn px-1 py-0.5 text-[10px] font-sans align-middle">
            敏感
          </span>
        )}
      </Label>
      <code className="min-w-0 max-w-[45%] truncate text-[11px] text-muted-foreground">
        {preview}
      </code>
    </div>
  )
}

function EnvBlock({
  envObj,
  envKeys,
  envSelected,
  setEnvSelected,
  topSelected,
  setTopSelected,
  maskSensitive
}: {
  envObj: Record<string, unknown>
  envKeys: string[]
  envSelected: Record<string, boolean>
  setEnvSelected: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  topSelected: boolean
  setTopSelected: (v: boolean) => void
  maskSensitive: boolean
}) {
  if (envKeys.length === 0) {
    return (
      <FieldRow
        name="env"
        value={{}}
        checked={topSelected}
        onCheckedChange={setTopSelected}
      />
    )
  }
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-dashed p-3 space-y-2">
      <div className="flex items-center gap-3 min-w-0">
        <Switch checked={topSelected} onCheckedChange={setTopSelected} />
        <Label className="font-mono text-xs flex-1 min-w-0">
          env
          <span className="ml-2 text-[10px] font-sans text-muted-foreground">
            （展开下面的子项分别勾选）
          </span>
        </Label>
      </div>
      <Separator />
      <div className="space-y-1.5 pl-1">
        {envKeys.map((ek) => {
          const isSensitive = MASK_ENV_KEYS.has(ek)
          const masked = maskSensitive && isSensitive
          const raw = envObj[ek]
          const preview = masked && typeof raw === "string" ? maskString(raw) : previewOf(raw)
          return (
            <div key={ek} className="flex items-center gap-3 min-w-0">
              <Switch
                checked={!!envSelected[ek]}
                onCheckedChange={(v) =>
                  setEnvSelected((s) => ({ ...s, [ek]: v }))
                }
                disabled={!topSelected}
              />
              <Label className="font-mono text-[11px] flex-1 min-w-0 truncate">
                env.{ek}
                {isSensitive && (
                  <span className="ml-1 inline-block rounded bg-warn/20 text-warn px-1 py-0.5 text-[10px] font-sans align-middle">
                    敏感
                  </span>
                )}
              </Label>
              <code className="min-w-0 max-w-[45%] truncate text-[11px] text-muted-foreground">
                {preview}
              </code>
            </div>
          )
        })}
      </div>
    </div>
  )
}
