import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Cloud,
  ExternalLink,
  Key,
  Loader2,
  LogIn,
  LogOut,
  Monitor,
  RefreshCw,
  ShieldCheck
} from "lucide-react"
import { toast } from "sonner"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  authCancelLogin,
  authLogout,
  authStartLogin,
  fetchOauthUsage,
  getAuthStatus,
  readClaudeSettings,
  type AuthStatus,
  type OauthUsage,
  type OauthUsageWindow
} from "@/lib/ipc"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionHeader
} from "./layout"

interface CliSettings {
  env?: Record<string, string>
}

type AuthKind =
  | { kind: "oauth"; method: string; status: AuthStatus }
  | { kind: "third-party"; label: string; baseUrl?: string }
  | { kind: "official-key" }
  | { kind: "none" }

function detectAuth(
  env: Record<string, string> | undefined,
  status: AuthStatus | null
): AuthKind {
  const e = env ?? {}
  // 第三方 / 官方 key 走 env，CLI auth status 不会反映这部分（CLI 自己也不查）
  if (e.ANTHROPIC_AUTH_TOKEN) {
    return {
      kind: "third-party",
      label: "第三方 API（已配置 AUTH_TOKEN）",
      baseUrl: e.ANTHROPIC_BASE_URL
    }
  }
  if (e.ANTHROPIC_API_KEY) return { kind: "official-key" }
  if (status?.loggedIn) {
    const method = status.authMethod ?? status.apiProvider ?? "Anthropic"
    return { kind: "oauth", method, status }
  }
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

function describeMethod(method: string): string {
  const m = method.toLowerCase()
  if (m === "claude.ai" || m === "claudeai") return "Claude.ai 订阅"
  if (m === "console") return "Anthropic Console"
  if (m === "firstparty") return "Anthropic 官方"
  if (m === "bedrock") return "AWS Bedrock"
  if (m === "vertex") return "Google Vertex"
  if (m === "foundry") return "Azure Foundry"
  return method
}

export function Account() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [authStatusError, setAuthStatusError] = useState<string | null>(null)
  const [env, setEnv] = useState<Record<string, string>>({})
  const [oauth, setOauth] = useState<OauthUsage | null>(null)
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [oauthFetchedAt, setOauthFetchedAt] = useState<number>(0)
  const [loading, setLoading] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [awaitingLogin, setAwaitingLogin] = useState(false)

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
    let nextEnv: Record<string, string> = {}
    let nextStatus: AuthStatus | null = null
    try {
      const raw = (await readClaudeSettings("global")) as CliSettings | null
      nextEnv = raw?.env ?? {}
      setEnv(nextEnv)
    } catch (e) {
      toast.error(`读取 settings.json 失败: ${String(e)}`)
    }
    try {
      nextStatus = await getAuthStatus()
      setAuthStatus(nextStatus)
      setAuthStatusError(null)
      // 同步缓存给 Composer 等位置（保留旧 key 名兼容）
      try {
        const apiKeySource =
          nextStatus.loggedIn && !nextEnv.ANTHROPIC_AUTH_TOKEN && !nextEnv.ANTHROPIC_API_KEY
            ? nextStatus.apiProvider ?? "oauth"
            : "none"
        localStorage.setItem("claudinal.api-key-source", apiKeySource)
      } catch {
        // ignore
      }
    } catch (e) {
      setAuthStatus(null)
      setAuthStatusError(String(e))
    } finally {
      setLoading(false)
    }
    const nextAuth = detectAuth(nextEnv, nextStatus)
    if (nextAuth.kind === "oauth") {
      refreshOauth().catch(() => undefined)
    } else {
      setOauth(null)
      setOauthError(null)
      setOauthFetchedAt(0)
      setOauthLoading(false)
    }
  }, [refreshOauth])

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stopAwaitingLogin = useCallback(async () => {
    setAwaitingLogin(false)
    try {
      await authCancelLogin()
    } catch (e) {
      toast.error(`停止登录失败: ${String(e)}`)
    }
  }, [])

  // 等待登录态：后台启动登录后周期性轮询 auth status，看到 loggedIn 翻成 true 就停
  useEffect(() => {
    if (!awaitingLogin) return
    let alive = true
    const tickMs = 5_000
    const maxTicks = 24 // 约 2 分钟
    let ticks = 0
    const id = setInterval(async () => {
      if (!alive) return
      ticks += 1
      try {
        const s = await getAuthStatus()
        if (!alive) return
        setAuthStatus(s)
        if (s.loggedIn) {
          authCancelLogin().catch(() => undefined)
          setAwaitingLogin(false)
          toast.success("登录已生效")
          refreshOauth().catch(() => undefined)
          return
        }
      } catch {
        // 暂时拉不到状态不弹 toast，避免登录过程中刷屏
      }
      if (ticks >= maxTicks) {
        authCancelLogin().catch(() => undefined)
        setAwaitingLogin(false)
        toast.error("登录等待超时，已停止后台登录进程")
        return
      }
    }, tickMs)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [awaitingLogin, refreshOauth])

  const auth = useMemo(() => detectAuth(env, authStatus), [env, authStatus])

  const showPlanUsage = auth.kind === "oauth"

  const performLogout = useCallback(async () => {
    setLogoutBusy(true)
    try {
      await authLogout()
      toast.success("已登出")
      await refresh()
    } catch (e) {
      toast.error(`登出失败: ${String(e)}`)
    } finally {
      setLogoutBusy(false)
      setShowLogoutConfirm(false)
    }
  }, [refresh])

  const startLogin = useCallback(
    async (useConsole: boolean) => {
      try {
        await authStartLogin(useConsole)
        toast.message("已在后台启动登录，请在浏览器完成 OAuth")
        setAwaitingLogin(true)
      } catch (e) {
        toast.error(`无法启动登录: ${String(e)}`)
      }
    },
    []
  )

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={Monitor}
        title="账户和使用情况"
        description="登录方式来自 claude auth status；env 中的 AUTH_TOKEN / API_KEY 优先。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading || oauthLoading}
          >
            <RefreshCw className={loading || oauthLoading ? "animate-spin" : ""} />
            刷新
          </Button>
        }
      />

      <SettingsSectionBody>
        <section className="rounded-lg border bg-card p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              登录
            </div>
            <AuthActions
              auth={auth}
              awaitingLogin={awaitingLogin}
              logoutBusy={logoutBusy}
              onLogout={() => setShowLogoutConfirm(true)}
              onLogin={startLogin}
            />
          </div>
          <AuthBlock auth={auth} env={env} />
          {authStatusError && auth.kind === "none" && (
            <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 p-3 text-xs">
              <AlertTriangle className="size-3.5 shrink-0 text-warn mt-0.5" />
              <div className="min-w-0 break-all">
                <div className="text-warn">读取 auth status 失败</div>
                <div className="mt-0.5 font-mono text-muted-foreground">
                  {authStatusError}
                </div>
              </div>
            </div>
          )}
          {awaitingLogin && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs">
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground mt-0.5" />
              <div className="min-w-0">
                <div>已在后台启动登录，请在浏览器完成 OAuth；GUI 这边每 5 秒自动检查一次状态。</div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1.5 h-7 px-2 text-xs"
                  onClick={stopAwaitingLogin}
                >
                  停止等待
                </Button>
              </div>
            </div>
          )}
        </section>

        {showPlanUsage && (
          <PlanUsageSection
            data={oauth}
            error={oauthError}
            loading={oauthLoading}
            fetchedAt={oauthFetchedAt}
          />
        )}
      </SettingsSectionBody>

      <ConfirmDialog
        open={showLogoutConfirm}
        onOpenChange={setShowLogoutConfirm}
        title="登出 Anthropic 账号"
        destructive
        confirmText={logoutBusy ? "登出中…" : "登出"}
        description={
          <span>
            将清除 Claude CLI 本地保存的 OAuth token；下次启动会话前需要重新登录或切换到 API Key。
          </span>
        }
        onConfirm={performLogout}
      />
    </SettingsSection>
  )
}

