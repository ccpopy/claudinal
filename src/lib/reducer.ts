import type { ClaudeEvent, ContentBlock } from "../types/events"
import type { UIBlock, UIEntry, UIMessage } from "../types/ui"
import { splitUploadedFileText } from "./fileAttachments"

export interface State {
  entries: UIEntry[]
}

export type Action =
  | { kind: "event"; event: ClaudeEvent }
  | {
      kind: "user_local"
      blocks: UIBlock[]
      queued?: boolean
      queueMode?: UIMessage["queueMode"]
      queueStatus?: UIMessage["queueStatus"]
      localId?: string
    }
  | {
      kind: "update_local_queue"
      localId: string
      queueMode?: UIMessage["queueMode"]
      queueStatus?: UIMessage["queueStatus"]
    }
  | { kind: "unqueue_local"; localId: string }
  | { kind: "drop_local"; localId: string }
  | { kind: "load_transcript"; events: ClaudeEvent[] }
  | { kind: "replace_state"; state: State }
  | { kind: "reset" }

export function init(): State {
  return { entries: [] }
}

export function reduce(state: State, action: Action): State {
  if (action.kind === "reset") return init()
  if (action.kind === "replace_state") return action.state
  if (action.kind === "user_local") {
    const ts = Date.now()
    const msg: UIMessage = {
      kind: "message",
      id: action.localId ?? `local-${state.entries.length}-${ts}`,
      role: "user",
      blocks: action.blocks,
      streaming: false,
      queued: action.queued,
      queueMode: action.queueMode,
      queueStatus: action.queueStatus,
      ts
    }
    return { entries: [...state.entries, msg] }
  }
  if (action.kind === "update_local_queue") {
    return {
      entries: state.entries.map((entry) => {
        if (entry.kind !== "message" || entry.id !== action.localId) {
          return entry
        }
        return {
          ...entry,
          queueMode: action.queueMode ?? entry.queueMode,
          queueStatus: action.queueStatus ?? entry.queueStatus
        }
      })
    }
  }
  if (action.kind === "unqueue_local") {
    // 插话发送时会先挂在当前 run 中间。CLI 真正处理它后，把它挪到
    // 当前工具结果之后、后续 assistant 输出之前，避免 UI 显示成助手先答、用户后问。
    const idx = state.entries.findIndex(
      (e) => e.kind === "message" && e.id === action.localId
    )
    if (idx < 0) return state
    const cur = state.entries[idx] as UIMessage
    const filtered = state.entries.filter((_, i) => i !== idx)
    let insertAt = filtered.length
    for (let i = idx; i < filtered.length; i++) {
      const e = filtered[i]
      if (e.kind === "message" && (e as UIMessage).role === "assistant") {
        insertAt = i
        break
      }
    }
    return {
      entries: [
        ...filtered.slice(0, insertAt),
        { ...cur, queued: false, queueMode: undefined, queueStatus: undefined },
        ...filtered.slice(insertAt)
      ]
    }
  }
  if (action.kind === "drop_local") {
    return {
      entries: state.entries.filter(
        (e) => !(e.kind === "message" && e.id === action.localId)
      )
    }
  }
  if (action.kind === "load_transcript") {
    let s: State = init()
    for (const ev of action.events) {
      const t = (ev as { type?: string }).type
      // 过滤 jsonl 内部事件：queue-operation / attachment / ai-title
      if (
        t === "queue-operation" ||
        (t === "attachment" && !isQueuedCommandAttachment(ev)) ||
        t === "ai-title" ||
        t === "deferred_tools_delta" ||
        t === "skill_listing" ||
        t === "tools_changed" ||
        t === "permission-mode" ||
        t === "last-prompt" ||
        t === "file-history-snapshot" ||
        t === "task_reminder" ||
        t === "tool_reference" ||
        t === "system_changed" ||
        t === "edited_text_file" ||
        t === "unavailable" ||
        t === "date_change" ||
        t === "todo_reminder" ||
        t === "queued_command"
      )
        continue
      s = reduceEvent(s, ev)
    }
    return {
      entries: s.entries.map((e) =>
        e.kind === "message" ? ({ ...e, streaming: false } as UIMessage) : e
      )
    }
  }
  return reduceEvent(state, action.event)
}

