import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { PlanUsageSection } from "./PlanUsage"
import {
  authCancelLogin,
  authLogout,
  authStartLogin,
  fetchOauthUsage,
  getAuthStatus,
  invalidateOauthUsageRequest,
  readClaudeSettings,
  type AuthStatus,
  type OauthUsage
} from "@/lib/ipc"
import {
  SettingsCard,
  SettingsCardTitle,
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
  const [resetBusy, setResetBusy] = useState(false)
  const requestRef = useRef(0)
  const accountKeyRef = useRef("")

  const refreshOauth = useCallback(async (request: number) => {
    if (request !== requestRef.current) return
    setOauthLoading(true)
    setOauthError(null)
    try {
      const data = await fetchOauthUsage()
      if (request !== requestRef.current) return
      setOauth(data)
      setOauthFetchedAt(Date.now())
    } catch (e) {
      if (request !== requestRef.current) return
      // Keep the last successful snapshot for this account, visibly marked stale.
      setOauthError(String(e))
    } finally {
      if (request === requestRef.current) setOauthLoading(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    let nextEnv: Record<string, string> = {}
    let nextStatus: AuthStatus | null = null
    try {
      const raw = (await readClaudeSettings("global")) as CliSettings | null
      if (request !== requestRef.current) return
      nextEnv = raw?.env ?? {}
      setEnv(nextEnv)
    } catch (e) {
      if (request !== requestRef.current) return
      toast.error(`读取 settings.json 失败: ${String(e)}`)
    }
    try {
      nextStatus = await getAuthStatus()
      if (request !== requestRef.current) return
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
      if (request !== requestRef.current) return
      setAuthStatusError(String(e))
      setOauthLoading(false)
      return
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
    if (request !== requestRef.current) return
    const nextAuth = detectAuth(nextEnv, nextStatus)
    const nextAccountKey = nextAuth.kind === "oauth"
      ? JSON.stringify([nextAuth.status.orgId, nextAuth.status.email, nextAuth.method]) : ""
    if (nextAccountKey !== accountKeyRef.current) {
      accountKeyRef.current = nextAccountKey
      invalidateOauthUsageRequest()
      setOauth(null)
      setOauthError(null)
      setOauthFetchedAt(0)
    }
    if (nextAuth.kind === "oauth") {
      await refreshOauth(request)
    } else {
      setOauth(null)
      setOauthError(null)
      setOauthFetchedAt(0)
      setOauthLoading(false)
    }
  }, [refreshOauth])

  useEffect(() => {
    void refresh()
    return () => { requestRef.current += 1 }
  }, [refresh])

  // Returning from the official usage/reset page updates counts without re-entry.
  useEffect(() => {
    const onFocus = () => { if (!loading && !oauthLoading && !awaitingLogin && !logoutBusy && !resetBusy) void refresh() }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [refresh, loading, oauthLoading, awaitingLogin, logoutBusy, resetBusy])

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
        if (s.loggedIn) {
          authCancelLogin().catch(() => undefined)
          setAwaitingLogin(false)
          toast.success("登录已生效")
          invalidateOauthUsageRequest()
          void refresh()
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
  }, [awaitingLogin, refresh])

  const auth = useMemo(() => detectAuth(env, authStatus), [env, authStatus])

  const showPlanUsage = auth.kind === "oauth"

  const performLogout = useCallback(async () => {
    requestRef.current += 1
    invalidateOauthUsageRequest()
    setOauthLoading(false)
    setLoading(false)
    setLogoutBusy(true)
    try {
      await authLogout()
      invalidateOauthUsageRequest()
      accountKeyRef.current = ""
      setAuthStatus(null)
      setOauth(null)
      setOauthError(null)
      setOauthFetchedAt(0)
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
        description="查看和管理 Anthropic 账号的登录状态与计划用量。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading || oauthLoading || resetBusy}
          >
            <RefreshCw className={loading || oauthLoading ? "animate-spin" : ""} />
            刷新
          </Button>
        }
      />

      <SettingsSectionBody>
        <SettingsCard>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SettingsCardTitle>登录</SettingsCardTitle>
            <AuthActions
              auth={auth}
              awaitingLogin={awaitingLogin || resetBusy}
              logoutBusy={logoutBusy || resetBusy}
              onLogout={() => setShowLogoutConfirm(true)}
              onLogin={startLogin}
            />
          </div>
          <AuthBlock auth={auth} env={env} />
          {authStatusError && (
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
        </SettingsCard>

        {showPlanUsage && (
          <PlanUsageSection
            key={`${authStatus?.orgId}:${authStatus?.email}`}
            data={oauth}
            error={oauthError}
            loading={oauthLoading}
            fetchedAt={oauthFetchedAt}
            onRefresh={() => { void refresh() }}
            account={{ orgId: authStatus?.orgId ?? null, email: authStatus?.email ?? null }}
            onResetBusyChange={setResetBusy}
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
        凭据由环境变量提供，CLI 登录状态不适用
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
