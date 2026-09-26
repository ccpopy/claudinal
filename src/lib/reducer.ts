import type { ClaudeEvent, ContentBlock } from "../types/events"
import type { UIBlock, UIEntry, UIMessage } from "../types/ui"
import { splitUploadedFileText } from "./fileAttachments"
import {
  initSubagentRegistry,
  settleSubagentRegistryForResume,
  reduceSubagentRegistry,
  subagentCycleReadyForFinal,
  truncateSubagentRegistry,
  type SubagentRegistry,
  type SubagentResultDisposition
} from "./subagents"

export interface State {
  entries: UIEntry[]
  hiddenStream?: boolean
  /** 已隐藏中断协议消息，等待对应 result 到达并归一成 interrupted。 */
  pendingInterruption: boolean
  subagents: SubagentRegistry
}

export type Action =
  | { kind: "event"; event: ClaudeEvent }
  | {
      kind: "user_local"
      blocks: UIBlock[]
      delivery?: UIMessage["delivery"]
      rawText?: string
      localId?: string
      ts?: number
    }
  | { kind: "delivery_changed"; messageId: string; state: UIMessage["deliveryState"] }
  | { kind: "runtime_exited" }
  | { kind: "truncate_after_message"; messageId: string }
  | { kind: "load_transcript"; events: ClaudeEvent[] }
  | { kind: "replace_state"; state: State }
  | { kind: "reset" }

export function init(): State {
  return {
    entries: [],
    pendingInterruption: false,
    subagents: initSubagentRegistry()
  }
}

