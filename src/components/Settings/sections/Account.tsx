import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Cloud,
  Key,
  Monitor,
  RefreshCw,
  ShieldCheck
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import {
  fetchOauthUsage,
  readClaudeSettings,
  type OauthUsage,
  type OauthUsageWindow
} from "@/lib/ipc"

interface CliSettings {
  env?: Record<string, string>
}

type AuthKind =
  | { kind: "oauth"; label: string }
  | { kind: "third-party"; label: string; baseUrl?: string }
  | { kind: "official-key" }
  | { kind: "none" }

function detectAuth(env: Record<string, string> | undefined, apiKeySource: string | null): AuthKind {
  const e = env ?? {}
  if (e.ANTHROPIC_AUTH_TOKEN) {
    return {
      kind: "third-party",
      label: "第三方 API（已配置 AUTH_TOKEN）",
      baseUrl: e.ANTHROPIC_BASE_URL
    }
  }
  if (e.ANTHROPIC_API_KEY) return { kind: "official-key" }
  if (apiKeySource && apiKeySource !== "none") {
    return { kind: "oauth", label: `凭据来源：${apiKeySource}` }
  }
  if (apiKeySource === "none") return { kind: "oauth", label: "Anthropic OAuth（已登录）" }
  return { kind: "none" }
}

function maskToken(t: string | undefined): string {
  if (!t) return ""
  if (t.length <= 12) return "•".repeat(t.length)
  return `${t.slice(0, 6)}…${t.slice(-4)}`
}

