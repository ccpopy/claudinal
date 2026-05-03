import { useCallback, useEffect, useMemo, useState } from "react"
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

  const load = useCallback(
    async (target: SettingsScope) => {
      const def = SCOPES.find((s) => s.id === target) ?? SCOPES[0]
      if (def.needsCwd && !cwd) {
        setFilePath("")
        setContent("")
        setOriginal("")
        return
      }
      setLoading(true)
      try {
        const path = await claudeMdPath(target, cwd ?? undefined)
        setFilePath(path)
        const raw = await readClaudeMd(target, cwd ?? undefined)
        setContent(raw)
        setOriginal(raw)
      } catch (e) {
        toast.error(`读取 CLAUDE.md 失败: ${String(e)}`)
        setContent("")
        setOriginal("")
      } finally {
        setLoading(false)
      }
    },
    [cwd]
  )

  useEffect(() => {
    load(scope)
  }, [scope, load])

  const save = async () => {
    if (!dirty) return
    setSaving(true)
    try {
      await writeClaudeMd(scope, content, cwd ?? undefined)
      setOriginal(content)
      toast.success("已保存 CLAUDE.md，下次会话生效")
    } catch (e) {
      toast.error(`保存失败: ${String(e)}`)
    } finally {
      setSaving(false)
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
          {/* —— CLAUDE.md 编辑 —— */}
          <section className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold">自定义指令</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                通过 CLAUDE.md 为 Claude 设置系统提示词，每次会话自动注入。
              </p>
            </div>

            <div className="flex items-center gap-1 border-b border-border">
              {SCOPES.map((s) => {
                const Icon = s.icon
                const active = s.id === scope
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setScope(s.id)}
                    title={s.hint}
                    className={cn(
                      "px-3 py-2 text-sm flex items-center gap-1.5 border-b-2 transition-colors -mb-px cursor-pointer",
                      active
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="size-3.5" />
                    {s.label}
                  </button>
                )
              })}
            </div>

            {disabled ? (
              <div className="rounded-md border border-dashed bg-muted/40 p-6 text-sm text-muted-foreground">
                请先在侧边栏选择一个项目，才能编辑项目级 CLAUDE.md。
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <code
                    className="font-mono text-xs text-muted-foreground truncate"
                    title={formatPathForDisplay(filePath)}
                  >
                    {formatPathForDisplay(filePath) || "（路径解析中…）"}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
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
                      : "# 项目说明\n\n## 代码风格\n\n## 依赖说明\n\n…"
                  }
                  disabled={loading}
                  className="font-mono text-xs min-h-[280px] max-h-[480px] leading-relaxed"
                  spellCheck={false}
                />

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={save}
                    disabled={!dirty || saving || loading}
                  >
                    <Save className="size-3.5" />
                    {saving ? "保存中…" : "保存"}
                  </Button>
                  {dirty && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={reset}
                      disabled={saving}
                    >
                      撤销
                    </Button>
                  )}
                  {dirty && (
                    <span className="text-xs text-warn">有未保存的修改</span>
                  )}
                </div>
              </>
            )}
          </section>

          {/* —— Pinned slash —— */}
          <section className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">高频命令置顶</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  勾选的命令会在 Composer 输入 <code className="font-mono">/</code> 时排在最前。
                </p>
              </div>
              {settings.pinnedSlash.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearPins}
                  className="text-muted-foreground"
                >
                  <PinOff className="size-3.5" />
                  全部取消
                </Button>
              )}
            </div>

            {settings.pinnedSlash.length > 0 && (
              <div className="flex flex-wrap gap-1.5 rounded-md border bg-muted/30 px-3 py-2">
                {settings.pinnedSlash.map((cmd) => (
                  <button
                    key={cmd}
                    type="button"
                    onClick={() => togglePin(cmd)}
                    className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs hover:bg-accent"
                    title="取消置顶"
                  >
                    <Pin className="size-3 text-primary" />
                    <span className="font-mono">/{cmd}</span>
                  </button>
                ))}
              </div>
            )}

            <Input
              type="text"
              value={slashSearch}
              onChange={(e) => setSlashSearch(e.target.value)}
              placeholder="搜索命令…"
              className="h-8"
            />

            <div className="rounded-md border max-h-[260px] overflow-auto scrollbar-thin">
              {filteredSlash.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  没有可选项；启动一次新会话后会缓存 CLI 暴露的命令列表。
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
                          className={cn(
                            "w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-accent/40 transition-colors",
                            pinned && "bg-accent/30"
                          )}
                        >
                          <span className="font-mono text-xs">/{cmd}</span>
                          {pinned ? (
                            <Pin className="size-3.5 text-primary" />
                          ) : (
                            <PinOff className="size-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </section>
      </SettingsSectionBody>
    </SettingsSection>
  )
}
