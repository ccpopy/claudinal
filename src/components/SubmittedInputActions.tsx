import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import {
  CircleAlert,
  CircleStop,
  Clock,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RotateCcw,
  ScrollText,
  SkipForward,
  X,
  type LucideIcon
} from "lucide-react"
import { toast } from "sonner"
import {
  joinOutgoingText,
  prepareInputFiles,
  splitOutgoingText,
  buildOutgoingText,
  type OutgoingFileMarker
} from "@/lib/inputAttachments"
import { formatBytes, SUPPORTED_ATTACHMENT_ACCEPT } from "@/lib/fileAttachments"
import type { UIMessage } from "@/types/ui"
import type { InputPayload } from "@/lib/submissionCoordinator"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { AttachmentChip } from "./composer/AttachmentChip"

export interface SubmissionActions {
  payload(id: string): InputPayload | undefined
  retry(id: string): void | Promise<void>
  edit(id: string, payload: InputPayload): void
  cancel(id: string): void
  resume(id: string): void
}

type Tone = "error" | "muted"

interface SubmissionStatus {
  icon: LucideIcon
  tone: Tone
  text: string
}

/** 需要用户处理的投递状态才出现操作行；正常送达不打扰。 */
function submissionStatus(message: UIMessage): SubmissionStatus | null {
  const state = message.deliveryState
  if (message.localState === "save_failed") {
    return {
      icon: CircleAlert,
      tone: "error",
      text: message.submissionPendingNames?.length ? "附件准备失败，尚未发送" : "本地保存失败，尚未发送"
    }
  }
  if (state === "delivery_unknown") return { icon: CircleAlert, tone: "error", text: "连接中断，无法确认是否已接收" }
  if (state === "failed") return { icon: CircleAlert, tone: "error", text: "未能发送" }
  if (state === "cancelled") return { icon: CircleStop, tone: "muted", text: "已取消，尚未发送" }
  if (state === "queued") return { icon: Clock, tone: "muted", text: "排队中，本轮结束后发送" }
  if (state === "paused") return { icon: Clock, tone: "muted", text: "等待处理上一条" }
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

/**
 * 气泡下方的一行：状态说明 + 就地操作。按规范这一行始终可见，
 * 不依赖悬停；次要操作收进「更多」菜单。
 */
export function SubmissionFooter({
  message,
  actions,
  onEdit
}: {
  message: UIMessage
  actions: SubmissionActions
  onEdit: () => void
}) {
  const [details, setDetails] = useState(false)
  const payload = actions.payload(message.id)
  const status = submissionStatus(message)
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
        onClick={() => void actions.retry(message.id)}
      >
        <RotateCcw className="size-3.5" />
        {unknown ? "再次发送" : "重试"}
      </Button>}
      {canEditSubmission(message) && <Button type="button" variant="ghost" size="sm" className={actionClass} onClick={onEdit}>
        <Pencil className="size-3.5" />
        编辑
      </Button>}
      {queued && <Button type="button" variant="ghost" size="sm" className={actionClass} onClick={() => actions.cancel(message.id)}>
        <X className="size-3.5" />
        取消排队
      </Button>}
      {state === "paused" && <Button type="button" variant="ghost" size="sm" className={actionClass} onClick={() => actions.resume(message.id)}>
        <SkipForward className="size-3.5" />
        跳过上一条
      </Button>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className={cn(actionClass, "w-7 px-0")} aria-label="更多操作">
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
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
      {unknown ? "管道可能已接收部分或全部请求。请检查本会话回复、工具结果及文件差异；再次发送可能重复操作。\n" : ""}
      {message.submissionError || "原文和附件由此对话保留。"}
      {message.submissionTimings && Object.entries(message.submissionTimings).filter(([key]) => key !== "registered").map(([key, value]) => `\n${({ saved: "保存完成", writeStarted: "开始投递", written: "管道写入完成", firstResponse: "首个响应" } as Record<string, string>)[key]}：${Math.round(value - message.submissionTimings!.registered)} ms`)}
      {`\n输入版本：${message.inputRevision ?? 1}\n尝试记录：${message.attemptDetails?.map((attempt) => `v${attempt.revision} · ${attempt.state} · ${attempt.id}${attempt.error ? ` · ${attempt.error}` : ""}`).join("\n") ?? message.attemptIds?.join("\n") ?? "历史记录"}`}
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

interface EditorDraft {
  body: string
  files: OutgoingFileMarker[]
  images: InputPayload["images"]
  documents: InputPayload["documents"]
  pendingNames?: string[]
}

/**
 * 就地编辑：气泡原位变成与底部输入框同风格的编辑卡，
 * 只持有这条消息的副本，绝不触碰底部草稿。
 */
export function MessageInlineEditor({
  message,
  payload,
  onSubmit,
  onCancel
}: {
  message: UIMessage
  payload: InputPayload
  onSubmit: (payload: InputPayload) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<EditorDraft>(() => {
    const split = splitOutgoingText(payload.text)
    return { body: split.body, files: split.files, images: payload.images, documents: payload.documents, pendingNames: payload.pendingNames }
  })
  const [preparing, setPreparing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  const queued = message.deliveryState === "queued" || message.deliveryState === "paused"

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [draft.body])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    return () => { generation.current += 1 }
  }, [])

  const empty = !draft.body.trim() && !draft.files.length && !draft.images.length && !draft.documents.length
  const blocked = preparing || !!draft.pendingNames?.length || empty

  const submit = () => {
    if (blocked) return
    onSubmit({ text: joinOutgoingText(draft.body, draft.files), images: draft.images, documents: draft.documents })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    } else if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      submit()
    }
  }

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    const current = generation.current
    setPreparing(true)
    try {
      const ready = await prepareInputFiles(files)
      if (current !== generation.current) return
      setDraft((value) => ({
        ...value,
        files: [...value.files, ...splitOutgoingText(buildOutgoingText("", ready.files)).files],
        images: [...value.images, ...ready.images],
        documents: [...value.documents, ...ready.documents]
      }))
    } catch (error) {
      if (current === generation.current) toast.error(`附件读取失败：${String(error)}`)
    } finally {
      if (current === generation.current) setPreparing(false)
    }
  }

  const hasAttachments = draft.images.length > 0 || draft.files.length > 0 || !!draft.pendingNames?.length
  return <div className="w-full max-w-[85%] rounded-[14px] border bg-card p-3 shadow-sm focus-within:border-ring/60">
    {hasAttachments && <div className="mb-2 flex flex-wrap gap-2">
      {draft.images.map((image, index) => <AttachmentChip
        key={`image-${index}`}
        icon={<img src={`data:${image.mime};base64,${image.data}`} alt="" className="size-6 rounded-full object-cover" />}
        label={`图片 ${index + 1}`}
        meta={formatBytes(Math.ceil((image.data.length * 3) / 4))}
        onRemove={() => setDraft((value) => ({ ...value, images: value.images.filter((_, i) => i !== index) }))}
      />)}
      {draft.files.map((file, index) => <AttachmentChip
        key={`file-${index}`}
        icon={<FileText className="size-3.5" />}
        label={file.name || "未命名附件"}
        meta={[file.size !== undefined ? formatBytes(file.size) : null, file.mode === "document" ? "PDF" : file.mode === "metadata-only" ? "仅信息" : null].filter(Boolean).join(" · ")}
        onRemove={() => setDraft((value) => ({
          ...value,
          files: value.files.filter((_, i) => i !== index),
          documents: file.mode === "document" ? value.documents.filter((doc) => doc.name !== file.name) : value.documents
        }))}
      />)}
      {draft.pendingNames?.map((name) => <AttachmentChip
        key={`pending-${name}`}
        icon={<ImageIcon className="size-3.5" />}
        label={name}
        meta="未就绪"
        onRemove={() => setDraft((value) => ({ ...value, pendingNames: value.pendingNames?.filter((item) => item !== name) }))}
      />)}
    </div>}
    <textarea
      ref={textareaRef}
      rows={1}
      value={draft.body}
      aria-label="编辑消息"
      placeholder="编辑消息内容"
      onChange={(event) => setDraft((value) => ({ ...value, body: event.target.value }))}
      onKeyDown={onKeyDown}
      className="block min-h-[44px] w-full resize-none bg-transparent px-1 py-0.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground [scrollbar-gutter:stable]"
    />
    <div className="mt-2 flex items-center justify-between gap-2">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={SUPPORTED_ATTACHMENT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ""
          void addFiles(files)
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 w-8 px-0 text-muted-foreground"
        disabled={preparing}
        onClick={() => fileInputRef.current?.click()}
        aria-label="添加附件"
        title="添加附件"
      >
        {preparing ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
      </Button>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={onCancel} title="取消 (Esc)">
          取消
        </Button>
        <Button type="button" size="sm" className="h-8 text-xs" disabled={blocked} onClick={submit} title={queued ? "保存 (Enter)" : "发送 (Enter)"}>
          {queued ? "保存" : "发送"}
        </Button>
      </div>
    </div>
  </div>
}
