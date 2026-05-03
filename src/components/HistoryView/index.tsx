import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent
} from "react"
import {
  ArrowLeft,
  ArrowDownNarrowWide,
  History as HistoryIcon,
  MessageSquare,
  RefreshCw,
  Search
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  listRecentSessionsAll,
  searchSessions,
  type SessionMeta,
  type SessionSearchHit
} from "@/lib/ipc"
import type { Project } from "@/lib/projects"
import { sessionDisplayTitle } from "@/lib/sessionDisplayTitle"
import { isArchived } from "@/lib/archivedSessions"
import { cn } from "@/lib/utils"

interface IndexedSession {
  project: Project
  session: SessionMeta
  title: string
  haystack: string
  projectLabel: string
  archived: boolean
}

interface BodyHit {
  project: Project
  session: SessionMeta
  title: string
  projectLabel: string
  snippet: string
  role: string
  archived: boolean
}

type SortMode = "modified" | "msgCount" | "title"

const POOL_SIZE = 500
const VISIBLE_LIMIT = 200

const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: "modified", label: "最近活动" },
  { value: "msgCount", label: "消息数" },
  { value: "title", label: "标题" }
]

interface Props {
  projects: Project[]
  onBack: () => void
  onSelectSession: (project: Project, session: SessionMeta) => void
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function normalizeCwd(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "")
}

function fmtRelative(ts: number): string {
  if (!ts) return ""
  const now = Date.now()
  const diff = Math.floor((now - ts * 1000) / 1000)
  if (diff < 60) return "刚刚"
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  return new Date(ts * 1000).toLocaleDateString("zh-CN")
}

function fmtAbsolute(ts: number): string {
  if (!ts) return ""
  return new Date(ts * 1000).toLocaleString("zh-CN")
}

function mapBodyHits(
  hits: SessionSearchHit[],
  projByCwd: Map<string, Project>
): BodyHit[] {
  const out: BodyHit[] = []
  for (const hit of hits) {
    const cwd = hit.cwd ? normalizeCwd(hit.cwd) : ""
    if (!cwd) continue
    const registered = projByCwd.get(cwd)
    const project: Project =
      registered ??
      ({
        id: `global::${cwd}`,
        cwd,
        name: basename(cwd) || cwd,
        lastUsedAt: 0
      } as Project)
    const session: SessionMeta = {
      id: hit.sessionId,
      file_path: hit.filePath ?? "",
      modified_ts: hit.modifiedTs ?? 0,
      size_bytes: 0,
      msg_count: 0,
      ai_title: hit.aiTitle ?? null,
      first_user_text: hit.firstUserText ?? null
    }
    out.push({
      project,
      session,
      title: sessionDisplayTitle(session),
      projectLabel: registered?.name ?? hit.dirLabel ?? basename(cwd),
      snippet: hit.snippet,
      role: hit.role,
      archived: isArchived(project.id, session.id)
    })
  }
  return out
}

