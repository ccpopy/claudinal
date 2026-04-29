import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { ClaudeEvent } from "../types/events"

export type SpawnArgs = {
  cwd: string
  model: string | null
  effort: string | null
  permissionMode: string | null
  resumeSessionId?: string | null
  forkSessionId?: string | null
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

export async function deleteSessionJsonl(
  cwd: string,
  sessionId: string
): Promise<void> {
  return invoke("delete_session_jsonl", { cwd, sessionId })
}

export async function readSessionSidecar(
  cwd: string,
  sessionId: string
): Promise<unknown | null> {
  return invoke<unknown | null>("read_session_sidecar", { cwd, sessionId })
}

export async function writeSessionSidecar(
  cwd: string,
  sessionId: string,
  data: unknown
): Promise<void> {
  return invoke("write_session_sidecar", { cwd, sessionId, data })
}

export async function openPath(path: string): Promise<void> {
  return invoke("open_path", { path })
}

export async function watchSessions(cwd: string): Promise<void> {
  return invoke("watch_sessions", { cwd })
}

export async function unwatchSessions(cwd: string): Promise<void> {
  return invoke("unwatch_sessions", { cwd })
}

export async function listenSessionsChanged(
  cwd: string,
  handler: () => void
): Promise<UnlistenFn> {
  return listen(`claudinal://sessions/${cwd}/changed`, () => handler())
}

export interface FileMatch {
  path: string
  rel: string
  is_dir: boolean
}

export async function listFiles(
  cwd: string,
  prefix: string
): Promise<FileMatch[]> {
  return invoke<FileMatch[]>("list_files", { cwd, prefix })
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
