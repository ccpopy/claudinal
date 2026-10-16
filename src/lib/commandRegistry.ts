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

// Either tag order; groups: 1 message, 2 name | 3 name, 4 message; 5 args.
const CLI_COMMAND_ENVELOPE = /^\s*(?:<command-message>([^<\n]*)<\/command-message>\s*<command-name>\/?([\w.:-]+)<\/command-name>|<command-name>\/?([\w.:-]+)<\/command-name>\s*<command-message>([^<\n]*)<\/command-message>)(?:\s*<command-args>([\s\S]*)<\/command-args>)?\s*$/

/**
 * The CLI persists a slash input as a command envelope. Decode only when the
 * whole message is exactly that serialization and its name fields agree, so
 * prose that merely mentions these tags stays literal.
 */
export function decodeCliCommandEnvelope(text: string): string | null {
  const match = CLI_COMMAND_ENVELOPE.exec(text)
  if (!match) return null
  const message = (match[1] ?? match[4]).trim()
  const name = match[2] ?? match[3]
  if (!message || (message !== name && !name.endsWith(`:${message}`))) return null
  const args = match[5]?.trim() ?? ""
  return args ? `/${name} ${args}` : `/${name}`
}
