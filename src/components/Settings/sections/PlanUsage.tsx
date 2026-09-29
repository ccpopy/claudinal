import { useEffect, useState } from "react"
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { type OauthUsage, type OauthUsageWindow } from "@/lib/ipc"
import { resetCountdown, resetTime } from "@/lib/oauthUsage"
import { cn } from "@/lib/utils"
import { SettingsCard } from "./layout"
import { LimitResetSection, type ResetAccount } from "./LimitReset"

export function PlanUsageSection({ data, error, loading, fetchedAt, onRefresh, account, onResetBusyChange }: {
  data: OauthUsage | null
  error: string | null
  loading: boolean
  fetchedAt: number
  onRefresh: () => void
  account?: ResetAccount
  onResetBusyChange?: (busy: boolean) => void
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
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

    <LimitResetSection data={data} error={error} loading={loading} now={now} account={account}
      onRefresh={onRefresh} onBusyChange={onResetBusyChange} />
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
