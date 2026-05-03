import { emitSettingsBus } from "@/lib/settingsBus"

const KEY = "claudinal.collaboration.settings"

export type CollabProviderId = "claude" | "codex" | "gemini" | "opencode"

export interface CollabSettings {
  enabled: boolean
  defaultProvider: CollabProviderId
  enabledProviders: Record<CollabProviderId, boolean>
  allowWrites: boolean
  providerPaths: Record<CollabProviderId, string>
  providerResponsibilityScopes: Record<CollabProviderId, string>
  defaultResponsibilityScope: string
  defaultAllowedPaths: string[]
}

export const DEFAULT_COLLAB_SETTINGS: CollabSettings = {
  enabled: false,
  defaultProvider: "claude",
  enabledProviders: {
    claude: true,
    codex: false,
    gemini: false,
    opencode: false
  },
  allowWrites: false,
  providerPaths: {
    claude: "",
    codex: "",
    gemini: "",
    opencode: ""
  },
  providerResponsibilityScopes: {
    claude:
      "在主会话内承担需求拆解和小范围修改，整合外部 Agent 的输出。",
    codex:
      "做代码实现和重构，按 --output-schema 返回结构化结果，写入限定到允许路径。",
    gemini:
      "做长上下文阅读、跨文件分析和评审，默认只读不修改文件。",
    opencode:
      "用已配置的 LLM provider 做替代实现或快速验证，写入限定到允许路径。"
  },
  defaultResponsibilityScope: "只读分析、给出建议，不修改文件。",
  defaultAllowedPaths: []
}

export function loadCollabSettings(): CollabSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return cloneDefault()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return cloneDefault()
    }
    const merged = {
      ...cloneDefault(),
      ...(parsed as Partial<CollabSettings>)
    }
    merged.providerPaths = {
      ...cloneDefault().providerPaths,
      ...((parsed as Partial<CollabSettings>).providerPaths ?? {})
    }
    merged.enabledProviders = {
      ...cloneDefault().enabledProviders,
      ...((parsed as Partial<CollabSettings>).enabledProviders ?? {})
    }
    merged.providerResponsibilityScopes = {
      ...cloneDefault().providerResponsibilityScopes,
      ...((parsed as Partial<CollabSettings>).providerResponsibilityScopes ?? {})
    }
    merged.defaultProvider = normalizeProvider(merged.defaultProvider)
    merged.defaultAllowedPaths = Array.isArray(merged.defaultAllowedPaths)
      ? merged.defaultAllowedPaths.filter((path) => typeof path === "string")
      : []
    return merged
  } catch {
    return cloneDefault()
  }
}

export function saveCollabSettings(settings: CollabSettings) {
  localStorage.setItem(KEY, JSON.stringify(settings))
  emitSettingsBus("settings")
}

export function providerPathEnv(settings: CollabSettings): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [provider, path] of Object.entries(settings.providerPaths)) {
    const trimmed = path.trim()
    if (trimmed) out[provider] = trimmed
  }
  return out
}

export function enabledProviderList(settings: CollabSettings): CollabProviderId[] {
  return (["claude", "codex", "gemini", "opencode"] as CollabProviderId[]).filter(
    (provider) => settings.enabledProviders[provider]
  )
}

function cloneDefault(): CollabSettings {
  return {
    ...DEFAULT_COLLAB_SETTINGS,
    enabledProviders: { ...DEFAULT_COLLAB_SETTINGS.enabledProviders },
    providerPaths: { ...DEFAULT_COLLAB_SETTINGS.providerPaths },
    providerResponsibilityScopes: {
      ...DEFAULT_COLLAB_SETTINGS.providerResponsibilityScopes
    },
    defaultAllowedPaths: [...DEFAULT_COLLAB_SETTINGS.defaultAllowedPaths]
  }
}

function normalizeProvider(value: string): CollabProviderId {
  if (
    value === "claude" ||
    value === "codex" ||
    value === "gemini" ||
    value === "opencode"
  ) {
    return value
  }
  return "codex"
}
