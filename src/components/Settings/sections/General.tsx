import { useEffect, useState } from "react"
import { Cog, ExternalLink, RefreshCw, Save, Terminal } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { claudeCliVersionInfo, openExternal, type ClaudeCliVersionInfo } from "@/lib/ipc"
import { loadSettings, saveSettings, type AppSettings } from "@/lib/settings"
import { checkForAppUpdate } from "@/lib/updater"
import appPackage from "../../../../package.json"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionFooter,
  SettingsSectionHeader
} from "./layout"

const PERMISSION_OPTIONS = [
  { value: "default", label: "default" },
  { value: "acceptEdits", label: "acceptEdits" },
  { value: "plan", label: "plan" },
  { value: "bypassPermissions", label: "bypassPermissions" }
]

const APP_VERSION = appPackage.version
const GITHUB_REPOSITORY_URL = "https://github.com/ccpopy/claudinal"

type UpdateCheckState =
  | "idle"
  | "checking"
  | "latest"
  | "available"
  | "failed"
  | "dev"

function updateStatusLabel(state: UpdateCheckState, version: string | null) {
  if (state === "checking") return "检查中..."
  if (state === "latest") return "已是最新"
  if (state === "available") return version ? `有新版本 ${version}` : "有新版本"
  if (state === "failed") return "检查失败"
  if (state === "dev") return "开发模式不检查更新"
  return null
}

function updateStatusClass(state: UpdateCheckState) {
  if (state === "latest") return "text-connected"
  if (state === "available") return "text-warn"
  if (state === "failed") return "text-destructive"
  return "text-muted-foreground"
}

