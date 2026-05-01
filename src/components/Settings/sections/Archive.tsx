import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Archive as ArchiveIcon,
  ArchiveRestore,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2
} from "lucide-react"
import { toast } from "sonner"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import {
  deleteSessionJsonl,
  listProjectSessions,
  type SessionMeta
} from "@/lib/ipc"
import {
  listArchived,
  unarchive,
  type ArchivedRef
} from "@/lib/archivedSessions"
import { unpin } from "@/lib/pinned"
import { listProjects, type Project } from "@/lib/projects"
import { getSessionTitle } from "@/lib/sessionTitles"
import { sessionDisplayTitle } from "@/lib/sessionDisplayTitle"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionHeader
} from "./layout"

// 单条归档行的合并视图：localStorage 里的 ArchivedRef + 真实 jsonl 元数据 + 项目信息
interface ArchivedRow {
  ref: ArchivedRef
  project: Project
  // null 表示已无对应 jsonl（项目移除 / 文件被外部删除）；仍允许「恢复」「移除记录」
  meta: SessionMeta | null
}

function fmtRelative(ts: number): string {
  if (!ts) return ""
  const now = Date.now()
  const diff = Math.floor((now - ts) / 1000)
  if (diff < 60) return "刚刚"
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  return new Date(ts).toLocaleDateString()
}

function rowTitle(row: ArchivedRow): string {
  const customTitle = getSessionTitle(row.ref.sessionId)
  if (customTitle) return customTitle
  if (row.meta) return sessionDisplayTitle(row.meta)
  return row.ref.sessionId.slice(0, 8)
}

interface Props {
  onSelectProject?: (project: Project) => void
  onSelectSession?: (project: Project, session: SessionMeta) => void
}