export function reduce(state: State, action: Action): State {
  if (action.kind === "delivery_changed") {
    return { ...state, entries: state.entries.map((entry) => entry.kind === "message" && entry.id === action.messageId
      ? { ...entry, deliveryState: action.state !== "responded" && (entry.deliveryState === "acknowledged" || entry.deliveryState === "responded") ? entry.deliveryState : action.state } : entry) }
  }
  if (action.kind === "runtime_exited") {
    return { ...state, hiddenStream: false, pendingInterruption: false, subagents: settleSubagentRegistryForResume(state.subagents), entries: closeStreamingEntries(state.entries, Date.now()).map((entry) => entry.kind === "message"
      ? { ...entry, streaming: false, deliveryState: entry.deliveryState === "writing" || entry.deliveryState === "awaiting_ack" ? "delivery_unknown" : entry.deliveryState } : entry) }
  }
  if (action.kind === "reset") return init()
  if (action.kind === "replace_state") return action.state
  if (action.kind === "truncate_after_message") {
    const idx = state.entries.findIndex(
      (entry) => entry.kind === "message" && entry.id === action.messageId
    )
    if (idx < 0) return state
    const cutoffTs = state.entries[idx]?.ts ?? Date.now()
    return {
      entries: state.entries.slice(0, idx),
      hiddenStream: false,
      pendingInterruption: false,
      subagents: truncateSubagentRegistry(state.subagents, cutoffTs)
    }
  }
  if (action.kind === "user_local") {
    const ts = action.ts ?? Date.now()
    const msg: UIMessage = {
      kind: "message",
      id: action.localId ?? `local-${state.entries.length}-${ts}`,
      role: "user",
      blocks: action.blocks,
      rawText: action.rawText,
      streaming: false,
      delivery: action.delivery,
      deliveryState: "writing",
      ts
    }
    if (state.entries.some((entry) => entry.kind === "message" && entry.id === msg.id)) return state
    return {
      ...state,
      entries: [...state.entries, msg],
      pendingInterruption: false
    }
  }
  if (action.kind === "load_transcript") {
    let s: State = init()
    for (const ev of action.events) {
      const t = (ev as { type?: string }).type
      // queue-operation 本身不进入消息流，但其中的 task-notification
      // 是异步 Agent 生命周期的权威完成信号，必须先归一后再隐藏。
      if (t === "queue-operation") {
        s = reduceEvent(s, ev)
        continue
      }
      // 过滤 jsonl 内部事件：queue-operation / attachment / ai-title
      if (
        t === "attachment" ||
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
      ...s,
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
  if (!ev || typeof ev !== "object") return state
  const ts = parseTs(ev)
  const t = (ev as { type?: string }).type
  const subagentTransition = reduceSubagentRegistry(state.subagents, ev)
  if (subagentTransition.changed) {
    state = { ...state, subagents: subagentTransition.registry }
  }
  if ((ev as Record<string, unknown>).parent_tool_use_id) return state
  if (t === "queue-operation") return state
  if (isMetaSkillPromptEvent(ev)) return removeLeakedSkillMetaPrompt(state)
  if (isInterruptionArtifactEvent(state, ev)) {
    return {
      ...state,
      pendingInterruption: latestTurnResultIsInterrupted(state.entries)
        ? state.pendingInterruption
        : true
    }
  }
  if (isInternalGeneratedEvent(ev)) return state
  // GUI 软中断写入的 interrupt control_request 会让 CLI 在 stdout 回一条
  // control_response 回执：纯协议事件，显式忽略，避免落进 unknown 渲染脏行
  if (t === "control_response") return state

  if (t === "system") return reduceSystem(state, ev as Record<string, unknown>, ts)
  if (t === "stream_event")
    return reduceStreamEvent(state, (ev as Record<string, unknown>).event, ts)
  if (t === "assistant") return reduceAssistant(state, ev as Record<string, unknown>, ts)
  if (t === "user") return reduceUser(state, ev as Record<string, unknown>, ts)
  if (t === "attachment")
    return reduceAttachment(state, ev as Record<string, unknown>, ts)
  if (t === "result")
    return reduceResult(
      state,
      ev as Record<string, unknown>,
      ts,
      subagentTransition.resultDisposition
    )
  if (t === "rate_limit_event")
    return reduceRateLimit(state, ev as Record<string, unknown>, ts)
  if (t === "hook_event" || t === "hook")
    return reduceHook(state, ev as Record<string, unknown>, ts)
  if (t === "raw") {
    return {
      ...state,
      entries: [...state.entries, { kind: "raw", line: (ev as { line?: string }).line, ts }]
    }
  }
  if (t === "stderr") {
    return {
      ...state,
      entries: [
        ...state.entries,
        { kind: "stderr", line: (ev as { line?: string }).line ?? "", ts }
      ]
    }
  }
  return appendUnknown(state, ev, ts)
}

function reduceAttachment(state: State, ev: Record<string, unknown>, ts: number): State {
  const attachment = ev.attachment as Record<string, unknown> | undefined
  if (attachment?.type === "queued_command") return state
  return appendUnknown(state, ev as ClaudeEvent, ts)
}

function eventStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}
function hasDiagnostics(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : !!value && (typeof value !== "object" || Object.keys(value).length > 0)
}

function reduceSystem(state: State, ev: Record<string, unknown>, ts: number): State {
  const sub = ev.subtype as string | undefined
  if (sub === "init") {
    return {
      ...state,
      entries: [
        ...state.entries,
        {
          kind: "system_init",
          sessionId: ev.session_id as string | undefined,
          model: ev.model as string | undefined,
          requestedModel: ev.requested_model as string | undefined,
          cwd: ev.cwd as string | undefined,
          permissionMode: ev.permissionMode as string | undefined,
          mcpServers:
            Array.isArray(ev.mcp_servers) ? ev.mcp_servers.filter((server): server is { name: string; status: string } => !!server && typeof server.name === "string" && typeof server.status === "string") : [],
          tools: eventStrings(ev.tools),
          skills: eventStrings(ev.skills),
          slashCommands: eventStrings(ev.slash_commands),
          agents: eventStrings(ev.agents),
          version: ev.claude_code_version as string | undefined,
          outputStyle: ev.output_style as string | undefined,
          apiKeySource: ev.apiKeySource as string | undefined,
          fastModeState: ev.fast_mode_state as string | undefined,
          ts
        },
        ...((hasDiagnostics(ev.mcp_server_errors) || hasDiagnostics(ev.plugin_errors)) ? [{ kind: "stderr" as const, line: `部分扩展未加载：${JSON.stringify({ mcp: ev.mcp_server_errors, plugins: ev.plugin_errors })}`, ts }] : [])
      ]
    }
  }
  if (sub === "status" || sub === "api_retry") {
    return {
      ...state,
      entries: [
        ...state.entries,
        { kind: "system_status", status: sub === "api_retry" ? `CLI 正在恢复连接${typeof ev.attempt === "number" ? `（第 ${ev.attempt} 次）` : ""}` : (ev.status as string) ?? "", ts }
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
    const role = msg.role as "user" | "assistant" | undefined
    if (role !== "assistant") {
      return { ...state, hiddenStream: true }
    }
    const entry: UIMessage = {
      kind: "message",
      id: (msg.id as string) ?? `stream-${state.entries.length}`,
      role,
      blocks: [],
      model: msg.model as string | undefined,
      usage: msg.usage as Record<string, unknown> | undefined,
      stopReason: null,
      streaming: true,
      ts
    }
    return { ...state, entries: [...state.entries, entry], hiddenStream: false }
  }

  if (state.hiddenStream) {
    if (t === "message_stop") return { ...state, hiddenStream: false }
    return state
  }

  const idx = findStreamingIdx(state.entries)
  if (idx < 0) return state
  const entries = state.entries.slice()
  const cur = entries[idx] as UIMessage
  const blocks = cur.blocks.slice()

  if (t === "content_block_start") {
    const cb = (inner.content_block as Record<string, unknown>) ?? {}
    const blkType = (cb.type as string) ?? "unknown"
    if (blkType === "text" && isSkillMetaPromptText(cb.text as string | undefined)) {
      return removeStreamingMessageAndHide(state)
    }
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
    return { ...state, entries }
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
    if (next.type === "text" && isSkillMetaPromptText(next.text)) {
      return removeStreamingMessageAndHide(state)
    }
    blocks[i] = next
    entries[idx] = { ...cur, blocks }
    return { ...state, entries }
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
    return { ...state, entries }
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
    return { ...state, entries }
  }

  if (t === "message_stop") {
    entries[idx] = { ...cur, streaming: false, stopTs: ts }
    return { ...state, entries }
  }

  return state
}

// CLI 在每个 content_block_stop 后会发一个完整 assistant 快照（中间快照）。
// 命中已存在 streaming UIMessage 时，只合并 content / model / usage / stopReason，
// 保持 streaming 状态——真正的关闭由 stream_event message_stop 决定。
function reduceAssistant(state: State, ev: Record<string, unknown>, ts: number): State {
  const msg = (ev.message as Record<string, unknown>) ?? {}
  const id = msg.id as string | undefined
  const apiError = ev.isApiErrorMessage === true
  const backgroundActivity =
    state.subagents.cycleActive && !subagentCycleReadyForFinal(state.subagents)
  const blocks = convertContentBlocks(msg.content)
  // jsonl 历史路径：用消息 ts 给 thinking/tool_use 块当 startedAt
  for (const b of blocks) {
    if ((b.type === "thinking" || b.type === "tool_use") && !b.startedAt) {
      b.startedAt = ts
    }
  }
  const idx = id
    ? findMergeableAssistantIdx(state.entries, id)
    : findStreamingIdx(state.entries)
  if (idx >= 0) {
    const cur = state.entries[idx] as UIMessage
    const reconciled: UIMessage = {
      ...cur,
      transcriptUuid: (ev.uuid as string | undefined) ?? cur.transcriptUuid,
      // Claude CLI may persist one assistant message id across several records,
      // while compatibility gateways can emit a stale snapshot after newer deltas.
      // Reconcile monotonically so a snapshot cannot erase visible content.
      blocks: reconcileAssistantBlocks(cur.blocks, blocks),
      model: (msg.model as string | undefined) ?? cur.model,
      usage: (msg.usage as Record<string, unknown> | undefined) ?? cur.usage,
      stopReason:
        (msg.stop_reason as string | null | undefined) ?? cur.stopReason ?? null,
      apiError: apiError || cur.apiError,
      backgroundActivity,
      streaming: cur.streaming
    }
    const next = state.entries.slice()
    next[idx] = reconciled
    return { ...state, entries: next }
  }
  const entry: UIMessage = {
    kind: "message",
    transcriptUuid: ev.uuid as string | undefined,
    id: id ?? `asst-${state.entries.length}`,
    role: "assistant",
    blocks,
    model: msg.model as string | undefined,
    usage: msg.usage as Record<string, unknown> | undefined,
    stopReason: (msg.stop_reason as string | null | undefined) ?? null,
    apiError: apiError || undefined,
    backgroundActivity: backgroundActivity || undefined,
    streaming: false,
    ts
  }
  return { ...state, entries: [...state.entries, entry] }
}

// user 事件常携带顶级 tool_use_result（结构化 file/structuredPatch/originalFile/type 等）
// 把它附着到对应 tool_result block 上，供 UI 做 diff 渲染。
// 同时把结束时间写回上游 assistant 消息中对应 toolUseId 的 tool_use 块（用于显示耗时）。
function reduceUser(state: State, ev: Record<string, unknown>, ts: number): State {
  // jsonl 中 CLI 注入的 system-reminder 标记为 isMeta:true，不展示给用户
  if (ev.isMeta === true) return state
  const uuid = typeof ev.uuid === "string" ? ev.uuid : undefined
  if (uuid && state.entries.some((entry) => entry.kind === "message" && entry.role === "user" && entry.id === uuid)) {
    return { ...state, entries: state.entries.map((entry) => entry.kind === "message" && entry.id === uuid ? { ...entry, deliveryState: entry.deliveryState === "responded" ? "responded" : "acknowledged" } : entry) }
  }
  const msg = (ev.message as Record<string, unknown>) ?? {}
  const blocks = normalizeUserBlocks(convertContentBlocks(msg.content))
  if (blocks.length === 0) return state
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
    id: (ev.uuid as string) ?? (msg.id as string) ?? `user-${state.entries.length}`,
    role: "user",
    rawText: typeof msg.content === "string" ? msg.content : undefined,
    blocks,
    streaming: false,
    ts
  }
  return {
    ...state,
    entries: [...entries, entry],
    pendingInterruption: blocks.some((block) => block.type !== "tool_result")
      ? false
      : state.pendingInterruption
  }
}

// 把 user 消息文本中的 [Image #N] 序号占位与同条消息的 image content block 按出现顺序
// 一一配对（角标 / lightbox alt 用 #N，与文中字样所见即所得）。
// `[Image: source: <path>]` 这种含本地路径形态只做剥离，不计入配对（CLI 常和 #N 并列出现，
// 同一张图配 2 个占位会错位）。fallback 用 basename。
const SKILL_META_PROMPT_PREFIX = "Base directory for this skill:"
const INTERRUPTED_USER_SENTINEL = "[Request interrupted by user]"
const NO_RESPONSE_SENTINEL = "No response requested."

function isInternalGeneratedEvent(ev: ClaudeEvent): boolean {
  if (!ev || typeof ev !== "object") return false
  const obj = ev as Record<string, unknown>
  // 子代理 transcript 是 Claude 内部 Task 会话，不应作为主聊天内容展示。
  if (obj.isSidechain === true) return true
  if (obj.isMeta === true) return true
  return isNoResponseAssistantEvent(obj)
}

function soleTextOf(ev: Record<string, unknown>): string | undefined {
  const msg = (ev.message as Record<string, unknown> | undefined) ?? {}
  const blocks = convertContentBlocks(msg.content)
  return blocks.length === 1 && blocks[0].type === "text"
    ? blocks[0].text?.trim()
    : undefined
}

function isExactInterruptionUserEvent(obj: Record<string, unknown>): boolean {
  if (obj.type !== "user") return false
  const msg = (obj.message as Record<string, unknown> | undefined) ?? {}
  return msg.role === "user" && soleTextOf(obj) === INTERRUPTED_USER_SENTINEL
}

/** 带完整 SDK 元数据的 CLI 中断协议 user 事件。 */
function isSdkInterruptionUserEvent(obj: Record<string, unknown>): boolean {
  return (
    isExactInterruptionUserEvent(obj) &&
    typeof obj.promptId === "string" &&
    obj.userType === "external" &&
    obj.entrypoint === "sdk-cli"
  )
}

function isAuthoredUserMessage(entry: UIEntry): entry is UIMessage {
  return (
    entry.kind === "message" &&
    entry.role === "user" &&
    entry.blocks.some((block) => block.type !== "tool_result")
  )
}

/**
 * 当前是否存在尚未出现终止 assistant/result 的真实用户回合。
 * 这让 live 事件即使缺少 promptId 等可选 SDK 元数据，也能安全识别中断哨兵；
 * 已完成回合之后用户真的输入同名字面量时则保留原文。
 */
function hasUnresolvedUserTurn(entries: UIEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === "result") return false
    if (
      entry.kind === "message" &&
      entry.role === "assistant" &&
      entry.stopReason != null &&
      entry.stopReason !== "tool_use"
    ) {
      return false
    }
    if (isAuthoredUserMessage(entry)) return true
  }
  return false
}

function latestTurnResultIsInterrupted(entries: UIEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (isAuthoredUserMessage(entry)) return false
    if (entry.kind === "result") return entry.terminalReason === "interrupted"
  }
  return false
}

