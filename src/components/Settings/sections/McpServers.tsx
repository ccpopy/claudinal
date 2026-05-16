import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings2,
  Trash2,
  X
} from "lucide-react"
import { toast } from "sonner"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Badge } from "@/components/ui/badge"
import { Breadcrumb, BreadcrumbItem, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  claudeMcpPath,
  openPath,
  pathExists,
  readClaudeJsonMcpConfigs,
  readClaudeMcpConfig,
  type McpScope,
  writeClaudeJsonMcpConfig,
  writeClaudeMcpConfig
} from "@/lib/ipc"
import {
  loadMcpStatusCache,
  normalizeMcpConfig,
  type McpConfigFile,
  type McpServerConfig
} from "@/lib/mcp"
import { cn } from "@/lib/utils"
import { SettingsSectionHeader } from "./layout"

type ServerScope = McpScope | "claude-json-global" | "claude-json-project"
type EditableServerScope = McpScope | "claude-json-global"

const SCOPE_OPTIONS: Array<{ value: EditableServerScope; label: string }> = [
  { value: "global", label: "用户级 mcp.json" },
  { value: "project", label: "项目级 .mcp.json" },
  { value: "claude-json-global", label: "Claude CLI 全局" }
]

const TYPE_OPTIONS = [
  { value: "stdio", label: "STDIO" },
  { value: "http", label: "流式 HTTP" }
]

const AUTH_OPTIONS = [
  { value: "none", label: "无" },
  { value: "bearer", label: "Bearer" },
  { value: "oauth", label: "OAuth" }
]

const KNOWN_SERVER_KEYS = new Set([
  "type",
  "command",
  "args",
  "env",
  "envPassthrough",
  "cwd",
  "url",
  "headers",
  "auth",
  "disabled"
])

interface Props {
  cwd?: string | null
}

interface ValueRow {
  id: string
  value: string
}

interface PairRow {
  id: string
  key: string
  value: string
}

interface ServerRow {
  name: string
  scope: ServerScope
  config: McpServerConfig
  status: string | null
  overridesGlobal: boolean
  readOnly: boolean
  duplicateOf?: string
}

interface EditorState {
  originalName: string | null
  originalScope: EditableServerScope | null
  scope: EditableServerScope
  name: string
  enabled: boolean
  type: "stdio" | "http"
  command: string
  args: ValueRow[]
  env: PairRow[]
  envPassthrough: ValueRow[]
  cwd: string
  url: string
  headers: PairRow[]
  auth: "none" | "bearer" | "oauth"
  extra: Record<string, unknown>
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function valueRows(values: unknown): ValueRow[] {
  return Array.isArray(values)
    ? values
        .filter((value): value is string => typeof value === "string")
        .map((value) => ({ id: makeId(), value }))
    : []
}

function pairRows(values: unknown): PairRow[] {
  if (!values || typeof values !== "object" || Array.isArray(values)) return []
  return Object.entries(values as Record<string, unknown>).map(([key, value]) => ({
    id: makeId(),
    key,
    value: typeof value === "string" ? value : JSON.stringify(value)
  }))
}

function rowsToValues(rows: ValueRow[]) {
  return rows.map((row) => row.value.trim()).filter(Boolean)
}

function rowsToRecord(rows: PairRow[]) {
  return Object.fromEntries(
    rows
      .map((row) => [row.key.trim(), row.value] as const)
      .filter(([key]) => key)
  )
}

function serverType(config: McpServerConfig): "stdio" | "http" {
  return config.type === "http" || config.url ? "http" : "stdio"
}

function commandName(command: string) {
  const normalized = command.replace(/\\/g, "/").split("/").pop() ?? command
  return normalized.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/i, "")
}

function serverFingerprint(config: McpServerConfig): string | null {
  const type = serverType(config)
  if (type === "http") {
    const url = config.url?.trim().toLowerCase()
    return url ? `http:${url}` : null
  }

  let command = config.command?.trim() ?? ""
  let args = Array.isArray(config.args)
    ? config.args.filter((arg): arg is string => typeof arg === "string")
    : []
  if (commandName(command) === "cmd" && args[0]?.toLowerCase() === "/c" && args[1]) {
    command = args[1]
    args = args.slice(2)
  }
  const normalizedCommand = commandName(command)
  if (!normalizedCommand) return null
  return ["stdio", normalizedCommand, ...args.map((arg) => arg.trim())]
    .filter(Boolean)
    .join("\0")
    .toLowerCase()
}

