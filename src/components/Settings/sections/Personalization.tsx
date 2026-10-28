import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ExternalLink,
  FileText,
  Folder,
  FolderLock,
  Pin,
  PinOff,
  Save,
  UserCircle
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn, formatPathForDisplay } from "@/lib/utils"
import {
  claudeMdPath,
  openExternal,
  openPath,
  readClaudeMd,
  writeClaudeMd,
  type SettingsScope
} from "@/lib/ipc"
import {
  loadSettings,
  saveSettings,
  type AppSettings
} from "@/lib/settings"
import { loadSlashCommandsCache } from "@/lib/slashCommands"
import {
  SettingsCard,
  SettingsCardTitle,
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionHeader
} from "./layout"

interface Props {
  cwd?: string | null
}

interface ScopeDef {
  id: SettingsScope
  label: string
  hint: string
  needsCwd: boolean
  icon: typeof Folder
}

const SCOPES: ScopeDef[] = [
  {
    id: "global",
    label: "全局",
    hint: "对所有项目生效",
    needsCwd: false,
    icon: Folder
  },
  {
    id: "project",
    label: "项目",
    hint: "随项目入库，团队共享",
    needsCwd: true,
    icon: FileText
  },
  {
    id: "project-local",
    label: "项目（本地）",
    hint: "仅本机生效，应加入 .gitignore",
    needsCwd: true,
    icon: FolderLock
  }
]

const DOC_URL = "https://code.claude.com/docs/en/memory"

// 兜底常用 slash，避免设置页第一次打开时空白
const FALLBACK_SLASH = [
  "clear",
  "compact",
  "context",
  "init",
  "review",
  "security-review",
  "usage"
]