function isInterruptionArtifactEvent(state: State, ev: ClaudeEvent): boolean {
  if (!ev || typeof ev !== "object") return false
  const obj = ev as Record<string, unknown>
  if (!isExactInterruptionUserEvent(obj)) return false
  return (
    isSdkInterruptionUserEvent(obj) ||
    hasUnresolvedUserTurn(state.entries) ||
    latestTurnResultIsInterrupted(state.entries)
  )
}

/** 取消回合时 CLI 合成的 assistant 事件（"No response requested."），无信息量，直接丢弃。 */
function isNoResponseAssistantEvent(ev: Record<string, unknown>): boolean {
  if (ev.type !== "assistant") return false
  const msg = (ev.message as Record<string, unknown> | undefined) ?? {}
  if (msg.role !== "assistant") return false
  const model =
    typeof msg.model === "string"
      ? msg.model.split(/\s+/).join("").toLowerCase()
      : ""
  const stopReason = msg.stop_reason
  return (
    model === "<synthetic>" &&
    soleTextOf(ev) === NO_RESPONSE_SENTINEL &&
    (stopReason == null || stopReason === "stop_sequence") &&
    ev.isApiErrorMessage !== true
  )
}

/**
 * 收尾所有残留 streaming 的 assistant 消息（去流式态与块光标）。
 * 兼容网关（DashScope 等）漏发 message_stop 时，result 到达即回合结束，
 * 不收尾的话"思考中…"骨架屏与块尾光标会永远残留。
 */
