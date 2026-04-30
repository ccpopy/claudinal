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
  readClaudeMcpConfig,
  type McpScope,
  writeClaudeMcpConfig
} from "@/lib/ipc"
import {
  loadMcpStatusCache,
  normalizeMcpConfig,
  type McpConfigFile,
  type McpServerConfig
} from "@/lib/mcp"
import { cn } from "@/lib/utils"

const SCOPE_OPTIONS: Array<{ value: McpScope; label: string }> = [
  { value: "global", label: "用户级" },
  { value: "project", label: "项目级" }
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
  scope: McpScope
  config: McpServerConfig
  status: string | null
  overridesGlobal: boolean
}

interface EditorState {
  originalName: string | null
  originalScope: McpScope | null
  scope: McpScope
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

function editorFromServer(
  name: string,
  scope: McpScope,
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

function newEditor(scope: McpScope, name: string): EditorState {
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
      setPaths({ global: globalPath, project: projectPath })
      setConfigs({
        global: normalizeMcpConfig(globalRaw),
        project: normalizeMcpConfig(projectRaw)
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
    const merged = new Map<string, ServerRow>()
    for (const [name, config] of Object.entries(configs.global.mcpServers ?? {})) {
      merged.set(name, {
        name,
        scope: "global",
        config,
        status: statusMap.get(name) ?? null,
        overridesGlobal: false
      })
    }
    for (const [name, config] of Object.entries(configs.project.mcpServers ?? {})) {
      merged.set(name, {
        name,
        scope: "project",
        config,
        status: statusMap.get(name) ?? null,
        overridesGlobal: merged.has(name)
      })
    }
    return Array.from(merged.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  }, [configs, statusMap])

  const updateEditor = (patch: Partial<EditorState>) => {
    setEditor((cur) => (cur ? { ...cur, ...patch } : cur))
    setDirty(true)
  }

  const replaceConfig = async (scope: McpScope, next: McpConfigFile) => {
    await writeClaudeMcpConfig(scope, next as Record<string, unknown>, scope === "project" ? cwd ?? undefined : undefined)
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

  const uniqueName = (base: string, scope: McpScope) => {
    const servers = configs[scope].mcpServers ?? {}
    if (!servers[base]) return base
    for (let i = 2; i < 100; i += 1) {
      const candidate = `${base}-${i}`
      if (!servers[candidate]) return candidate
    }
    return `${base}-${Date.now()}`
  }

  const startAdd = () => {
    const scope: McpScope = hasProject ? "project" : "global"
    setEditor(newEditor(scope, uniqueName("new-server", scope)))
    setDirty(true)
  }

  const startEdit = (row: ServerRow) => {
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

    const targetServers = configs[editor.scope].mcpServers ?? {}
    const isSameEntry =
      editor.originalName === name && editor.originalScope === editor.scope
    if (!isSameEntry && targetServers[name]) {
      toast.error("同一 scope 下已存在同名 MCP 服务器")
      return
    }

    setSaving(true)
    try {
      const changed = new Map<McpScope, McpConfigFile>()
      const getDraft = (scope: McpScope) => {
        const existing = changed.get(scope) ?? configs[scope]
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
        [name]: buildServerConfig(editor)
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
    setSaving(true)
    try {
      const next = normalizeMcpConfig(configs[row.scope])
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
    setSaving(true)
    try {
      const next = normalizeMcpConfig(configs[row.scope])
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
      <div className="shrink-0 px-8 pb-4 pt-8">
        {editor ? (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
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
        ) : null}
        <div className="mt-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <PlugIcon />
              MCP 服务器
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              连接外部工具和数据源，写入 Claude Code 原生 mcp.json。
            </p>
          </div>
          <div className="mt-6 flex shrink-0 items-center gap-2">
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
          </div>
        </div>
      </div>

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
          loading={loading}
          saving={saving}
          hasProject={hasProject}
          onOpenPath={openConfigFile}
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
              将从 {scopeLabel(pendingDelete.scope)} mcp.json 中移除{" "}
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
  loading,
  saving,
  hasProject,
  onOpenPath,
  onEdit,
  onToggle,
  onDelete
}: {
  rows: ServerRow[]
  paths: Record<McpScope, string>
  loading: boolean
  saving: boolean
  hasProject: boolean
  onOpenPath: (scope: McpScope) => void
  onEdit: (row: ServerRow) => void
  onToggle: (row: ServerRow, enabled: boolean) => void
  onDelete: (row: ServerRow) => void
}) {
  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 px-8 pb-6">
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
  return (
    <div className="flex min-h-[72px] items-center gap-3 rounded-lg border bg-background p-3 transition-colors hover:bg-accent/35">
      <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
        <Server className="size-4" />
      </div>
      <button
        type="button"
        onClick={onEdit}
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
          disabled={saving}
          aria-label={`${disabled ? "启用" : "停用"} ${row.name}`}
        />
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          <Settings2 className="size-3.5" />
          编辑
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={`卸载 ${row.name}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
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
        <div className="space-y-6 px-8 pb-6">
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
                  onUpdate({ scope: e.target.value as McpScope })
                }
                options={
                  hasProject
                    ? SCOPE_OPTIONS
                    : SCOPE_OPTIONS.filter((item) => item.value === "global")
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

function scopeLabel(scope: McpScope) {
  return scope === "global" ? "用户级" : "项目级"
}

function PlugIcon() {
  return <Server className="size-5" />
}