function isEditableScope(scope: ServerScope): scope is EditableServerScope {
  return (
    scope === "global" ||
    scope === "project" ||
    scope === "claude-json-global"
  )
}

function editorFromServer(
  name: string,
  scope: EditableServerScope,
  config: McpServerConfig
): EditorState {
  const extra = Object.fromEntries(
    Object.entries(config).filter(([key]) => !KNOWN_SERVER_KEYS.has(key))
  )
  const type = serverType(config)
  return {
    originalName: name,
    originalScope: scope,
    scope,
    name,
    enabled: config.disabled !== true,
    type,
    command: config.command ?? "",
    args: valueRows(config.args),
    env: pairRows(config.env),
    envPassthrough: valueRows(config.envPassthrough),
    cwd: config.cwd ?? "",
    url: config.url ?? "",
    headers: pairRows(config.headers),
    auth:
      config.auth === "bearer" || config.auth === "oauth"
        ? config.auth
        : "none",
    extra
  }
}

function newEditor(scope: EditableServerScope, name: string): EditorState {
  return {
    originalName: null,
    originalScope: null,
    scope,
    name,
    enabled: true,
    type: "stdio",
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    cwd: "",
    url: "",
    headers: [],
    auth: "none",
    extra: {}
  }
}

function buildServerConfig(editor: EditorState): McpServerConfig {
  const server: McpServerConfig = { ...editor.extra, type: editor.type }
  if (!editor.enabled) server.disabled = true

  if (editor.type === "stdio") {
    server.command = editor.command.trim()
    const args = rowsToValues(editor.args)
    const env = rowsToRecord(editor.env)
    const envPassthrough = rowsToValues(editor.envPassthrough)
    if (args.length > 0) server.args = args
    if (Object.keys(env).length > 0) server.env = env
    if (envPassthrough.length > 0) server.envPassthrough = envPassthrough
    if (editor.cwd.trim()) server.cwd = editor.cwd.trim()
    return server
  }

  server.url = editor.url.trim()
  const headers = rowsToRecord(editor.headers)
  if (Object.keys(headers).length > 0) server.headers = headers
  if (editor.auth !== "none") server.auth = editor.auth
  return server
}

function statusLabel(status: string | null, disabled: boolean) {
  if (disabled) return "disabled"
  return status || "configured"
}

