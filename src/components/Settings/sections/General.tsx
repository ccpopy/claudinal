import { useEffect, useRef, useState } from "react"
import { Cog, Download, ExternalLink, RefreshCw, Save, Terminal } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  claudeCliUpdateAvailabilityFromCommandOutput,
  waitForClaudeCliPostCommandVersion,
  type ClaudeCliUpdateAvailability
} from "@/lib/claudeCliUpdate"
import {
  claudeCliVersionInfo,
  installClaudeCli,
  listenClaudeCliCommandProgress,
  openExternal,
  updateClaudeCli,
  type ClaudeCliCommandProgressEvent,
  type ClaudeCliCommandResult,
  type ClaudeCliVersionInfo
} from "@/lib/ipc"
import { buildProxyEnv, loadProxyAsync } from "@/lib/proxy"
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

type CliCommandProgressStatus = "running" | "completed" | "failed"

interface CliCommandProgressChunk {
  stream: ClaudeCliCommandProgressEvent["stream"]
  chunk: string
}

interface CliCommandProgressState {
  command: string
  status: CliCommandProgressStatus
  chunks: CliCommandProgressChunk[]
  error: string | null
  exitCode: number | null
}

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

function cliCommandProgressStatusLabel(status: CliCommandProgressStatus) {
  if (status === "running") return "执行中..."
  if (status === "completed") return "已完成"
  return "失败"
}

function cliCommandProgressStatusClass(status: CliCommandProgressStatus) {
  if (status === "completed") return "text-connected"
  if (status === "failed") return "text-destructive"
  return "text-muted-foreground"
}

function cliCommandDescription(result: {
  command: string
  stdout: string
  stderr: string
}): string {
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n")
  return output ? `${result.command}\n${output.slice(0, 360)}` : result.command
}

function cliUpdateAvailabilityDetail(
  availability: ClaudeCliUpdateAvailability
): string {
  return [
    availability.packageManager
      ? `当前 Claude CLI 由 ${availability.packageManager} 管理。`
      : null,
    availability.updateCommand ? `建议命令：${availability.updateCommand}` : null
  ]
    .filter(Boolean)
    .join("\n")
}

function isCliUpdateAvailabilityPending(
  availability: ClaudeCliUpdateAvailability,
  observedVersion: string | null
): boolean {
  if (!observedVersion) return false
  return availability.currentVersion
    ? observedVersion === availability.currentVersion
    : observedVersion !== availability.availableVersion
}

async function claudeCliCommandEnv(): Promise<Record<string, string> | null> {
  const env = buildProxyEnv(await loadProxyAsync())
  return Object.keys(env).length > 0 ? env : null
}

function createClaudeCliProgressEventName(): string {
  return `claudinal://claude-cli-command/${globalThis.crypto.randomUUID()}`
}

