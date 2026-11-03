import { useState } from "react"
import {
  CircleAlert,
  CircleStop,
  Clock,
  CornerDownRight,
  Download,
  FileText,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  ScrollText,
  SkipForward,
  Trash2,
  X,
  type LucideIcon
} from "lucide-react"
import { toast } from "sonner"
import { guideDescription } from "@/lib/composerCapabilities"
import { GUIDE_READ_UNCONFIRMED } from "@/lib/submission"
import type { UIMessage } from "@/types/ui"
import type { InputPayload, SubmissionQueueState } from "@/lib/submissionCoordinator"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

export interface SubmissionActions {
  payload(id: string): InputPayload | undefined
  retry(id: string): void | Promise<void>
  retryCurrent?(id: string): void | Promise<void>
  retryOriginal?(id: string): void | Promise<void>
  canEdit?(id: string): boolean
  edit(id: string): void
  cancel(id: string): void
  /** Unsent cancelled/failed inputs can be deleted instead of lingering. */
  canDiscard?(id: string): boolean
  discard?(id: string): void
  resume(id: string): void
  resumeQueue?(id: string): void
  resumeInput?(id: string): void
  queueState?(id: string): SubmissionQueueState | undefined
  canGuide?(id: string): boolean
  guide?(id: string): void
  /** Whether the guide uses priority=now instead of waiting for running tools. */
  guideImmediate?(id: string): boolean
}

type Tone = "error" | "muted"

interface SubmissionStatus {
  icon: LucideIcon
  tone: Tone
  text: string
}

/** 需要用户处理的投递状态才出现操作行；正常送达不打扰。 */
function submissionStatus(message: UIMessage, queue?: SubmissionQueueState): SubmissionStatus | null {
  const state = message.deliveryState
  if (message.localState === "save_failed") {
    return {
      icon: CircleAlert,
      tone: "error",
      text: message.submissionPendingNames?.length ? "附件准备失败，尚未发送" : "本地保存失败，尚未发送"
    }
  }
  if (state === "delivery_unknown") return { icon: CircleAlert, tone: "error", text: message.submissionError === GUIDE_READ_UNCONFIRMED ? "引导读取未确认" : "连接中断，无法确认是否已接收" }
  if (state === "failed") return { icon: CircleAlert, tone: "error", text: "未能发送" }
  if (state === "cancelled") return { icon: CircleStop, tone: "muted", text: "已取消，尚未发送" }
  if (state === "queued") return { icon: Clock, tone: "muted", text: message.delivery === "guide" ? "引导准备中，即将提交" : "排队中，本轮结束后发送" }
  if (state === "paused") return { icon: Clock, tone: "muted", text: ({
    not_sent: "上一条尚未发送，队列暂停",
    needs_decision: "等待处理阻塞项，队列暂停",
    delivery_unknown: "上一条接收状态未知，队列暂停",
    connection_lost: "CLI 连接已结束，队列暂停",
    user_stop: "用户已停止，队列暂停"
  })[queue?.reason ?? "needs_decision"] }
  if (message.submissionError) return { icon: CircleAlert, tone: "error", text: "未能发送" }
  return null
}

/** 用户消息是否由这里接管状态行（接管后消息组件不再单独渲染状态文字）。 */
export function hasSubmissionFooter(message: UIMessage, actions?: SubmissionActions): boolean {
  return !!actions?.payload(message.id) && submissionStatus(message) !== null
}

export function canEditSubmission(message: UIMessage): boolean {
  const state = message.deliveryState
  return state === "failed" || state === "cancelled" || state === "queued" || state === "paused"
}

const actionClass = "h-7 gap-1 rounded-md px-2 text-xs font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2"

function attemptTarget(attempt: NonNullable<UIMessage["attemptDetails"]>[number]): string {
  const context = attempt.configuration?.context
  return context && typeof context === "object" && "target" in context && typeof context.target === "string" ? ` · ${context.target}` : ""
}

/**
 * 气泡下方的一行：状态说明 + 就地操作。按规范这一行始终可见，
 * 不依赖悬停；次要操作收进「更多」菜单。
 */
