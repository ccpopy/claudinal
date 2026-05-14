import type { PermissionRequestPayload } from "@/lib/ipc"

const KEY = "claudinal.permission-memory.v1"
const UNSAFE_CATEGORY_COMMAND_PATTERN = /(\|\||&&|[;|<>`]|[$]\()/

export interface PermissionMemoryRule {
  id: string
  cwd: string
  toolName: string
  kind: "exact" | "category"
  command?: string
  category?: string
  createdAt: number
  label: string
}

export interface PermissionMemoryCategory {
  id: string
  label: string
  description: string
  scope: string
  risk: string
}

interface Store {
  rules: PermissionMemoryRule[]
}

function normalizeCwd(cwd: string | undefined): string {
  return (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function requestCommand(request: PermissionRequestPayload | null): string | null {
  const command = request?.request.input?.command
  return typeof command === "string" && command.trim() ? command : null
}

function requestToolName(request: PermissionRequestPayload | null): string | null {
  const raw = request?.request.tool_name ?? request?.request.display_name
  return typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { rules: [] }
    const parsed = JSON.parse(raw) as Partial<Store>
    return {
      rules: Array.isArray(parsed.rules)
        ? parsed.rules.flatMap((rule) => {
            const normalized = normalizePermissionMemoryRule(rule)
            return normalized ? [normalized] : []
          })
        : []
    }
  } catch (error) {
    console.warn("读取权限记忆规则失败:", error)
    return { rules: [] }
  }
}

function saveStore(store: Store) {
  localStorage.setItem(KEY, JSON.stringify(store))
}

function normalizePermissionMemoryRule(
  value: unknown
): PermissionMemoryRule | null {
  if (!value || typeof value !== "object") return null
  const rule = value as Partial<PermissionMemoryRule>
  const { id, cwd, toolName, createdAt, label } = rule
  const baseValid =
    typeof id === "string" &&
    typeof cwd === "string" &&
    typeof toolName === "string" &&
    typeof createdAt === "number" &&
    typeof label === "string"
  if (!baseValid) return null
  const kind = rule.kind === "category" ? "category" : "exact"
  if (kind === "category") {
    const { category } = rule
    if (typeof category !== "string" || !category) return null
    return {
      id,
      cwd,
      toolName,
      kind,
      category,
      createdAt,
      label
    }
  }
  const { command } = rule
  if (typeof command !== "string" || !command) return null
  return {
    id,
    cwd,
    toolName,
    kind,
    command,
    createdAt,
    label
  }
}

export function canRememberExactPermission(
  request: PermissionRequestPayload | null
): boolean {
  if (!request) return false
  if (request.transport === "mcp") return false
  if (hasPermissionSuggestion(request)) return false
  return !!requestCommand(request) && !!requestToolName(request) && !!request.cwd
}

export function canRememberCategoryPermission(
  request: PermissionRequestPayload | null
): boolean {
  if (!request) return false
  if (request.transport !== "mcp" && hasAllowRuleSuggestion(request)) return false
  return (
    !!classifyPermissionRequestCategory(request) &&
    !!requestToolName(request) &&
    !!request.cwd
  )
}

function hasPermissionSuggestion(
  request: PermissionRequestPayload | null
): boolean {
  const suggestions = request?.request.permission_suggestions
  return Array.isArray(suggestions) && suggestions.some(Boolean)
}

export function hasAllowRuleSuggestion(
  request: PermissionRequestPayload | null
): boolean {
  const suggestions = request?.request.permission_suggestions
  if (!Array.isArray(suggestions)) return false
  return suggestions.some(
    (suggestion) =>
      suggestion &&
      typeof suggestion === "object" &&
      suggestion.type === "addRules" &&
      suggestion.behavior === "allow" &&
      Array.isArray(suggestion.rules) &&
      suggestion.rules.length > 0
  )
}

export function rememberExactPermissionRequest(
  request: PermissionRequestPayload
): PermissionMemoryRule {
  const command = requestCommand(request)
  const toolName = requestToolName(request)
  const cwd = normalizeCwd(request.cwd)
  if (!command || !toolName || !cwd) {
    throw new Error("当前权限请求不能保存该命令规则")
  }
  const id = `${cwd}::${toolName}::${command}`
  const label = `${toolName}: ${command.split("\n")[0]}`
  const store = loadStore()
  const existing = store.rules.find((rule) => rule.id === id)
  if (existing) return existing
  const rule: PermissionMemoryRule = {
    id,
    cwd,
    toolName,
    kind: "exact",
    command,
    createdAt: Date.now(),
    label
  }
  saveStore({ rules: [...store.rules, rule] })
  return rule
}

export function rememberCategoryPermissionRequest(
  request: PermissionRequestPayload
): PermissionMemoryRule {
  const category = classifyPermissionRequestCategory(request)
  const toolName = requestToolName(request)
  const cwd = normalizeCwd(request.cwd)
  if (!category || !toolName || !cwd) {
    throw new Error("当前权限请求不能保存为分类规则")
  }
  const id = `${cwd}::${toolName}::category::${category.id}`
  const store = loadStore()
  const existing = store.rules.find((rule) => rule.id === id)
  if (existing) return existing
  const rule: PermissionMemoryRule = {
    id,
    cwd,
    toolName,
    kind: "category",
    category: category.id,
    createdAt: Date.now(),
    label: category.label
  }
  saveStore({ rules: [...store.rules, rule] })
  return rule
}

export function findPermissionMemoryMatch(
  request: PermissionRequestPayload
): PermissionMemoryRule | null {
  const command = requestCommand(request)
  const toolName = requestToolName(request)
  const cwd = normalizeCwd(request.cwd)
  if (!toolName || !cwd) return null
  const rules = loadStore().rules
  if (command) {
    const exact = rules.find(
      (rule) =>
        rule.kind === "exact" &&
        rule.cwd === cwd &&
        rule.toolName === toolName &&
        rule.command === command
    )
    if (exact) return exact
  }
  const category = classifyPermissionRequestCategory(request)
  if (!category) return null
  return (
    rules.find(
      (rule) =>
        rule.kind === "category" &&
        rule.cwd === cwd &&
        rule.toolName === toolName &&
        rule.category === category.id
    ) ?? null
  )
}

export function classifyPermissionRequestCategory(
  request: PermissionRequestPayload | null
): PermissionMemoryCategory | null {
  const toolName = requestToolName(request)
  if (toolName !== "bash") return null
  const command = requestCommand(request)
  if (!command || !isSimpleCommand(command)) return null
  const tokens = tokenizeCommand(command)
  if (tokens.length === 0) return null
  return (
    classifyPackageManagerCommand(tokens) ??
    classifyCargoCommand(tokens) ??
    classifyGitReadCommand(tokens) ??
    classifyFileReadCommand(tokens)
  )
}

function isSimpleCommand(command: string): boolean {
  return !UNSAFE_CATEGORY_COMMAND_PATTERN.test(command)
}

function tokenizeCommand(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, "").toLowerCase())
    .filter(Boolean)
}

function classifyPackageManagerCommand(
  tokens: string[]
): PermissionMemoryCategory | null {
  const manager = tokens[0]
  if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) return null
  const action = tokens[1] === "run" ? tokens[2] : tokens[1]
  if (!action) return null
  if (
    ![
      "build",
      "check",
      "lint",
      "test",
      "test:unit",
      "typecheck",
      "type-check"
    ].includes(action)
  ) {
    return null
  }
  return {
    id: "bash:project-checks",
    label: "Bash 项目检查/构建命令",
    description: "允许常见的 build、test、check、lint、typecheck 命令",
    scope:
      "npm、pnpm、yarn、bun 的 build/test/check/lint/typecheck，以及 cargo build/check/clippy/test。",
    risk:
      "项目脚本可能写入缓存、生成产物或更新测试快照；只在信任当前项目脚本时启用。"
  }
}

function classifyCargoCommand(tokens: string[]): PermissionMemoryCategory | null {
  if (tokens[0] !== "cargo") return null
  if (!["build", "check", "clippy", "test"].includes(tokens[1] ?? "")) {
    return null
  }
  return {
    id: "bash:project-checks",
    label: "Bash 项目检查/构建命令",
    description: "允许常见的 build、test、check、lint、typecheck 命令",
    scope:
      "npm、pnpm、yarn、bun 的 build/test/check/lint/typecheck，以及 cargo build/check/clippy/test。",
    risk:
      "项目脚本可能写入缓存、生成产物或更新测试快照；只在信任当前项目脚本时启用。"
  }
}

function classifyGitReadCommand(
  tokens: string[]
): PermissionMemoryCategory | null {
  if (tokens[0] !== "git") return null
  const subcommand = tokens[1] ?? ""
  if (!isReadOnlyGitCommand(subcommand, tokens.slice(2))) {
    return null
  }
  return {
    id: "bash:git-read",
    label: "Bash Git 只读查询命令",
    description: "允许 git status、diff、log、show 等只读查询",
    scope: "git status、diff、log、show、branch 列表、remote 查询等只读查询。",
    risk: "不会覆盖 git remote add、git branch -D、git diff --output 等会改仓库或写文件的命令。"
  }
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

function classifyFileReadCommand(
  tokens: string[]
): PermissionMemoryCategory | null {
  const command = tokens[0]
  if (
    !["cat", "find", "grep", "head", "ls", "pwd", "rg", "tail", "wc"].includes(
      command
    )
  ) {
    return null
  }
  if (command === "find" && hasMutatingFindPredicate(tokens)) return null
  return {
    id: "bash:file-read",
    label: "Bash 文件只读查看命令",
    description: "允许 ls、cat、rg、grep、find 等只读查看",
    scope: "ls、cat、rg、grep、head、tail、wc、find 等文件查看命令。",
    risk: "find -delete、find -exec 等可能修改文件或执行命令的形式不会归类。"
  }
}

function hasMutatingFindPredicate(tokens: string[]): boolean {
  return tokens.some((token) =>
    [
      "-delete",
      "-exec",
      "-execdir",
      "-ok",
      "-okdir",
      "-fls",
      "-fprint",
      "-fprintf"
    ].includes(token)
  )
}
