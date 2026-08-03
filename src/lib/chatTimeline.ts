import type { UIBlock, UIMessage } from "@/types/ui"

const PREVIEW_LIMIT = 180
const MARKER_IDLE_WIDTH = 6
const MARKER_MAX_WIDTH = 28
const MARKER_INFLUENCE_RADIUS = 44
const TIMELINE_RAIL_WIDTH = 40
const TIMELINE_RAIL_LEFT_ANCHOR = 24
const TIMELINE_RAIL_MIN_LEFT_INSET = 8

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function markdownToPlainText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^\s{0,3}(?:`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/^\s{0,3}\[[^\]]+\]:\s+\S+.*$/gm, "")
    .replace(/<((?:https?|mailto):[^>]+)>/gi, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\[[ xX]\]\s+/gm, "")
    .replace(/^\s{0,3}(?:(?:[-*_]\s*){3,})$/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/(`+)(.*?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(
      /(^|[\s([{])\*([^*\n]+?)\*(?=$|[\s)\]},.!?:;，。！？：；])/gm,
      "$1$2"
    )
    .replace(
      /(^|[\s([{])_([^_\n]+?)_(?=$|[\s)\]},.!?:;，。！？：；])/gm,
      "$1$2"
    )
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1")
}

function compactMarkdownText(text: string): string {
  return compactText(markdownToPlainText(text))
}

function ellipsize(text: string, limit = PREVIEW_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1).trimEnd()}…`
}

function previewFromBlock(block: UIBlock): string | null {
  if (block.type === "text") {
    const text = compactMarkdownText(block.text ?? "")
    return text ? text : null
  }
  if (block.type === "attachment") {
    return block.attachmentName ? `附件：${block.attachmentName}` : "附件"
  }
  if (block.type === "image") {
    return block.imageAlt ? `图片：${block.imageAlt}` : "图片"
  }
  if (block.type === "thinking") {
    const text = compactMarkdownText(block.text ?? "")
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

export function chatTimelineRoleLabel(
  role: UIMessage["role"],
  delivery?: UIMessage["delivery"]
): string {
  if (role === "user") {
    return delivery === "guide" ? "引导消息" : "用户消息"
  }
  return "Claude 回复"
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

export function chatTimelineMarkerWidth(
  pointerY: number | null,
  markerCenterY: number
): number {
  if (pointerY === null) return MARKER_IDLE_WIDTH
  const distance = Math.abs(pointerY - markerCenterY)
  if (distance >= MARKER_INFLUENCE_RADIUS) return MARKER_IDLE_WIDTH
  const influence = 1 - distance / MARKER_INFLUENCE_RADIUS
  const eased = influence * influence * (3 - 2 * influence)
  return MARKER_IDLE_WIDTH + (MARKER_MAX_WIDTH - MARKER_IDLE_WIDTH) * eased
}

export function chatTimelineRailLeft(
  messageColumnLeft: number
): number | null {
  if (!Number.isFinite(messageColumnLeft) || messageColumnLeft <= 0) return null
  const contentAlignedLeft = messageColumnLeft - TIMELINE_RAIL_WIDTH

  if (contentAlignedLeft < TIMELINE_RAIL_MIN_LEFT_INSET) return null
  return Math.min(TIMELINE_RAIL_LEFT_ANCHOR, contentAlignedLeft)
}

export function timelineTargetIntersectsViewport(
  targetTop: number,
  targetHeight: number,
  viewportTop: number,
  viewportHeight: number
): boolean {
  const targetBottom = targetTop + Math.max(targetHeight, 0)
  const viewportBottom = viewportTop + Math.max(viewportHeight, 0)
  return targetBottom > viewportTop && targetTop < viewportBottom
}
