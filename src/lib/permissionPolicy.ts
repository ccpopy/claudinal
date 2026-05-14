import type { PermissionRequestPayload } from "@/lib/ipc"
import type { AppSettings } from "@/lib/settings"
import { isAskUserQuestionRequest } from "@/lib/askUserQuestion"

export interface PermissionAutoApproval {
  response: Record<string, unknown>
  reason: string
}

type PermissionMode = AppSettings["defaultPermissionMode"]

const READ_ONLY_TOOLS = new Set([
  "glob",
  "grep",
  "ls",
  "notebookread",
  "read"
])

const EDIT_TOOLS = new Set(["edit", "multiedit", "notebookedit", "write"])

const BUILT_IN_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  ...EDIT_TOOLS,
  "bash",
  "task",
  "todowrite",
  "webfetch",
  "websearch"
])

const DANGEROUS_BASH_COMMANDS = new Set([
  "clean",
  "clear-content",
  "clear-recyclebin",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "rimraf",
  "rm",
  "rmdir",
  "shred",
  "trash"
])

const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"])

export function autoApprovePermissionRequest(
  request: PermissionRequestPayload,
  mode: PermissionMode
): PermissionAutoApproval | null {
  if (isAskUserQuestionRequest(request)) return null

  const toolName = normalizedToolName(request)
  if (!toolName || !isBuiltInPermissionTool(toolName)) return null

  if (mode === "bypassPermissions") {
    return allow(request, "bypassPermissions")
  }

  if (READ_ONLY_TOOLS.has(toolName)) {
    return allow(request, "read-only tool")
  }

  if (EDIT_TOOLS.has(toolName)) {
    return mode === "acceptEdits" ? allow(request, "acceptEdits edit") : null
  }

  if (toolName !== "bash") {
    return null
  }

  const command = requestCommand(request)
  if (!command) return null

  const risk = classifyBashPermissionRisk(command)
  if (risk === "delete-or-clean") return null
  if (risk === "file-edit") {
    return mode === "acceptEdits" ? allow(request, "acceptEdits shell edit") : null
  }
  if (mode === "plan" && risk !== "read-only") return null
  return allow(request, `bash ${risk}`)
}

export function buildPermissionAllowResponse(
  request: PermissionRequestPayload
): Record<string, unknown> {
  const response: Record<string, unknown> = { behavior: "allow" }
  if (request.request.input !== undefined) {
    response.updatedInput = request.request.input
  }
  return response
}

export function classifyBashPermissionRisk(
  command: string
): "read-only" | "safe" | "file-edit" | "delete-or-clean" {
  const tokens = tokenizeCommand(command)
  if (tokens.length === 0) return "safe"
  if (containsDeleteOrCleanCommand(tokens)) return "delete-or-clean"
  if (containsShellFileEdit(command, tokens)) return "file-edit"
  if (isReadOnlyBashCommand(tokens)) return "read-only"
  return "safe"
}

function allow(
  request: PermissionRequestPayload,
  reason: string
): PermissionAutoApproval {
  return {
    response: buildPermissionAllowResponse(request),
    reason
  }
}

function normalizedToolName(request: PermissionRequestPayload): string | null {
  const raw = request.request.tool_name ?? request.request.display_name
  return typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null
}

function isBuiltInPermissionTool(toolName: string): boolean {
  if (toolName.startsWith("mcp__")) return false
  return BUILT_IN_TOOLS.has(toolName)
}

function requestCommand(request: PermissionRequestPayload): string | null {
  const command = request.request.input?.command
  return typeof command === "string" && command.trim() ? command : null
}

function tokenizeCommand(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, "").toLowerCase())
    .filter(Boolean)
}

function containsDeleteOrCleanCommand(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripExecutablePath(tokens[index])
    if (DANGEROUS_BASH_COMMANDS.has(token)) return true
    if (token === "git" && isGitCleanup(tokens[index + 1], tokens.slice(index + 2))) {
      return true
    }
    if (token === "find" && tokens.slice(index + 1).includes("-delete")) {
      return true
    }
    if (token === "cargo" && tokens[index + 1] === "clean") return true
    if (PACKAGE_MANAGERS.has(token) && isPackageCleanup(tokens.slice(index + 1))) {
      return true
    }
  }
  return false
}

function stripExecutablePath(token: string): string {
  const normalized = token.replace(/\\/g, "/")
  return normalized.slice(normalized.lastIndexOf("/") + 1)
}

function isGitCleanup(subcommand: string | undefined, args: string[]): boolean {
  if (subcommand === "clean") return true
  return subcommand === "reset" && args.includes("--hard")
}

function isPackageCleanup(args: string[]): boolean {
  const action = args[0] === "run" ? args[1] : args[0]
  return action === "clean"
}

function containsShellFileEdit(command: string, tokens: string[]): boolean {
  if (/(^|[^<])>(?![>&])|>>/.test(command)) return true
  return tokens.some((token, index) => {
    const commandName = stripExecutablePath(token)
    if (
      [
        "add-content",
        "out-file",
        "set-content",
        "tee",
        "write-output"
      ].includes(commandName)
    ) {
      return true
    }
    if (commandName === "sed" && tokens.slice(index + 1).some(isSedInPlaceArg)) {
      return true
    }
    return false
  })
}

function isSedInPlaceArg(token: string): boolean {
  return token === "-i" || token.startsWith("-i.")
}

function isReadOnlyBashCommand(tokens: string[]): boolean {
  const command = stripExecutablePath(tokens[0])
  if (
    ["cat", "find", "grep", "head", "ls", "pwd", "rg", "tail", "wc"].includes(
      command
    )
  ) {
    return true
  }
  if (command === "git") {
    return isReadOnlyGitCommand(tokens[1] ?? "", tokens.slice(2))
  }
  return false
}

function isReadOnlyGitCommand(subcommand: string, args: string[]): boolean {
  if (args.some((arg) => arg === "--output" || arg.startsWith("--output="))) {
    return false
  }
  if (
    [
      "diff",
      "log",
      "ls-files",
      "rev-list",
      "rev-parse",
      "show",
      "status"
    ].includes(subcommand)
  ) {
    return true
  }
  if (subcommand === "branch") {
    return args.every((arg) =>
      [
        "-a",
        "-r",
        "-v",
        "-vv",
        "--all",
        "--list",
        "--remotes",
        "--show-current",
        "--verbose"
      ].includes(arg)
    )
  }
  if (subcommand === "remote") {
    if (args.length === 0) return true
    if (args.length === 1) return args[0] === "-v"
    return ["show", "get-url"].includes(args[0] ?? "")
  }
  return false
}
