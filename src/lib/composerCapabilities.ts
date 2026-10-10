import type { CliCapabilities, SessionSettingsPatch } from "./ipc"
import type { ComposerFeatureCapabilities, ComposerRuntimeConfig } from "./composerPrefs"
import type { InstalledCliSnapshot } from "./installedCliCapabilities"

/** Preflight belongs to the next launch; only session IPC can identify a run. */
export function capturedRuntimeCapabilities(observed: CliCapabilities | null): CliCapabilities {
  if (observed) return observed
  return {
    executablePath: "", resolvedVersion: "unknown", installKind: "unknown", fingerprint: "",
    checkedAt: new Date().toISOString(), certification: "Captured runtime capabilities unavailable", evidence: {},
    coreStream: "unknown", userMessageReplay: "unknown", midTurnInput: "unknown", hookEvents: "unknown",
    headlessModelCommand: "unknown", nativeUltracodeEffort: "unknown", forkSession: "unknown", interrupt: "unknown",
    subagentTextForwarding: "unknown", fileCheckpoints: "unknown", runtimeSettingsControl: "unknown",
    independentUltracode: "unknown", modelSettings: "unknown", autoCompactWindow: "unknown", headlessFastMode: "unknown",
    promptSuggestions: "unknown", contextUsageSummary: "unknown"
  }
}

export function composerFeatureCapabilities(installed: InstalledCliSnapshot, runtime?: { capabilities: CliCapabilities; apiLaunchProfileKey: string }, selectedProfileKey?: string): ComposerFeatureCapabilities {
  const capabilities = runtime && runtime.apiLaunchProfileKey === selectedProfileKey ? runtime.capabilities : installed.capabilities
  const reason = !capabilities
    ? installed.status === "loading" ? "正在检测所选 CLI，请稍候" : installed.error === "timeout" ? "CLI 检测超时，可在运行环境诊断中重试" : "所选 CLI 能力尚未确认，可在运行环境诊断中检测"
    : capabilities.settingsProbeReason === "timeout" ? "CLI 设置控制检测超时，可在运行环境诊断中重试"
      : capabilities.runtimeSettingsControl !== "supported" ? "此 CLI 的设置控制尚未确认，实际响应优先于版本提示" : undefined
  const ultra = capabilities?.independentUltracode === "supported" && capabilities.runtimeSettingsControl === "supported"
  const fast = capabilities?.headlessFastMode === "supported" && capabilities.runtimeSettingsControl === "supported"
  const compact = capabilities?.autoCompactWindow === "supported"
  return {
    independentUltracode: ultra, fastMode: fast, autoCompactWindow: compact,
    ultracodeReason: ultra ? undefined : reason ?? (capabilities?.independentUltracode === "unsupported" ? "所选 CLI 未接受独立 Ultracode 开关" : "独立 Ultracode 开关尚未确认"),
    fastModeReason: fast ? undefined : reason ?? (capabilities?.headlessFastMode === "unsupported" ? "所选 CLI 未确认 headless Fast 控制" : "headless Fast 控制尚未确认"),
    autoCompactWindowReason: compact ? undefined : "所选 CLI 尚未确认按模型设置自动压缩窗口"
  }
}

/** Pass explicit selections through for Anthropic gateways, with no auth bypass. */
export function filterComposerRuntimePatch(patch: SessionSettingsPatch, capabilities: CliCapabilities, openaiCompatible = false): SessionSettingsPatch {
  const result = { ...patch }
  if (openaiCompatible || capabilities.runtimeSettingsControl !== "supported" || capabilities.independentUltracode !== "supported") { delete result.ultracode; delete result.enableWorkflows }
  if (openaiCompatible || capabilities.runtimeSettingsControl !== "supported" || capabilities.headlessFastMode !== "supported") delete result.fastMode
  if (openaiCompatible || capabilities.autoCompactWindow !== "supported") delete result.modelSettings
  return result
}

const FAST_REASONS: Readonly<Record<string, string>> = {
  not_first_party: "当前提供商或账号路径未获 Fast 授权；请确认网关与上游支持",
  model_not_allowed: "当前模型不支持 Fast；请选择 CLI 支持的 Opus 模型",
  extra_usage_disabled: "额外用量未启用；请检查账号的 Usage credits / 额外用量设置",
  sdk_opt_in_required: "CLI 尚未收到本会话 Fast 授权；请显式开启 Fast 并等待回读",
  network_error: "Fast 资格检查失败；请检查连接与网关兼容性",
  disabled_by_env: "Fast 被运行环境禁用；请检查 CLI 或组织配置",
  pending: "Fast 资格仍在检查中", free: "当前免费账号不满足 Fast 条件",
  preference: "CLI 当前偏好未启用 Fast", unknown: "CLI 未说明具体禁用原因"
}
export function fastModeStatusText(actual?: ComposerRuntimeConfig | null, pending = false): string {
  if (pending) return "待应用并回读确认"
  const state = actual?.fastModeState
  const label = state === "on" ? "CLI 已开启" : state === "cooldown" ? "冷却中，CLI 暂用标准速度" : state === "off" ? "CLI 已关闭" : "尚未确认"
  return actual?.fastModeDisabledReason ? `${label}；${FAST_REASONS[actual.fastModeDisabledReason] ?? FAST_REASONS.unknown}` : label
}

export function ultracodeStatusText(actual?: ComposerRuntimeConfig | null, pending = false): string {
  const flag = (value: boolean | undefined) => value === true ? "是" : value === false ? "否" : "待确认"
  return `${pending ? "待应用；" : ""}CLI 请求：${flag(actual?.ultracodeRequested)} · 可用：${flag(actual?.ultracodeAvailable)} · 生效：${flag(actual?.ultracode)}`
}
