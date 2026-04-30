import { invoke } from "@tauri-apps/api/core"

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

export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  return invoke<InstalledPlugin[]>("list_installed_plugins")
}

export async function listMarketplaces(): Promise<Marketplace[]> {
  return invoke<Marketplace[]>("list_marketplaces")
}

export async function listSkills(cwd?: string | null): Promise<Skill[]> {
  return invoke<Skill[]>("list_skills", { cwd: cwd ?? null })
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
  return invoke<PluginCommandResult>("run_plugin_command", {
    args: {
      action: args.action,
      kind: args.kind,
      target: args.target ?? null,
      scope: args.scope ?? null,
      cwd: args.cwd ?? null
    }
  })
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
