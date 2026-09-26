export interface CommandIdentity { rawToken: string; name: string; arguments: string }

export function parseCommand(text: string): CommandIdentity | null {
  const match = /^\s*(\/([\w.:-]+))(?=\s|$)([\s\S]*)$/.exec(text)
  return match ? { rawToken: match[1], name: match[2], arguments: match[3].trimStart() } : null
}

export type CommandRoute = "message" | "new_conversation" | "permissions" | "cli" | "preview" | "confirm_text"
export function routeCommand(text: string, runtimeCommands: readonly string[], previewCommands: readonly string[]): CommandRoute {
  const command = parseCommand(text)
  if (!command) return "message"
  if (["clear", "reset"].includes(command.name) && !command.arguments) return "new_conversation"
  if (command.name === "permissions" && !command.arguments) return "permissions"
  return runtimeCommands.includes(command.name) ? "cli" : previewCommands.includes(command.name) ? "preview" : "confirm_text"
}