export function HistoryView({ projects, onBack, onSelectSession }: Props) {
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState<IndexedSession[]>([])
  const [bodyHits, setBodyHits] = useState<BodyHit[]>([])
  const [bodySearching, setBodySearching] = useState(false)
  const [loading, setLoading] = useState(false)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>("modified")
  const [includeArchived, setIncludeArchived] = useState(false)
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const projByCwd = new Map<string, Project>()
      for (const p of projectsRef.current) {
        projByCwd.set(normalizeCwd(p.cwd), p)
      }
      const items = await listRecentSessionsAll(POOL_SIZE)
      const built: IndexedSession[] = []
      for (const item of items) {
        const cwd = item.cwd ? normalizeCwd(item.cwd) : null
        if (!cwd) continue
        const registered = projByCwd.get(cwd)
        const project: Project =
          registered ??
          ({
            id: `global::${cwd}`,
            cwd,
            name: basename(cwd) || cwd,
            lastUsedAt: 0
          } as Project)
        const session: SessionMeta = {
          id: item.id,
          file_path: item.file_path,
          modified_ts: item.modified_ts,
          size_bytes: item.size_bytes,
          msg_count: item.msg_count,
          ai_title: item.ai_title,
          first_user_text: item.first_user_text
        }
        const title = sessionDisplayTitle(session)
        const projectLabel = registered?.name ?? item.dirLabel ?? basename(cwd)
        const haystack = [
          title,
          session.first_user_text ?? "",
          projectLabel,
          project.cwd
        ]
          .join("\n")
          .toLowerCase()
        built.push({
          project,
          session,
          title,
          haystack,
          projectLabel,
          archived: isArchived(project.id, session.id)
        })
      }
      built.sort((a, b) => b.session.modified_ts - a.session.modified_ts)
      setIndex(built)
    } catch (e) {
      toast.error(`读取历史会话失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const trimmedQuery = query.trim()
  const lowerQuery = trimmedQuery.toLowerCase()

  useEffect(() => {
    if (trimmedQuery.length < 2) {
      setBodyHits([])
      setBodySearching(false)
      return
    }
    const projByCwd = new Map<string, Project>()
    for (const p of projectsRef.current) {
      projByCwd.set(normalizeCwd(p.cwd), p)
    }
    let cancelled = false
    setBodySearching(true)
    const handle = window.setTimeout(() => {
      searchSessions(trimmedQuery, 60)
        .then((hits) => {
          if (cancelled) return
          setBodyHits(mapBodyHits(hits, projByCwd))
        })
        .catch(() => {
          if (cancelled) return
          setBodyHits([])
        })
        .finally(() => {
          if (!cancelled) setBodySearching(false)
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [trimmedQuery])

  const projectsInIndex = useMemo(() => {
    const map = new Map<string, { id: string; label: string }>()
    for (const entry of index) {
      if (!map.has(entry.project.id)) {
        map.set(entry.project.id, {
          id: entry.project.id,
          label: entry.projectLabel
        })
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.label.localeCompare(b.label)
    )
  }, [index])

  const filteredSessions = useMemo(() => {
    let pool = index
    if (!includeArchived) {
      pool = pool.filter((entry) => !entry.archived)
    }
    if (projectFilter) {
      pool = pool.filter((entry) => entry.project.id === projectFilter)
    }
    if (trimmedQuery) {
      pool = pool.filter((entry) => entry.haystack.includes(lowerQuery))
    }
    const sorted = [...pool].sort((a, b) => {
      if (sortMode === "msgCount") {
        return (b.session.msg_count ?? 0) - (a.session.msg_count ?? 0)
      }
      if (sortMode === "title") {
        return a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
      }
      return b.session.modified_ts - a.session.modified_ts
    })
    return sorted.slice(0, VISIBLE_LIMIT)
  }, [
    index,
    trimmedQuery,
    lowerQuery,
    projectFilter,
    sortMode,
    includeArchived
  ])

  const dedupedBodyHits = useMemo(() => {
    if (bodyHits.length === 0) return [] as BodyHit[]
    const titleIds = new Set(filteredSessions.map((m) => m.session.id))
    const seen = new Set<string>()
    const out: BodyHit[] = []
    for (const hit of bodyHits) {
      if (projectFilter && hit.project.id !== projectFilter) continue
      if (titleIds.has(hit.session.id)) continue
      if (seen.has(hit.session.id)) continue
      if (!includeArchived && hit.archived) continue
      seen.add(hit.session.id)
      out.push(hit)
    }
    return out.slice(0, 30)
  }, [bodyHits, filteredSessions, projectFilter, includeArchived])

  const totalIndexed = index.length
  const totalArchived = useMemo(
    () => index.filter((e) => e.archived).length,
    [index]
  )

  const handleSelect = (entry: { project: Project; session: SessionMeta }) => {
    onSelectSession(entry.project, entry.session)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-8 pb-4 pt-8">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            返回
          </button>
        </div>
        <div className="mt-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <HistoryIcon className="size-5" />
              历史会话
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              跨项目浏览 <code className="font-mono text-xs">~/.claude/projects/</code>{" "}
              下的所有会话记录。元数据从 SQLite 缓存读取，全文搜索基于 FTS5。可按标题、项目、消息数或最近活动排序。
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            刷新
          </Button>
        </div>
      </div>

      <div className="shrink-0 border-y bg-card/50 px-8 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex min-w-[260px] flex-1 items-center">
            <Search className="absolute left-2.5 size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setQuery(e.target.value)
              }
              placeholder="搜索标题 / 首条用户文本 / 正文（输入 ≥ 2 个字符触发 FTS）"
              className="h-8 w-full rounded-md border bg-background px-2.5 pl-7 text-sm outline-none transition-colors focus:border-primary/40"
            />
          </div>
          <div className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[11px] text-muted-foreground">
            <ArrowDownNarrowWide className="size-3.5" />
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="bg-transparent text-foreground outline-none"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  按{o.label}
                </option>
              ))}
            </select>
          </div>
          {projectsInIndex.length > 0 && (
            <select
              value={projectFilter ?? ""}
              onChange={(e) =>
                setProjectFilter(e.target.value ? e.target.value : null)
              }
              className="h-8 max-w-[220px] truncate rounded-md border bg-background px-2 text-[11px] text-foreground outline-none"
            >
              <option value="">全部项目（{projectsInIndex.length}）</option>
              {projectsInIndex.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
          <label className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            <span>含归档</span>
            {totalArchived > 0 && (
              <span className="tabular-nums opacity-70">{totalArchived}</span>
            )}
          </label>
          {(projectFilter || sortMode !== "modified" || includeArchived) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setProjectFilter(null)
                setSortMode("modified")
                setIncludeArchived(false)
              }}
              className="h-8"
            >
              清除筛选
            </Button>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {filteredSessions.length} / {totalIndexed}
          </span>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-6 px-8 pb-10 pt-6">
          {loading && index.length === 0 ? (
            <EmptyState text="正在索引会话…" />
          ) : filteredSessions.length === 0 && dedupedBodyHits.length === 0 ? (
            <EmptyState
              text={
                trimmedQuery
                  ? "没有匹配的会话"
                  : totalIndexed === 0
                    ? "尚未在 ~/.claude/projects/ 下找到任何 jsonl"
                    : "当前筛选下没有会话"
              }
            />
          ) : (
            <>
              <section className="space-y-2">
                <SectionTitle
                  label="会话列表"
                  count={filteredSessions.length}
                />
                <div className="overflow-hidden rounded-lg border bg-card">
                  {filteredSessions.map((entry, idx) => (
                    <SessionRow
                      key={`${entry.project.id}:${entry.session.id}`}
                      entry={entry}
                      isLast={idx === filteredSessions.length - 1}
                      onSelect={() => handleSelect(entry)}
                    />
                  ))}
                </div>
              </section>

              {dedupedBodyHits.length > 0 && (
                <section className="space-y-2">
                  <SectionTitle
                    label="正文命中"
                    count={dedupedBodyHits.length}
                    hint={bodySearching ? "搜索中…" : undefined}
                  />
                  <div className="overflow-hidden rounded-lg border bg-card">
                    {dedupedBodyHits.map((hit, idx) => (
                      <BodyHitRow
                        key={`body:${hit.project.id}:${hit.session.id}`}
                        hit={hit}
                        isLast={idx === dedupedBodyHits.length - 1}
                        onSelect={() => handleSelect(hit)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function SectionTitle({
  label,
  count,
  hint
}: {
  label: string
  count: number
  hint?: string
}) {
  return (
    <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
      <span>{label}</span>
      <span className="font-mono tabular-nums">{count}</span>
      {hint && <span className="text-[11px] normal-case">· {hint}</span>}
    </div>
  )
}

function SessionRow({
  entry,
  isLast,
  onSelect
}: {
  entry: IndexedSession
  isLast: boolean
  onSelect: () => void
}) {
  const ts = entry.session.modified_ts
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-accent/40",
        !isLast && "border-b"
      )}
      title={entry.title}
    >
      <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.title}</span>
          {entry.archived && (
            <Badge variant="outline" className="font-sans text-[10px]">
              已归档
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
          <span className="truncate" title={entry.project.cwd}>
            {entry.projectLabel}
          </span>
          <span title={fmtAbsolute(ts)}>{fmtRelative(ts)}</span>
          <span>{entry.session.msg_count} 条消息</span>
          <span className="truncate font-mono opacity-70">
            {entry.session.id.slice(0, 8)}
          </span>
        </div>
      </div>
    </button>
  )
}

function BodyHitRow({
  hit,
  isLast,
  onSelect
}: {
  hit: BodyHit
  isLast: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors hover:bg-accent/40",
        !isLast && "border-b"
      )}
    >
      <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{hit.title}</span>
          <Badge variant="outline" className="font-sans text-[10px]">
            {hit.role}
          </Badge>
          {hit.archived && (
            <Badge variant="outline" className="font-sans text-[10px]">
              已归档
            </Badge>
          )}
        </div>
        <div
          className="max-h-20 overflow-hidden text-xs text-muted-foreground whitespace-pre-wrap break-words"
          title={hit.snippet}
        >
          {hit.snippet}
        </div>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {hit.projectLabel}
        </div>
      </div>
    </button>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-card py-16 text-center">
      <HistoryIcon className="size-6 text-muted-foreground" />
      <div className="mt-2 text-sm font-medium">{text}</div>
    </div>
  )
}