function closeStreamingEntries(entries: UIEntry[], ts: number): UIEntry[] {
  let changed = false
  const next = entries.map((e) => {
    if (e.kind !== "message") return e
    const m = e as UIMessage
    if (m.role !== "assistant" || !m.streaming) return e
    changed = true
    return {
      ...m,
      streaming: false,
      stopTs: m.stopTs ?? ts,
      blocks: m.blocks.map((b) => (b.partial ? { ...b, partial: false } : b))
    } as UIMessage
  })
  return changed ? next : entries
}

function isSkillMetaPromptText(text: string | undefined): boolean {
  return text?.trimStart().startsWith(SKILL_META_PROMPT_PREFIX) === true
}

function isMetaSkillPromptEvent(ev: ClaudeEvent): boolean {
  if (!ev || typeof ev !== "object") return false
  const obj = ev as Record<string, unknown>
  if (obj.type !== "user" || (obj.isMeta !== true && typeof obj.sourceToolUseID !== "string")) return false
  const msg = (obj.message as Record<string, unknown> | undefined) ?? {}
  return convertContentBlocks(msg.content).some(
    (block) => block.type === "text" && isSkillMetaPromptText(block.text)
  )
}

function removeLeakedSkillMetaPrompt(state: State): State {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i]
    if (entry.kind !== "message" || entry.role === "user") continue
    const hasSkillMeta = entry.blocks.some(
      (block) => block.type === "text" && isSkillMetaPromptText(block.text)
    )
    if (!hasSkillMeta) continue
    const entries = state.entries.slice()
    entries.splice(i, 1)
    return { ...state, entries, hiddenStream: false }
  }
  return { ...state, hiddenStream: false }
}

