import type { SessionMeta } from "@/lib/ipc"
import { getSessionTitle } from "@/lib/sessionTitles"

type SessionTitleMeta = Pick<SessionMeta, "id" | "ai_title" | "first_user_text">

export function isInternalCommandText(text: string): boolean {
  const trimmed = text.trimStart()
  return (
    trimmed.startsWith("<command-name>") && trimmed.includes("</command-name>")
  )
}

export function cleanSessionTitleText(
  text: string | null | undefined,
  maxChars = 120
): string | null {
  const trimmed = text?.trim()
  if (!trimmed || isInternalCommandText(trimmed)) return null
  return Array.from(trimmed.replace(/\s+/g, " ")).slice(0, maxChars).join("")
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
