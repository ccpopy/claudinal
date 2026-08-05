export interface ClaudeWorkspaceTrustInfo {
  projectKey: string
  trusted: boolean
  allowCount: number
  settingsSources: string[]
  configPath: string
}

export function shouldPromptClaudeWorkspaceTrust(
  info: ClaudeWorkspaceTrustInfo
): boolean {
  return !info.trusted && info.allowCount > 0
}
