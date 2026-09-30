import { useState } from "react"
import { ChevronDown, Clock3, Paperclip } from "lucide-react"
import { Button } from "@/components/ui/button"
import { deliveryLabel } from "@/lib/submission"
import type { UIMessage } from "@/types/ui"
import {
  MessageInlineEditor,
  SubmissionFooter,
  canEditSubmission,
  hasSubmissionFooter,
  type SubmissionActions
} from "./SubmittedInputActions"

/** Local queue, separate from the transcript until each input is dispatched. */
export function QueuedComposerBar({ messages, actions }: {
  messages: UIMessage[]
  actions: SubmissionActions
}) {
  if (!messages.length) return null
  return <section aria-label="待发送消息" className="mx-auto max-w-3xl rounded-xl border bg-card/95 shadow-xs xl:max-w-4xl 2xl:max-w-5xl">
    <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
      <Clock3 className="size-3.5" aria-hidden />待发送 · {messages.length}
    </div>
    <div className="max-h-64 overflow-y-auto divide-y">
      {messages.map((message) => <QueuedRow key={message.id} message={message} actions={actions} />)}
    </div>
  </section>
}

function QueuedRow({ message, actions }: { message: UIMessage; actions: SubmissionActions }) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const payload = actions.payload(message.id)
  const editable = canEditSubmission(message)
  const text = message.blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
  const attachments = message.blocks.filter((block) => block.type === "image" || block.type === "attachment")
  return <div className="flex flex-col items-end gap-1.5 px-3 py-2">
    {editing && editable && payload ? <MessageInlineEditor
      message={message} payload={payload}
      onSubmit={(next) => { actions.edit(message.id, next); setEditing(false) }}
      onCancel={() => setEditing(false)}
    /> : <>
      <button type="button" aria-label="展开或收起待发送内容" aria-expanded={expanded}
        className="flex w-full items-start gap-2 text-left text-sm" onClick={() => setExpanded((value) => !value)}>
        <span className={expanded ? "min-w-0 flex-1 whitespace-pre-wrap break-words" : "min-w-0 flex-1 truncate"}>{text || "附件消息"}</span>
        {!!attachments.length && <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Paperclip className="size-3" />{attachments.length}</span>}
        <ChevronDown className={`mt-0.5 size-3.5 shrink-0 text-muted-foreground ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && !!attachments.length && <p className="w-full break-words text-xs text-muted-foreground">
        {attachments.map((block) => block.attachmentName ?? block.imageAlt ?? "图片").join("、")}
      </p>}
    </>}
    {hasSubmissionFooter(message, actions)
      ? <SubmissionFooter message={message} actions={actions} onEdit={() => setEditing(true)} />
      : <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span role="status">{deliveryLabel[message.deliveryState ?? "preparing"]}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => actions.cancel(message.id)}>取消排队</Button>
      </div>}
  </div>
}