function parseTs(ev: unknown): number {
  if (ev && typeof ev === "object") {
    const obj = ev as Record<string, unknown>
    const raw = obj.timestamp ?? obj.ts
    if (typeof raw === "string") {
      const ms = Date.parse(raw)
      if (!Number.isNaN(ms)) return ms
    } else if (typeof raw === "number") {
      return raw
    }
  }
  return Date.now()
}

function reduceEvent(state: State, ev: ClaudeEvent): State {
  const ts = parseTs(ev)
  const t = (ev as { type?: string }).type
  if (isInternalGeneratedEvent(ev)) return state

  if (t === "system") return reduceSystem(state, ev as Record<string, unknown>, ts)
  if (t === "stream_event")
    return reduceStreamEvent(state, (ev as Record<string, unknown>).event, ts)
  if (t === "assistant") return reduceAssistant(state, ev as Record<string, unknown>, ts)
  if (t === "user") return reduceUser(state, ev as Record<string, unknown>, ts)
  if (t === "attachment")
    return reduceAttachment(state, ev as Record<string, unknown>, ts)
  if (t === "result") return reduceResult(state, ev as Record<string, unknown>, ts)
  if (t === "rate_limit_event")
    return reduceRateLimit(state, ev as Record<string, unknown>, ts)
  if (t === "hook_event" || t === "hook")
    return reduceHook(state, ev as Record<string, unknown>, ts)
  if (t === "raw") {
    return {
      entries: [...state.entries, { kind: "raw", line: (ev as { line?: string }).line, ts }]
    }
  }
  if (t === "stderr") {
    return {
      entries: [
        ...state.entries,
        { kind: "stderr", line: (ev as { line?: string }).line ?? "", ts }
      ]
    }
  }
  return appendUnknown(state, ev, ts)
}

function isQueuedCommandAttachment(ev: ClaudeEvent): boolean {
  if (!ev || typeof ev !== "object") return false
  return (
    (ev as Record<string, unknown>).type === "attachment" &&
    ((ev as Record<string, unknown>).attachment as Record<string, unknown> | undefined)?.type ===
      "queued_command"
  )
}

function reduceAttachment(state: State, ev: Record<string, unknown>, ts: number): State {
  const attachment = ev.attachment as Record<string, unknown> | undefined
  if (attachment?.type !== "queued_command") {
    return appendUnknown(state, ev as ClaudeEvent, ts)
  }
  const commandMode =
    typeof attachment.commandMode === "string" ? attachment.commandMode : "prompt"
  if (commandMode !== "prompt") return state
  const prompt = attachment.prompt
  const blocks =
    typeof prompt === "string"
      ? ([{ type: "text", text: prompt }] as UIBlock[])
      : convertContentBlocks(prompt)
  const visibleBlocks = normalizeUserBlocks(blocks)
  if (isInternalCommandBlocks(visibleBlocks)) return state
  if (visibleBlocks.length === 0) return state
  const entry: UIMessage = {
    kind: "message",
    id: (ev.uuid as string | undefined) ?? `queued-${state.entries.length}-${ts}`,
    role: "user",
    blocks: visibleBlocks,
    streaming: false,
    ts
  }
  return { entries: [...state.entries, entry] }
}

function reduceSystem(state: State, ev: Record<string, unknown>, ts: number): State {
  const sub = ev.subtype as string | undefined
  if (sub === "init") {
    return {
      entries: [
        ...state.entries,
        {
          kind: "system_init",
          sessionId: ev.session_id as string | undefined,
          model: ev.model as string | undefined,
          cwd: ev.cwd as string | undefined,
          permissionMode: ev.permissionMode as string | undefined,
          mcpServers:
            (ev.mcp_servers as Array<{ name: string; status: string }>) ?? [],
          tools: (ev.tools as string[]) ?? [],
          skills: (ev.skills as string[]) ?? [],
          slashCommands: (ev.slash_commands as string[]) ?? [],
          agents: (ev.agents as string[]) ?? [],
          version: ev.claude_code_version as string | undefined,
          outputStyle: ev.output_style as string | undefined,
          apiKeySource: ev.apiKeySource as string | undefined,
          fastModeState: ev.fast_mode_state as string | undefined,
          ts
        }
      ]
    }
  }
  if (sub === "status") {
    return {
      entries: [
        ...state.entries,
        { kind: "system_status", status: (ev.status as string) ?? "", ts }
      ]
    }
  }
  return appendUnknown(state, ev as ClaudeEvent, ts)
}