function AuthActions({
  auth,
  awaitingLogin,
  logoutBusy,
  onLogout,
  onLogin
}: {
  auth: AuthKind
  awaitingLogin: boolean
  logoutBusy: boolean
  onLogout: () => void
  onLogin: (useConsole: boolean) => void
}) {
  // 第三方 / 官方 key 模式下账号鉴权由 env 提供，登入登出按钮无意义，藏起来
  if (auth.kind === "third-party" || auth.kind === "official-key") {
    return (
      <span className="text-[11px] text-muted-foreground">
        当前由环境变量提供凭据，CLI 登录态不参与
      </span>
    )
  }

  if (auth.kind === "oauth") {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onLogout}
          disabled={logoutBusy}
        >
          {logoutBusy ? <Loader2 className="animate-spin" /> : <LogOut />}
          登出
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={awaitingLogin}>
              {awaitingLogin ? <Loader2 className="animate-spin" /> : <LogIn />}
              重新登录
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px]">
            <DropdownMenuItem onSelect={() => onLogin(false)}>
              <Cloud className="size-4" />
              <div className="flex flex-col">
                <span>Claude.ai 订阅</span>
                <span className="text-[11px] text-muted-foreground">
                  默认（适合 Pro / Max 用户）
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onLogin(true)}>
              <ExternalLink className="size-4" />
              <div className="flex flex-col">
                <span>Anthropic Console</span>
                <span className="text-[11px] text-muted-foreground">
                  按 API 用量计费
                </span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  // 未登录
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" disabled={awaitingLogin}>
          {awaitingLogin ? <Loader2 className="animate-spin" /> : <LogIn />}
          登录
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuItem onSelect={() => onLogin(false)}>
          <Cloud className="size-4" />
          Claude.ai 订阅
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onLogin(true)}>
          <ExternalLink className="size-4" />
          Anthropic Console
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
            label="Sonnet"
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
          <Badge variant="success" className="text-[10px]">
            活跃
          </Badge>
        </div>
        <Field label="API Key" value={maskToken(env.ANTHROPIC_API_KEY)} mono />
      </div>
    )
  }
  if (auth.kind === "oauth") {
    const { status, method } = auth
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Cloud className="size-4 text-connected" />
          <span className="font-medium">{describeMethod(method)}</span>
          <Badge variant="success" className="text-[10px]">已登录</Badge>
          {status.subscriptionType && (
            <Badge variant="primary" className="text-[10px]">
              {status.subscriptionType}
            </Badge>
          )}
        </div>
        {status.email && <Field label="账号" value={status.email} />}
        {status.orgName && <Field label="组织" value={status.orgName} />}
        {status.apiProvider && status.apiProvider !== "firstParty" && (
          <Field label="Provider" value={status.apiProvider} mono />
        )}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <ShieldCheck className="size-4" />
      未检测到登录信息
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
      <span className={mono ? "font-mono break-all" : "break-all"}>
        {value || "—"}
      </span>
    </div>
  )
}
