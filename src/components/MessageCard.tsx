import { MessageInlineEditor, SubmissionFooter, canEditSubmission, hasSubmissionFooter, type SubmissionActions } from "./SubmittedInputActions"
import { deliveryLabel, type DeliveryState } from "@/lib/submission"
import { parseCommand } from "@/lib/commandRegistry"
import { RetryButton } from "./RetryButton"
import { CommandChip } from "./CommandChip"
import { isInjectedOnlyUserMessage, parseTaskNotification, splitInjectedContext, type InjectedContext, type TaskNotification } from "@/lib/userMessageText"
import { useEffect, useState } from "react"
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Info,
  CircleAlert,
  CircleStop,
  Clock,
  Cog,
  CornerDownRight,
  DollarSign,
  FileWarning,
  Gauge,
  ListChecks,
  Loader2,
  ShieldAlert,
  Terminal,
  Timer,
  Webhook,
  type LucideIcon
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn, formatRunDuration } from "@/lib/utils"
import type { UIEntry, UIMessage } from "@/types/ui"
import { BlockView, ExpandableRow, CodeBlock } from "./MessageBlocks"
import { CopyButton } from "./CopyButton"

interface Props {
  submissionActions?: SubmissionActions
  onOpenPermissions?: () => void
  entry: UIEntry
  cwd?: string | null
  onRetryMessage?: (messageId: string) => void | Promise<void>
  retryableMessageIds?: ReadonlySet<string>
  /** 当前会话可用的 slash 命令；用户消息仅对其中的命令显示命令 chip */
  slashCommands?: readonly string[]
}

export function MessageCard({
  submissionActions,
  entry,
  onOpenPermissions,
  cwd,
  onRetryMessage,
  retryableMessageIds,
  slashCommands
}: Props) {
  if (entry.kind === "message") {
    return (
      <MessageView
        submissionActions={submissionActions}
        msg={entry}
        cwd={cwd}
        slashCommands={slashCommands}
        onRetryMessage={onRetryMessage}
        retryableMessageIds={retryableMessageIds}
      />
    )
  }
  if (entry.kind === "system_init") return <SystemInitView e={entry} />
  if (entry.kind === "system_status") return entry.status.startsWith("CLI 正在恢复") ? <SimpleRow label="连接恢复中" content={entry.status} /> : null
  if (entry.kind === "result") return <ResultView e={entry} onOpenPermissions={onOpenPermissions} />
  if (entry.kind === "rate_limit") return null
  if (entry.kind === "hook") return <HookEventView e={entry} />
  if (entry.kind === "stderr") {
    return <SimpleRow label="stderr" tone="error" content={entry.line} />
  }
  if (entry.kind === "raw") {
    return <SimpleRow label="raw" content={entry.line ?? ""} />
  }
  return null
}

function MessageView({
  submissionActions,
  msg,
  cwd,
  slashCommands,
  onRetryMessage,
  retryableMessageIds
}: {
  submissionActions?: SubmissionActions
  msg: UIMessage
  cwd?: string | null
  slashCommands?: readonly string[]
  onRetryMessage?: (messageId: string) => void | Promise<void>
  retryableMessageIds?: ReadonlySet<string>
}) {
  if (msg.blocks.length === 0 && msg.streaming) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>思考中…</span>
      </div>
    )
  }
  if (msg.role === "user") {
    return (
      <UserMessageView
        submissionActions={submissionActions}
        msg={msg}
        cwd={cwd}
        slashCommands={slashCommands}
        onRetry={
          onRetryMessage && retryableMessageIds?.has(msg.id)
            ? () => onRetryMessage?.(msg.id)
            : undefined
        }
      />
    )
  }
  if (msg.apiError) return <ApiErrorMessageView msg={msg} />
  return (
    <div className="flex flex-col gap-2 items-stretch">
      {msg.blocks.map((b, i) => (
        <BlockView
          key={i}
          role={msg.role}
          block={b}
          imageGallery={msg.blocks}
          cwd={cwd}
        />
      ))}
    </div>
  )
}

/**
 * 用户消息：附件与图片在上、文字气泡在下，全部右对齐；
 * 开头的 slash 命令渲染成与输入框一致的行内 chip；
 * 投递状态只在「未完成 / 异常」时以气泡下方小字出现，正常送达不打扰。
 */