export function McpServers({ cwd }: Props) {
  const [configs, setConfigs] = useState<Record<McpScope, McpConfigFile>>({
    global: { mcpServers: {} },
    project: { mcpServers: {} }
  })
  const [paths, setPaths] = useState<Record<McpScope, string>>({
    global: "",
    project: ""
  })
  const [claudeJsonPath, setClaudeJsonPath] = useState("")
  const [claudeJsonConfigs, setClaudeJsonConfigs] = useState<Record<McpScope, McpConfigFile>>({
    global: { mcpServers: {} },
    project: { mcpServers: {} }
  })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [dirty, setDirty] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ServerRow | null>(null)
  const [statuses, setStatuses] = useState(() => loadMcpStatusCache())
  const hasProject = !!cwd

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const globalPath = await claudeMcpPath("global")
      const globalRaw = await readClaudeMcpConfig("global")
      let projectPath = ""
      let projectRaw: Record<string, unknown> | null = null
      if (cwd) {
        projectPath = await claudeMcpPath("project", cwd)
        projectRaw = await readClaudeMcpConfig("project", cwd)
      }
      const claudeJson = await readClaudeJsonMcpConfigs(cwd ?? undefined)
      setPaths({ global: globalPath, project: projectPath })
      setConfigs({
        global: normalizeMcpConfig(globalRaw),
        project: normalizeMcpConfig(projectRaw)
      })
      setClaudeJsonPath(claudeJson.path)
      setClaudeJsonConfigs({
        global: normalizeMcpConfig(claudeJson.global),
        project: normalizeMcpConfig(claudeJson.project)
      })
      setStatuses(loadMcpStatusCache())
      setEditor(null)
      setDirty(false)
    } catch (e) {
      toast.error(`读取 MCP 配置失败: ${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    load()
  }, [load])

  const statusMap = useMemo(
    () => new Map(statuses.map((status) => [status.name, status.status])),
    [statuses]
  )

  const rows = useMemo(() => {
    const next: ServerRow[] = []
    const globalNames = new Set<string>()

    for (const [name, config] of Object.entries(claudeJsonConfigs.global.mcpServers ?? {})) {
      globalNames.add(name)
      next.push({
        name,
        scope: "claude-json-global",
        config,
        status: statusMap.get(name) ?? null,
        overridesGlobal: false,
        readOnly: false
      })
    }
    for (const [name, config] of Object.entries(configs.global.mcpServers ?? {})) {
      globalNames.add(name)
      next.push({
        name,
        scope: "global",
        config,
        status: statusMap.get(name) ?? null,
        overridesGlobal: false,
        readOnly: false
      })
    }
    for (const [name, config] of Object.entries(claudeJsonConfigs.project.mcpServers ?? {})) {
      next.push({
        name,
        scope: "claude-json-project",
        config,
        status: statusMap.get(name) ?? null,
        overridesGlobal: globalNames.has(name),
        readOnly: true
      })
    }
    for (const [name, config] of Object.entries(configs.project.mcpServers ?? {})) {
      next.push({
        name,
        scope: "project",
        config,
        status: statusMap.get(name) ?? null,
        overridesGlobal: globalNames.has(name),
        readOnly: false
      })
    }
    const firstByFingerprint = new Map<string, string>()
    for (const row of next) {
      const fingerprint = serverFingerprint(row.config)
      if (!fingerprint) continue
      const first = firstByFingerprint.get(fingerprint)
      if (first && first !== row.name) row.duplicateOf = first
      else firstByFingerprint.set(fingerprint, row.name)
    }
    return next.sort((a, b) =>
      a.name.localeCompare(b.name) ||
      scopeLabel(a.scope).localeCompare(scopeLabel(b.scope))
    )
  }, [claudeJsonConfigs, configs, statusMap])

  const updateEditor = (patch: Partial<EditorState>) => {
    setEditor((cur) => (cur ? { ...cur, ...patch } : cur))
    setDirty(true)
  }

  const configForScope = (scope: EditableServerScope): McpConfigFile => {
    if (scope === "claude-json-global") return claudeJsonConfigs.global
    return configs[scope]
  }

  const replaceConfig = async (
    scope: EditableServerScope,
    next: McpConfigFile
  ) => {
    if (scope === "claude-json-global") {
      await writeClaudeJsonMcpConfig("global", next as Record<string, unknown>)
      setClaudeJsonConfigs((cur) => ({ ...cur, global: next }))
      return
    }
    await writeClaudeMcpConfig(
      scope,
      next as Record<string, unknown>,
      scope === "project" ? cwd ?? undefined : undefined
    )
    setConfigs((cur) => ({ ...cur, [scope]: next }))
  }

  const openConfigFile = async (scope: McpScope) => {
    const path = paths[scope]
    if (!path) return
    if (scope === "project" && !cwd) {
      toast.error("当前没有项目，不能打开项目级 mcp.json")
      return
    }
    try {
      if (!(await pathExists(path))) {
        await writeClaudeMcpConfig(
          scope,
          configs[scope] as Record<string, unknown>,
          scope === "project" ? cwd ?? undefined : undefined
        )
      }
      await openPath(path)
    } catch (e) {
      toast.error(`打开失败: ${String(e)}`)
    }
  }

  const openClaudeJsonConfig = async () => {
    if (!claudeJsonPath) return
    try {
      if (!(await pathExists(claudeJsonPath))) {
        toast.error("Claude CLI 配置文件不存在")
        return
      }
      await openPath(claudeJsonPath)
    } catch (e) {
      toast.error(`打开失败: ${String(e)}`)
    }
  }

  const uniqueName = (base: string) => {
    const names = new Set(rows.map((row) => row.name))
    if (!names.has(base)) return base
    for (let i = 2; i < 100; i += 1) {
      const candidate = `${base}-${i}`
      if (!names.has(candidate)) return candidate
    }
    return `${base}-${Date.now()}`
  }

  const startAdd = () => {
    const scope: McpScope = hasProject ? "project" : "global"
    setEditor(newEditor(scope, uniqueName("new-server")))
    setDirty(true)
  }

  const startEdit = (row: ServerRow) => {
    if (row.readOnly || !isEditableScope(row.scope)) return
    setEditor(editorFromServer(row.name, row.scope, row.config))
    setDirty(false)
  }

  const saveEditor = async () => {
    if (!editor) return
    const name = editor.name.trim()
    if (!name) {
      toast.error("请填写服务器名称")
      return
    }
    if (editor.scope === "project" && !cwd) {
      toast.error("当前没有项目，不能保存项目级 MCP 配置")
      return
    }
    if (editor.type === "stdio" && !editor.command.trim()) {
      toast.error("请填写启动命令")
      return
    }
    if (editor.type === "http" && !editor.url.trim()) {
      toast.error("请填写 URL")
      return
    }

    const targetServers = configForScope(editor.scope).mcpServers ?? {}
    const isSameEntry =
      editor.originalName === name && editor.originalScope === editor.scope
    const conflictingRow = rows.find(
      (row) =>
        row.name === name &&
        !(row.scope === editor.originalScope && row.name === editor.originalName)
    )
    const nextConfig = buildServerConfig(editor)
    const nextFingerprint = serverFingerprint(nextConfig)
    const equivalentRow = nextFingerprint
      ? rows.find(
          (row) =>
            serverFingerprint(row.config) === nextFingerprint &&
            !(row.scope === editor.originalScope && row.name === editor.originalName)
        )
      : undefined
    if (!isSameEntry && (targetServers[name] || conflictingRow || equivalentRow)) {
      toast.error(
        conflictingRow
          ? `已存在同名 MCP 服务器（${scopeLabel(conflictingRow.scope)}）`
          : equivalentRow
            ? `已存在等价 MCP 服务器（${equivalentRow.name} / ${scopeLabel(equivalentRow.scope)}）`
          : "同一 scope 下已存在同名 MCP 服务器"
      )
      return
    }

    setSaving(true)
    try {
      const changed = new Map<EditableServerScope, McpConfigFile>()
      const getDraft = (scope: EditableServerScope) => {
        const existing = changed.get(scope) ?? configForScope(scope)
        const draft = normalizeMcpConfig(existing)
        draft.mcpServers = { ...(draft.mcpServers ?? {}) }
        changed.set(scope, draft)
        return draft
      }

      if (editor.originalName && editor.originalScope) {
        const draft = getDraft(editor.originalScope)
        delete draft.mcpServers?.[editor.originalName]
      }
      const target = getDraft(editor.scope)
      target.mcpServers = {
        ...(target.mcpServers ?? {}),
        [name]: nextConfig
      }

      for (const [scope, config] of changed) {
        await replaceConfig(scope, config)
      }
      setEditor(null)
      setDirty(false)
      toast.success("MCP 服务器配置已保存")
    } catch (e) {
      toast.error(`保存失败: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const toggleServer = async (row: ServerRow, enabled: boolean) => {
    if (row.readOnly || !isEditableScope(row.scope)) return
    setSaving(true)
    try {
      const next = normalizeMcpConfig(configForScope(row.scope))
      next.mcpServers = { ...(next.mcpServers ?? {}) }
      const config = { ...row.config }
      if (enabled) delete config.disabled
      else config.disabled = true
      next.mcpServers[row.name] = config
      await replaceConfig(row.scope, next)
      toast.success(enabled ? "已启用 MCP 服务器" : "已停用 MCP 服务器")
    } catch (e) {
      toast.error(`更新失败: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const deleteServer = async (row: ServerRow) => {
    if (row.readOnly || !isEditableScope(row.scope)) return
    setSaving(true)
    try {
      const next = normalizeMcpConfig(configForScope(row.scope))
      next.mcpServers = { ...(next.mcpServers ?? {}) }
      delete next.mcpServers[row.name]
      await replaceConfig(row.scope, next)
      setPendingDelete(null)
      if (editor?.originalName === row.name && editor.originalScope === row.scope) {
        setEditor(null)
      }
      toast.success("MCP 服务器已卸载")
    } catch (e) {
      toast.error(`卸载失败: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsSectionHeader
        icon={Server}
        title="MCP 服务器"
        description="连接外部工具和数据源，可写入 mcp.json 或 Claude CLI 全局配置。"
        eyebrow={
          editor ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <button
              type="button"
              onClick={() => setEditor(null)}
              className="inline-flex items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              返回
            </button>
            <Breadcrumb>
              <BreadcrumbItem onClick={() => setEditor(null)}>
                MCP 服务器
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem current>{editor.name || "新服务器"}</BreadcrumbItem>
            </Breadcrumb>
          </div>
          ) : undefined
        }
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={load}
              disabled={loading || saving}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              刷新
            </Button>
            {!editor && (
              <Button type="button" size="sm" onClick={startAdd}>
                <Plus />
                添加服务器
              </Button>
            )}
            {editor && editor.originalName && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  const row = rows.find(
                    (item) =>
                      item.name === editor.originalName &&
                      item.scope === editor.originalScope
                  )
                  if (row) setPendingDelete(row)
                }}
              >
                <Trash2 />
                卸载
              </Button>
            )}
          </>
        }
      />

      {editor ? (
        <EditorView
          editor={editor}
          dirty={dirty}
          saving={saving}
          loading={loading}
          hasProject={hasProject}
          onUpdate={updateEditor}
          onSave={saveEditor}
        />
      ) : (
        <ListView
          rows={rows}
          paths={paths}
          claudeJsonPath={claudeJsonPath}
          loading={loading}
          saving={saving}
          hasProject={hasProject}
          onOpenPath={openConfigFile}
          onOpenClaudeJson={openClaudeJsonConfig}
          onEdit={startEdit}
          onToggle={toggleServer}
          onDelete={setPendingDelete}
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title="卸载 MCP 服务器"
        description={
          pendingDelete ? (
            <span>
              将从 {scopeLabel(pendingDelete.scope)} 配置中移除{" "}
              <code className="font-mono">{pendingDelete.name}</code>。
            </span>
          ) : null
        }
        confirmText="卸载"
        destructive
        onConfirm={async () => {
          if (pendingDelete) await deleteServer(pendingDelete)
        }}
      />
    </div>
  )
}

