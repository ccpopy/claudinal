import { useEffect, useState } from "react"
import { AlertTriangle, ExternalLink, Loader2, RefreshCw, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { openExternal, type OauthUsage, type OauthUsageWindow } from "@/lib/ipc"
import { CLAUDE_USAGE_URL, limitResets, resetCountdown, resetTime } from "@/lib/oauthUsage"
import { cn } from "@/lib/utils"
import { SettingsCard } from "./layout"

export function PlanUsageSection({ data, error, loading, fetchedAt, onRefresh }: {
  data: OauthUsage | null
  error: string | null
  loading: boolean
  fetchedAt: number
  onRefresh: () => void
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const resets = limitResets(data, now)
  const weekly = [
    ["全部模型", data?.seven_day], ["Sonnet", data?.seven_day_sonnet], ["仅 Opus", data?.seven_day_opus]
  ] as const
  return <>
    <SettingsCard className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold">计划用量限额</div>
          <Badge variant="outline" className="font-sans text-[10px] tracking-normal">Claude 订阅</Badge>
          {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="正在更新用量" />}
        </div>
        <p className="text-xs text-muted-foreground">与你的 Claude 账号共享会话和每周额度。「统计」展示本地会话用量。</p>
      </div>
      {error && <div role="alert" className="space-y-2 rounded-md border border-warn/30 bg-warn/5 p-3 text-xs">
        <div className="flex items-start gap-2 text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
        {data && <p className="text-muted-foreground">以下为上次成功获取的数据，当前用量可能已变化。</p>}
        <Button variant="outline" size="sm" disabled={loading} onClick={onRefresh}>
          <RefreshCw className={loading ? "animate-spin" : ""} />{loading ? "正在重试…" : "重试"}
        </Button>
      </div>}
      {!data && !error && <p className="text-xs text-muted-foreground" role="status">{loading ? "正在加载计划用量…" : "暂未获取到计划用量"}</p>}
      {data?.five_hour && <UsageBar label="当前会话" sub={resetCountdown(data.five_hour.resets_at, now)} window={data.five_hour} />}
      {weekly.some(([, window]) => window) && <>
        <Separator />
        <div className="space-y-3">
          <div className="text-sm font-semibold">每周限额</div>
          {weekly.map(([label, window]) => window && <UsageBar key={label} label={label}
            sub={resetTime(window.resets_at) ? `${resetTime(window.resets_at)} 重置` : "重置时间暂未提供"} window={window} />)}
        </div>
      </>}
      {fetchedAt > 0 && <div className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <RefreshCw className="size-3" />{error ? "上次成功更新" : "最近更新"}：{new Date(fetchedAt).toLocaleTimeString("zh-CN")}
      </div>}
    </SettingsCard>

    <SettingsCard className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold"><RotateCcw className="size-4 text-primary" />额度重置</div>
        {resets.kind === "known" && <Badge variant="outline">剩余 {resets.remaining} 次</Badge>}
      </div>
      {error && data && <p className="text-xs text-warn">重置次数也为上次获取的信息，使用前请在 Claude 确认。</p>}
      {resets.kind === "unknown" ? <p className="text-xs text-muted-foreground">
        {loading && !data ? "正在读取重置信息…" : "暂时无法读取剩余重置次数，请前往 Claude 查看。"}
      </p> : resets.remaining === 0 ? <p className="text-xs text-muted-foreground">当前没有剩余的额度重置次数。</p> : <div className="space-y-3">
        {resets.grants.filter(grant => grant.remaining > 0).map(grant => <div key={grant.id} className="space-y-1 rounded-md border p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{grant.limits.join("、") || "额度重置"}</span>
            <span className="tabular-nums">{grant.remaining} 次</span>
          </div>
          <p className="text-muted-foreground">{grant.endsAt ? `请在 ${resetTime(grant.endsAt)} 前使用` : "未提供到期时间"}</p>
          <p className="text-muted-foreground">{grant.paused ? "暂不可用" : grant.startsAt && Date.parse(grant.startsAt) > now
            ? `${resetTime(grant.startsAt)} 起可用` : grant.usable ? "可前往 Claude 使用" : "使用条件请在 Claude 确认"}</p>
        </div>)}
      </div>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">重置可立即恢复指定额度，原定每周重置时间不变。可在 Claude 网页或官方 Desktop 中确认使用。</p>
        <Button variant="outline" size="sm" onClick={() => openExternal(CLAUDE_USAGE_URL).catch(error => toast.error(`无法打开 Claude：${String(error)}`))}>
          <ExternalLink />前往 Claude 查看和使用
        </Button>
      </div>
    </SettingsCard>
  </>
}

function UsageBar({ label, sub, window: window }: { label: string; sub: string; window: OauthUsageWindow }) {
  const percent = Number.isFinite(window.utilization) ? Math.max(0, Math.min(100, window.utilization)) : null
  return <div className="grid grid-cols-[minmax(0,1fr)_56px] items-center gap-x-3 gap-y-2 sm:grid-cols-[160px_minmax(0,1fr)_56px]">
    <div className="col-span-2 sm:col-span-1"><div className="text-sm">{label}</div><div className="text-[11px] text-muted-foreground">{sub}</div></div>
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} className="h-2 overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full transition-[width]", percent !== null && percent >= 90 ? "bg-destructive" : percent !== null && percent >= 60 ? "bg-warn" : "bg-primary")} style={{ width: `${percent ?? 0}%` }} />
    </div>
    <div className="text-right text-xs tabular-nums text-muted-foreground">{percent === null ? "未知" : `已用 ${percent.toFixed(0)}%`}</div>
  </div>
}
