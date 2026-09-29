import { useRef, useState } from "react"
import { ExternalLink, Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { consumeClaudeUsageReset, openExternal, type ClaudeResetOutcome, type OauthUsage } from "@/lib/ipc"
import { CLAUDE_USAGE_URL, limitResets, resetTime, type LimitResetGrant } from "@/lib/oauthUsage"
import { SettingsCard } from "./layout"

export type ResetAccount = { orgId: string | null; email: string | null }

const messages: Record<ClaudeResetOutcome["code"], string> = {
  reset: "额度重置成功，正在刷新用量。",
  already_used: "这次重置已经使用，已重新查询剩余额度。",
  not_limited: "当前尚未达到该重置要求的用量上限，未使用重置。",
  cooldown: "额度重置处于冷却中，请稍后再试。",
  ineligible: "当前账号不符合该重置的使用条件，请在 Claude 查看。",
  unavailable: "该重置当前不可用，请刷新后在 Claude 确认。",
  auth_error: "Claude 未接受当前登录凭据，本次重置被拒绝，请刷新账号后再试。",
  rate_limited: "请求过于频繁，本次重置被拒绝，请稍后再试。",
  unknown: "尚未确认重置结果，可能已经生效。请先刷新用量；若重试，将继续确认同一次操作，避免重复使用。",
  in_flight: "同一次重置仍在处理中，请稍候再确认结果。",
  unknown_expired: "上次重置结果仍未确认，已停止继续提交。请前往 Claude 官方页面核对。",
}

export function LimitResetSection({ data, error, loading, now, account, onRefresh, onBusyChange }: {
  data: OauthUsage | null
  error: string | null
  loading: boolean
  now: number
  account?: ResetAccount
  onRefresh: () => void
  onBusyChange?: (busy: boolean) => void
}) {
  const resets = limitResets(data, now)
  const [selected, setSelected] = useState<{ grant: LimitResetGrant; requestId: string; account: ResetAccount } | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [outcome, setOutcome] = useState<ClaudeResetOutcome | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const uncertain = outcome?.code === "unknown" || outcome?.code === "in_flight" || outcome?.code === "unknown_expired"
  const retryWait = outcome?.retryAt ? Math.max(0, Math.ceil(outcome.retryAt - now / 1000)) : 0
  const canRetry = uncertain && outcome?.code !== "unknown_expired" && retryWait === 0
  const accountMatches = selected?.account.orgId === account?.orgId && selected?.account.email === account?.email
  const officialPage = () => openExternal(CLAUDE_USAGE_URL).catch(e => toast.error(`无法打开 Claude：${String(e)}`))

  const select = (grant: LimitResetGrant) => {
    if (busyRef.current || !account?.orgId || !account.email) return
    if (!uncertain || selected?.grant.id !== grant.id) {
      setSelected({ grant, requestId: crypto.randomUUID(), account: { ...account } })
      setOutcome(null)
      setFailure(null)
    }
    setOpen(true)
  }

  const submit = async () => {
    if (busyRef.current || !selected || !accountMatches || !selected.account.orgId || !selected.account.email) return
    if (uncertain && !canRetry) return
    busyRef.current = true
    setBusy(true)
    onBusyChange?.(true)
    setFailure(null)
    try {
      const result = await consumeClaudeUsageReset({
        grantId: selected.grant.id, requestId: selected.requestId,
        expectedOrgId: selected.account.orgId, expectedEmail: selected.account.email,
      })
      setOutcome(result)
      if (result.code === "reset") {
        toast.success("额度重置成功")
        setOpen(false)
      } else if (!["unknown", "in_flight", "unknown_expired"].includes(result.code)) {
        toast.warning(messages[result.code])
      }
    } catch (e) {
      setFailure(String(e))
    } finally {
      busyRef.current = false
      setBusy(false)
      onBusyChange?.(false)
      onRefresh()
    }
  }

  return <>
    <SettingsCard className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold"><RotateCcw className="size-4 text-primary" />额度重置</div>
        {resets.kind === "known" && <Badge variant="outline">剩余 {resets.remaining} 次</Badge>}
      </div>
      {error && data && <p className="text-xs text-warn">重置次数为上次获取的信息，请先刷新后使用。</p>}
      {uncertain && <div role="alert" className="space-y-2 rounded-md border border-warn/30 bg-warn/5 p-3 text-xs text-warn">
        <p>{messages[outcome.code]}</p>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>查看重置结果</Button>
      </div>}
      {resets.kind === "unknown" ? <p className="text-xs text-muted-foreground">
        {loading && !data ? "正在读取重置信息…" : "暂时无法读取剩余重置次数，请前往 Claude 查看。"}
      </p> : resets.remaining === 0 ? <p className="text-xs text-muted-foreground">当前没有剩余的额度重置次数。</p> : <div className="space-y-3">
        {resets.grants.filter(grant => grant.remaining > 0).map(grant => <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-xs">
          <div className="min-w-0 space-y-1">
            <div className="font-medium">{grant.limits.join("、") || "指定额度"}</div>
            <p className="text-muted-foreground">{grant.endsAt ? `请在 ${resetTime(grant.endsAt)} 前使用` : "未提供到期时间"}</p>
            <p className="text-muted-foreground">{grant.usable ? "当前可用" : "当前不满足使用条件"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="tabular-nums">{grant.remaining} 次</span>
            <Button size="sm" disabled={busy || loading || !!error || !grant.usable || !account?.orgId || !account.email || !!uncertain}
              onClick={() => select(grant)}><RotateCcw />使用</Button>
          </div>
        </div>)}
      </div>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">使用一次重置可立即恢复指定额度，原定每周重置时间不变。使用前需要确认，操作不可撤销。</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={officialPage}><ExternalLink />前往 Claude 查看</Button>
      </div>
    </SettingsCard>

    <AlertDialog open={open} onOpenChange={value => { if (!busyRef.current) setOpen(value) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{uncertain ? "确认重置结果" : "使用 1 次额度重置？"}</AlertDialogTitle>
          <AlertDialogDescription asChild><div className="space-y-3">
            <p>将为 <span className="break-all font-medium text-foreground">{selected?.account.email}</span> 恢复{selected?.grant.limits.join("、") || "指定额度"}，并消耗 1 次重置。</p>
            <p>原定每周重置时间不变。此操作不可撤销，已消耗的次数无法恢复。</p>
            {selected?.grant.endsAt && <p>本次重置有效期至 {resetTime(selected.grant.endsAt)}。</p>}
          </div></AlertDialogDescription>
        </AlertDialogHeader>
        {outcome && <div role="status" className="rounded-md bg-muted p-3 text-sm">{messages[outcome.code]}</div>}
        {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        {!accountMatches && <p role="alert" className="text-sm text-warn">账号已变化，请关闭确认框后刷新。</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{outcome ? "关闭" : "取消"}</AlertDialogCancel>
          {uncertain && <Button variant="outline" disabled={busy || loading} onClick={onRefresh}>刷新用量</Button>}
          {outcome?.code === "unknown_expired" ? <Button variant="outline" onClick={officialPage}>前往 Claude 核对</Button>
            : (!outcome || uncertain || failure) && <AlertDialogAction
              disabled={busy || !accountMatches || (!!uncertain && !canRetry)}
              onClick={event => { event.preventDefault(); void submit() }}>
              {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
              {busy ? "正在使用…" : uncertain ? retryWait > 0 ? `${retryWait} 秒后可重试` : "重试本次操作" : "确认使用 1 次"}
            </AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