function ListView({
  rows,
  paths,
  claudeJsonPath,
  loading,
  saving,
  hasProject,
  onOpenPath,
  onOpenClaudeJson,
  onEdit,
  onToggle,
  onDelete
}: {
  rows: ServerRow[]
  paths: Record<McpScope, string>
  claudeJsonPath: string
  loading: boolean
  saving: boolean
  hasProject: boolean
  onOpenPath: (scope: McpScope) => void
  onOpenClaudeJson: () => void
  onEdit: (row: ServerRow) => void
  onToggle: (row: ServerRow, enabled: boolean) => void
  onDelete: (row: ServerRow) => void
}) {
  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 px-8 pb-6 pt-2">
          <section className="rounded-lg border bg-card p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenPath("global")}
                disabled={!paths.global}
              >
                <ExternalLink className="size-3.5" />
                打开用户级 mcp.json
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenPath("project")}
                disabled={!hasProject || !paths.project}
              >
                <ExternalLink className="size-3.5" />
                打开项目级 mcp.json
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onOpenClaudeJson}
                disabled={!claudeJsonPath}
              >
                <ExternalLink className="size-3.5" />
                打开 Claude CLI 配置
              </Button>
            </div>
            {loading ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                正在读取 MCP 配置
              </div>
            ) : rows.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed text-center">
                <Server className="mb-3 size-6 text-muted-foreground" />
                <div className="text-sm font-medium">还没有 MCP 服务器</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  点击右上角添加服务器。
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {rows.map((row) => (
                  <ServerCard
                    key={`${row.scope}:${row.name}`}
                    row={row}
                    saving={saving}
                    onEdit={() => onEdit(row)}
                    onToggle={(enabled) => onToggle(row, enabled)}
                    onDelete={() => onDelete(row)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
    </>
  )
}

function ServerCard({
  row,
  saving,
  onEdit,
  onToggle,
  onDelete
}: {
  row: ServerRow
  saving: boolean
  onEdit: () => void
  onToggle: (enabled: boolean) => void
  onDelete: () => void
}) {
  const disabled = row.config.disabled === true
  const type = serverType(row.config)
  const status = statusLabel(row.status, disabled)
  const showDiagnostic =
    !disabled && (status === "needs-auth" || status === "failed")
  return (
    <div className="overflow-hidden rounded-lg border bg-background transition-colors hover:bg-accent/35">
      <div className="flex min-h-[72px] items-center gap-3 p-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
          <Server className="size-4" />
        </div>
        <button
          type="button"
          onClick={row.readOnly ? undefined : onEdit}
          disabled={row.readOnly}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{row.name}</span>
            <StatusDot status={status} />
            <Badge variant="outline" className="font-sans">
              {scopeLabel(row.scope)}
            </Badge>
            {row.overridesGlobal && (
              <Badge variant="warn" className="font-sans">
                覆盖用户级
              </Badge>
            )}
            {row.readOnly && (
              <Badge variant="secondary" className="font-sans">
                只读
              </Badge>
            )}
            {row.duplicateOf && (
              <Badge variant="warn" className="font-sans">
                可能重复：{row.duplicateOf}
              </Badge>
            )}
            <Badge variant="secondary">{type === "stdio" ? "STDIO" : "HTTP"}</Badge>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {type === "stdio"
              ? row.config.command || "未配置启动命令"
              : row.config.url || "未配置 URL"}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={!disabled}
            onCheckedChange={onToggle}
            disabled={saving || row.readOnly}
            aria-label={`${disabled ? "启用" : "停用"} ${row.name}`}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onEdit}
            disabled={row.readOnly}
            title={row.readOnly ? "来自 Claude CLI 配置，请打开配置文件修改" : undefined}
          >
            <Settings2 className="size-3.5" />
            编辑
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={row.readOnly}
            aria-label={`卸载 ${row.name}`}
            title={row.readOnly ? "来自 Claude CLI 配置，请打开配置文件修改" : undefined}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      {showDiagnostic && (
        <ServerDiagnostic name={row.name} status={status} type={type} />
      )}
    </div>
  )
}

function ServerDiagnostic({
  name,
  status,
  type
}: {
  name: string
  status: string
  type: "stdio" | "http"
}) {
  const isNeedsAuth = status === "needs-auth"
  const tone = isNeedsAuth
    ? "border-warn/40 bg-warn/5 text-foreground"
    : "border-destructive/30 bg-destructive/5 text-foreground"
  return (
    <div className={cn("border-t px-4 py-3 text-[11px] space-y-1.5", tone)}>
      <div className="font-medium">
        {isNeedsAuth
          ? "需要 OAuth 登录"
          : "MCP server 未能启动"}
      </div>
      {isNeedsAuth ? (
        <>
          <div className="text-muted-foreground">
            Claudinal 不接管 OAuth 流程。请在终端运行
            {type === "http" ? (
              <>
                <code className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono">
                  claude mcp authenticate {name}
                </code>{" "}
                完成浏览器登录；
              </>
            ) : (
              <>
                {" "}
                CLI 自带的鉴权命令完成登录（如{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  claude mcp authenticate {name}
                </code>
                ），或直接使用对应工具的官方登录方式（gh / gcloud / npm login 等）；
              </>
            )}
            登录态会写入 CLI 维护的凭据文件，下次启动会话即可生效。
          </div>
          <div className="text-muted-foreground">
            登录后可在「MCP 服务器」页右上「刷新」按钮重新拉一次状态。
          </div>
        </>
      ) : (
        <>
          <div className="text-muted-foreground">
            常见原因：1) 启动命令路径不存在 / 缺依赖；2) 项目级配置覆盖了用户级 server，但项目目录缺权限；3)
            网络代理或 TLS 证书问题。可在「网络代理」页确认代理是否生效，或在终端用同样的命令手动跑一次看 stderr。
          </div>
          {type === "http" && (
            <div className="text-muted-foreground">
              对于 HTTP MCP，先确认 URL 可达；若需要鉴权，运行
              <code className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono">
                claude mcp authenticate {name}
              </code>
              。
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EditorView({
  editor,
  dirty,
  saving,
  loading,
  hasProject,
  onUpdate,
  onSave
}: {
  editor: EditorState
  dirty: boolean
  saving: boolean
  loading: boolean
  hasProject: boolean
  onUpdate: (patch: Partial<EditorState>) => void
  onSave: () => void
}) {
  const disabled = loading || saving
  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 px-8 pb-6 pt-2">
          <section className="space-y-4 rounded-lg border bg-card p-5">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              基本信息
            </div>
            <FieldRow label="名称">
              <Input
                value={editor.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
                disabled={disabled}
                className="max-w-[360px] font-mono text-xs"
              />
            </FieldRow>
            <FieldRow label="保存位置">
              <Select
                value={editor.scope}
                onChange={(e) =>
                  onUpdate({ scope: e.target.value as EditorState["scope"] })
                }
                options={
                  SCOPE_OPTIONS.filter(
                    (item) => item.value !== "project" || hasProject
                  )
                }
                disabled={disabled}
                triggerClassName="max-w-[220px]"
              />
            </FieldRow>
            <FieldRow label="启用">
              <Switch
                checked={editor.enabled}
                onCheckedChange={(enabled) => onUpdate({ enabled })}
                disabled={disabled}
              />
            </FieldRow>
            <FieldRow label="类型">
              <div className="inline-flex rounded-md border bg-muted p-1">
                {TYPE_OPTIONS.map((item) => {
                  const active = editor.type === item.value
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() =>
                        onUpdate({ type: item.value as EditorState["type"] })
                      }
                      disabled={disabled}
                      className={cn(
                        "h-8 rounded px-3 text-sm transition-colors disabled:pointer-events-none disabled:opacity-50",
                        active
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {item.label}
                    </button>
                  )
                })}
              </div>
            </FieldRow>
          </section>

          {editor.type === "stdio" ? (
            <StdioEditor editor={editor} disabled={disabled} onUpdate={onUpdate} />
          ) : (
            <HttpEditor editor={editor} disabled={disabled} onUpdate={onUpdate} />
          )}
        </div>
      </ScrollArea>

      <div className="flex shrink-0 items-center gap-2 px-8 py-4">
        <Button onClick={onSave} disabled={!dirty || disabled}>
          <Save />
          保存
        </Button>
        {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
      </div>
    </>
  )
}

function StdioEditor({
  editor,
  disabled,
  onUpdate
}: {
  editor: EditorState
  disabled: boolean
  onUpdate: (patch: Partial<EditorState>) => void
}) {
  return (
    <section className="space-y-5 rounded-lg border bg-card p-5">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        STDIO
      </div>
      <StackField label="启动命令">
        <Input
          value={editor.command}
          onChange={(e) => onUpdate({ command: e.target.value })}
          placeholder="npx"
          className="font-mono text-xs"
          disabled={disabled}
        />
      </StackField>
      <ValueList
        label="参数"
        addText="添加参数"
        placeholder="-y @modelcontextprotocol/server-filesystem"
        rows={editor.args}
        disabled={disabled}
        onChange={(args) => onUpdate({ args })}
      />
      <PairList
        label="环境变量"
        addText="添加环境变量"
        keyPlaceholder="API_KEY"
        valuePlaceholder="value"
        rows={editor.env}
        disabled={disabled}
        onChange={(env) => onUpdate({ env })}
      />
      <ValueList
        label="环境变量传递"
        addText="添加透传变量"
        placeholder="GITHUB_TOKEN"
        rows={editor.envPassthrough}
        disabled={disabled}
        onChange={(envPassthrough) => onUpdate({ envPassthrough })}
      />
      <StackField label="工作目录">
        <Input
          value={editor.cwd}
          onChange={(e) => onUpdate({ cwd: e.target.value })}
          placeholder="/path/to/project"
          className="font-mono text-xs"
          disabled={disabled}
        />
      </StackField>
    </section>
  )
}

function HttpEditor({
  editor,
  disabled,
  onUpdate
}: {
  editor: EditorState
  disabled: boolean
  onUpdate: (patch: Partial<EditorState>) => void
}) {
  return (
    <section className="space-y-5 rounded-lg border bg-card p-5">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        流式 HTTP
      </div>
      <StackField label="URL">
        <Input
          value={editor.url}
          onChange={(e) => onUpdate({ url: e.target.value })}
          placeholder="https://example.com/mcp"
          className="font-mono text-xs"
          disabled={disabled}
        />
      </StackField>
      <FieldRow label="鉴权方式">
        <Select
          value={editor.auth}
          onChange={(e) =>
            onUpdate({ auth: e.target.value as EditorState["auth"] })
          }
          options={AUTH_OPTIONS}
          disabled={disabled}
          triggerClassName="max-w-[220px]"
        />
      </FieldRow>
      <PairList
        label="Headers"
        addText="添加 Header"
        keyPlaceholder="Authorization"
        valuePlaceholder="Bearer ..."
        rows={editor.headers}
        disabled={disabled}
        onChange={(headers) => onUpdate({ headers })}
      />
    </section>
  )
}

function ValueList({
  label,
  addText,
  placeholder,
  rows,
  disabled,
  onChange
}: {
  label: string
  addText: string
  placeholder: string
  rows: ValueRow[]
  disabled: boolean
  onChange: (rows: ValueRow[]) => void
}) {
  return (
    <StackField label={label}>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-2">
            <Input
              value={row.value}
              onChange={(e) =>
                onChange(
                  rows.map((item) =>
                    item.id === row.id ? { ...item, value: e.target.value } : item
                  )
                )
              }
              placeholder={placeholder}
              className="font-mono text-xs"
              disabled={disabled}
            />
            <IconButton
              label={`删除${label}`}
              disabled={disabled}
              onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
            />
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...rows, { id: makeId(), value: "" }])}
        >
          <Plus className="size-3.5" />
          {addText}
        </Button>
      </div>
    </StackField>
  )
}

function PairList({
  label,
  addText,
  keyPlaceholder,
  valuePlaceholder,
  rows,
  disabled,
  onChange
}: {
  label: string
  addText: string
  keyPlaceholder: string
  valuePlaceholder: string
  rows: PairRow[]
  disabled: boolean
  onChange: (rows: PairRow[]) => void
}) {
  return (
    <StackField label={label}>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[minmax(0,0.42fr)_minmax(0,1fr)_auto] items-center gap-2">
            <Input
              value={row.key}
              onChange={(e) =>
                onChange(
                  rows.map((item) =>
                    item.id === row.id ? { ...item, key: e.target.value } : item
                  )
                )
              }
              placeholder={keyPlaceholder}
              className="font-mono text-xs"
              disabled={disabled}
            />
            <Input
              value={row.value}
              onChange={(e) =>
                onChange(
                  rows.map((item) =>
                    item.id === row.id
                      ? { ...item, value: e.target.value }
                      : item
                  )
                )
              }
              placeholder={valuePlaceholder}
              className="font-mono text-xs"
              disabled={disabled}
            />
            <IconButton
              label={`删除${label}`}
              disabled={disabled}
              onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
            />
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...rows, { id: makeId(), key: "", value: "" }])}
        >
          <Plus className="size-3.5" />
          {addText}
        </Button>
      </div>
    </StackField>
  )
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <Label className="w-24 shrink-0 text-xs">{label}</Label>
      {children}
    </div>
  )
}

function StackField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      {children}
    </div>
  )
}

function IconButton({
  label,
  disabled,
  onClick
}: {
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
    >
      <X className="size-4" />
    </Button>
  )
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === "connected"
      ? "bg-connected"
      : status === "needs-auth"
        ? "bg-warn"
        : status === "failed"
          ? "bg-destructive"
          : status === "disabled"
            ? "bg-muted-foreground/45"
            : "bg-primary"
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span className={cn("size-2 rounded-full", cls)} />
      {status}
    </span>
  )
}

function scopeLabel(scope: ServerScope) {
  if (scope === "global") return "用户级"
  if (scope === "project") return "项目级"
  if (scope === "claude-json-global") return "Claude CLI 全局"
  return "Claude CLI 项目"
}
