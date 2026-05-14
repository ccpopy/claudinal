import type { UIBlock, UIMessage } from "@/types/ui"

const PREVIEW_LIMIT = 180

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function ellipsize(text: string, limit = PREVIEW_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1).trimEnd()}…`
}

function previewFromBlock(block: UIBlock): string | null {
  if (block.type === "text") {
    const text = compactText(block.text ?? "")
    return text ? text : null
  }
  if (block.type === "attachment") {
    return block.attachmentName ? `附件：${block.attachmentName}` : "附件"
  }
  if (block.type === "image") {
    return block.imageAlt ? `图片：${block.imageAlt}` : "图片"
  }
  if (block.type === "thinking") {
    const text = compactText(block.text ?? "")
    return text ? `思考：${text}` : "思考过程"
  }
  if (block.type === "tool_use") {
    return block.toolName ? `工具：${block.toolName}` : "工具调用"
  }
  if (block.type === "tool_result") {
    return block.isError ? "工具结果：失败" : "工具结果：完成"
  }
  return null
}

export function chatTimelineRoleLabel(role: UIMessage["role"]): string {
  return role === "user" ? "用户消息" : "Claude 回复"
}

export function chatTimelinePreview(message: UIMessage): string {
  for (const block of message.blocks) {
    const preview = previewFromBlock(block)
    if (preview) return ellipsize(preview)
  }
  if (message.streaming) return "正在生成回复"
  return "空消息"
}

export function formatTimelineTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ""
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(ts))
}
