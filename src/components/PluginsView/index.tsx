import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Package,
  Plus,
  Puzzle,
  RefreshCw,
  Sparkles,
  Store,
  Trash2
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select } from "@/components/ui/select"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { openExternal } from "@/lib/ipc"
import {
  addMarketplace,
  installPlugin,
  listInstalledPlugins,
  listMarketplaces,
  listSkills,
  removeMarketplace,
  uninstallPlugin,
  updateMarketplace,
  type InstalledPlugin,
  type Marketplace,
  type MarketplacePlugin,
  type PluginScope,
  type Skill
} from "@/lib/plugins"

type TopTab = "plugins" | "skills"
type PluginsTab = "installed" | "discover" | "marketplaces"

interface Props {
  cwd?: string | null
  onBack: () => void
}

const SCOPE_OPTIONS: Array<{ value: PluginScope; label: string }> = [
  { value: "user", label: "用户级（所有项目）" },
  { value: "project", label: "项目级（共享给协作者）" },
  { value: "local", label: "本地（仅自己）" }
]

export function PluginsView({ cwd, onBack }: Props) {
  const [tab, setTab] = useState<TopTab>("plugins")
  const [pluginsTab, setPluginsTab] = useState<PluginsTab>("installed")

  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState("")

  const [showAddMarket, setShowAddMarket] = useState(false)
  const [pendingUninstall, setPendingUninstall] =
    useState<InstalledPlugin | null>(null)
  const [pendingRemoveMarket, setPendingRemoveMarket] =
    useState<Marketplace | null>(null)
  const [installTarget, setInstallTarget] = useState<{
    id: string
    name: string
    description: string | null
  } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [inst, marks, sk] = await Promise.all([
        listInstalledPlugins(),
        listMarketplaces(),
        listSkills(cwd ?? null)
      ])
      setInstalled(inst)
      setMarketplaces(marks)
      setSkills(sk)
    } catch (e) {
      toast.error(`读取失败: ${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    refresh()
  }, [refresh])

  const installedFiltered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return installed
    return installed.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.marketplace.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
    )
  }, [installed, filter])

  const skillsFiltered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q)
    )
  }, [skills, filter])

  const discoverList = useMemo(() => {
    const installedKeys = new Set(installed.map((p) => p.id))
    const out: Array<{ market: string; plugin: MarketplacePlugin }> = []
    for (const m of marketplaces) {
      for (const p of m.plugins) {
        const id = `${p.name}@${m.name}`
        if (installedKeys.has(id)) continue
        out.push({ market: m.name, plugin: p })
      }
    }
    const q = filter.trim().toLowerCase()
    if (!q) return out.slice(0, 200)
    return out
      .filter(
        (it) =>
          it.plugin.name.toLowerCase().includes(q) ||
          (it.plugin.description ?? "").toLowerCase().includes(q) ||
          (it.plugin.category ?? "").toLowerCase().includes(q)
      )
      .slice(0, 200)
  }, [marketplaces, installed, filter])

  const onInstall = useCallback(
    async (target: string, scope: PluginScope) => {
      setBusy(true)
      try {
        const r = await installPlugin(target, scope, cwd ?? null)
        if (r.exit_code !== 0) {
          throw new Error(r.stderr || r.stdout || `exit ${r.exit_code}`)
        }
        toast.success(`已安装 ${target}（${scope}）`)
        setInstallTarget(null)
        await refresh()
      } catch (e) {
        toast.error(`安装失败: ${String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [cwd, refresh]
  )

  const onUninstall = useCallback(
    async (p: InstalledPlugin) => {
      setBusy(true)
      try {
        const r = await uninstallPlugin(
          p.id,
          p.scope as PluginScope,
          p.scope === "project" ? p.project_path ?? cwd ?? null : null
        )
        if (r.exit_code !== 0) {
          throw new Error(r.stderr || r.stdout || `exit ${r.exit_code}`)
        }
        toast.success(`已卸载 ${p.name}`)
        setPendingUninstall(null)
        await refresh()
      } catch (e) {
        toast.error(`卸载失败: ${String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [cwd, refresh]
  )

  const onAddMarket = useCallback(
    async (input: string) => {
      const target = input.trim()
      if (!target) return
      setBusy(true)
      try {
        const r = await addMarketplace(target)
        if (r.exit_code !== 0) {
          throw new Error(r.stderr || r.stdout || `exit ${r.exit_code}`)
        }
        toast.success(`Marketplace 已添加：${target}`)
        setShowAddMarket(false)
        await refresh()
      } catch (e) {
        toast.error(`添加失败: ${String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const onUpdateMarket = useCallback(
    async (m: Marketplace) => {
      setBusy(true)
      try {
        const r = await updateMarketplace(m.name)
        if (r.exit_code !== 0) {
          throw new Error(r.stderr || r.stdout || `exit ${r.exit_code}`)
        }
        toast.success(`已刷新 ${m.name}`)
        await refresh()
      } catch (e) {
        toast.error(`刷新失败: ${String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const onRemoveMarket = useCallback(
    async (m: Marketplace) => {
      setBusy(true)
      try {
        const r = await removeMarketplace(m.name)
        if (r.exit_code !== 0) {
          throw new Error(r.stderr || r.stdout || `exit ${r.exit_code}`)
        }
        toast.success(`已移除 ${m.name}（其安装的插件也被卸载）`)
        setPendingRemoveMarket(null)
        await refresh()
      } catch (e) {
        toast.error(`移除失败: ${String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

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
              <Puzzle className="size-5" />
              插件 & 技能
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              管理 Claude Code 原生插件与技能；与 CLI 共用同一份配置。
            </p>
          </div>
          <div className="mt-6 flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loading || busy}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              刷新
            </Button>
            {tab === "plugins" && pluginsTab === "marketplaces" && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => setShowAddMarket(true)}
              >
                <Plus />
                添加 Marketplace
              </Button>
            )}
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as TopTab)}
          className="mt-5"
        >
          <TabsList>
            <TabsTrigger value="plugins" className="gap-1.5">
              <Package className="size-3.5" />
              插件
              <span className="ml-1 rounded-sm bg-background/60 px-1 text-[10px] tabular-nums text-muted-foreground">
                {installed.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="skills" className="gap-1.5">
              <Sparkles className="size-3.5" />
              技能
              <span className="ml-1 rounded-sm bg-background/60 px-1 text-[10px] tabular-nums text-muted-foreground">
                {skills.length}
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "plugins" && (
          <Tabs
            value={pluginsTab}
            onValueChange={(v) => setPluginsTab(v as PluginsTab)}
            className="mt-3"
          >
            <div className="flex items-center justify-between gap-2">
              <TabsList variant="line">
                <TabsTrigger value="installed" className="gap-1.5">
                  已安装
                  <span className="rounded-sm bg-muted px-1 tabular-nums text-[10px]">
                    {installed.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="discover" className="gap-1.5">
                  发现
                  <span className="rounded-sm bg-muted px-1 tabular-nums text-[10px]">
                    {discoverList.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="marketplaces" className="gap-1.5">
                  Marketplace
                  <span className="rounded-sm bg-muted px-1 tabular-nums text-[10px]">
                    {marketplaces.length}
                  </span>
                </TabsTrigger>
              </TabsList>
              <div className="w-[260px]">
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="搜索"
                  className="h-8 text-sm"
                />
              </div>
            </div>
          </Tabs>
        )}
        {tab === "skills" && (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <div className="w-[260px]">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="搜索技能"
                className="h-8 text-sm"
              />
            </div>
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 px-8 pb-6">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              正在读取
            </div>
          ) : tab === "plugins" ? (
            <Tabs
              value={pluginsTab}
              onValueChange={(v) => setPluginsTab(v as PluginsTab)}
            >
              <TabsContent value="installed" className="mt-0">
                <InstalledList
                  rows={installedFiltered}
                  busy={busy}
                  onUninstall={(p) => setPendingUninstall(p)}
                />
              </TabsContent>
              <TabsContent value="discover" className="mt-0">
                <DiscoverList
                  rows={discoverList}
                  busy={busy}
                  onPick={(it) =>
                    setInstallTarget({
                      id: `${it.plugin.name}@${it.market}`,
                      name: it.plugin.name,
                      description: it.plugin.description
                    })
                  }
                />
              </TabsContent>
              <TabsContent value="marketplaces" className="mt-0">
                <MarketplaceList
                  rows={marketplaces}
                  busy={busy}
                  onUpdate={onUpdateMarket}
                  onRemove={(m) => setPendingRemoveMarket(m)}
                />
              </TabsContent>
            </Tabs>
          ) : (
            <SkillList rows={skillsFiltered} />
          )}
        </div>
      </ScrollArea>

      <AddMarketplaceDialog
        open={showAddMarket}
        onOpenChange={setShowAddMarket}
        busy={busy}
        onSubmit={onAddMarket}
      />

      <InstallPluginDialog
        target={installTarget}
        busy={busy}
        hasProject={!!cwd}
        onCancel={() => setInstallTarget(null)}
        onConfirm={onInstall}
      />

      <ConfirmDialog
        open={!!pendingUninstall}
        onOpenChange={(open) => {
          if (!open) setPendingUninstall(null)
        }}
        title="卸载插件"
        destructive
        confirmText="卸载"
        description={
          pendingUninstall ? (
            <span>
              将卸载{" "}
              <code className="font-mono">
                {pendingUninstall.id}
              </code>
              （{pendingUninstall.scope}），需重启或 /reload-plugins 生效。
            </span>
          ) : null
        }
        onConfirm={async () => {
          if (pendingUninstall) await onUninstall(pendingUninstall)
        }}
      />

      <ConfirmDialog
        open={!!pendingRemoveMarket}
        onOpenChange={(open) => {
          if (!open) setPendingRemoveMarket(null)
        }}
        title="移除 Marketplace"
        destructive
        confirmText="移除"
        description={
          pendingRemoveMarket ? (
            <span>
              移除 <code className="font-mono">{pendingRemoveMarket.name}</code>{" "}
              会一并卸载从中安装的所有插件。
            </span>
          ) : null
        }
        onConfirm={async () => {
          if (pendingRemoveMarket) await onRemoveMarket(pendingRemoveMarket)
        }}
      />
    </div>
  )
}

function InstalledList({
  rows,
  busy,
  onUninstall
}: {
  rows: InstalledPlugin[]
  busy: boolean
  onUninstall: (p: InstalledPlugin) => void
}) {
  if (rows.length === 0) {
    return <EmptyHint icon={<Package />} title="还没有安装插件" hint="切到「发现」或在 Marketplace 中安装。" />
  }
  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="space-y-3">
        {rows.map((p) => (
          <div
            key={`${p.id}-${p.scope}-${p.project_path ?? ""}`}
            className="flex min-h-[72px] items-center gap-3 rounded-lg border bg-background p-3 transition-colors hover:bg-accent/35"
          >
            <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
              <Package className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-semibold">
                  {p.name}
                </span>
                <Badge variant="outline" className="font-sans">
                  {scopeLabel(p.scope)}
                </Badge>
                {p.version && (
                  <Badge variant="secondary" className="font-mono">
                    v{p.version}
                  </Badge>
                )}
                {p.category && (
                  <Badge variant="outline" className="font-sans">
                    {p.category}
                  </Badge>
                )}
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {p.description || `来自 ${p.marketplace}`}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {p.homepage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => openExternal(p.homepage!).catch(() => undefined)}
                  aria-label="主页"
                  title="主页"
                >
                  <ExternalLink className="size-4" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-destructive"
                onClick={() => onUninstall(p)}
                disabled={busy}
                aria-label="卸载"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function DiscoverList({
  rows,
  busy,
  onPick
}: {
  rows: Array<{ market: string; plugin: MarketplacePlugin }>
  busy: boolean
  onPick: (it: { market: string; plugin: MarketplacePlugin }) => void
}) {
  if (rows.length === 0) {
    return (
      <EmptyHint
        icon={<Store />}
        title="无可发现的插件"
        hint="先添加 Marketplace 或调整搜索关键字。"
      />
    )
  }
  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="space-y-3">
        {rows.map((it) => (
          <div
            key={`${it.market}:${it.plugin.name}`}
            className="flex min-h-[72px] items-center gap-3 rounded-lg border bg-background p-3 transition-colors hover:bg-accent/35"
          >
            <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
              <Package className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-semibold">
                  {it.plugin.name}
                </span>
                <Badge variant="outline" className="font-mono">
                  {it.market}
                </Badge>
                {it.plugin.category && (
                  <Badge variant="secondary" className="font-sans">
                    {it.plugin.category}
                  </Badge>
                )}
                {it.plugin.author && (
                  <span className="text-[10px] text-muted-foreground">
                    by {it.plugin.author}
                  </span>
                )}
              </div>
              <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {it.plugin.description || "—"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {it.plugin.homepage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() =>
                    openExternal(it.plugin.homepage!).catch(() => undefined)
                  }
                  aria-label="主页"
                  title="主页"
                >
                  <ExternalLink className="size-4" />
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => onPick(it)}
              >
                安装
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function MarketplaceList({
  rows,
  busy,
  onUpdate,
  onRemove
}: {
  rows: Marketplace[]
  busy: boolean
  onUpdate: (m: Marketplace) => void
  onRemove: (m: Marketplace) => void
}) {
  if (rows.length === 0) {
    return (
      <EmptyHint
        icon={<Store />}
        title="还没有添加 Marketplace"
        hint="点击右上角添加，例如 anthropics/claude-code。"
      />
    )
  }
  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="space-y-3">
        {rows.map((m) => (
          <div
            key={m.name}
            className="flex min-h-[72px] items-center gap-3 rounded-lg border bg-background p-3 transition-colors hover:bg-accent/35"
          >
            <div className="grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
              <Store className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-semibold">{m.name}</span>
                <Badge variant="secondary">{m.plugins.length} 个插件</Badge>
              </div>
              <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {m.source ?? "—"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onUpdate(m)}
              >
                <RefreshCw className="size-3.5" />
                刷新
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(m)}
                disabled={busy}
                aria-label="移除"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function SkillList({ rows }: { rows: Skill[] }) {
  if (rows.length === 0) {
    return (
      <EmptyHint
        icon={<Sparkles />}
        title="还没有可用的技能"
        hint="技能存放在 ~/.claude/skills 或随插件一起安装。"
      />
    )
  }
  const grouped = new Map<string, Skill[]>()
  for (const s of rows) {
    const key = s.source.startsWith("plugin:")
      ? "插件携带"
      : s.source === "user"
        ? "用户级"
        : s.source === "project"
          ? "项目级"
          : s.source
    const list = grouped.get(key) ?? []
    list.push(s)
    grouped.set(key, list)
  }
  return (
    <section className="space-y-4">
      {Array.from(grouped.entries()).map(([group, list]) => (
        <div key={group} className="rounded-lg border bg-card p-5">
          <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            {group}
            <span className="rounded-sm bg-muted px-1.5 tabular-nums">
              {list.length}
            </span>
          </div>
          <div className="space-y-2">
            {list.map((s) => (
              <div
                key={s.path}
                className="flex items-center gap-3 rounded-lg border bg-background p-3 transition-colors hover:bg-accent/35"
                title={s.path}
              >
                <div className="grid size-9 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
                  <Sparkles className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold">
                      /{s.name}
                    </span>
                    {s.disable_model_invocation && (
                      <Badge variant="outline" className="font-sans">
                        仅手动
                      </Badge>
                    )}
                    {!s.user_invocable && (
                      <Badge variant="outline" className="font-sans">
                        仅 Claude
                      </Badge>
                    )}
                    {s.source.startsWith("plugin:") && (
                      <Badge variant="secondary" className="font-mono">
                        {s.source.replace(/^plugin:/, "")}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {s.description || "—"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function EmptyHint({
  icon,
  title,
  hint
}: {
  icon: React.ReactNode
  title: string
  hint: string
}) {
  return (
    <div className="flex h-44 flex-col items-center justify-center rounded-lg border border-dashed bg-card text-center">
      <div className="mb-3 grid size-10 place-items-center rounded-full border bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  )
}

function scopeLabel(scope: string) {
  switch (scope) {
    case "user":
      return "用户级"
    case "project":
      return "项目级"
    case "local":
      return "本地"
    default:
      return scope
  }
}

function AddMarketplaceDialog({
  open,
  onOpenChange,
  busy,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  busy: boolean
  onSubmit: (target: string) => Promise<void>
}) {
  const [value, setValue] = useState("")
  useEffect(() => {
    if (open) setValue("")
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加 Marketplace</DialogTitle>
          <DialogDescription>
            支持 GitHub 仓库（owner/repo）、完整 Git URL 或 marketplace.json
            的远程 URL。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs">来源</Label>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="anthropics/claude-code"
            className="font-mono text-xs"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value.trim()) {
                e.preventDefault()
                onSubmit(value.trim())
              }
            }}
          />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {[
              "anthropics/claude-code",
              "anthropics/claude-plugins-official",
              "obra/superpowers-marketplace"
            ].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setValue(s)}
                disabled={busy}
                className="rounded-sm border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={busy || !value.trim()}
            onClick={() => onSubmit(value.trim())}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function InstallPluginDialog({
  target,
  busy,
  hasProject,
  onCancel,
  onConfirm
}: {
  target: { id: string; name: string; description: string | null } | null
  busy: boolean
  hasProject: boolean
  onCancel: () => void
  onConfirm: (id: string, scope: PluginScope) => Promise<void>
}) {
  const [scope, setScope] = useState<PluginScope>("user")
  useEffect(() => {
    if (target) setScope("user")
  }, [target])
  return (
    <Dialog open={!!target} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>安装插件</DialogTitle>
          <DialogDescription>
            插件来自 Claude Code 原生 Marketplace。安装后 CLI 与 GUI 通用。
          </DialogDescription>
        </DialogHeader>
        {target && (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
              {target.id}
            </div>
            {target.description && (
              <p className="text-xs text-muted-foreground">
                {target.description}
              </p>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">安装范围</Label>
              <Select
                value={scope}
                onChange={(e) => setScope(e.target.value as PluginScope)}
                options={
                  hasProject
                    ? SCOPE_OPTIONS
                    : SCOPE_OPTIONS.filter((o) => o.value !== "project" && o.value !== "local")
                }
                disabled={busy}
                triggerClassName="max-w-full"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            type="button"
            disabled={busy || !target}
            onClick={() => target && onConfirm(target.id, scope)}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus />}
            安装
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