function reduceStreamEvent(state: State, raw: unknown, ts: number): State {
  if (!raw || typeof raw !== "object") return state
  const inner = raw as Record<string, unknown>
  const t = inner.type as string

  if (t === "message_start") {
    const msg = (inner.message as Record<string, unknown>) ?? {}
    const entry: UIMessage = {
      kind: "message",
      id: (msg.id as string) ?? `stream-${state.entries.length}`,
      role: (msg.role as "user" | "assistant") ?? "assistant",
      blocks: [],
      model: msg.model as string | undefined,
      usage: msg.usage as Record<string, unknown> | undefined,
      stopReason: null,
      streaming: true,
      ts
    }
    return { entries: [...state.entries, entry] }
  }

  const idx = findStreamingIdx(state.entries)
  if (idx < 0) return state
  const entries = state.entries.slice()
  const cur = entries[idx] as UIMessage
  const blocks = cur.blocks.slice()

  if (t === "content_block_start") {
    const cb = (inner.content_block as Record<string, unknown>) ?? {}
    const blkType = (cb.type as string) ?? "unknown"
    const blk: UIBlock = { type: blkType as UIBlock["type"], partial: true }
    if (blkType === "text") blk.text = (cb.text as string) ?? ""
    else if (blkType === "thinking") {
      blk.text = (cb.thinking as string) ?? ""
      blk.startedAt = ts
    } else if (blkType === "tool_use") {
      blk.toolName = cb.name as string | undefined
      blk.toolUseId = cb.id as string | undefined
      blk.toolInput = cb.input ?? {}
      blk.startedAt = ts
    } else {
      blk.raw = cb
    }
    const i = typeof inner.index === "number" ? inner.index : blocks.length
    // 若上游 index 跨号（少见但出现过：collab 子 agent stream-json 偶发跳号），
    // 直接 blocks[i]=blk 会留下 undefined 空槽，下游 for...of 会读到 undefined。
    // 用 unknown placeholder 填充中间空位，保持数组紧凑。
    while (blocks.length < i) blocks.push({ type: "unknown" } as UIBlock)
    blocks[i] = blk
    entries[idx] = { ...cur, blocks }
    return { entries }
  }

  if (t === "content_block_delta") {
    const i = typeof inner.index === "number" ? inner.index : blocks.length - 1
    const cb = blocks[i]
    if (!cb) return state
    const d = (inner.delta as Record<string, unknown>) ?? {}
    const next: UIBlock = { ...cb }
    const dt = d.type as string
    if (dt === "text_delta") next.text = (cb.text ?? "") + ((d.text as string) ?? "")
    else if (dt === "thinking_delta")
      next.text = (cb.text ?? "") + ((d.thinking as string) ?? "")
    else if (dt === "input_json_delta") {
      const partial =
        ((cb as UIBlock & { _partialJson?: string })._partialJson ?? "") +
        ((d.partial_json as string) ?? "")
      ;(next as UIBlock & { _partialJson?: string })._partialJson = partial
    }
    blocks[i] = next
    entries[idx] = { ...cur, blocks }
    return { entries }
  }

  if (t === "content_block_stop") {
    const i = typeof inner.index === "number" ? inner.index : blocks.length - 1
    const cb = blocks[i]
    if (!cb) return state
    const next: UIBlock = { ...cb, partial: false }
    const partial = (cb as UIBlock & { _partialJson?: string })._partialJson
    if (partial && next.type === "tool_use") {
      try {
        next.toolInput = JSON.parse(partial)
      } catch {
        // 保留原始 partial 字符串
      }
    }
    if (next.type === "thinking") next.endedAt = ts
    blocks[i] = next
    entries[idx] = { ...cur, blocks }
    return { entries }
  }

  if (t === "message_delta") {
    const stopReason = (inner.delta as Record<string, unknown> | undefined)
      ?.stop_reason as string | undefined
    const usage = inner.usage as Record<string, unknown> | undefined
    entries[idx] = {
      ...cur,
      stopReason: stopReason ?? cur.stopReason,
      usage: usage ?? cur.usage
    }
    return { entries }
  }

  if (t === "message_stop") {
    entries[idx] = { ...cur, streaming: false, stopTs: ts }
    return { entries }
  }

  return state
}