export function SubmissionFooter({
  message,
  actions
}: {
  message: UIMessage
  actions: SubmissionActions
}) {
  const [details, setDetails] = useState(false)
  const payload = actions.payload(message.id)
  const queue = actions.queueState?.(message.id)
  const status = submissionStatus(message, queue)
  if (!payload || !status) return null
  const state = message.deliveryState
  const unknown = state === "delivery_unknown"
  const queued = state === "queued" || state === "paused"
  const retryable = state === "failed" || state === "cancelled" || unknown
  const saveFailed = message.localState === "save_failed"
  return <div className="flex w-full max-w-[85%] flex-col items-end gap-1.5">
    <div className="flex flex-wrap items-center justify-end gap-x-1 gap-y-1">
      <span
        role="status"
        className={cn(
          "mr-1 inline-flex items-center gap-1 text-xs",
          status.tone === "error" ? "text-destructive" : "text-muted-foreground"
        )}
      >
        <status.icon className="size-3.5 shrink-0" aria-hidden />
        {status.text}
      </span>
      {retryable && <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(actionClass, "bg-background text-foreground shadow-xs")}
        onClick={() => void (unknown ? actions.retry(message.id) : (actions.retryCurrent ?? actions.retry)(message.id))}
      >
        <RotateCcw className="size-3.5" />
        {unknown ? "再次发送" : actions.retryCurrent ? "按当前配置重试" : "重试"}
      </Button>}
      {canEditSubmission(message) && <Button type="button" variant="ghost" size="sm" className={actionClass}
        title="取回输入框编辑，重新发送前不会投递" disabled={actions.canEdit?.(message.id) === false} onClick={() => actions.edit(message.id)}>
        <Pencil className="size-3.5" />
        编辑
      </Button>}
      {actions.canDiscard?.(message.id) && <Button type="button" variant="ghost" size="sm"
        className={cn(actionClass, "hover:bg-destructive/10 hover:text-destructive")} onClick={() => actions.discard?.(message.id)}>
        <Trash2 className="size-3.5" />
        删除
      </Button>}
      {queued && <Button type="button" variant="ghost" size="sm" className={actionClass} onClick={() => actions.cancel(message.id)}>
        <X className="size-3.5" />
        取消排队
      </Button>}
      {state === "queued" && actions.canGuide?.(message.id) && <Button type="button" variant="outline" size="sm" className={actionClass}
        title={guideDescription(!!actions.guideImmediate?.(message.id))} onClick={() => actions.guide?.(message.id)}>
        <CornerDownRight className="size-3.5" />立即引导
      </Button>}
      {state === "paused" && <Button type="button" variant="ghost" size="sm" className={actionClass} onClick={() => (actions.resumeQueue ?? actions.resume)(message.id)}>
        <SkipForward className="size-3.5" />
        {queue ? `继续队列，共 ${queue.pendingCount} 条` : "继续队列"}
      </Button>}
      {state === "paused" && actions.resumeInput && <Button type="button" variant="ghost" size="sm" className={actionClass}
        title="此输入将先于前面的暂停输入发送；其他输入保持暂停" onClick={() => actions.resumeInput?.(message.id)}>
        <SkipForward className="size-3.5" />仅发送这一条
      </Button>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className={cn(actionClass, "w-7 px-0")} aria-label="更多操作">
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {retryable && !unknown && actions.retryOriginal && <DropdownMenuItem onSelect={() => void actions.retryOriginal?.(message.id)}>
            <RotateCcw className="size-4" />按原配置重试
          </DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => setDetails((value) => !value)}>
            <ScrollText className="size-4" />
            {details ? "收起详情" : unknown ? "查看记录" : "查看详情"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => {
            void navigator.clipboard.writeText(payload.text).then(
              () => toast.success("原文已复制"),
              (error) => toast.error(`复制失败：${String(error)}`)
            )
          }}>
            <FileText className="size-4" />
            复制原文
          </DropdownMenuItem>
          {saveFailed && <DropdownMenuItem onSelect={() => downloadPayload(message.id, payload)}>
            <Download className="size-4" />
            另存输入与附件
          </DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {details && <div className="max-h-48 w-full overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 px-3 py-2 text-left text-xs leading-relaxed text-muted-foreground">
      {unknown && message.submissionError !== GUIDE_READ_UNCONFIRMED ? "管道可能已接收部分或全部请求。请检查本会话回复、工具结果及文件差异；再次发送可能重复操作。\n" : ""}
      {message.submissionError || "原文和附件由此对话保留。"}
      {queue?.blockerId ? `\n阻塞输入：${queue.blockerId}` : ""}
      {queue ? `\n待发送顺序：第 ${queue.pendingIds.indexOf(message.id) + 1} 条，共 ${queue.pendingCount} 条` : ""}
      {message.submissionTimings && Object.entries(message.submissionTimings).filter(([key]) => key !== "registered").map(([key, value]) => `\n${({ saved: "保存完成", writeStarted: "开始投递", written: "管道写入完成", firstResponse: "首个响应" } as Record<string, string>)[key]}：${Math.round(value - message.submissionTimings!.registered)} ms`)}
      {`\n输入版本：${message.inputRevision ?? 1}\n尝试记录：${message.attemptDetails?.map((attempt) => `v${attempt.revision} · ${attempt.state} · ${attempt.id}${attemptTarget(attempt)}${attempt.error ? ` · ${attempt.error}` : ""}`).join("\n") ?? message.attemptIds?.join("\n") ?? "历史记录"}`}
    </div>}
  </div>
}

function downloadPayload(id: string, payload: InputPayload) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ text: payload.text, images: payload.images, documents: payload.documents }, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `claudinal-input-${id}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
