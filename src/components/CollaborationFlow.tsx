import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  FileCheck,
  FileEdit,
  FilePlus,
  FileX,
  Folder,
  Loader2,
  Pause,
  Play,
  PlayCircle,
  RefreshCw,
  Terminal,
  X,
  XCircle
} from "lucide-react"
import { toast } from "sonner"
import {
  collabListFlows,
  collabReadFlow,
  collabRecordApproval,
  collabRunVerification,
  openPath,
  type CollabFileChange,
  type CollabFlow,
  type CollabStep
} from "@/lib/ipc"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  cwd: string | null
  currentSessionId?: string | null
}

type StatusTone = "neutral" | "primary" | "success" | "warn" | "destructive"

const STATUS_LABELS: Record<string, { label: string; tone: StatusTone }> = {
  draft: { label: "草稿", tone: "neutral" },
  running: { label: "运行中", tone: "primary" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "destructive" },
  approved: { label: "已审批", tone: "success" },
  rejected: { label: "已拒绝", tone: "warn" },
  verified: { label: "已验证", tone: "success" },
  cancelled: { label: "已取消", tone: "warn" }
}

function statusBadge(status: string) {
  const meta = STATUS_LABELS[status] ?? { label: status, tone: "neutral" as StatusTone }
  const variant: "primary" | "success" | "warn" | "destructive" | "outline" =
    meta.tone === "primary"
      ? "primary"
      : meta.tone === "success"
        ? "success"
        : meta.tone === "warn"
          ? "warn"
          : meta.tone === "destructive"
            ? "destructive"
            : "outline"
  return <Badge variant={variant}>{meta.label}</Badge>
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function StepIcon({ status }: { status: string }) {
  const cls = "size-4"
  switch (status) {
    case "running":
      return <Loader2 className={cn(cls, "animate-spin text-primary")} />
    case "completed":
      return <Check className={cn(cls, "text-primary")} />
    case "approved":
    case "verified":
      return <CheckCircle2 className={cn(cls, "text-connected")} />
    case "failed":
      return <XCircle className={cn(cls, "text-destructive")} />
    case "rejected":
      return <Pause className={cn(cls, "text-warn")} />
    case "cancelled":
      return <X className={cn(cls, "text-muted-foreground")} />
    default:
      return <Clock className={cn(cls, "text-muted-foreground")} />
  }
}

function ChangeIcon({ change }: { change: CollabFileChange }) {
  const cls = "size-3.5 shrink-0"
  switch (change.changeType) {
    case "added":
      return <FilePlus className={cn(cls, "text-connected")} />
    case "deleted":
      return <FileX className={cn(cls, "text-destructive")} />
    default:
      return <FileEdit className={cn(cls)} />
  }
}

function copy(text: string, label: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${label}已复制`))
    .catch((e) => toast.error(`复制失败: ${String(e)}`))
}

export function CollaborationFlow({ open, onOpenChange, cwd, currentSessionId }: Props) {
  const [flows, setFlows] = useState<CollabFlow[]>([])
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reloadInFlightRef = useRef(false)

  const reload = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!open) return
    if (reloadInFlightRef.current) return
    reloadInFlightRef.current = true
    if (!opts.silent) setLoading(true)
    setError(null)
    try {
      const list = await collabListFlows(cwd)
      setFlows(list)
      setSelectedFlowId((cur) => {
        if (cur && list.some((flow) => flow.id === cur)) return cur
        return list[0]?.id ?? null
      })
    } catch (e) {
      setError(String(e))
      setFlows([])
    } finally {
      reloadInFlightRef.current = false
      if (!opts.silent) setLoading(false)
    }
  }, [cwd, open])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!open || !cwd) return
    const id = window.setInterval(() => {
      void reload({ silent: true })
    }, 2000)
    return () => window.clearInterval(id)
  }, [cwd, open, reload])

  const selectedFlow = useMemo(
    () => flows.find((flow) => flow.id === selectedFlowId) ?? null,
    [flows, selectedFlowId]
  )

  const refreshSelectedFlow = useCallback(async () => {
    if (!selectedFlowId) return
    try {
      const next = await collabReadFlow(selectedFlowId)
      setFlows((cur) => cur.map((flow) => (flow.id === next.id ? next : flow)))
    } catch (e) {
      toast.error(`读取流程失败: ${String(e)}`)
    }
  }, [selectedFlowId])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-x-0 bottom-0 top-9 z-40 bg-background/35 backdrop-blur-[2px] duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed bottom-1.5 right-1.5 top-10 z-50 flex w-[min(1080px,calc(100vw-0.75rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-8 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-8"
        >
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2 min-w-0">
              <Bot className="size-4 text-muted-foreground shrink-0" />
              <DialogPrimitive.Title className="text-sm font-medium">
                协同流程
              </DialogPrimitive.Title>
              <Badge variant="outline" className="text-[10px]">
                {loading ? "加载中" : `${flows.length} 个流程`}
              </Badge>
              {cwd && (
                <span
                  className="ml-2 truncate text-xs text-muted-foreground font-mono"
                  title={cwd}
                >
                  {cwd}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => void reload()}
                disabled={loading}
                aria-label="刷新"
                title="刷新流程列表"
              >
                <RefreshCw
                  className={cn("size-4", loading && "animate-spin")}
                />
              </Button>
              <DialogPrimitive.Close asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="关闭"
                >
                  <X className="size-4" />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </div>

          {error ? (
            <div className="flex-1 grid place-items-center px-6 text-center text-sm text-destructive">
              <div className="space-y-2">
                <AlertCircle className="size-6 mx-auto" />
                <div>读取协同流程失败</div>
                <div className="font-mono text-xs text-muted-foreground break-all">
                  {error}
                </div>
              </div>
            </div>
          ) : !cwd ? (
            <div className="flex-1 grid place-items-center px-6 text-center text-sm text-muted-foreground">
              请先选择项目，再查看协同流程。
            </div>
          ) : flows.length === 0 ? (
            <div className="flex-1 grid place-items-center px-6 text-center text-sm text-muted-foreground">
              {loading
                ? "正在加载协同流程…"
                : "当前项目还没有协同流程；启用协同后让 Claude 调用 collab_start_flow 创建。"}
            </div>
          ) : (
            <div className="flex-1 min-h-0 grid grid-cols-[260px_1fr]">
              <ScrollArea className="border-r min-h-0">
                <div className="flex flex-col gap-0.5 p-2">
                  {flows.map((flow) => (
                    <FlowListItem
                      key={flow.id}
                      flow={flow}
                      active={selectedFlowId === flow.id}
                      currentSession={currentSessionId ?? null}
                      onSelect={() => setSelectedFlowId(flow.id)}
                    />
                  ))}
                </div>
              </ScrollArea>
              <ScrollArea key={selectedFlow?.id ?? "empty"} className="min-h-0">
                {selectedFlow ? (
                  <FlowDetail
                    flow={selectedFlow}
                    onChanged={refreshSelectedFlow}
                  />
                ) : (
                  <div className="grid h-full place-items-center text-sm text-muted-foreground">
                    请在左侧选择一个流程
                  </div>
                )}
              </ScrollArea>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function FlowListItem({
  flow,
  active,
  currentSession,
  onSelect
}: {
  flow: CollabFlow
  active: boolean
  currentSession: string | null
  onSelect: () => void
}) {
  const isCurrent =
    currentSession && flow.claudeSessionId && flow.claudeSessionId === currentSession
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "text-left px-2 py-2 rounded-md text-xs transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/60 text-muted-foreground"
      )}
      title={flow.userPrompt}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <StepIcon status={flow.status} />
        <span className="truncate font-mono text-[11px]">{shortId(flow.id)}</span>
        {isCurrent && (
          <Badge variant="primary" className="ml-auto text-[10px]">
            当前
          </Badge>
        )}
      </div>
      <div
        className={cn(
          "mt-1 line-clamp-2",
          active ? "text-accent-foreground" : "text-muted-foreground"
        )}
      >
        {flow.userPrompt || "（无用户描述）"}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] tabular-nums">
        {statusBadge(flow.status)}
        <span className="text-muted-foreground">
          {flow.steps.length} 步
        </span>
        <span className="ml-auto text-muted-foreground">
          {formatTime(flow.updatedAt)}
        </span>
      </div>
    </button>
  )
}

function FlowDetail({
  flow,
  onChanged
}: {
  flow: CollabFlow
  onChanged: () => Promise<void> | void
}) {
  return (
    <div className="space-y-4 p-4">
      <section className="space-y-2 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">流程</span>
          <code className="font-mono text-xs text-muted-foreground">
            {flow.id}
          </code>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => copy(flow.id, "流程 ID")}
            aria-label="复制流程 ID"
            title="复制流程 ID"
          >
            <Copy className="size-3.5" />
          </Button>
          {statusBadge(flow.status)}
        </div>
        <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
          <div className="flex items-center gap-2">
            <Folder className="size-3.5 shrink-0" />
            <span className="font-mono break-all" title={flow.cwd}>
              {flow.cwd}
            </span>
          </div>
          {flow.claudeSessionId && (
            <div className="flex items-center gap-2">
              <Terminal className="size-3.5 shrink-0" />
              <span className="font-mono break-all">
                Claude {shortId(flow.claudeSessionId)}
              </span>
            </div>
          )}
          <div>创建：{formatTime(flow.createdAt)}</div>
          <div>更新：{formatTime(flow.updatedAt)}</div>
        </div>
        {flow.userPrompt && (
          <div className="rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
            {flow.userPrompt}
          </div>
        )}
      </section>

      {flow.steps.length === 0 ? (
        <div className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          流程还没有步骤；让 Claude 通过 collab_delegate 创建第一步。
        </div>
      ) : (
        <div className="space-y-3">
          {flow.steps.map((step) => (
            <StepCard
              key={step.id}
              flowId={flow.id}
              step={step}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function StepCard({
  flowId,
  step,
  onChanged
}: {
  flowId: string
  step: CollabStep
  onChanged: () => Promise<void> | void
}) {
  const [decisionLoading, setDecisionLoading] = useState<
    "approve" | "reject" | "cancel" | null
  >(null)
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [verifyCommand, setVerifyCommand] = useState("")
  const [verifyLoading, setVerifyLoading] = useState(false)

  const isTerminal = ["approved", "rejected", "cancelled", "verified"].includes(
    step.status
  )
  const canApprove =
    !isTerminal && (step.status === "completed" || step.status === "verified")
  const canCancel = !isTerminal && step.status !== "running"
  const canVerify =
    step.status === "completed" || step.status === "approved"

  const handleDecision = useCallback(
    async (decision: "approve" | "reject" | "cancel") => {
      setDecisionLoading(decision)
      try {
        await collabRecordApproval({
          flowId,
          stepId: step.id,
          decision
        })
        const labelMap = { approve: "审批通过", reject: "已拒绝", cancel: "已取消" }
        toast.success(labelMap[decision])
        await onChanged()
      } catch (e) {
        toast.error(`记录审批失败: ${String(e)}`)
      } finally {
        setDecisionLoading(null)
      }
    },
    [flowId, step.id, onChanged]
  )

  const handleVerify = useCallback(async () => {
    const command = verifyCommand.trim()
    if (!command) {
      toast.error("请输入要执行的验证命令")
      return
    }
    setVerifyLoading(true)
    try {
      await collabRunVerification({
        flowId,
        stepId: step.id,
        command
      })
      toast.success("验证命令已记录")
      setVerifyCommand("")
      setVerifyOpen(false)
      await onChanged()
    } catch (e) {
      toast.error(`运行验证失败: ${String(e)}`)
    } finally {
      setVerifyLoading(false)
    }
  }, [flowId, step.id, verifyCommand, onChanged])

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <header className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-sans">
          步骤 {step.index}
        </Badge>
        <StepIcon status={step.status} />
        <Badge variant="outline">{step.provider}</Badge>
        {statusBadge(step.status)}
        <Badge variant={step.writeAllowed ? "warn" : "outline"}>
          {step.writeAllowed ? "允许写入" : "只读"}
        </Badge>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {shortId(step.id)}
        </span>
      </header>

      {step.responsibilityScope && (
        <div>
          <Label className="text-xs text-muted-foreground">责任范围</Label>
          <div className="mt-1 rounded-md border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
            {step.responsibilityScope}
          </div>
        </div>
      )}

      {step.allowedPaths.length > 0 && (
        <div>
          <Label className="text-xs text-muted-foreground">允许路径</Label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {step.allowedPaths.map((path) => (
              <Badge key={path} variant="outline" className="font-mono text-[10px]">
                {path}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {step.inputPrompt && (
        <details className="rounded-md border bg-muted/20">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
            输入 prompt
          </summary>
          <div className="border-t bg-background p-3 text-xs whitespace-pre-wrap font-mono">
            {step.inputPrompt}
          </div>
        </details>
      )}

      {step.failureReason && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">失败原因</div>
            <div className="mt-0.5 whitespace-pre-wrap">
              {step.failureReason}
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
        <div>开始：{formatTime(step.startedAt)}</div>
        <div>结束：{formatTime(step.endedAt)}</div>
      </div>

      {step.agentRun && <AgentRunBlock run={step.agentRun} />}

      {step.changedFiles.length > 0 && (
        <div>
          <Label className="text-xs text-muted-foreground">
            文件变更（{step.changedFiles.length}）
          </Label>
          <ul className="mt-1 space-y-1 rounded-md border bg-muted/20 p-2 text-xs">
            {step.changedFiles.map((change) => (
              <li
                key={`${change.changeType}-${change.path}`}
                className={cn(
                  "flex items-center gap-2 px-1 py-0.5 rounded",
                  !change.allowed && "bg-destructive/10 text-destructive"
                )}
                title={change.allowed ? change.changeType : "越界修改：超出允许路径"}
              >
                <ChangeIcon change={change} />
                <span className="font-mono break-all">{change.path}</span>
                <Badge
                  variant={change.allowed ? "outline" : "destructive"}
                  className="ml-auto text-[10px]"
                >
                  {change.allowed ? change.changeType : "越界"}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step.validationResults.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">
            验证记录（{step.validationResults.length}）
          </Label>
          {step.validationResults.map((record) => (
            <div
              key={record.id}
              className="rounded-md border bg-muted/20 p-2 text-xs space-y-1"
            >
              <div className="flex items-center gap-2">
                <FileCheck
                  className={cn(
                    "size-3.5",
                    record.exitCode === 0 ? "text-connected" : "text-destructive"
                  )}
                />
                <code className="font-mono text-[11px] break-all">
                  {record.command}
                </code>
                <Badge
                  variant={record.exitCode === 0 ? "success" : "destructive"}
                  className="ml-auto text-[10px]"
                >
                  exit {record.exitCode}
                </Badge>
              </div>
              <div className="text-muted-foreground">
                {formatTime(record.startedAt)} → {formatTime(record.endedAt)}
              </div>
              {record.stdoutPreview && (
                <pre className="rounded border bg-background p-2 text-[11px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">
                  {record.stdoutPreview}
                </pre>
              )}
              {record.stderrPreview && (
                <pre className="rounded border border-destructive/30 bg-destructive/5 p-2 text-[11px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto text-destructive">
                  {record.stderrPreview}
                </pre>
              )}
              <div className="flex flex-wrap gap-1 pt-1">
                <FilePathButton path={record.stdoutPath} label="stdout" />
                <FilePathButton path={record.stderrPath} label="stderr" />
              </div>
            </div>
          ))}
        </div>
      )}

      {step.approval && (
        <div className="rounded-md border bg-muted/20 p-2 text-xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-3.5" />
            <span className="font-medium">审批记录</span>
            {statusBadge(step.approval.decision)}
            <span className="ml-auto text-muted-foreground">
              {formatTime(step.approval.recordedAt)}
            </span>
          </div>
          {step.approval.note && (
            <div className="mt-1 whitespace-pre-wrap text-muted-foreground">
              {step.approval.note}
            </div>
          )}
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button
          variant="default"
          size="sm"
          disabled={!canApprove || decisionLoading !== null}
          onClick={() => void handleDecision("approve")}
        >
          {decisionLoading === "approve" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Check />
          )}
          通过
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canApprove || decisionLoading !== null}
          onClick={() => void handleDecision("reject")}
        >
          {decisionLoading === "reject" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Pause />
          )}
          退回
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!canCancel || decisionLoading !== null}
          onClick={() => void handleDecision("cancel")}
        >
          {decisionLoading === "cancel" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <X />
          )}
          取消
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canVerify}
          onClick={() => setVerifyOpen((v) => !v)}
        >
          <PlayCircle />
          {verifyOpen ? "收起验证" : "运行验证"}
        </Button>
      </footer>

      {verifyOpen && canVerify && (
        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <Label className="text-xs">验证命令</Label>
          <Input
            value={verifyCommand}
            onChange={(event) => setVerifyCommand(event.target.value)}
            placeholder="例如 pnpm build 或 cargo test --manifest-path src-tauri/Cargo.toml"
            className="font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void handleVerify()}
              disabled={verifyLoading || !verifyCommand.trim()}
            >
              {verifyLoading ? <Loader2 className="animate-spin" /> : <Play />}
              执行
            </Button>
            <span className="text-[11px] text-muted-foreground">
              在流程 cwd 下通过系统 shell 执行；exit code、stdout、stderr 会真实记录。
            </span>
          </div>
        </div>
      )}
    </section>
  )
}

function AgentRunBlock({
  run
}: {
  run: NonNullable<CollabStep["agentRun"]>
}) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Terminal className="size-3.5" />
        <span className="font-medium">{run.provider}</span>
        <Badge variant="outline" className="text-[10px]">
          {run.permissionMode}
        </Badge>
        <Badge
          variant={run.exitCode === 0 ? "success" : "destructive"}
          className="ml-auto text-[10px]"
        >
          exit {run.exitCode}
        </Badge>
      </div>
      <div className="text-muted-foreground">
        {formatTime(run.startedAt)} → {formatTime(run.endedAt)}
      </div>
      <pre className="overflow-x-auto rounded border bg-background p-2 text-[11px] font-mono whitespace-pre-wrap break-words">
        {run.command.join(" ")}
      </pre>
      {run.stdoutPreview && (
        <details className="rounded border bg-background">
          <summary className="cursor-pointer px-2 py-1 text-[11px] text-muted-foreground">
            stdout 预览
          </summary>
          <pre className="border-t p-2 text-[11px] font-mono whitespace-pre-wrap break-words max-h-60 overflow-auto">
            {run.stdoutPreview}
          </pre>
        </details>
      )}
      {run.stderrPreview && (
        <details className="rounded border border-destructive/30 bg-destructive/5">
          <summary className="cursor-pointer px-2 py-1 text-[11px] text-destructive">
            stderr 预览
          </summary>
          <pre className="border-t p-2 text-[11px] font-mono whitespace-pre-wrap break-words max-h-60 overflow-auto text-destructive">
            {run.stderrPreview}
          </pre>
        </details>
      )}
      {run.structuredOutput !== null && run.structuredOutput !== undefined && (
        <details className="rounded border bg-background">
          <summary className="cursor-pointer px-2 py-1 text-[11px] text-muted-foreground">
            结构化输出
          </summary>
          <pre className="border-t p-2 text-[11px] font-mono whitespace-pre-wrap break-words max-h-60 overflow-auto">
            {JSON.stringify(run.structuredOutput, null, 2)}
          </pre>
        </details>
      )}
      <div className="flex flex-wrap gap-1">
        <FilePathButton path={run.stdoutPath} label="stdout" />
        <FilePathButton path={run.stderrPath} label="stderr" />
        {run.outputPath && <FilePathButton path={run.outputPath} label="output" />}
      </div>
    </div>
  )
}

function FilePathButton({ path, label }: { path: string; label: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      onClick={() =>
        openPath(path).catch((e) => toast.error(`打开失败: ${String(e)}`))
      }
      title={path}
    >
      <ExternalLink className="size-3" />
      {label}
    </Button>
  )
}
