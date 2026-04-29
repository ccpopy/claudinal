export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown }

export interface MessagePayload {
  role: "user" | "assistant"
  content: string | ContentBlock[]
  model?: string
  usage?: Record<string, unknown>
  stop_reason?: string | null
}

export type ClaudeEvent =
  | { type: "system"; subtype?: string; [k: string]: unknown }
  | { type: "user"; message: MessagePayload; session_id?: string; [k: string]: unknown }
  | { type: "assistant"; message: MessagePayload; session_id?: string; [k: string]: unknown }
  | {
      type: "result"
      subtype?: string
      session_id?: string
      total_cost_usd?: number
      usage?: Record<string, unknown>
      [k: string]: unknown
    }
  | { type: "stderr"; line: string }
  | { type: "raw"; line: string }
  | { type: string; [k: string]: unknown }