function removeStreamingMessageAndHide(state: State): State {
  const idx = findStreamingIdx(state.entries)
  if (idx < 0) return { ...state, hiddenStream: true }
  const entries = state.entries.slice()
  entries.splice(idx, 1)
  return { ...state, entries, hiddenStream: true }
}

function normalizeUserBlocks(blocks: UIBlock[]): UIBlock[] {
  const out: UIBlock[] = []
  for (const block of blocks) {
    if (block.type !== "text") {
      out.push(block)
      continue
    }
    const text = block.text ?? ""
    if (!text.trim()) continue
    out.push(...splitUploadedFileText(text))
  }
  return out
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
    // Preserve authored text; image labels are presentation metadata only.
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

/**
 * live result 可能先于 transcript 中断哨兵到达。停止请求仍在途时先写入统一终态，
 * 让 reducer、sidecar 与重载后的展示使用同一语义，同时保留原始 is_error 字段。
 */
export function markInterruptedResult(
  event: ClaudeEvent,
  interrupting: boolean
): ClaudeEvent {
  if (!interrupting || (event as { type?: string }).type !== "result") return event
  return { ...event, terminal_reason: "interrupted" }
}

function reduceResult(
  state: State,
  ev: Record<string, unknown>,
  ts: number,
  disposition: SubagentResultDisposition
): State {
  // 网关漏发 message_stop 时这里兜底收尾残留 streaming 消息
  const entries = closeStreamingEntries(state.entries, ts).filter((entry) => entry.kind !== "system_status" || !entry.status.startsWith("CLI 正在恢复"))
  // Claude CLI 的异步 Agent 会让前台 assistant turn 暂时结束并发出 result，
  // 随后再由 task-notification 唤醒主会话。此时 result 只是等待边界：
  // 收掉块级流式光标，但不插入“完成”卡，也不切断同一 RunGroup。
  if (disposition === "intermediate") {
    return {
      ...state,
      entries,
      hiddenStream: false,
      pendingInterruption: false
    }
  }
  const assistantStopReason = latestAssistantStopReason(entries)
  const eventStopReason = ev.stop_reason as string | undefined
  const stopReason =
    assistantStopReason === "max_tokens"
      ? assistantStopReason
      : (eventStopReason ?? assistantStopReason)
  const terminalReason = state.pendingInterruption
    ? "interrupted"
    : (ev.terminal_reason as string | undefined)
  return {
    ...state,
    entries: [
      ...entries,
      {
        kind: "result",
        subtype: ev.subtype as string | undefined,
        result: ev.result as string | undefined,
        // 部分兼容网关把错误详情放在 error 字段而非 result
        error: typeof ev.error === "string" ? ev.error : undefined,
        totalCostUsd: ev.total_cost_usd as number | undefined,
        durationMs: ev.duration_ms as number | undefined,
        durationApiMs: ev.duration_api_ms as number | undefined,
        numTurns: ev.num_turns as number | undefined,
        isError: ev.is_error as boolean | undefined,
        stopReason,
        terminalReason,
        hasApiErrorMessage: hasApiErrorMessageSinceLastResult(entries) || undefined,
        modelUsage: ev.modelUsage as Record<string, unknown> | undefined,
        permissionDenials: ev.permission_denials as unknown[] | undefined,
        ts
      }
    ],
    hiddenStream: false,
    pendingInterruption: false
  }
}

function latestAssistantStopReason(entries: UIEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === "result") return undefined
    if (
      entry.kind === "message" &&
      entry.role === "assistant" &&
      entry.stopReason
    ) {
      return entry.stopReason
    }
  }
  return undefined
}

