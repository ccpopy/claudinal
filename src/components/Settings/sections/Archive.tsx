import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Archive as ArchiveIcon,
  ArchiveRestore,
  Database,
  Eye,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  Wrench
} from "lucide-react"
import { toast } from "sonner"
import { ArchivedSessionPreview } from "@/components/ArchivedSessionPreview"
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
  rebuildSessionIndex,
  sessionIndexDiagnostics,
  type SessionIndexDiagnostics,
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
  const [previewRow, setPreviewRow] = useState<ArchivedRow | null>(null)
  const [diag, setDiag] = useState<SessionIndexDiagnostics | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [confirmRebuild, setConfirmRebuild] = useState(false)

  const refreshDiag = useCallback(async () => {
    setDiagLoading(true)
    try {
      const next = await sessionIndexDiagnostics()
      setDiag(next)
      setDiagError(null)
    } catch (e) {
      setDiag(null)
      setDiagError(String(e))
    } finally {
      setDiagLoading(false)
    }
  }, [])

  const handleRebuild = useCallback(async () => {
    setConfirmRebuild(false)
    setRebuilding(true)
    try {
      await rebuildSessionIndex()
      toast.success("索引已重建，下次打开列表会重新扫描 jsonl / sidecar")
      await refreshDiag()
    } catch (e) {
      toast.error(`重建索引失败: ${String(e)}`)
    } finally {
      setRebuilding(false)
    }
  }, [refreshDiag])

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
    void refreshDiag()
  }, [refresh, refreshDiag])

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

  const handleView = useCallback((row: ArchivedRow) => {
    if (!row.meta) return
    setPreviewRow(row)
  }, [])

  const handlePreviewUnarchived = useCallback(() => {
    refresh()
  }, [refresh])

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
                    onView={() => handleView(row)}
                    onRestore={() => handleRestore(row)}
                    onDelete={() => setPendingDelete(row)}
                  />
                ))}
              </div>
            </section>
          ))
        )}

        <SessionIndexDiagnosticsCard
          diag={diag}
          error={diagError}
          loading={diagLoading}
          rebuilding={rebuilding}
          onRefresh={() => void refreshDiag()}
          onRebuildRequest={() => setConfirmRebuild(true)}
        />
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

      <ArchivedSessionPreview
        target={
          previewRow && previewRow.meta
            ? { project: previewRow.project, session: previewRow.meta }
            : null
        }
        onOpenChange={(open) => {
          if (!open) setPreviewRow(null)
        }}
        onUnarchived={handlePreviewUnarchived}
      />

      <ConfirmDialog
        open={confirmRebuild}
        onOpenChange={setConfirmRebuild}
        title="重建会话索引"
        confirmText={rebuilding ? "重建中…" : "重建"}
        description={
          <span>
            将清空 SQLite 中的派生缓存表（session_index / session_usage / activity_bucket / fts 等），<strong>不会触碰</strong> jsonl 或 sidecar；下次打开列表 / 统计页时会重新扫描磁盘填充。如果列表显示异常或损坏可执行此操作。
          </span>
        }
        onConfirm={handleRebuild}
      />
    </SettingsSection>
  )
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`
}

function displayIndexPath(path: string): string {
  const marker = ".claudinal"
  const normalized = path.replaceAll("/", "\\")
  const idx = normalized.toLowerCase().lastIndexOf(`\\${marker}\\`)
  if (idx >= 0) return normalized.slice(idx + 1)
  if (normalized.toLowerCase().startsWith(`${marker}\\`)) return normalized
  return normalized
}

function SessionIndexDiagnosticsCard({
  diag,
  error,
  loading,
  rebuilding,
  onRefresh,
  onRebuildRequest
}: {
  diag: SessionIndexDiagnostics | null
  error: string | null
  loading: boolean
  rebuilding: boolean
  onRefresh: () => void
  onRebuildRequest: () => void
}) {
  const schemaMismatch =
    diag != null && diag.schemaVersion !== diag.expectedSchemaVersion
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Database className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-semibold">会话索引</span>
        <span className="text-[11px] text-muted-foreground">
          仅读取缓存，不影响原始会话数据。
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading || rebuilding}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            诊断
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRebuildRequest}
            disabled={loading || rebuilding}
          >
            {rebuilding ? <Loader2 className="animate-spin" /> : <Wrench />}
            重建索引
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3 text-xs">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
            <div className="font-medium">读取索引失败</div>
            <div className="mt-1 break-all font-mono">{error}</div>
            <div className="mt-2 text-muted-foreground">
              如果索引文件损坏或异常，点击右上「重建索引」即可重置缓存。
            </div>
          </div>
        ) : diag ? (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <DiagRow
                label="数据库路径"
                value={displayIndexPath(diag.path)}
                title={diag.path}
                mono
              />
              <DiagRow
                label="schema 版本"
                value={diag.schemaVersion.toLocaleString("en-US")}
                tone={schemaMismatch ? "warn" : "default"}
              />
              <DiagRow label="文件大小" value={fmtBytes(diag.fileSizeBytes)} />
              <DiagRow
                label="会话索引行"
                value={diag.sessionIndexRows.toLocaleString("en-US")}
              />
              <DiagRow
                label="用量索引行"
                value={diag.sessionUsageRows.toLocaleString("en-US")}
              />
              <DiagRow
                label="活跃度数据行"
                value={diag.activityBucketRows.toLocaleString("en-US")}
              />
              <DiagRow
                label="活跃度扫描进度"
                value={diag.heatmapProgressRows.toLocaleString("en-US")}
              />
              <DiagRow
                label="全文搜索扫描进度"
                value={diag.ftsProgressRows.toLocaleString("en-US")}
              />
              <DiagRow
                label="全文索引行"
                value={diag.sessionTextRows.toLocaleString("en-US")}
              />
            </div>
            {schemaMismatch && (
              <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-warn">
                schema 版本与当前应用期望不一致，建议重建索引以避免读写错位。
              </div>
            )}
          </>
        ) : loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            读取诊断信息中…
          </div>
        ) : (
          <div className="text-muted-foreground">尚未读取索引诊断信息。</div>
        )}
      </div>
    </section>
  )
}

function DiagRow({
  label,
  value,
  title,
  mono,
  tone
}: {
  label: string
  value: string
  title?: string
  mono?: boolean
  tone?: "warn" | "default"
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={[
          "block min-w-0 flex-1 truncate",
          mono ? "font-mono" : "tabular-nums",
          tone === "warn" ? "text-warn" : ""
        ]
          .filter(Boolean)
          .join(" ")}
        title={title ?? value}
      >
        {value}
      </span>
    </div>
  )
}

function ArchivedListItem({
  row,
  isLast,
  onView,
  onRestore,
  onDelete
}: {
  row: ArchivedRow
  isLast: boolean
  onView: () => void
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
        {!orphan && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={onView}
                aria-label="查看会话内容"
              >
                <Eye className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              查看会话内容（保持归档）
            </TooltipContent>
          </Tooltip>
        )}
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