function UserMessageView({ msg, cwd, slashCommands, onRetry, submissionActions }: {
  submissionActions?: SubmissionActions
  msg: UIMessage
  cwd?: string | null
  slashCommands?: readonly string[]
  onRetry?: () => void | Promise<void>
}) {
  const [showPendingLabel, setShowPendingLabel] = useState(false)
  useEffect(() => { setShowPendingLabel(false); const timer = setTimeout(() => setShowPendingLabel(true), 400); return () => clearTimeout(timer) }, [msg.attemptId])
  const textBlocks = msg.blocks.filter((b) => b.type === "text" && b.text)
  const images = msg.blocks.filter((b) => b.type === "image")
  const others = msg.blocks.filter((b) => b.type !== "text" && b.type !== "image")
  const original = msg.rawText ?? textBlocks.map((b) => b.text ?? "").join("\n")
  const { body: text, injected } = splitInjectedContext(
    textBlocks.map((b) => b.text ?? "").join("\n").trim()
  )
  // 只有当前会话确认存在的命令才显示成 chip，"/tmp 看下日志" 之类保持原文
  const parsed = parseCommand(text)
  const command = parsed && slashCommands?.includes(parsed.name) ? parsed : null
  const body = command ? command.arguments : text
  const guide = msg.delivery === "guide"
  const delivery = msg.deliveryState
  const status = delivery ? DELIVERY_STATUS[delivery] : null
  const [editing, setEditing] = useState(false)
  const payload = submissionActions?.payload(msg.id)
  // 状态变化（如重试后进入发送中）或原始输入失效时退出编辑
  useEffect(() => { if (!payload || !canEditSubmission(msg)) setEditing(false) }, [payload, msg])
  if (editing && payload && submissionActions) {
    return <div className="flex min-w-0 flex-col items-end">
      <MessageInlineEditor
        message={msg}
        payload={payload}
        onCancel={() => setEditing(false)}
        onSubmit={(next) => { submissionActions.edit(msg.id, next); setEditing(false) }}
      />
    </div>
  }
  // 后台任务通知是 CLI 发给模型的系统事件，按左侧事件行展示，不混进用户气泡
  const taskNotes = injected.filter((item) => item.tag === "task-notification").map((item) => parseTaskNotification(item.content))
  const contextNotes = injected.filter((item) => item.tag !== "task-notification")
  if (isInjectedOnlyUserMessage(msg)) {
    return <div className="flex min-w-0 flex-col items-start gap-1.5">
      {taskNotes.map((note, index) => <TaskNotificationRow key={note.taskId ?? index} note={note} />)}
      {contextNotes.length > 0 && <InjectedContextView items={contextNotes} align="start" />}
    </div>
  }
  const footer = hasSubmissionFooter(msg, submissionActions)
  return <div className="group/msg flex min-w-0 flex-col items-end gap-1.5">
    {taskNotes.map((note, index) => <div key={note.taskId ?? index} className="self-start"><TaskNotificationRow note={note} /></div>)}
    {others.length > 0 && <div className="flex max-w-[85%] flex-wrap justify-end gap-2 [&>*]:max-w-full">
      {others.map((block, index) => <BlockView key={index} role="user" block={block} variant="user" cwd={cwd} />)}
    </div>}
    {images.length > 0 && <div className="flex max-w-[85%] flex-wrap justify-end gap-2 [&_img]:max-h-48">
      {images.map((block, index) => <BlockView key={index} role="user" block={block} imageGallery={images} variant="user" cwd={cwd} />)}
    </div>}
    {(text || (guide && !images.length && !others.length)) && <div className={cn(
      "min-w-0 max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed text-foreground",
      guide ? "border border-primary/25 bg-primary/5" : "bg-muted"
    )}>
      {guide && <div className="mb-1 flex items-center gap-1 text-xs font-medium text-primary">
        <CornerDownRight className="size-3.5" aria-hidden />引导
      </div>}
      <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {command && <CommandChip command={command.rawToken} className={cn("-my-0.5", body && "mr-1.5")} />}
        {body}
      </div>
    </div>}
    {msg.submissionPendingNames?.length && !footer ? <p className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
      <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />附件准备中：{msg.submissionPendingNames.join("、")}
    </p> : null}
    {contextNotes.length > 0 && <InjectedContextView items={contextNotes} />}
    {footer && submissionActions
      ? <SubmissionFooter message={msg} actions={submissionActions} onEdit={() => setEditing(true)} />
      : status && (delivery !== "preparing" || showPendingLabel) && <p role="status" className={cn("flex items-center gap-1 px-1 text-[11px]", status.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
        <status.icon className={cn("size-3 shrink-0", status.spin && "animate-spin")} aria-hidden />
        {guide && delivery === "awaiting_ack" ? "引导已提交，等待 CLI 读取" : deliveryLabel[delivery!]}
      </p>}
    <div className="flex gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100">
      {onRetry && (!submissionActions?.payload(msg.id) || msg.deliveryState === "responded" || msg.deliveryState === "acknowledged") && <RetryButton onRetry={onRetry} ariaLabel={delivery === "failed" ? "重新发送未送达输入" : "在新分支重新执行"} />}
      {original && <CopyButton text={original} ariaLabel="复制原始输入" label="原始输入已复制" />}
    </div>
  </div>
}

const TASK_OUTCOME_LABEL: Record<TaskNotification["outcome"], string> = {
  completed: "已完成",
  failed: "失败",
  killed: "已停止",
  unknown: "已结束"
}
const TASK_KIND_LABEL: Record<TaskNotification["kind"], string> = {
  command: "后台命令",
  agent: "子智能体",
  task: "后台任务"
}

/** 后台命令 / 异步 Agent 的结束通知：与「会话开始」同款的可展开事件行。 */
function TaskNotificationRow({ note }: { note: TaskNotification }) {
  const [open, setOpen] = useState(false)
  const failed = note.outcome === "failed"
  const subject = note.name ?? (note.kind === "task" ? note.summary : undefined)
  const details: Array<[string, string]> = [
    ...(!note.name && note.summary && subject !== note.summary ? [["摘要", note.summary] as [string, string]] : []),
    ...(note.taskId ? [["任务 ID", note.taskId] as [string, string]] : []),
    ...(note.toolUseId ? [["工具调用", note.toolUseId] as [string, string]] : []),
    ...(note.status ? [["状态", note.status] as [string, string]] : [])
  ]
  return <ExpandableRow
    open={open}
    onToggle={() => setOpen(!open)}
    icon={note.kind === "agent" ? Bot : note.kind === "command" ? Terminal : ListChecks}
    tone={failed ? "error" : undefined}
    label={`${TASK_KIND_LABEL[note.kind]}${TASK_OUTCOME_LABEL[note.outcome]}${subject ? ` · ${subject}` : ""}`}
    meta={note.exitCode !== undefined && note.exitCode !== 0 ? `退出码 ${note.exitCode}` : undefined}
  >
    <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
      {details.map(([key, value]) => <div key={key} className="flex gap-2">
        <span className="w-14 shrink-0">{key}</span>
        <span className="min-w-0 break-all font-mono text-foreground/80">{value}</span>
      </div>)}
      {note.outputFile && <div className="flex items-start gap-2">
        <span className="w-14 shrink-0">输出文件</span>
        <span className="min-w-0 flex-1 break-all font-mono text-foreground/80">{note.outputFile}</span>
        <CopyButton text={note.outputFile} ariaLabel="复制输出文件路径" label="路径已复制" className="-my-1 shrink-0" />
      </div>}
      {!details.length && !note.outputFile && <div>CLI 未提供更多信息</div>}
    </div>
  </ExpandableRow>
}

/** CLI 随用户消息注入的上下文：默认折叠成一行小字，按需展开查看原文。 */
function InjectedContextView({ items, align = "end" }: { items: InjectedContext[]; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false)
  const labels = [...new Set(items.map((item) => item.label))].join("、")
  return <div className={cn("flex max-w-[85%] flex-col gap-1", align === "start" ? "items-start" : "items-end")}>
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      className="flex items-center gap-1 rounded px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Info className="size-3 shrink-0" aria-hidden />
      附带{labels}{items.length > 1 ? ` · ${items.length}` : ""}
      <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
    </button>
    {open && <div className="flex max-h-60 w-full flex-col gap-2 overflow-auto rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {items.map((item, index) => <div key={index} className="min-w-0">
        {items.length > 1 && <div className="mb-0.5 font-medium text-foreground/80">{item.label}</div>}
        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.content || "（空）"}</div>
      </div>)}
    </div>}
  </div>
}

