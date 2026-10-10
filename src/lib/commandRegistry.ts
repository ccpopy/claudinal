export interface CommandIdentity { rawToken: string; name: string; arguments: string }

export function parseCommand(text: string): CommandIdentity | null {
  const match = /^\s*(\/([\w.:-]+))(?=\s|$)([\s\S]*)$/.exec(text)
  return match ? { rawToken: match[1], name: match[2], arguments: match[3].trimStart() } : null
}

export type CommandRoute = "message" | "new_conversation" | "permissions" | "cli" | "unconfirmed_cli" | "terminal"
// These commands require an interactive terminal. A cache miss for other
// commands is not evidence that the current CLI cannot execute them.
const TERMINAL_COMMANDS = new Set(["login", "logout", "terminal-setup", "keybindings", "vim"])
export function routeCommand(text: string, knownCommands: readonly string[]): CommandRoute {
  const command = parseCommand(text)
  if (!command) return "message"
  if (["clear", "reset"].includes(command.name) && !command.arguments) return "new_conversation"
  if (command.name === "permissions" && !command.arguments) return "permissions"
  if (TERMINAL_COMMANDS.has(command.name)) return "terminal"
  return knownCommands.includes(command.name) ? "cli" : "unconfirmed_cli"
}