export function General() {
  const [cfg, setCfg] = useState<AppSettings>(() => loadSettings())
  const [dirty, setDirty] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateCheckState>("idle")
  const [availableVersion, setAvailableVersion] = useState<string | null>(null)
  const [checkingCli, setCheckingCli] = useState(false)
  const [installingCli, setInstallingCli] = useState(false)
  const [updatingCli, setUpdatingCli] = useState(false)
  const [cliInfo, setCliInfo] = useState<ClaudeCliVersionInfo | null>(null)
  const [cliUpdateAvailability, setCliUpdateAvailability] =
    useState<ClaudeCliUpdateAvailability | null>(null)
  const [cliCommandProgress, setCliCommandProgress] =
    useState<CliCommandProgressState | null>(null)
  const cliCommandProgressRef = useRef<HTMLPreElement | null>(null)
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

  const checkClaudeCliVersion = async (
    manual = false,
    notifyUnsupported = true
  ): Promise<ClaudeCliVersionInfo | null> => {
    if (manual) {
      setCliCommandProgress(null)
    }
    setCheckingCli(true)
    try {
      const env = await claudeCliCommandEnv()
      const info = await readClaudeCliVersion(env)
      if (!info.installed) {
        if (manual) {
          toast.warning("未检测到 Claude CLI", {
            description: `可点击安装按钮执行：${info.install_command}`
          })
        }
      } else if (!info.supported && notifyUnsupported) {
        toast.warning(`Claude CLI 版本过低：${info.version}`, {
          description: `最低支持 ${info.min_supported_version}，请运行 ${info.update_command} 升级。`
        })
      } else if (manual) {
        toast.success(`Claude CLI 版本可用：${info.version}`)
      }
      return info
    } catch (error) {
      toast.error(`检查 Claude CLI 版本失败: ${String(error)}`)
      return null
    } finally {
      setCheckingCli(false)
    }
  }

  const readClaudeCliVersion = async (
    env: Record<string, string> | null = null
  ): Promise<ClaudeCliVersionInfo> => {
    const info = await claudeCliVersionInfo(env)
    setCliInfo(info)
    setCliUpdateAvailability((availability) => {
      if (!availability) return null
      if (!info.installed || !info.version) return null
      return isCliUpdateAvailabilityPending(availability, info.version)
        ? availability
        : null
    })
    return info
  }

  const verifyCliAfterCommand = (
    previousVersion: string | null,
    env: Record<string, string> | null
  ) =>
    waitForClaudeCliPostCommandVersion(
      () => readClaudeCliVersion(env),
      previousVersion
    )

  const appendCliCommandProgress = (event: ClaudeCliCommandProgressEvent) => {
    setCliCommandProgress((progress) => {
      if (!progress) return progress
      const last = progress.chunks[progress.chunks.length - 1]
      const chunks =
        last?.stream === event.stream
          ? [
              ...progress.chunks.slice(0, -1),
              { stream: event.stream, chunk: last.chunk + event.chunk }
            ]
          : [...progress.chunks, event]
      return { ...progress, chunks }
    })
  }

  const runClaudeCliCommandWithProgress = async (
    command: string,
    run: (progressEvent: string) => Promise<ClaudeCliCommandResult>
  ): Promise<ClaudeCliCommandResult> => {
    const progressEvent = createClaudeCliProgressEventName()
    setCliCommandProgress({
      command,
      status: "running",
      chunks: [],
      error: null,
      exitCode: null
    })

    let unlisten: (() => void) | null = null
    try {
      unlisten = await listenClaudeCliCommandProgress(
        progressEvent,
        appendCliCommandProgress
      )
      const result = await run(progressEvent)
      setCliCommandProgress((progress) =>
        progress
          ? {
              ...progress,
              command: result.command || progress.command,
              status: "completed",
              exitCode: result.exit_code
            }
          : progress
      )
      return result
    } catch (error) {
      setCliCommandProgress((progress) =>
        progress
          ? {
              ...progress,
              status: "failed",
              error: String(error)
            }
          : progress
      )
      throw error
    } finally {
      unlisten?.()
    }
  }

  const installCli = async () => {
    setInstallingCli(true)
    try {
      const env = await claudeCliCommandEnv()
      const result = await runClaudeCliCommandWithProgress(
        cliInfo?.install_command ?? "Claude CLI install",
        (progressEvent) => installClaudeCli(env, progressEvent)
      )
      const info = await verifyCliAfterCommand(null, env)
      if (!info.installed) {
        toast.error("Claude CLI 安装命令已完成，但复查时仍未检测到 CLI", {
          description: cliCommandDescription(result)
        })
      } else if (!info.supported) {
        toast.error(`Claude CLI 安装后版本仍过低：${info.version}`, {
          description: `最低支持 ${info.min_supported_version}\n${cliCommandDescription(result)}`
        })
      } else {
        toast.success(`Claude CLI 已安装：${info.version}`, {
          description: cliCommandDescription(result)
        })
      }
    } catch (error) {
      toast.error(`安装 Claude CLI 失败: ${String(error)}`)
    } finally {
      setInstallingCli(false)
    }
  }

  const updateCli = async () => {
    setUpdatingCli(true)
    try {
      const env = await claudeCliCommandEnv()
      const beforeInfo = cliInfo?.version ? cliInfo : await readClaudeCliVersion(env)
      const previousVersion = beforeInfo.version ?? null
      const result = await runClaudeCliCommandWithProgress(
        beforeInfo.update_command,
        (progressEvent) => updateClaudeCli(env, progressEvent)
      )
      const detectedUpdate =
        claudeCliUpdateAvailabilityFromCommandOutput(result.stdout, result.stderr)
      const info = await verifyCliAfterCommand(previousVersion, env)
      setCliUpdateAvailability(
        detectedUpdate &&
          info.installed &&
          isCliUpdateAvailabilityPending(detectedUpdate, info.version)
          ? detectedUpdate
          : null
      )
      if (!info.installed) {
        toast.error("Claude CLI 更新命令已完成，但复查时未检测到 CLI", {
          description: cliCommandDescription(result)
        })
      } else if (!info.supported) {
        toast.error(`Claude CLI 更新后仍是旧版本：${info.version}`, {
          description: `最低支持 ${info.min_supported_version}\n${cliCommandDescription(result)}`
        })
      } else if (
        detectedUpdate &&
        isCliUpdateAvailabilityPending(detectedUpdate, info.version)
      ) {
        const detail = cliUpdateAvailabilityDetail(detectedUpdate)
        toast.warning(`检测到 Claude CLI 可更新到：${detectedUpdate.availableVersion}`, {
          description: [detail, cliCommandDescription(result)]
            .filter(Boolean)
            .join("\n")
        })
      } else if (previousVersion && info.version === previousVersion) {
        toast.warning(`Claude CLI 更新后复查版本仍为：${info.version}`, {
          description: `已等待 Claude CLI 写入新版本后复查，版本仍未变化。\n${cliCommandDescription(result)}`
        })
      } else {
        toast.success(`Claude CLI 已更新：${info.version}`, {
          description: cliCommandDescription(result)
        })
      }
    } catch (error) {
      toast.error(`更新 Claude CLI 失败: ${String(error)}`)
    } finally {
      setUpdatingCli(false)
    }
  }

  useEffect(() => {
    void checkClaudeCliVersion(false)
  }, [])

  useEffect(() => {
    const element = cliCommandProgressRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [cliCommandProgress?.chunks, cliCommandProgress?.status])

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
                    自动检查本地 Claude CLI 是否满足桌面端最低要求；未安装时可按官方 npm 命令安装。
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => checkClaudeCliVersion(true)}
                    disabled={checkingCli || installingCli || updatingCli}
                  >
                    <RefreshCw className={checkingCli ? "animate-spin" : ""} />
                    重新检查
                  </Button>
                  {cliInfo && !cliInfo.installed && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={installCli}
                      disabled={checkingCli || installingCli || updatingCli}
                    >
                      <Download className={installingCli ? "animate-pulse" : ""} />
                      一键安装
                    </Button>
                  )}
                  {cliInfo?.installed && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={updateCli}
                      disabled={checkingCli || installingCli || updatingCli}
                    >
                      <RefreshCw className={updatingCli ? "animate-spin" : ""} />
                      执行更新
                    </Button>
                  )}
                </div>
              </div>
              {cliInfo && (
                <div
                  className={
                    !cliInfo.installed
                      ? "rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
                      : cliInfo.supported
                      ? "rounded-md border bg-muted/35 px-3 py-2 text-xs text-muted-foreground"
                      : "rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
                  }
                >
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <Terminal className="size-3.5" />
                    <span>{cliInfo.installed ? cliInfo.version : "未安装"}</span>
                  </div>
                  {cliInfo.path && (
                    <div className="mt-1 font-mono text-[11px]">{cliInfo.path}</div>
                  )}
                  <div className="mt-2 space-y-1">
                    <div>最低支持：{cliInfo.min_supported_version}</div>
                    {!cliInfo.installed ? (
                      <>
                        <div>
                          安装命令：
                          <span className="font-mono">{cliInfo.install_command}</span>
                        </div>
                        <button
                          type="button"
                          className="inline-flex max-w-full items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() =>
                            openExternal(cliInfo.setup_url).catch((error) =>
                              toast.error(String(error))
                            )
                          }
                        >
                          <ExternalLink className="size-3.5 shrink-0" />
                          <span className="truncate font-mono">{cliInfo.setup_url}</span>
                        </button>
                      </>
                    ) : (
                      <div>
                        更新命令：
                        <span className="font-mono">{cliInfo.update_command}</span>
                      </div>
                    )}
                    {cliInfo.installed && cliUpdateAvailability && (
                      <div className="rounded-sm border border-warn/30 bg-warn/10 px-2 py-1 text-warn">
                        <div>
                          检测到可更新：
                          <span className="font-mono">
                            {cliUpdateAvailability.currentVersion ?? cliInfo.version}
                          </span>
                          {" -> "}
                          <span className="font-mono">
                            {cliUpdateAvailability.availableVersion}
                          </span>
                        </div>
                        {cliUpdateAvailability.packageManager && (
                          <div>
                            管理方式：{cliUpdateAvailability.packageManager}
                          </div>
                        )}
                        {cliUpdateAvailability.updateCommand && (
                          <div>
                            建议命令：
                            <span className="font-mono">
                              {cliUpdateAvailability.updateCommand}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {cliCommandProgress && (
                <div className="rounded-md border bg-background px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">
                      <Terminal className="size-3.5 shrink-0" />
                      <span className="shrink-0">命令输出</span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {cliCommandProgress.command}
                      </span>
                    </div>
                    <span
                      className={cliCommandProgressStatusClass(
                        cliCommandProgress.status
                      )}
                    >
                      {cliCommandProgressStatusLabel(cliCommandProgress.status)}
                    </span>
                  </div>
                  <pre
                    ref={cliCommandProgressRef}
                    className="mt-2 max-h-44 overflow-y-auto rounded-sm bg-muted/35 px-2 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
                  >
                    {cliCommandProgress.chunks.length === 0 ? (
                      <span className="text-muted-foreground">
                        {cliCommandProgress.status === "running"
                          ? "等待命令输出..."
                          : "命令未输出 stdout/stderr。"}
                      </span>
                    ) : (
                      cliCommandProgress.chunks.map((chunk, index) => (
                        <span
                          key={`${chunk.stream}-${index}`}
                          className={
                            chunk.stream === "stderr"
                              ? "text-warn"
                              : "text-foreground"
                          }
                        >
                          {chunk.chunk}
                        </span>
                      ))
                    )}
                  </pre>
                  {cliCommandProgress.status === "failed" &&
                    cliCommandProgress.error && (
                      <div className="mt-2 break-words text-destructive">
                        {cliCommandProgress.error}
                      </div>
                    )}
                </div>
              )}
            </div>
            <Separator />
            <div className="space-y-3">
              <div>
                <Label className="text-sm">默认权限模式</Label>
                <div className="text-xs text-muted-foreground mt-0.5">
                  新会话启动时传给 Claude CLI 的 permission-mode。Composer 内的「计划模式」和权限模式选择器是会话级临时覆盖，不会写回这里。
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