// CLI 在每个 content_block_stop 后会发一个完整 assistant 快照（中间快照）。
// 命中已存在 streaming UIMessage 时，只合并 content / model / usage / stopReason，
// 保持 streaming 状态——真正的关闭由 stream_event message_stop 决定。
function reduceAssistant(state: State, ev: Record<string, unknown>, ts: number): State {
  const msg = (ev.message as Record<string, unknown>) ?? {}
  const id = msg.id as string | undefined
  const blocks = convertContentBlocks(msg.content)
  // jsonl 历史路径：用消息 ts 给 thinking/tool_use 块当 startedAt
  for (const b of blocks) {
    if ((b.type === "thinking" || b.type === "tool_use") && !b.startedAt) {
      b.startedAt = ts
    }
  }
  if (id) {
    const idx = findMessageIdx(state.entries, id)
    if (idx >= 0) {
      const cur = state.entries[idx] as UIMessage
      const replaced: UIMessage = {
        ...cur,
        blocks,
        model: (msg.model as string | undefined) ?? cur.model,
        usage: (msg.usage as Record<string, unknown> | undefined) ?? cur.usage,
        stopReason:
          (msg.stop_reason as string | null | undefined) ?? cur.stopReason ?? null,
        streaming: cur.streaming
      }
      const next = state.entries.slice()
      next[idx] = replaced
      return { entries: next }
    }
  }
  const entry: UIMessage = {
    kind: "message",
    id: id ?? `asst-${state.entries.length}`,
    role: "assistant",
    blocks,
    model: msg.model as string | undefined,
    usage: msg.usage as Record<string, unknown> | undefined,
    stopReason: (msg.stop_reason as string | null | undefined) ?? null,
    streaming: false,
    ts
  }
  return { entries: [...state.entries, entry] }
}

// user 事件常携带顶级 tool_use_result（结构化 file/structuredPatch/originalFile/type 等）
// 把它附着到对应 tool_result block 上，供 UI 做 diff 渲染。
// 同时把结束时间写回上游 assistant 消息中对应 toolUseId 的 tool_use 块（用于显示耗时）。
function reduceUser(state: State, ev: Record<string, unknown>, ts: number): State {
  // jsonl 中 CLI 注入的 system-reminder 标记为 isMeta:true，不展示给用户
  if (ev.isMeta === true) return state
  const msg = (ev.message as Record<string, unknown>) ?? {}
  const blocks = normalizeUserBlocks(convertContentBlocks(msg.content))
  if (isInternalCommandBlocks(blocks)) return state
  if (blocks.length === 0) return state
  // CLI 在 stream-json 模式会把发出的 user message 原样 echo 回来。协同模式发出的
  // 内容带有一段固定 prefix（见 src/App.tsx:buildCollaborationPrompt），UI 上只展示
  // 用户原文，不展示协同规则样板。
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      const stripped = stripCollabPrefix(b.text)
      if (stripped !== null) b.text = stripped
    }
  }
  bindImagePlaceholders(blocks)
  const tur = ev.tool_use_result
  if (tur != null) {
    const target = blocks.find((b) => b.type === "tool_result")
    if (target) {
      target.toolUseResult = tur
    }
  }
  let entries = state.entries
  for (const b of blocks) {
    if (b.type === "tool_result" && b.toolUseId) {
      entries = stampToolEndedAt(entries, b.toolUseId, ts)
    }
  }
  const entry: UIMessage = {
    kind: "message",
    id: (msg.id as string) ?? `user-${state.entries.length}`,
    role: "user",
    blocks,
    streaming: false,
    ts
  }
  return { entries: [...entries, entry] }
}