function hasApiErrorMessageSinceLastResult(entries: UIEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === "result") return false
    if (entry.kind === "message" && entry.role === "assistant" && entry.apiError) {
      return true
    }
  }
  return false
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
    ...state,
    entries: [
      ...state.entries,
      { kind: "hook", hookEventName, toolName, raw: ev, ts }
    ]
  }
}

function reduceRateLimit(state: State, ev: Record<string, unknown>, ts: number): State {
  const info = (ev.rate_limit_info as Record<string, unknown>) ?? {}
  return {
    ...state,
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
    if (
      e.kind === "message" &&
      (e as UIMessage).role === "assistant" &&
      (e as UIMessage).streaming
    )
      return i
  }
  return -1
}

function findMergeableAssistantIdx(entries: UIEntry[], id: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === "result") return -1
    if (e.kind !== "message") continue
    const message = e as UIMessage
    if (message.role === "user") return -1
    return message.id === id ? i : -1
  }
  return -1
}

function reconcileAssistantBlocks(current: UIBlock[], incoming: UIBlock[]): UIBlock[] {
  const out = current
    .filter((block) => !(block.type === "unknown" && block.raw === undefined))
    .map((block) => ({ ...block }))
  const matchedUnkeyed = new Set<number>()
  const keyed = new Map<string, number>()

  for (let i = 0; i < out.length; i++) {
    const key = assistantBlockKey(out[i])
    if (key) keyed.set(key, i)
  }

  for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex++) {
    const nextBlock = incoming[incomingIndex]
    const key = assistantBlockKey(nextBlock)
    if (key) {
      const existingIndex = keyed.get(key)
      if (existingIndex !== undefined) {
        out[existingIndex] = mergeAssistantBlock(out[existingIndex], nextBlock)
      } else {
        keyed.set(key, out.length)
        out.push({ ...nextBlock })
      }
      continue
    }

    let existingIndex = -1
    if (
      incomingIndex < out.length &&
      !matchedUnkeyed.has(incomingIndex) &&
      compatibleAssistantBlocks(out[incomingIndex], nextBlock)
    ) {
      existingIndex = incomingIndex
    } else {
      existingIndex = out.findIndex(
        (block, index) =>
          !matchedUnkeyed.has(index) && compatibleAssistantBlocks(block, nextBlock)
      )
    }

    if (existingIndex >= 0) {
      out[existingIndex] = mergeAssistantBlock(out[existingIndex], nextBlock)
      matchedUnkeyed.add(existingIndex)
    } else {
      out.push({ ...nextBlock })
      matchedUnkeyed.add(out.length - 1)
    }
  }
  return out
}

