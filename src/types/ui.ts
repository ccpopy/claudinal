export type UIBlockType =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "image"
  | "unknown"

export interface UIBlock {
  type: UIBlockType
  text?: string
  toolName?: string
  toolInput?: unknown
  toolUseId?: string
  toolResultContent?: unknown
  toolUseResult?: unknown // 顶级 tool_use_result（含 file/structuredPatch/originalFile/type 等）
  isError?: boolean
  imageMediaType?: string
  imageData?: string
  imageAlt?: string
  partial?: boolean
  raw?: unknown
  startedAt?: number
  endedAt?: number
}

export interface ImagePayload {
  data: string
  mime: string
}

export interface ContextUsage {
  model?: string
  usedTokens: number
  contextWindow?: number
  percent?: number
  inputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  outputTokens?: number
}

export interface UIMessage {
  kind: "message"
  id: string
  role: "user" | "assistant"
  blocks: UIBlock[]
  model?: string
  usage?: Record<string, unknown>
  stopReason?: string | null
  streaming: boolean
  queued?: boolean
  ts: number
  stopTs?: number
}

export interface UISystemInit {
  kind: "system_init"
  sessionId?: string
  model?: string
  cwd?: string
  permissionMode?: string
  mcpServers: Array<{ name: string; status: string }>
  tools: string[]
  skills: string[]
  slashCommands: string[]
  agents: string[]
  version?: string
  outputStyle?: string
  apiKeySource?: string
  fastModeState?: string
  ts: number
}

export interface UISystemStatus {
  kind: "system_status"
  status: string
  ts: number
}

export interface UIResult {
  kind: "result"
  subtype?: string
  result?: string
  totalCostUsd?: number
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
  isError?: boolean
  stopReason?: string
  modelUsage?: Record<string, unknown>
  permissionDenials?: unknown[]
  ts: number
}

export interface UIRateLimit {
  kind: "rate_limit"
  rateLimitType?: string
  resetsAt?: number
  status?: string
  ts: number
}

export interface UIHookEvent {
  kind: "hook"
  hookEventName?: string
  toolName?: string
  raw: unknown
  ts: number
}

export interface UIRaw {
  kind: "raw"
  line?: string
  ts: number
}

export interface UIStderr {
  kind: "stderr"
  line: string
  ts: number
}

export interface UIUnknown {
  kind: "unknown"
  raw: unknown
  ts: number
}

export type UIEntry =
  | UIMessage
  | UISystemInit
  | UISystemStatus
  | UIResult
  | UIRateLimit
  | UIHookEvent
  | UIRaw
  | UIStderr
  | UIUnknown
