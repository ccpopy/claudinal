import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { ClaudeEvent } from "../types/events"

export type SpawnArgs = {
  cwd: string
  model: string | null
  effort: string | null
  permissionMode: string | null
  resumeSessionId?: string | null
  env?: Record<string, string> | null
}

export interface DirEntry {
  name: string
  path: string
  is_dir: boolean
}

export interface SessionMeta {
  id: string
  file_path: string
  modified_ts: number
  size_bytes: number
  msg_count: number
  ai_title: string | null
  first_user_text: string | null
}

export async function detectClaudeCli(): Promise<string> {
  return invoke<string>("detect_claude_cli")
}

export async function spawnSession(args: SpawnArgs): Promise<string> {
  return invoke<string>("spawn_session", args as Record<string, unknown>)
}

export async function sendUserMessage(
  sessionId: string,
  contentBlocks: Array<Record<string, unknown>>
): Promise<void> {
  return invoke("send_user_message", { sessionId, contentBlocks })
}

export async function stopSession(sessionId: string): Promise<void> {
  return invoke("stop_session", { sessionId })
}

export async function createDir(path: string): Promise<void> {
  return invoke("create_dir", { path })
}

export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path })
}

export async function defaultWorkspaceRoot(): Promise<string> {
  return invoke<string>("default_workspace_root")
}

export async function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path })
}

export async function listProjectSessions(cwd: string): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("list_project_sessions", { cwd })
}

export async function readSessionTranscript(
  cwd: string,
  sessionId: string
): Promise<ClaudeEvent[]> {
  return invoke<ClaudeEvent[]>("read_session_transcript", { cwd, sessionId })
}

export async function openPath(path: string): Promise<void> {
  return invoke("open_path", { path })
}

export async function listenSessionEvents(
  sessionId: string,
  handler: (ev: ClaudeEvent) => void
): Promise<UnlistenFn> {
  return listen<ClaudeEvent>(`claude://session/${sessionId}/event`, (e) =>
    handler(e.payload)
  )
}

export async function listenSessionErrors(
  sessionId: string,
  handler: (line: string) => void
): Promise<UnlistenFn> {
  return listen<string>(`claude://session/${sessionId}/error`, (e) =>
    handler(e.payload)
  )
}
