import { useMemo, useState, type Dispatch, type SetStateAction } from "react"
import {
  ArrowLeft,
  Folder,
  FolderPlus,
  Plus,
  Save,
  TerminalSquare,
  WandSparkles
} from "lucide-react"
import { toast } from "sonner"
import { AddProjectDialog } from "@/components/AddProjectDialog"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  compactScripts,
  completeScripts,
  configuredScriptCount,
  getProjectEnv,
  loadProjectEnvStore,
  saveProjectEnv,
  type EnvPlatform,
  type ProjectEnvAction,
  type ProjectEnvConfig
} from "@/lib/projectEnv"
import { listProjects, type Project } from "@/lib/projects"
import { cn, formatPathForDisplay } from "@/lib/utils"
import { SettingsSectionHeader } from "./layout"

interface Props {
  cwd?: string | null
  onSelectProject?: (project: Project) => void
}

interface EditorState {
  project: Project
  name: string
  setupScripts: Record<EnvPlatform, string>
  cleanupScripts: Record<EnvPlatform, string>
  setupPlatform: EnvPlatform
  cleanupPlatform: EnvPlatform
  actions: ProjectEnvAction[]
}

const PLATFORM_OPTIONS: Array<{ value: EnvPlatform; label: string }> = [
  { value: "default", label: "默认" },
  { value: "macos", label: "macOS" },
  { value: "linux", label: "Linux" },
  { value: "windows", label: "Windows" }
]

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function normalizePath(path: string | null | undefined) {
  return (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function makeEditor(project: Project, config: ProjectEnvConfig): EditorState {
  return {
    project,
    name: config.name || project.name || basename(project.cwd),
    setupScripts: completeScripts(config.setupScripts),
    cleanupScripts: completeScripts(config.cleanupScripts),
    setupPlatform: "default",
    cleanupPlatform: "default",
    actions: config.actions ?? []
  }
}

function editorToConfig(editor: EditorState): ProjectEnvConfig {
  const name = editor.name.trim()
  return {
    ...(name && name !== editor.project.name ? { name } : {}),
    setupScripts: compactScripts(editor.setupScripts),
    cleanupScripts: compactScripts(editor.cleanupScripts),
    actions: editor.actions
  }
}

function configFingerprint(config: ProjectEnvConfig) {
  return JSON.stringify(config)
}

export function Environment({ cwd, onSelectProject }: Props) {
  const [projects, setProjects] = useState(() => listProjects())
  const [envStore, setEnvStore] = useState(() => loadProjectEnvStore())
  const [addOpen, setAddOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [initialConfig, setInitialConfig] = useState("")

  const currentProjectId = useMemo(() => {
    const cwdNorm = normalizePath(cwd)
    if (!cwdNorm) return null
    return projects.find((project) => normalizePath(project.cwd) === cwdNorm)?.id ?? null
  }, [cwd, projects])

  const rows = useMemo(
    () =>
      projects.map((project) => ({
        project,
        config: getProjectEnv(envStore, project.id)
      })),
    [envStore, projects]
  )

  const openEditor = (project: Project) => {
    onSelectProject?.(project)
    const next = makeEditor(project, getProjectEnv(envStore, project.id))
    setEditor(next)
    setInitialConfig(configFingerprint(editorToConfig(next)))
  }

  const refreshProjects = () => {
    setProjects(listProjects())
    setEnvStore(loadProjectEnvStore())
  }

  const dirty = editor
    ? configFingerprint(editorToConfig(editor)) !== initialConfig
    : false

  const saveEditor = () => {
    if (!editor) return
    const name = editor.name.trim()
    if (!name) {
      toast.error("请填写环境名称")
      return
    }
    const config = editorToConfig({ ...editor, name })
    const nextStore = saveProjectEnv(editor.project.id, config)
    setEnvStore(nextStore)
    setInitialConfig(configFingerprint(config))
    setEditor((cur) => (cur ? { ...cur, name } : cur))
    toast.success("项目环境配置已保存")
  }

  const updateScript = (
    type: "setupScripts" | "cleanupScripts",
    platform: EnvPlatform,
    value: string
  ) => {
    setEditor((cur) =>
      cur
        ? {
            ...cur,
            [type]: {
              ...cur[type],
              [platform]: value
            }
          }
        : cur
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsSectionHeader
        icon={TerminalSquare}
        title="环境"
        description="本地环境用于指示 Claude 如何为项目设置工作树。"
        eyebrow={
          editor ? (
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
              <BreadcrumbItem onClick={() => setEditor(null)}>环境</BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem onClick={() => setEditor(null)}>
                {editor.project.name}
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem current>编辑</BreadcrumbItem>
            </Breadcrumb>
          </div>
          ) : undefined
        }
        actions={
          !editor ? (
            <Button
              type="button"
              size="sm"
              onClick={() => setAddOpen(true)}
            >
              <FolderPlus />
              添加项目
            </Button>
          ) : undefined
        }
      />

      {editor ? (
        <EditorView
          editor={editor}
          dirty={dirty}
          onBack={() => setEditor(null)}
          onSave={saveEditor}
          onChange={setEditor}
          onUpdateScript={updateScript}
        />
      ) : (
        <ListView
          rows={rows}
          currentProjectId={currentProjectId}
          onAdd={() => setAddOpen(true)}
          onEdit={openEditor}
        />
      )}

      <AddProjectDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={(project) => {
          refreshProjects()
          setTimeout(() => openEditor(project), 0)
        }}
      />
    </div>
  )
}

function ListView({
  rows,
  currentProjectId,
  onAdd,
  onEdit
}: {
  rows: Array<{ project: Project; config: ProjectEnvConfig }>
  currentProjectId: string | null
  onAdd: () => void
  onEdit: (project: Project) => void
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-6 px-8 pb-6 pt-2">
        <section className="rounded-lg border bg-card p-5">
          {rows.length === 0 ? (
            <div className="flex h-44 flex-col items-center justify-center rounded-lg border border-dashed text-center">
              <Folder className="mb-3 size-6 text-muted-foreground" />
              <div className="text-sm font-medium">还没有项目</div>
              <div className="mt-1 text-xs text-muted-foreground">
                添加项目后即可配置工作树设置和清理脚本。
              </div>
              <Button type="button" size="sm" className="mt-4" onClick={onAdd}>
                <FolderPlus />
                添加项目
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {rows.map(({ project, config }) => (
                <ProjectEnvironmentCard
                  key={project.id}
                  project={project}
                  config={config}
                  current={project.id === currentProjectId}
                  onEdit={() => onEdit(project)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  )
}

function ProjectEnvironmentCard({
  project,
  config,
  current,
  onEdit
}: {
  project: Project
  config: ProjectEnvConfig
  current: boolean
  onEdit: () => void
}) {
  const scriptCount = configuredScriptCount(config)
  const label = config.name || project.name
  return (
    <div className="flex min-h-[76px] items-center gap-3 rounded-lg border bg-background p-3 transition-colors hover:bg-accent/35">
      <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
        <Folder className="size-4" />
      </div>
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold">{label}</span>
          {current && (
            <Badge variant="primary" className="font-sans">
              当前项目
            </Badge>
          )}
          {scriptCount > 0 ? (
            <Badge variant="outline" className="font-sans">
              {scriptCount} 个脚本
            </Badge>
          ) : (
            <Badge variant="secondary" className="font-sans">
              未配置
            </Badge>
          )}
        </div>
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {formatPathForDisplay(project.cwd)}
        </div>
      </button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-8 shrink-0"
        onClick={onEdit}
        aria-label={`编辑 ${label} 的环境`}
      >
        <Plus className="size-4" />
      </Button>
    </div>
  )
}

function EditorView({
  editor,
  dirty,
  onBack,
  onSave,
  onChange,
  onUpdateScript
}: {
  editor: EditorState
  dirty: boolean
  onBack: () => void
  onSave: () => void
  onChange: Dispatch<SetStateAction<EditorState | null>>
  onUpdateScript: (
    type: "setupScripts" | "cleanupScripts",
    platform: EnvPlatform,
    value: string
  ) => void
}) {
  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 px-8 pb-6 pt-2">
          <section className="rounded-lg border bg-card p-5">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              本地环境
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,0.38fr)_minmax(0,1fr)]">
              <div className="flex items-center gap-3 rounded-lg border bg-background p-3">
                <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
                  <Folder className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {editor.project.name}
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {formatPathForDisplay(editor.project.cwd)}
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="environment-name">名称</Label>
                <Input
                  id="environment-name"
                  value={editor.name}
                  onChange={(event) =>
                    onChange((cur) =>
                      cur ? { ...cur, name: event.target.value } : cur
                    )
                  }
                  placeholder={basename(editor.project.cwd)}
                />
                <p className="text-xs text-muted-foreground">
                  用于在环境列表中识别这个项目，不会执行任何命令。
                </p>
              </div>
            </div>
          </section>

          <ScriptSection
            title="设置脚本"
            description="创建工作树时在项目根目录下运行。"
            value={editor.setupScripts[editor.setupPlatform]}
            platform={editor.setupPlatform}
            onPlatformChange={(setupPlatform) =>
              onChange((cur) => (cur ? { ...cur, setupPlatform } : cur))
            }
            onChange={(value) =>
              onUpdateScript("setupScripts", editor.setupPlatform, value)
            }
          />

          <ScriptSection
            title="清理脚本"
            description="清理工作树之前在项目根目录下运行。"
            value={editor.cleanupScripts[editor.cleanupPlatform]}
            platform={editor.cleanupPlatform}
            onPlatformChange={(cleanupPlatform) =>
              onChange((cur) => (cur ? { ...cur, cleanupPlatform } : cur))
            }
            onChange={(value) =>
              onUpdateScript("cleanupScripts", editor.cleanupPlatform, value)
            }
          />

          <section className="rounded-lg border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">操作</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  可以把常用命令挂到项目工具栏，后续版本会接入执行入口。
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" disabled>
                <Plus className="size-3.5" />
                添加操作
              </Button>
            </div>
            <div className="mt-4 rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <WandSparkles className="size-4 text-muted-foreground" />
                操作工具栏留作 P4
              </div>
              <p className="mt-1 text-xs">
                当前只保存脚本配置，不创建、不清理、不派生工作树。
              </p>
            </div>
          </section>
        </div>
      </ScrollArea>

      <div className="flex shrink-0 items-center gap-2 px-8 py-4">
        <Button type="button" onClick={onSave} disabled={!dirty}>
          <Save />
          保存
        </Button>
        <Button type="button" variant="outline" onClick={onBack}>
          返回列表
        </Button>
        {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
      </div>
    </>
  )
}

function ScriptSection({
  title,
  description,
  value,
  platform,
  onPlatformChange,
  onChange
}: {
  title: string
  description: string
  value: string
  platform: EnvPlatform
  onPlatformChange: (platform: EnvPlatform) => void
  onChange: (value: string) => void
}) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-sans">
            变量
          </Badge>
          <code className="rounded-md border bg-background px-2 py-1 font-mono text-xs text-muted-foreground">
            $CLAUDINAL_WORKTREE_PATH
          </code>
        </div>
      </div>
      <PlatformTabs value={platform} onChange={onPlatformChange} />
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          platform === "windows"
            ? "pnpm install\r\npnpm build"
            : "pnpm install\npnpm build"
        }
        className="min-h-44 font-mono text-xs leading-5"
        spellCheck={false}
      />
    </section>
  )
}

function PlatformTabs({
  value,
  onChange
}: {
  value: EnvPlatform
  onChange: (value: EnvPlatform) => void
}) {
  return (
    <div className="inline-flex rounded-md border bg-muted p-1">
      {PLATFORM_OPTIONS.map((item) => {
        const active = value === item.value
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => onChange(item.value)}
            className={cn(
              "h-8 rounded px-3 text-sm transition-colors",
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
  )
}
