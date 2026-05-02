import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  RefreshCw,
  Tag
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  scanActivityHeatmap,
  scanGlobalUsage,
  type ActivityCell,
  type GlobalUsage
} from "@/lib/ipc"
import {
  findRule,
  loadPricing,
  recomputeCost,
  type PricingConfig,
  type RuleMatch
} from "@/lib/pricing"
import { subscribeSettingsBus } from "@/lib/settingsBus"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionHeader
} from "./layout"
import { PricingEditor } from "./PricingEditor"

const HEATMAP_DAYS = 30

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = (d.getMonth() + 1).toString().padStart(2, "0")
  const day = d.getDate().toString().padStart(2, "0")
  return `${y}-${m}-${day}`
}

interface ModelCost {
  cost: number | null
  match: RuleMatch | null
}

export function Statistics() {
  const [usage, setUsage] = useState<GlobalUsage | null>(null)
  const [cells, setCells] = useState<ActivityCell[]>([])
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<"list" | "pricing">("list")
  const [pricing, setPricing] = useState<PricingConfig>(() => loadPricing())

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      // 串行扫描：两个命令各自打开 SQLite 写事务，并发会触发 `database is locked`。
      const u = await scanGlobalUsage()
      setUsage(u)
      const c = await scanActivityHeatmap(HEATMAP_DAYS)
      setCells(c)
    } catch (e) {
      toast.error(`扫描失败: ${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    return subscribeSettingsBus("usage", () => {
      void refresh()
    })
  }, [refresh])

  useEffect(() => {
    return subscribeSettingsBus("pricing", () => {
      setPricing(loadPricing())
    })
  }, [])

  const sortedModels = useMemo(() => {
    if (!usage) return [] as Array<[string, GlobalUsage["by_model"][string]]>
    return Object.entries(usage.by_model).sort((a, b) => {
      // 按 token 总量降序，避免依赖 CLI 计算的 cost_usd（已被忽略）
      const ta =
        a[1].input_tokens +
        a[1].output_tokens +
        a[1].cache_read_input_tokens +
        a[1].cache_creation_input_tokens
      const tb =
        b[1].input_tokens +
        b[1].output_tokens +
        b[1].cache_read_input_tokens +
        b[1].cache_creation_input_tokens
      return tb - ta
    })
  }, [usage])

  const modelCosts = useMemo(() => {
    const map = new Map<string, ModelCost>()
    for (const [model, m] of sortedModels) {
      const match = findRule(model, pricing)
      const cost = recomputeCost(
        {
          input: m.input_tokens,
          output: m.output_tokens,
          cacheRead: m.cache_read_input_tokens,
          cacheCreate: m.cache_creation_input_tokens
        },
        match?.rule ?? null
      )
      map.set(model, { cost, match: match ?? null })
    }
    return map
  }, [sortedModels, pricing])

  const { totalCost, unmatchedModels } = useMemo(() => {
    let sum = 0
    let unmatched = 0
    for (const [, { cost }] of modelCosts) {
      if (cost == null) unmatched += 1
      else sum += cost
    }
    return { totalCost: sum, unmatchedModels: unmatched }
  }, [modelCosts])

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={mode === "pricing" ? Tag : BarChart3}
        title={mode === "pricing" ? "定价设置" : "统计"}
        description={
          mode === "pricing" ? (
            "为不同厂商/模型配置 4 维价格，统计页将按规则重算成本。规则按组内顺序匹配，命中即停。"
          ) : (
            <>
              全部会话累计来源于 <code className="font-mono text-xs">~/.claude/projects/</code> 目录，此处只统计 gui 端 result 的数据；活跃度按本地时区聚合最近 {HEATMAP_DAYS} 天。成本按「定价设置」中的规则重算。
            </>
          )
        }
        eyebrow={
          mode === "pricing" ? (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => setMode("list")}
                className="inline-flex items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                返回
              </button>
              <Breadcrumb>
                <BreadcrumbItem onClick={() => setMode("list")}>
                  统计
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem current>定价设置</BreadcrumbItem>
              </Breadcrumb>
            </div>
          ) : undefined
        }
        actions={
          mode === "list" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMode("pricing")}
              >
                <Tag className="size-3.5" />
                定价设置
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={refresh}
                disabled={loading}
              >
                <RefreshCw className={loading ? "animate-spin" : ""} />
                刷新
              </Button>
            </>
          ) : undefined
        }
      />

      {mode === "pricing" ? (
        <SettingsSectionBody>
          <PricingEditor />
        </SettingsSectionBody>
      ) : (
        <SettingsSectionBody>
          <section className="rounded-lg border bg-card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                全部会话累计
              </div>
              {usage && usage.last_updated > 0 && (
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  最后扫描：{new Date(usage.last_updated * 1000).toLocaleString("zh-CN")}
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Stat
                label="会话数"
                value={fmt(usage?.session_count ?? 0)}
                hint={
                  usage && usage.with_sidecar_count !== usage.session_count
                    ? `其中 ${usage.with_sidecar_count} 条有 GUI 端 result`
                    : undefined
                }
              />
              <Stat
                label="总成本"
                value={`$${totalCost.toFixed(4)}`}
                hint={
                  unmatchedModels > 0
                    ? `${unmatchedModels} 个模型未匹配定价规则`
                    : "按定价设置重算"
                }
              />
              <Stat
                label="输入 tokens"
                value={fmt(usage?.total_input_tokens ?? 0)}
              />
              <Stat
                label="输出 tokens"
                value={fmt(usage?.total_output_tokens ?? 0)}
              />
              <Stat
                label="缓存命中"
                value={fmt(usage?.total_cache_read ?? 0)}
              />
              <Stat
                label="缓存创建"
                value={fmt(usage?.total_cache_write ?? 0)}
              />
            </div>
            {usage && usage.scan_errors.length > 0 && (
              <div className="rounded-md border border-warn/40 bg-warn/10 p-3 text-xs space-y-1.5">
                <div className="flex items-center gap-1.5 font-medium text-warn">
                  <AlertTriangle className="size-3.5" />
                  有 {usage.skipped_sidecar_count} 个 sidecar 未纳入统计
                </div>
                <div className="space-y-1">
                  {usage.scan_errors.slice(0, 5).map((err) => (
                    <div
                      key={`${err.path}:${err.reason}`}
                      className="font-mono break-all text-muted-foreground"
                    >
                      {err.path}: {err.reason}
                    </div>
                  ))}
                </div>
                {usage.scan_errors.length > 5 && (
                  <div className="text-muted-foreground">
                    其余 {usage.scan_errors.length - 5} 个错误已省略。
                  </div>
                )}
              </div>
            )}
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  按模型拆分
                </div>
                <button
                  type="button"
                  onClick={() => setMode("pricing")}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  管理定价 →
                </button>
              </div>
              {sortedModels.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  没有 sidecar 记录 — 完成一轮对话后会自动写入。
                </div>
              ) : (
                <div className="rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-medium">模型</th>
                        <th className="text-right px-3 py-1.5 font-medium">成本</th>
                        <th className="text-right px-3 py-1.5 font-medium">输入</th>
                        <th className="text-right px-3 py-1.5 font-medium">输出</th>
                        <th className="text-right px-3 py-1.5 font-medium">缓存命中</th>
                        <th className="text-right px-3 py-1.5 font-medium">缓存创建</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedModels.map(([model, m]) => {
                        const entry = modelCosts.get(model)
                        return (
                          <tr key={model} className="border-t">
                            <td className="px-3 py-1.5 font-mono break-all">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span>{model}</span>
                                {entry?.match && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge
                                        variant="secondary"
                                        className="font-sans text-[10px]"
                                      >
                                        {entry.match.groupName}
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      <div className="text-[11px]">
                                        命中规则：
                                        <code className="font-mono">
                                          {entry.match.rule.pattern}
                                        </code>
                                      </div>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {entry?.cost == null ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                                      —
                                      <Badge
                                        variant="warn"
                                        className="font-sans text-[10px]"
                                      >
                                        未配置
                                      </Badge>
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">
                                    <div className="text-[11px]">
                                      在「定价设置」中为该模型 ID 添加规则
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                `$${entry.cost.toFixed(4)}`
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {fmt(m.input_tokens)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {fmt(m.output_tokens)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {fmt(m.cache_read_input_tokens)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {fmt(m.cache_creation_input_tokens)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-5 space-y-3">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              活跃度热力图（最近 {HEATMAP_DAYS} 天）
            </div>
            <ActivityHeatmap cells={cells} days={HEATMAP_DAYS} />
          </section>
        </SettingsSectionBody>
      )}
    </SettingsSection>
  )
}

function Stat({
  label,
  value,
  hint
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-md bg-muted/30 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-mono tabular-nums">{value}</div>
      {hint && (
        <div className="text-[10px] text-muted-foreground/70 mt-0.5">{hint}</div>
      )}
    </div>
  )
}

function ActivityHeatmap({ cells, days }: { cells: ActivityCell[]; days: number }) {
  const dates = useMemo(() => {
    const arr: string[] = []
    const now = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      arr.push(fmtDate(d))
    }
    return arr
  }, [days])

  const matrix = useMemo(() => {
    // [hour][dateIdx] = count
    const m: number[][] = Array.from({ length: 24 }, () =>
      Array(dates.length).fill(0)
    )
    const dateIndex = new Map<string, number>()
    dates.forEach((d, i) => dateIndex.set(d, i))
    let max = 0
    for (const c of cells) {
      const di = dateIndex.get(c.date)
      if (di == null) continue
      if (c.hour < 0 || c.hour > 23) continue
      m[c.hour][di] += c.count
      if (m[c.hour][di] > max) max = m[c.hour][di]
    }
    return { m, max }
  }, [cells, dates])

  if (matrix.max === 0) {
    return (
      <div className="text-xs text-muted-foreground py-6">
        暂无活动数据 — 在窗口内发起对话后会更新。
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-center overflow-x-auto scrollbar-thin">
        <div className="inline-flex flex-col gap-0.5">
          {/* 24 行（小时） */}
          {Array.from({ length: 24 }).map((_, hour) => (
            <div key={hour} className="flex items-center gap-1">
              <div className="w-7 text-[10px] text-muted-foreground tabular-nums shrink-0 text-right">
                {hour % 3 === 0 ? hour.toString().padStart(2, "0") : ""}
              </div>
              <div className="flex gap-0.5">
                {dates.map((d, di) => {
                  const count = matrix.m[hour][di]
                  return (
                    <Tooltip key={di}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn(
                            "size-3 rounded-[2px] transition-colors",
                            cellTone(count, matrix.max)
                          )}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <div className="text-xs">
                          {d} · {hour.toString().padStart(2, "0")}:00
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {count} 条消息
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            </div>
          ))}
          {/* 日期轴：首日 / 月初 / 末日 */}
          <div className="flex items-center gap-1 mt-1">
            <div className="w-7 shrink-0" />
            <div className="flex gap-0.5">
              {dates.map((d, di) => {
                const day = new Date(d).getDate()
                const show = di === 0 || day === 1 || di === dates.length - 1
                return (
                  <div
                    key={di}
                    className="w-3 text-[9px] text-muted-foreground tabular-nums text-center"
                  >
                    {show ? day : ""}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-center gap-2 text-[10px] text-muted-foreground">
        <span>少</span>
        {[0.05, 0.25, 0.5, 0.75, 1].map((r) => (
          <div
            key={r}
            className={cn(
              "size-3 rounded-[2px]",
              cellTone(r * matrix.max, matrix.max)
            )}
          />
        ))}
        <span>多</span>
      </div>
    </div>
  )
}

function cellTone(count: number, max: number): string {
  if (count === 0) return "bg-muted/40"
  const ratio = max > 0 ? count / max : 0
  if (ratio < 0.2) return "bg-primary/20"
  if (ratio < 0.4) return "bg-primary/40"
  if (ratio < 0.6) return "bg-primary/60"
  if (ratio < 0.8) return "bg-primary/80"
  return "bg-primary"
}
