export type UIBlockType =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "image"
  | "attachment"
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
  attachmentName?: string
  attachmentMime?: string
  attachmentSize?: number
  attachmentText?: string
  attachmentContentMode?: "inline" | "document" | "metadata-only"
  partial?: boolean
  raw?: unknown
  startedAt?: number
  endedAt?: number
}

export interface ImagePayload {
  data: string
  mime: string
}

export interface DocumentPayload {
  data: string
  mime: string
  name: string
  size: number
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
  delivery?: "guide"
  /** CLI 标记的 API 错误消息（isApiErrorMessage）：按错误卡片渲染而非普通 markdown */
  apiError?: boolean
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
  /** 部分网关把错误详情放在 error 字段而非 result */
  error?: string
  totalCostUsd?: number
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
  isError?: boolean
  stopReason?: string
  terminalReason?: string
  /** 同一回合已包含可见的 assistant API 错误卡，result 无需重复回显相同正文。 */
  hasApiErrorMessage?: boolean
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