// 把 user 消息文本中的 [Image #N] 序号占位与同条消息的 image content block 按出现顺序
// 一一配对（角标 / lightbox alt 用 #N，与文中字样所见即所得）。
// `[Image: source: <path>]` 这种含本地路径形态只做剥离，不计入配对（CLI 常和 #N 并列出现，
// 同一张图配 2 个占位会错位）。fallback 用 basename。
// 与 src/App.tsx 的 COLLAB_PREFIX_TAG 与 COLLAB_PROMPT_SEPARATOR 保持一致。
const COLLAB_PREFIX_TAG = "[Claudinal 协同模式]"
const COLLAB_PROMPT_SEPARATOR = "\n\n用户需求：\n"
const LOCAL_COMMAND_CAVEAT_PREFIX =
  "Caveat: The messages below were generated by the user while running local commands.".toLowerCase()

function isInternalGeneratedEvent(ev: ClaudeEvent): boolean {
  if (!ev || typeof ev !== "object") return false
  const obj = ev as Record<string, unknown>
  // 子代理 transcript 是 Claude 内部 Task 会话，不应作为主聊天内容展示。
  if (obj.isSidechain === true) return true
  if (obj.isMeta === true) return true
  return false
}

function normalizeUserBlocks(blocks: UIBlock[]): UIBlock[] {
  const out: UIBlock[] = []
  for (const block of blocks) {
    if (block.type !== "text") {
      out.push(block)
      continue
    }
    const text = stripInternalTextSections(block.text)
    if (!text.trim()) continue
    out.push(...splitUploadedFileText(text))
  }
  return out
}

function stripInternalTextSections(text: string | undefined): string {
  if (!text) return ""
  let cleaned = text
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
  cleaned = cleaned.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
  cleaned = cleaned.replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, "")
  return cleaned.replace(/\n{3,}/g, "\n\n").trim()
}

function isInternalCommandText(text: string): boolean {
  const trimmed = text.trimStart()
  const lower = trimmed.toLowerCase()
  if (lower.startsWith(LOCAL_COMMAND_CAVEAT_PREFIX)) return true
  const opening = trimmed.match(
    /^<(command-name|command-message|command-args|local-command-[a-z0-9-]+|bash-(?:input|stdout|stderr)|system-reminder|task-notification|local-command-caveat)>/i
  )
  if (!opening) return false
  return lower.includes(`</${opening[1].toLowerCase()}>`)
}

function isInternalCommandBlocks(blocks: UIBlock[]): boolean {
  if (blocks.length === 0) return false
  let sawInternal = false
  for (const block of blocks) {
    if (block.type !== "text" || typeof block.text !== "string") return false
    if (!block.text.trim()) continue
    if (!isInternalCommandText(block.text)) return false
    sawInternal = true
  }
  return sawInternal
}

function stripCollabPrefix(text: string): string | null {
  if (!text.startsWith(COLLAB_PREFIX_TAG)) return null
  const idx = text.indexOf(COLLAB_PROMPT_SEPARATOR)
  if (idx < 0) return null
  return text.slice(idx + COLLAB_PROMPT_SEPARATOR.length).trim()
}

function bindImagePlaceholders(blocks: UIBlock[]) {
  const numbered: string[] = []
  const sourceBasenames: string[] = []
  const numberedRe = /\[Image\s+#(\d+)\]/gi
  const sourceRe = /\[Image\s*:\s*source\s*:\s*([^\]]+)\]/gi
  for (const b of blocks) {
    if (b.type !== "text" || !b.text) continue
    let m: RegExpExecArray | null
    while ((m = numberedRe.exec(b.text)) !== null) numbered.push(m[1])
    numberedRe.lastIndex = 0
    while ((m = sourceRe.exec(b.text)) !== null) {
      const raw = m[1].trim()
      const base = raw.replace(/\\/g, "/").split("/").pop() ?? raw
      sourceBasenames.push(base)
    }
    sourceRe.lastIndex = 0
    // 剥离含本地路径的形态（保留 [Image #N] 让用户能与角标对照）
    b.text = b.text.replace(sourceRe, "").trim()
  }
  let ni = 0
  let si = 0
  for (const b of blocks) {
    if (b.type !== "image") continue
    if (ni < numbered.length) {
      b.imageAlt = `#${numbered[ni++]}`
    } else if (si < sourceBasenames.length) {
      b.imageAlt = sourceBasenames[si++]
    }
  }
}

