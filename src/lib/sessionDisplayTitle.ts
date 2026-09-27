import type { SessionMeta } from "@/lib/ipc"
import { getSessionTitle } from "@/lib/sessionTitles"
import { stripLeadingSlashCommand } from "@/lib/composerCommand"

type SessionTitleMeta = Pick<SessionMeta, "id" | "ai_title" | "first_user_text">

export function cleanSessionTitleText(
  text: string | null | undefined,
  maxChars = 120
): string | null {
  const trimmed = text?.trim() ?? ""
  if (!trimmed) return null
  // CLI 在 stream-json 会话里不写 ai-title，标题回落到首条用户消息；
  // 以 slash 命令开头的消息（"/frontend-design 帮我…"）剥离命令 token，让标题说人话。
  // 与 Rust 侧 reader.rs::title_candidate 保持一致。
  const withoutCommand = stripLeadingSlashCommand(trimmed)
  const candidate = withoutCommand || trimmed
  return Array.from(candidate.replace(/\s+/g, " ")).slice(0, maxChars).join("")
}

export function sessionGeneratedTitle(session: SessionTitleMeta): string | null {
  return (
    cleanSessionTitleText(session.ai_title) ||
    cleanSessionTitleText(session.first_user_text)
  )
}

export function sessionDisplayTitle(session: SessionTitleMeta): string {
  return (
    getSessionTitle(session.id) ||
    sessionGeneratedTitle(session) ||
    session.id.slice(0, 8)
  )
}