export function Archive({ onSelectProject, onSelectSession }: Props) {
  const [rows, setRows] = useState<ArchivedRow[]>([])
  const [loading, setLoading] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ArchivedRow | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const refs = listArchived()
      if (refs.length === 0) {
        setRows([])
        return
      }
      const projects = listProjects()
      const projectMap = new Map(projects.map((p) => [p.id, p]))
      // 按项目分组拉一次 sessions，避免重复读
      const byProject = new Map<string, ArchivedRef[]>()
      for (const ref of refs) {
        if (!projectMap.has(ref.projectId)) continue
        const arr = byProject.get(ref.projectId) ?? []
        arr.push(ref)
        byProject.set(ref.projectId, arr)
      }
      const out: ArchivedRow[] = []
      for (const [projectId, list] of byProject) {
        const project = projectMap.get(projectId)
        if (!project) continue
        let metas: SessionMeta[] = []
        try {
          metas = await listProjectSessions(project.cwd)
        } catch {
          // 项目目录被移除等：仍展示 ref，meta = null
        }
        const metaMap = new Map(metas.map((m) => [m.id, m]))
        for (const ref of list) {
          out.push({ ref, project, meta: metaMap.get(ref.sessionId) ?? null })
        }
      }
      // 与 listArchived 保持一致：按 archivedAt 倒序
      out.sort((a, b) => b.ref.archivedAt - a.ref.archivedAt)
      // 同时清掉所有归档但其项目已不在的孤儿记录（不实施，保留在内存里以便用户手动移除）
      setRows(out)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 按项目分组渲染
  const grouped = useMemo(() => {
    const map = new Map<string, { project: Project; items: ArchivedRow[] }>()
    for (const row of rows) {
      const cur = map.get(row.project.id)
      if (cur) {
        cur.items.push(row)
      } else {
        map.set(row.project.id, { project: row.project, items: [row] })
      }
    }
    // 项目按内部 items[0].archivedAt 倒序
    return Array.from(map.values()).sort(
      (a, b) => b.items[0].ref.archivedAt - a.items[0].ref.archivedAt
    )
  }, [rows])

  const handleRestore = useCallback(
    (row: ArchivedRow) => {
      unarchive(row.project.id, row.ref.sessionId)
      if (row.meta) {
        onSelectSession?.(row.project, row.meta)
      } else {
        onSelectProject?.(row.project)
      }
      toast.success("已恢复，可在返回对话后查看")
      refresh()
    },
    [onSelectProject, onSelectSession, refresh]
  )

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return
    const row = pendingDelete
    try {
      // 即使 jsonl 已不存在，删除也安全（Rust 端已是幂等）；
      // 但项目被移除时 cwd 可能也无效，此时跳过文件删除，仅清记录
      if (row.meta) {
        await deleteSessionJsonl(row.project.cwd, row.ref.sessionId)
      }
      unpin(row.project.id, row.ref.sessionId)
      unarchive(row.project.id, row.ref.sessionId)
      toast.success("会话已删除")
      refresh()
    } catch (e) {
      toast.error(`删除失败: ${String(e)}`)
    } finally {
      setPendingDelete(null)
    }
  }, [pendingDelete, refresh])

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={ArchiveIcon}
        title="已归档对话"
        description={
          <>
            归档不影响 jsonl 文件本身，仅在侧边栏中隐藏；可在 chat 头部菜单的「归档会话」中操作。
          </>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            刷新
          </Button>
        }
      />

      <SettingsSectionBody>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-card py-16">
            {loading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <>
                <ArchiveIcon className="size-6 text-muted-foreground" />
                <div className="mt-2 text-sm font-medium">还没有归档的会话</div>
                <div className="mt-1 max-w-md text-center text-xs text-muted-foreground">
                  打开任意会话，点击标题旁的「⋯」菜单，选择「归档会话」即可移到这里。归档后会话从侧边栏隐藏，但 jsonl 不会被删除。
                </div>
              </>
            )}
          </div>
        ) : (
          grouped.map((group) => (
            <section key={group.project.id} className="space-y-3">
              <div className="flex items-center gap-2">
                <FolderOpen className="size-3.5 text-muted-foreground" />
                <span
                  className="truncate text-sm font-semibold"
                  title={group.project.cwd}
                >
                  {group.project.name}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {group.items.length}
                </span>
              </div>
              <div className="overflow-hidden rounded-lg border bg-card">
                {group.items.map((row, idx) => (
                  <ArchivedListItem
                    key={`${row.project.id}:${row.ref.sessionId}`}
                    row={row}
                    isLast={idx === group.items.length - 1}
                    onRestore={() => handleRestore(row)}
                    onDelete={() => setPendingDelete(row)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </SettingsSectionBody>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title="删除归档会话"
        destructive
        confirmText="删除"
        description={
          pendingDelete ? (
            <span>
              将永久删除会话{" "}
              <code className="font-mono text-xs">
                {pendingDelete.ref.sessionId.slice(0, 8)}
              </code>{" "}
              的 jsonl 文件，此操作不可恢复。
            </span>
          ) : null
        }
        onConfirm={handleDelete}
      />
    </SettingsSection>
  )
}

function ArchivedListItem({
  row,
  isLast,
  onRestore,
  onDelete
}: {
  row: ArchivedRow
  isLast: boolean
  onRestore: () => void
  onDelete: () => void
}) {
  const title = rowTitle(row)
  const archivedAgo = fmtRelative(row.ref.archivedAt)
  const orphan = row.meta == null
  const msgCount = row.meta?.msg_count ?? null

  return (
    <div
      className={
        isLast
          ? "flex items-center gap-3 px-5 py-3.5"
          : "flex items-center gap-3 border-b px-5 py-3.5"
      }
    >
      <ArchiveIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium" title={title}>
            {title}
          </span>
          {orphan && (
            <Badge variant="warn" className="font-sans">
              jsonl 缺失
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
          <span>归档于 {archivedAgo}</span>
          {msgCount != null && <span>{msgCount} 条消息</span>}
          <span
            className="truncate font-mono"
            title={row.ref.sessionId}
          >
            {row.ref.sessionId.slice(0, 8)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={onRestore}
              aria-label="恢复"
            >
              <ArchiveRestore className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {orphan ? "移除归档记录" : "恢复"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
              aria-label="删除"
            >
              <Trash2 className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">删除 jsonl</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