function stampToolEndedAt(entries: UIEntry[], toolUseId: string, ts: number): UIEntry[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind !== "message") continue
    const m = e as UIMessage
    const idx = m.blocks.findIndex(
      (b) => b.type === "tool_use" && b.toolUseId === toolUseId
    )
    if (idx < 0) continue
    if (m.blocks[idx].endedAt) return entries
    const nextBlocks = m.blocks.slice()
    nextBlocks[idx] = { ...nextBlocks[idx], endedAt: ts }
    const next = entries.slice()
    next[i] = { ...m, blocks: nextBlocks } as UIMessage
    return next
  }
  return entries
}

function reduceResult(state: State, ev: Record<string, unknown>, ts: number): State {
  return {
    entries: [
      ...state.entries,
      {
        kind: "result",
        subtype: ev.subtype as string | undefined,
        result: ev.result as string | undefined,
        totalCostUsd: ev.total_cost_usd as number | undefined,
        durationMs: ev.duration_ms as number | undefined,
        durationApiMs: ev.duration_api_ms as number | undefined,
        numTurns: ev.num_turns as number | undefined,
        isError: ev.is_error as boolean | undefined,
        stopReason: ev.stop_reason as string | undefined,
        modelUsage: ev.modelUsage as Record<string, unknown> | undefined,
        permissionDenials: ev.permission_denials as unknown[] | undefined,
        ts
      }
    ]
  }
}

function reduceHook(state: State, ev: Record<string, unknown>, ts: number): State {
  const hookEventName =
    (ev.hook_event_name as string | undefined) ??
    (ev.hookEventName as string | undefined) ??
    (ev.event as string | undefined)
  const toolName =
    (ev.tool_name as string | undefined) ??
    (ev.toolName as string | undefined)
  return {
    entries: [
      ...state.entries,
      { kind: "hook", hookEventName, toolName, raw: ev, ts }
    ]
  }
}

function reduceRateLimit(state: State, ev: Record<string, unknown>, ts: number): State {
  const info = (ev.rate_limit_info as Record<string, unknown>) ?? {}
  return {
    entries: [
      ...state.entries,
      {
        kind: "rate_limit",
        rateLimitType: info.rateLimitType as string | undefined,
        resetsAt: info.resetsAt as number | undefined,
        status: info.status as string | undefined,
        ts
      }
    ]
  }
}

function findStreamingIdx(entries: UIEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === "message" && (e as UIMessage).streaming) return i
  }
  return -1
}

function findMessageIdx(entries: UIEntry[], id: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === "message" && (e as UIMessage).id === id) return i
  }
  return -1
}

function convertContentBlocks(content: unknown): UIBlock[] {
  if (!Array.isArray(content)) {
    if (typeof content === "string") return [{ type: "text", text: content }]
    return []
  }
  return (content as ContentBlock[]).map((c) => {
    const obj = c as unknown as Record<string, unknown>
    const t = obj.type as string | undefined
    if (t === "text") return { type: "text", text: obj.text as string }
    if (t === "thinking") return { type: "thinking", text: obj.thinking as string }
    if (t === "image") {
      const src = (obj.source as Record<string, unknown>) ?? {}
      return {
        type: "image",
        imageMediaType: src.media_type as string | undefined,
        imageData: src.data as string | undefined
      }
    }
    if (t === "tool_use") {
      return {
        type: "tool_use",
        toolName: obj.name as string | undefined,
        toolInput: obj.input,
        toolUseId: obj.id as string | undefined
      }
    }
    if (t === "tool_result") {
      return {
        type: "tool_result",
        toolUseId: obj.tool_use_id as string | undefined,
        toolResultContent: obj.content,
        isError: obj.is_error as boolean | undefined
      }
    }
    return { type: "unknown", raw: c }
  })
}

function appendUnknown(state: State, ev: ClaudeEvent, ts: number): State {
  return { entries: [...state.entries, { kind: "unknown", raw: ev, ts }] }
}
