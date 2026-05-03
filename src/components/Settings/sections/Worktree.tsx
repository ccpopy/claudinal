import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Loader2,
  RefreshCw,
  Trash2,
  TreePine
} from "lucide-react"
import { toast } from "sonner"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  gitRemoveWorktree,
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

export function Worktree({ cwd, onSelectProject, onProjectsChanged }: Props) {
  const [projects, setProjects] = useState(() => listProjects())
  const [list, setList] = useState<GitWorktreeList | null>(null)
  const [loading, setLoading] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<GitWorktreeInfo | null>(null)

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
        description="查看当前 Git 仓库已经存在的隔离 worktree。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={reading || !cwd}
          >
            <RefreshCw className={reading ? "size-3.5 animate-spin" : "size-3.5"} />
            刷新
          </Button>
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
              <EmptyState title="暂无工作树" detail="当前仓库没有除主工作区以外的 Git worktree。" />
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
    </SettingsSection>
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