export function Personalization({ cwd }: Props) {
  const [scope, setScope] = useState<SettingsScope>("global")
  const [filePath, setFilePath] = useState<string>("")
  const [content, setContent] = useState<string>("")
  const [original, setOriginal] = useState<string>("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [slashSearch, setSlashSearch] = useState("")

  const cwdReady = !!cwd
  const cur = SCOPES.find((s) => s.id === scope) ?? SCOPES[0]
  const dirty = content !== original
  const disabled = cur.needsCwd && !cwdReady
  const targetKey = JSON.stringify([scope, cwd ?? null])
  const targetRef = useRef(targetKey)
  targetRef.current = targetKey
  const loadedTargetRef = useRef<string | null>(null)
  const loadRequestRef = useRef(0)
  const targetReady = loadedTargetRef.current === targetKey

  const load = useCallback(
    async (target: SettingsScope) => {
      const request = ++loadRequestRef.current
      const key = JSON.stringify([target, cwd ?? null])
      const current = () => request === loadRequestRef.current && targetRef.current === key
      loadedTargetRef.current = null
      setFilePath(""); setContent(""); setOriginal(""); setSaving(false)
      const def = SCOPES.find((s) => s.id === target) ?? SCOPES[0]
      if (def.needsCwd && !cwd) {
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const path = await claudeMdPath(target, cwd ?? undefined)
        if (!current()) return
        setFilePath(path)
        const raw = await readClaudeMd(target, cwd ?? undefined)
        if (!current()) return
        loadedTargetRef.current = key
        setContent(raw)
        setOriginal(raw)
      } catch (e) {
        if (!current()) return
        toast.error(`读取 CLAUDE.md 失败: ${String(e)}`)
        setContent("")
        setOriginal("")
      } finally {
        if (current()) setLoading(false)
      }
    },
    [cwd]
  )

  useEffect(() => {
    void load(scope)
    return () => { loadRequestRef.current++ }
  }, [scope, load])

  const save = async () => {
    if (!dirty || disabled || loading || saving || loadedTargetRef.current !== targetKey) return
    const request = loadRequestRef.current
    const current = () => request === loadRequestRef.current && targetRef.current === targetKey
    const savedContent = content
    setSaving(true)
    try {
      await writeClaudeMd(scope, savedContent, cwd ?? undefined)
      if (!current()) return
      setOriginal(savedContent)
      toast.success("已保存 CLAUDE.md，下次会话生效")
    } catch (e) {
      if (current()) toast.error(`保存失败: ${String(e)}`)
    } finally {
      if (current()) setSaving(false)
    }
  }

  const reset = () => {
    setContent(original)
  }

  // —— pinned slash 部分 ——
  const slashPool = useMemo(() => {
    const cached = loadSlashCommandsCache()
    const merged = new Set<string>([
      ...cached,
      ...FALLBACK_SLASH,
      ...settings.pinnedSlash
    ])
    return Array.from(merged).sort((a, b) => a.localeCompare(b))
  }, [settings.pinnedSlash])

  const filteredSlash = useMemo(() => {
    const q = slashSearch.trim().toLowerCase()
    if (!q) return slashPool
    return slashPool.filter((s) => s.toLowerCase().includes(q))
  }, [slashPool, slashSearch])

  const togglePin = (cmd: string) => {
    setSettings((cur) => {
      const has = cur.pinnedSlash.includes(cmd)
      const next: AppSettings = {
        ...cur,
        pinnedSlash: has
          ? cur.pinnedSlash.filter((c) => c !== cmd)
          : [...cur.pinnedSlash, cmd]
      }
      saveSettings(next)
      return next
    })
  }

  const clearPins = () => {
    setSettings((cur) => {
      const next: AppSettings = { ...cur, pinnedSlash: [] }
      saveSettings(next)
      return next
    })
  }

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={UserCircle}
        title="个性化"
        description="管理 CLAUDE.md 自定义指令和常用斜杠命令。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              openExternal(DOC_URL).catch((e) => toast.error(String(e)))
            }
          >
            <ExternalLink className="size-3.5" />
            了解 CLAUDE.md
          </Button>
        }
      />

      <SettingsSectionBody>
        <SettingsCard>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <SettingsCardTitle description="写入 CLAUDE.md，每次会话自动作为指令加载。">
                自定义指令
              </SettingsCardTitle>
            </div>
            <div className="inline-flex rounded-md border bg-muted p-1" role="tablist" aria-label="CLAUDE.md 范围">
              {SCOPES.map((s) => {
                const Icon = s.icon
                const active = s.id === scope
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setScope(s.id)}
                    title={s.hint}
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded px-2.5 text-xs transition-colors",
                      active
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="size-3.5" />
                    {s.label}
                  </button>
                )
              })}
            </div>
          </div>

          {disabled ? (
            <div className="rounded-md border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
              先在侧边栏选择一个项目，再编辑项目级 CLAUDE.md。
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span
                  className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                  title={formatPathForDisplay(filePath)}
                >
                  {formatPathForDisplay(filePath) || "正在解析路径…"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground"
                  onClick={() =>
                    filePath &&
                    openPath(filePath).catch((e) => toast.error(String(e)))
                  }
                  disabled={!filePath}
                >
                  <ExternalLink className="size-3.5" />
                  在系统中打开
                </Button>
              </div>
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={
                  loading
                    ? "正在加载…"
                    : "# 项目说明\n\n## 代码风格\n\n## 依赖说明"
                }
                disabled={loading || !targetReady}
                className="min-h-[260px] max-h-[480px] font-mono text-[13px] leading-relaxed"
                spellCheck={false}
              />
              {dirty && (
                <div className="flex items-center justify-end gap-2">
                  <span className="mr-auto text-xs text-warn">有未保存的修改</span>
                  <Button size="sm" variant="ghost" onClick={reset} disabled={saving}>
                    撤销
                  </Button>
                  <Button size="sm" onClick={save} disabled={saving || loading || !targetReady}>
                    <Save className="size-3.5" />
                    {saving ? "保存中…" : "保存"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </SettingsCard>

        <SettingsCard>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SettingsCardTitle description="置顶的命令在输入 / 时排在最前。">
                高频命令置顶
              </SettingsCardTitle>
            </div>
            {settings.pinnedSlash.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearPins}
                className="-mt-1 shrink-0 text-muted-foreground"
              >
                <PinOff className="size-3.5" />
                全部取消
              </Button>
            )}
          </div>

          {settings.pinnedSlash.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {settings.pinnedSlash.map((cmd) => (
                <button
                  key={cmd}
                  type="button"
                  onClick={() => togglePin(cmd)}
                  className="inline-flex items-center gap-1 rounded-full border bg-primary/5 px-2.5 py-0.5 text-xs hover:bg-accent"
                  title="取消置顶"
                >
                  <Pin className="size-3 text-primary" />
                  <span className="font-mono">/{cmd}</span>
                </button>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <Input
              type="text"
              value={slashSearch}
              onChange={(e) => setSlashSearch(e.target.value)}
              placeholder="搜索命令…"
              className="h-8"
            />
            <ScrollArea className="max-h-[260px] rounded-md border" viewportClassName="max-h-[260px]">
              {filteredSlash.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  暂无命令；启动一次会话后会读取 CLI 提供的命令列表。
                </div>
              ) : (
                <ul className="divide-y">
                  {filteredSlash.map((cmd) => {
                    const pinned = settings.pinnedSlash.includes(cmd)
                    return (
                      <li key={cmd}>
                        <button
                          type="button"
                          onClick={() => togglePin(cmd)}
                          aria-pressed={pinned}
                          className="group flex h-8 w-full items-center justify-between px-3 text-left transition-colors hover:bg-accent/50"
                        >
                          <span className={cn("font-mono text-xs", !pinned && "text-muted-foreground group-hover:text-foreground")}>/{cmd}</span>
                          {pinned ? (
                            <Pin className="size-3.5 text-primary" />
                          ) : (
                            <Pin className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground" />
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </ScrollArea>
          </div>
        </SettingsCard>
      </SettingsSectionBody>
    </SettingsSection>
  )
}