/** 已确认 / 已响应属于正常态，不展示；其余状态给出图标与语气。 */
const DELIVERY_STATUS: Partial<Record<DeliveryState, { icon: LucideIcon; tone: "muted" | "error"; spin?: boolean }>> = {
  preparing: { icon: Clock, tone: "muted" },
  needs_confirmation: { icon: Info, tone: "muted" },
  paused: { icon: Clock, tone: "muted" },
  cancelled: { icon: CircleStop, tone: "muted" },
  queued: { icon: Clock, tone: "muted" },
  writing: { icon: Loader2, tone: "muted", spin: true },
  awaiting_ack: { icon: Loader2, tone: "muted", spin: true },
  failed: { icon: CircleAlert, tone: "error" },
  delivery_unknown: { icon: CircleAlert, tone: "error" }
}

/** API 错误消息卡：isApiErrorMessage 的 assistant 消息，按错误形态渲染而非普通 markdown。 */
function ApiErrorMessageView({ msg }: { msg: UIMessage }) {
  const rawText = msg.blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim()
  const text = rawText || "上游未返回可显示的错误详情。"
  return (
    <div className="self-start w-full max-w-full overflow-hidden rounded-lg border border-destructive/30 bg-destructive/5">
      <div className="flex items-center gap-1.5 border-b border-destructive/20 px-3 py-1.5 text-xs font-medium text-destructive">
        <AlertTriangle className="size-3.5 shrink-0" />
        <span>请求失败</span>
        <CopyButton
          text={text}
          ariaLabel="复制错误信息"
          label="错误信息已复制"
          className="ml-auto -mr-1"
        />
      </div>
      <div className="px-3 py-2 text-[13px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {text}
      </div>
    </div>
  )
}

