import { invoke } from "@tauri-apps/api/core"
import { invalidateSlashCommandsCache } from "./slashCommands"
import { emitSettingsBus } from "./settingsBus"

export interface InstalledPlugin {
  id: string
  name: string
  marketplace: string
  version: string | null
  scope: string
  install_path: string | null
  project_path: string | null
  installed_at: string | null
  last_updated: string | null
  /** CLI 在当前项目下判定的启用状态；停用插件的技能与命令不会被加载 */
  enabled: boolean
  description: string | null
  author: string | null
  homepage: string | null
  category: string | null
}

export interface MarketplacePlugin {
  name: string
  description: string | null
  author: string | null
  homepage: string | null
  category: string | null
}

export interface Marketplace {
  name: string
  source: string | null
  install_location: string | null
  last_updated: string | null
  plugins: MarketplacePlugin[]
}

export interface Skill {
  name: string
  description: string | null
  /** "user" / "project" / "plugin:<id>" */
  source: string
  path: string
  disable_model_invocation: boolean
  user_invocable: boolean
}

export interface SkillInvocation {
  name: string
  arguments: string
  commandText: string
}

export interface PluginCommandResult {
  stdout: string
  stderr: string
  exit_code: number
}

export interface SkillInstallEntry {
  name: string
  path: string
}

export interface SkillInstallResult {
  installed: SkillInstallEntry[]
}

export type PluginAction =
  | "install"
  | "uninstall"
  | "enable"
  | "disable"
  | "list"
export type MarketplaceAction = "add" | "remove" | "update" | "list"

export type PluginScope = "user" | "project" | "local"
export type SkillScope = "user" | "project"

/** Anthropic 官方插件市场（Claude Code 内置名称与仓库） */
export const OFFICIAL_MARKETPLACE = {
  name: "claude-plugins-official",
  source: "anthropics/claude-plugins-official"
} as const

export async function listInstalledPlugins(cwd?: string | null): Promise<InstalledPlugin[]> {
  return invoke<InstalledPlugin[]>("list_installed_plugins", { cwd: cwd ?? null })
}

export async function listMarketplaces(): Promise<Marketplace[]> {
  return invoke<Marketplace[]>("list_marketplaces")
}

export async function listSkills(cwd?: string | null): Promise<Skill[]> {
  return invoke<Skill[]>("list_skills", { cwd: cwd ?? null })
}

export async function expandSkillCommand(
  cwd: string | null | undefined,
  text: string
): Promise<SkillInvocation | null> {
  return invoke<SkillInvocation | null>("expand_skill_command", {
    cwd: cwd ?? null,
    text
  })
}

export async function installSkillFromPath(
  path: string,
  scope: SkillScope = "user",
  cwd?: string | null,
  overwrite = false
): Promise<SkillInstallResult> {
  return invoke<SkillInstallResult>("install_skill_from_path", {
    args: {
      path,
      scope,
      cwd: cwd ?? null,
      overwrite
    }
  })
}

export async function installBuiltinSkill(
  id: string,
  cwd?: string | null
): Promise<PluginCommandResult> {
  return invoke<PluginCommandResult>("install_builtin_skill", {
    args: { id, cwd: cwd ?? null }
  })
}

interface RunPluginCommandArgs {
  action: string
  kind: "marketplace" | "plugin"
  target?: string | null
  scope?: PluginScope | null
  cwd?: string | null
}

export async function runPluginCommand(
  args: RunPluginCommandArgs
): Promise<PluginCommandResult> {
  const result = await invoke<PluginCommandResult>("run_plugin_command", {
    args: {
      action: args.action,
      kind: args.kind,
      target: args.target ?? null,
      scope: args.scope ?? null,
      cwd: args.cwd ?? null
    }
  })
  invalidateSlashCommandsCache()
  emitSettingsBus("plugins")
  return result
}

export async function addMarketplace(
  ownerRepoOrUrl: string
): Promise<PluginCommandResult> {
  return runPluginCommand({
    kind: "marketplace",
    action: "add",
    target: ownerRepoOrUrl
  })
}

export async function updateMarketplace(
  name: string
): Promise<PluginCommandResult> {
  return runPluginCommand({
    kind: "marketplace",
    action: "update",
    target: name
  })
}

export async function removeMarketplace(
  name: string
): Promise<PluginCommandResult> {
  return runPluginCommand({
    kind: "marketplace",
    action: "remove",
    target: name
  })
}

export async function installPlugin(
  pluginAtMarketplace: string,
  scope: PluginScope = "user",
  cwd?: string | null
): Promise<PluginCommandResult> {
  return runPluginCommand({
    kind: "plugin",
    action: "install",
    target: pluginAtMarketplace,
    scope,
    cwd: cwd ?? null
  })
}

export async function setPluginEnabled(
  pluginAtMarketplace: string,
  enabled: boolean,
  scope: PluginScope,
  cwd?: string | null
): Promise<PluginCommandResult> {
  return runPluginCommand({
    kind: "plugin",
    action: enabled ? "enable" : "disable",
    target: pluginAtMarketplace,
    scope,
    cwd: cwd ?? null
  })
}

export async function uninstallPlugin(
  pluginAtMarketplace: string,
  scope: PluginScope = "user",
  cwd?: string | null
): Promise<PluginCommandResult> {
  return runPluginCommand({
    kind: "plugin",
    action: "uninstall",
    target: pluginAtMarketplace,
    scope,
    cwd: cwd ?? null
  })
}
