import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction
} from "react"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderGit2,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  TreePine
} from "lucide-react"
import { toast } from "sonner"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  gitCreateWorktree,
  gitRemoveWorktree,
  gitSuggestWorktreePath,
  gitWorktreeList,
  openPath,
  type GitWorktreeInfo,
  type GitWorktreeList
} from "@/lib/ipc"
import {
  addProject,
  listProjects,
  removeProject as removeProjectStore,
  type Project
} from "@/lib/projects"
import { cn, formatPathForDisplay } from "@/lib/utils"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionHeader
} from "./layout"

interface Props {
  cwd?: string | null
  onSelectProject?: (project: Project) => void
  onProjectsChanged?: () => void
}

function normalizePath(path: string | null | undefined) {
  const original = path ?? ""
  const normalized = original.replace(/\\/g, "/").replace(/\/+$/, "")
  return /^[a-z]:\//i.test(normalized) || original.includes("\\")
    ? normalized.toLowerCase()
    : normalized
}

function basename(path: string | null | undefined) {
  return (path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "worktree"
}

function worktreeTitle(worktree: GitWorktreeInfo) {
  if (worktree.branch) return worktree.branch
  if (worktree.detached && worktree.head) {
    return `detached ${worktree.head.slice(0, 8)}`
  }
  if (worktree.bare) return "bare"
  return basename(worktree.path)
}

function worktreeSortKey(worktree: GitWorktreeInfo) {
  return `${worktree.branch ?? ""}:${worktree.path}`
}

function repoName(path: string | null | undefined) {
  return basename(path).replace(/\s+/g, "-").toLowerCase() || "repo"
}

function timestampSlug() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function defaultBranch(list: GitWorktreeList | null) {
  return `codex/${repoName(list?.currentRoot)}-${timestampSlug()}`
}

function currentBaseRef(list: GitWorktreeList | null) {
  return list?.worktrees.find((worktree) => worktree.current)?.branch ?? "HEAD"
}

interface CreateDraft {
  branch: string
  base: string
  path: string
  addProject: boolean
}

export function Worktree({ cwd, onSelectProject, onProjectsChanged }: Props) {
  const [projects, setProjects] = useState(() => listProjects())
  const [list, setList] = useState<GitWorktreeList | null>(null)
  const [loading, setLoading] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<GitWorktreeInfo | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createDraft, setCreateDraft] = useState<CreateDraft>(() => ({
    branch: "",
    base: "HEAD",
    path: "",
    addProject: true
  }))

  const worktrees = useMemo(
    () =>
      (list?.worktrees ?? [])
        .filter((worktree) => !worktree.current)
        .slice()
        .sort((a, b) => worktreeSortKey(a).localeCompare(worktreeSortKey(b))),
    [list?.worktrees]
  )

  const projectByPath = useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of projects) map.set(normalizePath(project.cwd), project)
    return map
  }, [projects])

  const refreshProjects = useCallback(() => {
    setProjects(listProjects())
    onProjectsChanged?.()
  }, [onProjectsChanged])

  const refresh = useCallback(async () => {
    if (!cwd) {
      setList(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setList(await gitWorktreeList(cwd))
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    refresh()
  }, [refresh])

  const ensureProject = useCallback(
    (path: string, select: boolean) => {
      const project = addProject(path)
      refreshProjects()
      if (select) {
        onSelectProject?.(project)
        toast.success("返回对话时将打开该工作树")
      } else {
        toast.success("已添加到项目列表")
      }
    },
    [onSelectProject, refreshProjects]
  )

  const suggestPath = useCallback(
    async (branch: string) => {
      if (!cwd) return
      const path = await gitSuggestWorktreePath({ cwd, branch })
      setCreateDraft((cur) => ({ ...cur, path }))
    },
    [cwd]
  )

  const openCreate = useCallback(async () => {
    if (!cwd || !list?.isRepo) return
    const branch = defaultBranch(list)
    const next = {
      branch,
      base: currentBaseRef(list),
      path: "",
      addProject: true
    }
    setCreateDraft(next)
    setCreateOpen(true)
    try {
      const path = await gitSuggestWorktreePath({ cwd, branch })
      setCreateDraft((cur) =>
        cur.branch === branch ? { ...cur, path } : cur
      )
    } catch (err) {
      toast.error(`生成默认路径失败: ${String(err)}`)
    }
  }, [cwd, list])

  const createWorktree = async () => {
    if (!cwd || creating) return
    const branch = createDraft.branch.trim()
    const path = createDraft.path.trim()
    const base = createDraft.base.trim() || "HEAD"
    if (!branch || !path) {
      toast.error("请填写分支名和工作树路径")
      return
    }
    setCreating(true)
    try {
      const result = await gitCreateWorktree({ cwd, branch, path, base })
      if (createDraft.addProject) {
        const project = addProject(result.path)
        refreshProjects()
        onSelectProject?.(project)
        toast.success("工作树已创建并添加到项目列表")
      } else {
        toast.success("工作树已创建")
      }
      setCreateOpen(false)
      await refresh()
    } catch (err) {
      toast.error(`创建工作树失败: ${String(err)}`)
    } finally {
      setCreating(false)
    }
  }

  const removeWorktree = async () => {
    if (!cwd || !pendingRemove || removing) return
    const target = pendingRemove
    setRemoving(true)
    try {
      await gitRemoveWorktree({ cwd, path: target.path })
      const stored = projectByPath.get(normalizePath(target.path))
      if (stored) {
        removeProjectStore(stored.id)
        refreshProjects()
      }
      toast.success("工作树已删除")
      setPendingRemove(null)
      await refresh()
    } catch (err) {
      toast.error(`删除失败: ${String(err)}`)
    } finally {
      setRemoving(false)
    }
  }

  const reading = loading || (!!cwd && !list && !error)
  const empty = !reading && list?.isRepo && worktrees.length === 0

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={TreePine}
        title="工作树"
        description="为当前 Git 仓库创建和管理隔离 worktree。"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={openCreate}
              disabled={reading || !cwd || !list?.isRepo}
            >
              <Plus className="size-3.5" />
              新建工作树
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={reading || !cwd}
            >
              <RefreshCw className={reading ? "size-3.5 animate-spin" : "size-3.5"} />
              刷新
            </Button>
          </div>
        }
      />

      <SettingsSectionBody>
        {!cwd ? (
          <EmptyState title="当前没有项目" detail="选择一个项目后即可查看该 Git 仓库的工作树。" />
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4" />
              读取工作树失败
            </div>
            <div className="mt-2 break-all font-mono text-xs">{error}</div>
          </div>
        ) : list && !list.isRepo ? (
          <EmptyState title="当前项目不是 Git 仓库" detail="工作树功能依赖 Git worktree 命令。" />
        ) : (
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <FolderGit2 className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">当前仓库</h3>
                {list?.currentRoot && (
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {formatPathForDisplay(list.currentRoot)}
                  </span>
                )}
              </div>
              <Badge variant="secondary" className="font-sans">
                {worktrees.length}
              </Badge>
            </div>

            {reading ? (
              <div className="flex h-32 items-center justify-center rounded-lg border bg-card">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : empty ? (
              <EmptyState title="暂无工作树" detail="可以新建一个隔离工作树，然后作为独立项目打开。" />
            ) : (
              <div className="overflow-hidden rounded-lg border bg-card">
                {worktrees.map((worktree, index) => (
                  <WorktreeRow
                    key={worktree.path}
                    worktree={worktree}
                    project={projectByPath.get(normalizePath(worktree.path)) ?? null}
                    isLast={index === worktrees.length - 1}
                    onOpen={() =>
                      openPath(worktree.path).catch((err) =>
                        toast.error(`打开失败: ${String(err)}`)
                      )
                    }
                    onCopy={() =>
                      navigator.clipboard
                        .writeText(worktree.path)
                        .then(() => toast.success("路径已复制"))
                        .catch((err) => toast.error(String(err)))
                    }
                    onProject={(project) => {
                      if (project) {
                        onSelectProject?.(project)
                        toast.success("返回对话时将打开该工作树")
                      } else {
                        ensureProject(worktree.path, true)
                      }
                    }}
                    onRemove={() => setPendingRemove(worktree)}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </SettingsSectionBody>

      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemove(null)
        }}
        title="删除工作树"
        destructive
        confirmText={removing ? "删除中" : "删除"}
        description={
          pendingRemove ? (
            <div className="space-y-2">
              <p>
                将删除{" "}
                <code className="font-mono text-xs">{worktreeTitle(pendingRemove)}</code>
                。如果工作树中还有未提交变更，Git 会拒绝删除。
              </p>
              <p className="break-all font-mono text-xs">{pendingRemove.path}</p>
            </div>
          ) : null
        }
        onConfirm={removeWorktree}
      />

      <CreateWorktreeDialog
        open={createOpen}
        draft={createDraft}
        creating={creating}
        onOpenChange={(open) => {
          if (!creating) setCreateOpen(open)
        }}
        onChange={setCreateDraft}
        onSuggestPath={() => {
          suggestPath(createDraft.branch).catch((err) =>
            toast.error(`生成路径失败: ${String(err)}`)
          )
        }}
        onBrowsePath={async () => {
          try {
            const selected = await openDialog({ directory: true, multiple: false })
            if (typeof selected === "string") {
              setCreateDraft((cur) => ({
                ...cur,
                path: selected.replace(/\\/g, "/")
              }))
            }
          } catch (err) {
            toast.error(String(err))
          }
        }}
        onConfirm={createWorktree}
      />
    </SettingsSection>
  )
}

function CreateWorktreeDialog({
  open,
  draft,
  creating,
  onOpenChange,
  onChange,
  onSuggestPath,
  onBrowsePath,
  onConfirm
}: {
  open: boolean
  draft: CreateDraft
  creating: boolean
  onOpenChange: (open: boolean) => void
  onChange: Dispatch<SetStateAction<CreateDraft>>
  onSuggestPath: () => void
  onBrowsePath: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-4" />
            新建工作树
          </DialogTitle>
          <DialogDescription>
            创建命令为 git worktree add -b 分支 路径 基础引用；Git 报错会直接显示。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="worktree-branch">新分支</Label>
            <Input
              id="worktree-branch"
              value={draft.branch}
              onChange={(event) =>
                onChange((cur) => ({ ...cur, branch: event.target.value }))
              }
              className="font-mono text-xs"
              placeholder="codex/my-task"
              disabled={creating}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="worktree-base">基础引用</Label>
            <Input
              id="worktree-base"
              value={draft.base}
              onChange={(event) =>
                onChange((cur) => ({ ...cur, base: event.target.value }))
              }
              className="font-mono text-xs"
              placeholder="HEAD"
              disabled={creating}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="worktree-path">工作树路径</Label>
            <div className="flex gap-2">
              <Input
                id="worktree-path"
                value={draft.path}
                onChange={(event) =>
                  onChange((cur) => ({ ...cur, path: event.target.value }))
                }
                className="font-mono text-xs"
                placeholder="C:/Users/me/.codex/worktrees/..."
                disabled={creating}
              />
              <Button
                type="button"
                variant="outline"
                onClick={onSuggestPath}
                disabled={creating || !draft.branch.trim()}
              >
                生成
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onBrowsePath}
                disabled={creating}
              >
                <FolderOpen className="size-4" />
                浏览
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
            <div>
              <Label htmlFor="worktree-add-project" className="text-sm">
                创建后添加为项目并打开
              </Label>
              <div className="mt-0.5 text-xs text-muted-foreground">
                关闭后只创建 Git worktree，不切换当前项目。
              </div>
            </div>
            <Switch
              id="worktree-add-project"
              checked={draft.addProject}
              onCheckedChange={(addProject) =>
                onChange((cur) => ({ ...cur, addProject }))
              }
              disabled={creating}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={creating || !draft.branch.trim() || !draft.path.trim()}
          >
            {creating ? <Loader2 className="animate-spin" /> : <Plus />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-44 flex-col items-center justify-center rounded-lg border border-dashed bg-card text-center">
      <TreePine className="mb-3 size-6 text-muted-foreground" />
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 max-w-md text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

function WorktreeRow({
  worktree,
  project,
  isLast,
  onOpen,
  onCopy,
  onProject,
  onRemove
}: {
  worktree: GitWorktreeInfo
  project: Project | null
  isLast: boolean
  onOpen: () => void
  onCopy: () => void
  onProject: (project: Project | null) => void
  onRemove: () => void
}) {
  const title = worktreeTitle(worktree)
  const removable = worktree.exists && !worktree.bare
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-accent/35",
        !isLast && "border-b"
      )}
    >
      <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
        <TreePine className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold" title={title}>
            {title}
          </span>
          {project && (
            <Badge variant="success" className="font-sans">
              项目
            </Badge>
          )}
          {worktree.changedFiles != null && worktree.changedFiles > 0 && (
            <Badge variant="warn" className="font-sans">
              {worktree.changedFiles} 个变更
            </Badge>
          )}
          {worktree.detached && (
            <Badge variant="outline" className="font-sans">
              detached
            </Badge>
          )}
          {worktree.locked != null && (
            <Badge variant="outline" className="font-sans">
              locked
            </Badge>
          )}
          {worktree.prunable != null && (
            <Badge variant="warn" className="font-sans">
              prunable
            </Badge>
          )}
          {!worktree.exists && (
            <Badge variant="destructive" className="font-sans">
              缺失
            </Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="truncate font-mono" title={worktree.path}>
            {formatPathForDisplay(worktree.path)}
          </span>
          {worktree.head && <span className="font-mono">{worktree.head.slice(0, 8)}</span>}
        </div>
        {worktree.statusError && (
          <div className="mt-1 break-all text-[11px] text-destructive">
            {worktree.statusError}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onCopy}
          aria-label="复制路径"
        >
          <Copy className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onOpen}
          disabled={!worktree.exists}
          aria-label="打开目录"
        >
          <ExternalLink className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onProject(project)}
          disabled={!worktree.exists || worktree.bare}
          className="h-8"
        >
          {project ? <Check className="size-3.5" /> : <GitBranch className="size-3.5" />}
          {project ? "打开" : "添加"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}
          disabled={!removable}
          aria-label="删除工作树"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  )
}