export function General() {
  const [cfg, setCfg] = useState<AppSettings>(() => loadSettings())
  const [dirty, setDirty] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateCheckState>("idle")
  const [availableVersion, setAvailableVersion] = useState<string | null>(null)
  const [checkingCli, setCheckingCli] = useState(false)
  const [cliInfo, setCliInfo] = useState<ClaudeCliVersionInfo | null>(null)
  const updateStatus = updateStatusLabel(updateState, availableVersion)

  const update = (patch: Partial<AppSettings>) => {
    setCfg((c) => ({ ...c, ...patch }))
    setDirty(true)
  }

  const save = () => {
    saveSettings(cfg)
    setDirty(false)
    toast.success("已保存")
  }

  const checkUpdate = async () => {
    setCheckingUpdate(true)
    setUpdateState("checking")
    setAvailableVersion(null)
    try {
      const update = await checkForAppUpdate({ throwOnError: true })
      if (import.meta.env.DEV) {
        setUpdateState("dev")
      } else if (update) {
        setAvailableVersion(update.version)
        setUpdateState("available")
      } else {
        setUpdateState("latest")
      }
    } catch {
      setUpdateState("failed")
    } finally {
      setCheckingUpdate(false)
    }
  }

  const checkClaudeCliVersion = async (manual = false) => {
    setCheckingCli(true)
    try {
      const info = await claudeCliVersionInfo()
      setCliInfo(info)
      if (!info.supported) {
        toast.warning(`Claude CLI 版本过低：${info.version}`, {
          description: `最低支持 ${info.min_supported_version}，请运行 ${info.update_command} 升级。`
        })
      } else if (manual) {
        toast.success(`Claude CLI 版本可用：${info.version}`)
      }
    } catch (error) {
      toast.error(`检查 Claude CLI 版本失败: ${String(error)}`)
    } finally {
      setCheckingCli(false)
    }
  }

  useEffect(() => {
    void checkClaudeCliVersion(false)
  }, [])

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={Cog}
        title="常规"
        description="应用启动行为与更新检查。"
      />

      <SettingsSectionBody>
        <section className="space-y-4 rounded-lg border bg-card p-5">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">自动检查更新</Label>
                <div className="text-xs text-muted-foreground mt-0.5">
                  启动时检查 GitHub release，发现新版本时提示安装并重启。
                </div>
              </div>
              <Switch
                checked={cfg.autoCheckUpdate}
                onCheckedChange={(v) => update({ autoCheckUpdate: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-muted-foreground">当前版本</span>
                  <span className="font-mono text-foreground">v{APP_VERSION}</span>
                  {updateStatus && (
                    <span className={updateStatusClass(updateState)}>
                      {updateStatus}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="mt-1 inline-flex max-w-full items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() =>
                    openExternal(GITHUB_REPOSITORY_URL).catch((error) =>
                      toast.error(String(error))
                    )
                  }
                >
                  <ExternalLink className="size-3.5 shrink-0" />
                  <span className="truncate font-mono">{GITHUB_REPOSITORY_URL}</span>
                </button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={checkUpdate}
                disabled={checkingUpdate}
              >
                <RefreshCw className={checkingUpdate ? "animate-spin" : ""} />
                立即检查
              </Button>
            </div>
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label className="text-sm">Claude CLI 版本</Label>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    自动检查本地 Claude CLI 是否满足桌面端最低要求。
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => checkClaudeCliVersion(true)}
                  disabled={checkingCli}
                >
                  <RefreshCw className={checkingCli ? "animate-spin" : ""} />
                  重新检查
                </Button>
              </div>
              {cliInfo && (
                <div
                  className={
                    cliInfo.supported
                      ? "rounded-md border bg-muted/35 px-3 py-2 text-xs text-muted-foreground"
                      : "rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
                  }
                >
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <Terminal className="size-3.5" />
                    <span>{cliInfo.version}</span>
                  </div>
                  <div className="mt-1 font-mono text-[11px]">{cliInfo.path}</div>
                  <div className="mt-2">
                    最低支持：{cliInfo.min_supported_version}
                    {!cliInfo.supported && (
                      <>
                        ；升级命令：
                        <span className="font-mono">{cliInfo.update_command}</span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
            <Separator />
            <div className="space-y-3">
              <div>
                <Label className="text-sm">默认权限模式</Label>
                <div className="text-xs text-muted-foreground mt-0.5">
                  新会话启动时传给 Claude CLI 的 permission-mode。
                </div>
              </div>
              <Select
                value={cfg.defaultPermissionMode}
                onChange={(e) =>
                  update({
                    defaultPermissionMode: e.target
                      .value as AppSettings["defaultPermissionMode"]
                  })
                }
                options={PERMISSION_OPTIONS}
                triggerClassName="max-w-[260px]"
              />
            </div>
            <Separator />
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label className="text-sm">使用 MCP 权限工具</Label>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    关闭时使用内置 stdio 权限弹窗；开启后把权限请求交给 MCP 工具。
                  </div>
                </div>
                <Switch
                  checked={cfg.permissionMcpEnabled}
                  onCheckedChange={(v) => update({ permissionMcpEnabled: v })}
                />
              </div>

              <div className="space-y-3">
                <div>
                  <Label className="text-sm">MCP 权限工具</Label>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    传给 --permission-prompt-tool；默认指向内置 Rust MCP server。
                  </div>
                </div>
                <Input
                  value={cfg.permissionPromptTool}
                  onChange={(e) =>
                    update({ permissionPromptTool: e.target.value })
                  }
                  disabled={!cfg.permissionMcpEnabled}
                  className="font-mono text-xs"
                />
              </div>

              <div className="space-y-3">
                <div>
                  <Label className="text-sm">MCP 配置 JSON</Label>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    传给 --mcp-config；${"{CLAUDINAL_EXE}"} 会在启动时替换为当前应用二进制路径。
                  </div>
                </div>
                <Textarea
                  value={cfg.permissionMcpConfig}
                  onChange={(e) =>
                    update({ permissionMcpConfig: e.target.value })
                  }
                  disabled={!cfg.permissionMcpEnabled}
                  className="min-h-32 font-mono text-xs"
                />
              </div>
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