function assistantBlockKey(block: UIBlock): string | null {
  if ((block.type === "tool_use" || block.type === "tool_result") && block.toolUseId) {
    return `${block.type}:${block.toolUseId}`
  }
  return null
}

function compatibleAssistantBlocks(current: UIBlock, incoming: UIBlock): boolean {
  if (current.type !== incoming.type) return false
  if (current.type === "text" || current.type === "thinking") {
    const currentText = current.text ?? ""
    const incomingText = incoming.text ?? ""
    return currentText.startsWith(incomingText) || incomingText.startsWith(currentText)
  }
  if (current.type === "image") {
    return (
      current.imageMediaType === incoming.imageMediaType &&
      current.imageData === incoming.imageData
    )
  }
  return false
}

function mergeAssistantBlock(current: UIBlock, incoming: UIBlock): UIBlock {
  const merged: UIBlock = { ...current, ...incoming }
  if (current.type === incoming.type && (current.type === "text" || current.type === "thinking")) {
    const currentText = current.text ?? ""
    const incomingText = incoming.text ?? ""
    merged.text = incomingText.length >= currentText.length ? incomingText : currentText
  }
  if (current.type === "tool_use" && incoming.type === "tool_use") {
    merged.toolName = incoming.toolName ?? current.toolName
    merged.toolInput = mergeMonotonicToolValue(current.toolInput, incoming.toolInput)
  }
  if (current.type === "tool_result" && incoming.type === "tool_result") {
    merged.toolResultContent = mergeMonotonicToolValue(
      current.toolResultContent,
      incoming.toolResultContent
    )
    merged.toolUseResult = incoming.toolUseResult ?? current.toolUseResult
    merged.isError = incoming.isError ?? current.isError
  }
  merged.startedAt = current.startedAt ?? incoming.startedAt
  merged.endedAt = incoming.endedAt ?? current.endedAt
  return merged
}

function mergeMonotonicToolValue(current: unknown, incoming: unknown): unknown {
  if (incoming === undefined) return current
  if (current === undefined) return incoming
  if (typeof current === "string" && typeof incoming === "string") {
    if (current.startsWith(incoming) || incoming.startsWith(current)) {
      return incoming.length >= current.length ? incoming : current
    }
    return incoming
  }
  if (Array.isArray(current) && Array.isArray(incoming)) {
    return incoming.length >= current.length ? incoming : current
  }
  if (isPlainRecord(current) && isPlainRecord(incoming)) {
    const merged: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = mergeMonotonicToolValue(current[key], value)
    }
    return merged
  }
  return incoming
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function convertContentBlocks(content: unknown): UIBlock[] {
  if (!Array.isArray(content)) {
    if (typeof content === "string") return [{ type: "text", text: content }]
    return []
  }
  return (content as ContentBlock[]).map((c) => {
    if (!c || typeof c !== "object") return { type: "unknown", raw: c }
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
    if (t === "document") {
      const source = (obj.source as Record<string, unknown>) ?? {}
      return { type: "attachment", attachmentName: typeof obj.title === "string" ? obj.title : "document.pdf",
        attachmentMime: typeof source.media_type === "string" ? source.media_type : "application/pdf",
        attachmentSize: typeof source.data === "string" ? Math.floor(source.data.length * 3 / 4) : undefined,
        attachmentContentMode: "document" }
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
  if (state.entries.filter((entry) => entry.kind === "unknown").length >= 100) return state
  const raw = JSON.stringify(ev)
  return {
    ...state,
    entries: [...state.entries, { kind: "unknown", raw: raw.length > 8192 ? raw.slice(0, 8192) : ev, ts }]
  }
}