function SimpleRow({
  label,
  tone,
  content
}: {
  label: string
  tone?: "error"
  content: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={tone === "error" ? AlertTriangle : FileWarning}
      label={label}
      tone={tone}
    >
      <CodeBlock>{content}</CodeBlock>
    </ExpandableRow>
  )
}

function SystemInitView({
  e
}: {
  e: Extract<UIEntry, { kind: "system_init" }>
}) {
  const [open, setOpen] = useState(false)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={Cog}
      label={`会话开始${e.model ? ` · ${e.model}` : ""}`}
    >
      <div className="flex flex-col gap-1.5 text-muted-foreground">
        {e.requestedModel && e.requestedModel !== e.model && <div className="text-xs">请求模型：{e.requestedModel} · CLI 报告：{e.model ?? "待确认"}</div>}
        {e.cwd && <div className="font-mono break-all text-[11px]">{e.cwd}</div>}
        <div className="flex flex-wrap gap-1">
          {e.permissionMode && (
            <Badge variant="outline" className="text-[10px]">
              perm: {e.permissionMode}
            </Badge>
          )}
          {e.outputStyle && (
            <Badge variant="outline" className="text-[10px]">
              style: {e.outputStyle}
            </Badge>
          )}
          {e.fastModeState && (
            <Badge variant="outline" className="text-[10px]">
              fast: {e.fastModeState}
            </Badge>
          )}
          {e.version && (
            <Badge variant="outline" className="text-[10px]">
              v{e.version}
            </Badge>
          )}
        </div>
        {e.mcpServers.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {e.mcpServers.map((m) => (
              <Badge
                key={m.name}
                variant={
                  m.status === "connected"
                    ? "success"
                    : m.status === "needs-auth"
                      ? "warn"
                      : "outline"
                }
                className="text-[10px]"
              >
                {m.name} · {m.status}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </ExpandableRow>
  )
}

interface PermissionDenial {
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
}

function ResultView({ e, onOpenPermissions }: { onOpenPermissions?: () => void; e: Extract<UIEntry, { kind: "result" }> }) {
  const denials = (e.permissionDenials as PermissionDenial[] | undefined) ?? []
  const interrupted = e.terminalReason === "interrupted"
  const failed =
    !interrupted && (e.isError === true || e.terminalReason === "api_error")
  // 失败时优先展示 error 字段详情；历史 sidecar 的 api_error 可能只有
  // result 文本，此时回退展示它。实时路径已有 assistant 错误卡时通常不重复。
  const fallbackErrorDetail =
    e.terminalReason === "api_error" && !e.hasApiErrorMessage
      ? (e.result ?? "").trim()
      : ""
  const errorDetail = failed ? (e.error ?? fallbackErrorDetail).trim() : ""
  const truncated =
    !failed &&
    !interrupted &&
    (e.stopReason === "max_tokens" || e.terminalReason === "max_tokens")
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <div
        className={cn(
          "flex flex-wrap items-center gap-3 text-xs",
          failed
            ? "text-destructive"
            : truncated
              ? "text-warn"
              : "text-muted-foreground"
        )}
      >
        {failed ? (
          <AlertTriangle className="size-3.5" />
        ) : truncated ? (
          <AlertTriangle className="size-3.5" />
        ) : interrupted ? (
          <CircleStop className="size-3.5" />
        ) : (
          <CheckCircle2 className="size-3.5" />
        )}
        <span>
          {failed
            ? "失败"
            : truncated
              ? "已截断"
              : interrupted
                ? "已取消"
                : "完成"}
          {failed && e.subtype && e.subtype !== "success"
            ? ` · ${e.subtype}`
            : ""}
        </span>
        {typeof e.totalCostUsd === "number" && (
          <span className="inline-flex items-center gap-1">
            <DollarSign className="size-3" />
            {e.totalCostUsd.toFixed(4)}
          </span>
        )}
        {typeof e.durationMs === "number" && (
          <span className="inline-flex items-center gap-1">
            <Timer className="size-3" />
            {formatRunDuration(e.durationMs)}
          </span>
        )}
        {typeof e.numTurns === "number" && (
          <span className="inline-flex items-center gap-1">
            <Gauge className="size-3" />
            {e.numTurns} 轮
          </span>
        )}
      </div>
      {errorDetail && (
        <div className="max-w-full rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-1.5 text-xs leading-relaxed text-destructive/90 break-words [overflow-wrap:anywhere]">
          {errorDetail}
        </div>
      )}
      {truncated && (
        <div className="inline-flex items-center gap-1.5 text-xs text-warn">
          <AlertTriangle className="size-3.5" />
          输出达到 max_tokens 上限，内容可能被截断；发送「继续」可让模型接着写。
        </div>
      )}
      {denials.length > 0 && <PermissionDenialList denials={denials} onOpenPermissions={onOpenPermissions} />}
    </div>
  )
}

function PermissionDenialList({ denials, onOpenPermissions }: { denials: PermissionDenial[]; onOpenPermissions?: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={ShieldAlert}
      label={`权限被拒 · ${denials.length} 个工具`}
      tone="error"
    >
      <div className="space-y-1.5">
        {denials.map((d, i) => (
          <DenialRow key={d.tool_use_id ?? i} d={d} />
        ))}
        <div className="text-[11px] text-muted-foreground">
          检查当前权限配置及拒绝原因，确认后再重试。
          {onOpenPermissions && <button type="button" className="ml-2 text-primary underline" onClick={onOpenPermissions}>打开权限设置</button>}
        </div>
      </div>
    </ExpandableRow>
  )
}

function DenialRow({ d }: { d: PermissionDenial }) {
  const name = d.tool_name ?? "?"
  const input = d.tool_input ?? {}
  const cmd = (input.command as string) ?? null
  const fp = (input.file_path as string) ?? (input.path as string) ?? null
  const summary = cmd ?? fp ?? JSON.stringify(input).slice(0, 120)

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-destructive">{name}</div>
      </div>
      <div className="font-mono break-all text-foreground/80">{summary}</div>
    </div>
  )
}

function HookEventView({ e }: { e: Extract<UIEntry, { kind: "hook" }> }) {
  const [open, setOpen] = useState(false)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={Webhook}
      label={`hook · ${e.hookEventName ?? "event"}${e.toolName ? ` · ${e.toolName}` : ""}`}
    >
      <CodeBlock>{JSON.stringify(e.raw, null, 2)}</CodeBlock>
    </ExpandableRow>
  )
}