function fmtCountdown(resetsAt: string | undefined): string {
  if (!resetsAt) return ""
  const ms = Date.parse(resetsAt) - Date.now()
  if (ms <= 0) return "已重置"
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d} 天 ${h % 24} 小时后重置`
  }
  if (h > 0) return `${h} 小时 ${m} 分钟后重置`
  return `${m} 分钟后重置`
}

function fmtResetAt(resetsAt: string | undefined): string {
  if (!resetsAt) return ""
  try {
    const d = new Date(resetsAt)
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    })
  } catch {
    return resetsAt
  }
}

export function Account() {
  const [apiKeySource, setApiKeySource] = useState<string | null>(null)
  const [env, setEnv] = useState<Record<string, string>>({})
  const [oauth, setOauth] = useState<OauthUsage | null>(null)
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [oauthFetchedAt, setOauthFetchedAt] = useState<number>(0)
  const [loading, setLoading] = useState(false)

  const refreshOauth = useCallback(async () => {
    setOauthLoading(true)
    setOauthError(null)
    try {
      const data = await fetchOauthUsage()
      setOauth(data)
      setOauthFetchedAt(Date.now())
    } catch (e) {
      setOauth(null)
      setOauthError(String(e))
    } finally {
      setOauthLoading(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const raw = (await readClaudeSettings("global")) as CliSettings | null
      setEnv(raw?.env ?? {})
    } catch (e) {
      toast.error(`读取 settings.json 失败: ${String(e)}`)
    } finally {
      setLoading(false)
    }
    try {
      setApiKeySource(localStorage.getItem("claudinal.api-key-source"))
    } catch {
      // ignore
    }
    refreshOauth().catch(() => undefined)
  }, [refreshOauth])

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const auth = useMemo(() => detectAuth(env, apiKeySource), [env, apiKeySource])

  const showPlanUsage = auth.kind === "oauth" || auth.kind === "official-key"

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Monitor className="size-5" />
            Usage
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            登录来自 settings.json env；计划用量调 Anthropic OAuth API。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-6 shrink-0"
          onClick={refresh}
          disabled={loading || oauthLoading}
        >
          <RefreshCw className={oauthLoading ? "animate-spin" : ""} />
          刷新
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 pb-6 w-full space-y-6">
          <section className="rounded-lg border bg-card p-5 space-y-3">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              登录
            </div>
            <AuthBlock auth={auth} env={env} />
          </section>

          {showPlanUsage && (
            <PlanUsageSection
              data={oauth}
              error={oauthError}
              loading={oauthLoading}
              fetchedAt={oauthFetchedAt}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function PlanUsageSection({
  data,
  error,
  loading,
  fetchedAt
}: {
  data: OauthUsage | null
  error: string | null
  loading: boolean
  fetchedAt: number
}) {
  if (error) {
    return (
      <section className="rounded-lg border bg-card p-5 space-y-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          计划用量限额
        </div>
        <div className="flex items-start gap-2 text-xs text-warn">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          仅 Anthropic OAuth 登录用户可拉取；macOS 凭据存 Keychain 待 P4 支持。
        </div>
      </section>
    )
  }
  if (loading && !data) {
    return (
      <section className="rounded-lg border bg-card p-5">
        <div className="text-xs text-muted-foreground">加载计划用量中…</div>
      </section>
    )
  }
  if (!data) return null

  const fiveHour = data.five_hour
  const sevenDay = data.seven_day
  const sevenDayOpus = data.seven_day_opus ?? undefined
  const sevenDaySonnet = data.seven_day_sonnet ?? undefined

  return (
    <section className="rounded-lg border bg-card p-5 space-y-5">
      <div className="space-y-3">
        <div className="text-sm font-semibold">计划用量限额</div>
        {fiveHour && (
          <UsageBar
            label="当前会话"
            sub={fmtCountdown(fiveHour.resets_at)}
            window={fiveHour}
          />
        )}
      </div>

      <Separator />

      <div className="space-y-3">
        <div className="text-sm font-semibold">每周限额</div>
        {sevenDay && (
          <UsageBar
            label="全部模型"
            sub={`${fmtResetAt(sevenDay.resets_at)} 重置`}
            window={sevenDay}
          />
        )}
        {sevenDaySonnet && (
          <UsageBar
            label="仅 Sonnet"
            sub={`${fmtResetAt(sevenDaySonnet.resets_at)} 重置`}
            window={sevenDaySonnet}
          />
        )}
        {sevenDayOpus && (
          <UsageBar
            label="仅 Opus"
            sub={`${fmtResetAt(sevenDayOpus.resets_at)} 重置`}
            window={sevenDayOpus}
          />
        )}
        {fetchedAt > 0 && (
          <div className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
            <RefreshCw className="size-3" />
            最近更新：{new Date(fetchedAt).toLocaleTimeString("zh-CN")}
          </div>
        )}
      </div>
    </section>
  )
}

function UsageBar({
  label,
  sub,
  window: w,
  hideValueRight
}: {
  label: string
  sub?: string
  window: OauthUsageWindow
  hideValueRight?: boolean
}) {
  const pct = Math.max(0, Math.min(100, w.utilization))
  const tone =
    pct >= 90 ? "bg-destructive" : pct >= 60 ? "bg-warn" : "bg-primary"
  return (
    <div className="grid grid-cols-[160px_1fr_56px] items-center gap-3">
      <div>
        <div className="text-sm">{label}</div>
        {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full transition-[width]", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!hideValueRight && (
        <div className="text-xs text-muted-foreground tabular-nums text-right">
          已用 {pct.toFixed(0)}%
        </div>
      )}
    </div>
  )
}

function AuthBlock({
  auth,
  env
}: {
  auth: AuthKind
  env: Record<string, string>
}) {
  if (auth.kind === "third-party") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <Key className="size-4 text-primary" />
          <span className="font-medium">{auth.label}</span>
          <Badge variant="success" className="text-[10px]">
            活跃
          </Badge>
        </div>
        {auth.baseUrl && <Field label="Base URL" value={auth.baseUrl} mono />}
        <Field label="Auth Token" value={maskToken(env.ANTHROPIC_AUTH_TOKEN)} mono />
      </div>
    )
  }
  if (auth.kind === "official-key") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <Key className="size-4 text-primary" />
          <span className="font-medium">官方 API Key</span>
          <Badge variant="success" className="text-[10px]">活跃</Badge>
        </div>
        <Field label="API Key" value={maskToken(env.ANTHROPIC_API_KEY)} mono />
      </div>
    )
  }
  if (auth.kind === "oauth") {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Cloud className="size-4 text-connected" />
        <span className="font-medium">{auth.label}</span>
        <Badge variant="success" className="text-[10px]">已登录</Badge>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <ShieldCheck className="size-4" />
      未检测到登录信息（启动一次会话后会刷新）
    </div>
  )
}

function Field({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground w-[100px] shrink-0">{label}</span>
      <span className={mono ? "font-mono break-all" : "break-all"}>{value || "—"}</span>
    </div>
  )
}
