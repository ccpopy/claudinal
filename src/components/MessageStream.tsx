import type { SubmissionActions } from "./SubmittedInputActions"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, MessageSquareDashed } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import {
  chatTimelinePreview,
  chatTimelineRoleLabel,
  formatTimelineTime,
  timelineTargetIntersectsViewport
} from "@/lib/chatTimeline"
import type { ReviewRunDiff } from "@/lib/diff"
import { matchReviewsToResults } from "@/lib/diff"
import type { SubagentTask } from "@/lib/subagents"
import type { UIBlock, UIEntry, UIMessage } from "@/types/ui"
import { ChatTimelineNav, type ChatTimelineItem } from "./ChatTimelineNav"
import { MessageCard } from "./MessageCard"
import { RunGroup, type RunStep } from "./RunGroup"
import { RunReviewCard } from "./RunReviewCard"

interface Props {
  submissionActions?: SubmissionActions
  onOpenPermissions?: () => void
  entries: UIEntry[]
  streaming: boolean
  cwd?: string | null
  /** 默认 true：每次 entries / streaming 变化把 viewport 滚到底部（直播会话用）。
   *  传 false 表示纯只读预览（如归档预览），从顶部开始让用户自行下滚。 */
  autoScroll?: boolean
  reviews?: ReviewRunDiff[]
  onShowDiff?: (review: ReviewRunDiff, path?: string) => void
  retryableMessageIds?: ReadonlySet<string>
  onRetryMessage?: (messageId: string) => void | Promise<void>
  pendingSubagentCount?: number
  subagents?: SubagentTask[]
  onOpenSubagent?: (agentId: string) => void
  /** 当前会话可用的 slash 命令，用于把用户消息开头的命令渲染成 chip */
  slashCommands?: readonly string[]
}

interface MsgGroup {
  kind: "msg"
  key: string
  msg: UIMessage
}
interface RunPlaceholder {
  kind: "run"
  key: string
  steps: RunStep[]
  running: boolean
  durationMs?: number
  startTs?: number
  endTs?: number
}
interface EntryGroup {
  kind: "entry"
  key: string
  entry: UIEntry
}
type Group = MsgGroup | RunPlaceholder | EntryGroup

function isProgressAssistantMessage(message: UIMessage): boolean {
  return (
    message.backgroundActivity === true ||
    message.stopReason === "tool_use" ||
    message.blocks.some((block) => block.type === "tool_use") ||
    (message.streaming && message.stopReason !== "end_turn")
  )
}

function resultFinalText(
  entry: Extract<UIEntry, { kind: "result" }>
): string | null {
  if (
    entry.isError === true ||
    entry.terminalReason === "api_error" ||
    entry.terminalReason === "interrupted" ||
    entry.subtype?.startsWith("error")
  ) {
    return null
  }
  const text = entry.result?.trim()
  return text || null
}

export function buildGroups(entries: UIEntry[], liveStreaming: boolean): Group[] {
  const groups: Group[] = []
  const state: {
    current: RunPlaceholder | null
    counter: number
    hasFinalAssistantText: boolean
  } = {
    current: null,
    counter: 0,
    hasFinalAssistantText: false
  }

  const ensureRun = (startTs?: number): RunPlaceholder => {
    if (state.current) {
      if (startTs && !state.current.startTs) state.current.startTs = startTs
      return state.current
    }
    const r: RunPlaceholder = {
      kind: "run",
      key: `run-${state.counter++}`,
      steps: [],
      running: true,
      startTs
    }
    groups.push(r)
    state.current = r
    return r
  }

  const stamp = (entryTs?: number) => {
    if (!entryTs || !state.current) return
    if (!state.current.endTs || entryTs > state.current.endTs) {
      state.current.endTs = entryTs
    }
  }

  const appendStep = (run: RunPlaceholder, step: RunStep) => {
    const text = step.block.type === "text" ? step.block.text?.trim() : null
    if (
      text &&
      run.steps.some(
        (existing) =>
          existing.block.type === "text" && existing.block.text?.trim() === text
      )
    ) {
      return
    }
    run.steps.push(step)
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.kind === "skill_load" || e.kind === "activity") {
      const block: UIBlock = e.kind === "skill_load"
        ? { type: "skill_load", skill: e, toolUseId: e.toolUseId }
        : { type: "activity", activity: e }
      if (state.current) {
        appendStep(state.current, { key: `${e.kind}-${e.id}`, block })
        stamp(e.ts)
      } else {
        // Notifications between turns are completed records, not a new run.
        groups.push({ kind: "entry", key: `${e.kind}-${e.id}`, entry: e })
      }
    } else if (e.kind === "message") {
      const m = e as UIMessage
      if (m.role === "user") {
        const toolResults: UIBlock[] = []
        const userVisible: UIBlock[] = []
        for (const b of m.blocks) {
          if (!b) continue
          if (b.type === "tool_result") toolResults.push(b)
          else userVisible.push(b)
        }
        if (toolResults.length > 0) {
          const run = ensureRun()
          for (let k = 0; k < toolResults.length; k++) {
            appendStep(run, {
              key: `${m.id}-tr-${k}`,
              block: toolResults[k]
            })
          }
          stamp(m.ts)
        }
        if (userVisible.length > 0) {
          state.hasFinalAssistantText = false
          if (m.delivery === "guide") {
            groups.push({
              kind: "msg",
              key: `msg-${m.id}`,
              msg: { ...m, blocks: userVisible }
            })
            continue
          }
          if (m.deliveryState && ["preparing", "needs_confirmation", "queued", "paused", "cancelled", "failed", "delivery_unknown"].includes(m.deliveryState)) {
            groups.push({ kind: "msg", key: `msg-${m.id}`, msg: { ...m, blocks: userVisible } }); continue
          }
          if (state.current) state.current.running = false
          state.current = null
          groups.push({
            kind: "msg",
            key: `msg-${m.id}`,
            msg: { ...m, blocks: userVisible }
          })
          // 立即开一个新的 run，给"处理中…"占位让用户可见秒表
          ensureRun(m.ts)
        }
      } else {
        const stepBlocks: UIBlock[] = []
        const visibleBlocks: UIBlock[] = []
        const progressMessage = isProgressAssistantMessage(m)
        for (const b of m.blocks) {
          if (!b) continue
          if (
            b.type === "thinking" ||
            b.type === "tool_use" ||
            (b.type === "text" && progressMessage)
          ) {
            stepBlocks.push(b)
          } else visibleBlocks.push(b)
        }
        if (stepBlocks.length > 0) {
          const run = ensureRun()
          for (let k = 0; k < stepBlocks.length; k++) {
            appendStep(run, {
              key: `${m.id}-st-${k}`,
              block: stepBlocks[k]
            })
          }
        }
        // assistant 消息（含末尾 text 段）也算入当前轮的 endTs
        // 优先 stopTs（message_stop 时间），其次 ts（message_start 时间）
        stamp(m.stopTs ?? m.ts)
        if (visibleBlocks.length > 0) {
          if (
            visibleBlocks.some(
              (block) => block.type === "text" && !!block.text?.trim()
            )
          ) {
            state.hasFinalAssistantText = true
          }
          groups.push({
            kind: "msg",
            key: `msg-${m.id}`,
            msg: { ...m, blocks: visibleBlocks }
          })
        }
      }
    } else if (e.kind === "result") {
      const cur = state.current
      if (cur) {
        cur.running = false
        cur.durationMs = e.durationMs
        if (e.ts && (!cur.endTs || e.ts > cur.endTs)) cur.endTs = e.ts
      }
      const fallbackText = state.hasFinalAssistantText ? null : resultFinalText(e)
      if (fallbackText) {
        groups.push({
          kind: "msg",
          key: `result-final-${i}`,
          msg: {
            kind: "message",
            id: `result-final-${i}`,
            role: "assistant",
            blocks: [{ type: "text", text: fallbackText }],
            stopReason: "end_turn",
            streaming: false,
            ts: e.ts
          }
        })
      }
      groups.push({ kind: "entry", key: `result-${i}`, entry: e })
      state.current = null
      state.hasFinalAssistantText = false
    } else {
      // 其它 entry（system_init / stderr / raw / unknown）只渲染，不拉宽 endTs
      groups.push({ kind: "entry", key: `entry-${i}-${e.kind}`, entry: e })
    }
  }

  // 顶层不再 streaming（用户停止 / 已加载历史会话）→ 残留 run 视为完成
  if (!liveStreaming && state.current) {
    state.current.running = false
  }

  return groups
}

export function MessageStream({
  submissionActions,
  onOpenPermissions,
  entries,
  streaming,
  cwd,
  autoScroll = true,
  reviews = [],
  onShowDiff,
  retryableMessageIds,
  onRetryMessage,
  pendingSubagentCount = 0,
  subagents = [],
  onOpenSubagent,
  slashCommands
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const timelineTargetRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const activeTimelineIdRef = useRef<string | null>(null)
  const visibleTimelineIdsKeyRef = useRef("")
  const [pinnedToBottom, setPinnedToBottom] = useState(true)
  const [activeTimelineId, setActiveTimelineId] = useState<string | null>(null)
  const [visibleTimelineIds, setVisibleTimelineIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [timelineVisible, setTimelineVisible] = useState(false)

  const groups = useMemo(() => buildGroups(entries, streaming), [entries, streaming])

  // 审查 diff 归位：旧版按顺位 reviews[n] 配第 n 个 result，resume CLI 跑过的
  // 会话时（result 数 > review 数）会把 review 错挂到最早的 result 上；改为
  // 数量一致保持顺位、不一致按 createdAt 时间归位（见 matchReviewsToResults）。
  const matchedReviews = useMemo(() => {
    const resultTs: number[] = []
    for (const g of groups) {
      if (g.kind === "entry" && g.entry.kind === "result") {
        resultTs.push(g.entry.ts)
      }
    }
    return matchReviewsToResults(resultTs, reviews)
  }, [groups, reviews])

  const timelineItems = useMemo<ChatTimelineItem[]>(
    () =>
      groups.flatMap((g) =>
        g.kind === "msg"
          ? [
              {
                id: g.key,
                role: g.msg.role,
                label: chatTimelineRoleLabel(g.msg.role, g.msg.delivery),
                preview: chatTimelinePreview(g.msg),
                time: formatTimelineTime(g.msg.stopTs ?? g.msg.ts)
              }
            ]
          : []
      ),
    [groups]
  )

  useEffect(() => {
    const validIds = new Set(timelineItems.map((item) => item.id))
    for (const id of timelineTargetRefs.current.keys()) {
      if (!validIds.has(id)) timelineTargetRefs.current.delete(id)
    }
    if (!activeTimelineIdRef.current || !validIds.has(activeTimelineIdRef.current)) {
      const next = timelineItems[0]?.id ?? null
      activeTimelineIdRef.current = next
      setActiveTimelineId(next)
    }
  }, [timelineItems])

  const setTimelineTargetRef = useCallback(
    (id: string, node: HTMLDivElement | null) => {
      if (node) {
        timelineTargetRefs.current.set(id, node)
      } else {
        timelineTargetRefs.current.delete(id)
      }
    },
    []
  )

  const updateTimelineState = useCallback(() => {
    const el = ref.current
    const viewport = el?.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    if (!viewport || timelineItems.length === 0) return
    const viewportTop = viewport.scrollTop
    const viewportHeight = viewport.clientHeight
    const anchorTop = viewportTop + viewportHeight * 0.32
    const nextVisibleIds: string[] = []
    let next = timelineItems[0].id
    let passedAnchor = false
    for (const item of timelineItems) {
      const target = timelineTargetRefs.current.get(item.id)
      if (!target) continue
      if (
        timelineTargetIntersectsViewport(
          target.offsetTop,
          target.offsetHeight,
          viewportTop,
          viewportHeight
        )
      ) {
        nextVisibleIds.push(item.id)
      }
      if (!passedAnchor && target.offsetTop <= anchorTop) {
        next = item.id
      } else {
        passedAnchor = true
      }
    }
    const nextVisibleKey = nextVisibleIds.join("\u0000")
    if (nextVisibleKey !== visibleTimelineIdsKeyRef.current) {
      visibleTimelineIdsKeyRef.current = nextVisibleKey
      setVisibleTimelineIds(new Set(nextVisibleIds))
    }
    if (next === activeTimelineIdRef.current) return
    activeTimelineIdRef.current = next
    setActiveTimelineId(next)
  }, [timelineItems])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const viewport = el.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    if (!viewport) return
    const onScroll = () => {
      const distance =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      setTimelineVisible(viewport.scrollHeight > viewport.clientHeight)
      if (autoScroll) setPinnedToBottom(distance < 32)
      updateTimelineState()
    }
    viewport.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => viewport.removeEventListener("scroll", onScroll)
  }, [autoScroll, updateTimelineState])

  const scrollToBottom = () => {
    const el = ref.current
    const viewport = el?.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    setPinnedToBottom(true)
    updateTimelineState()
  }

  useEffect(() => {
    if (!autoScroll || !pinnedToBottom) return
    scrollToBottom()
  }, [entries, streaming, autoScroll, pinnedToBottom])

  const scrollToTimelineItem = useCallback((id: string) => {
    const el = ref.current
    const viewport = el?.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    const target = timelineTargetRefs.current.get(id)
    if (!viewport || !target) return
    viewport.scrollTo({
      top: Math.max(target.offsetTop - 24, 0),
      behavior: "smooth"
    })
    activeTimelineIdRef.current = id
    setActiveTimelineId(id)
  }, [])

  if (entries.length === 0) {
    return (
      <div className="flex-1 grid place-items-center text-muted-foreground p-8">
        <div className="flex flex-col items-center gap-2">
          <MessageSquareDashed className="size-12" strokeWidth={1.2} />
          <div className="text-foreground text-base font-medium">就绪</div>
          <div className="text-sm text-center max-w-md">
            输入消息开始对话。
          </div>
        </div>
      </div>
    )
  }

  let reviewIndex = 0
  return (
    <ScrollArea ref={ref} className="relative flex-1 min-h-0 overflow-hidden">
      <div
        data-message-stream-content
        className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6 xl:max-w-4xl 2xl:max-w-5xl"
      >
        {groups.map((g) => {
          if (g.kind === "msg") {
            return (
              <div
                key={g.key}
                ref={(node) => setTimelineTargetRef(g.key, node)}
                data-timeline-target={g.key}
                className="scroll-mt-6"
              >
                <MessageCard
                  submissionActions={submissionActions}
                  entry={g.msg}
                  cwd={cwd}
                  retryableMessageIds={retryableMessageIds}
                  slashCommands={slashCommands}
                  onRetryMessage={onRetryMessage}
                  onOpenPermissions={onOpenPermissions}
                />
              </div>
            )
          }
          if (g.kind === "run") {
            return (
              <RunGroup
                key={g.key}
                steps={g.steps}
                running={g.running}
                cwd={cwd}
                durationMs={g.durationMs}
                startTs={g.startTs}
                endTs={g.endTs}
                pendingSubagentCount={g.running ? pendingSubagentCount : 0}
                subagents={subagents}
                onOpenSubagent={onOpenSubagent}
              />
            )
          }
          if (g.entry.kind === "result") {
            const review = matchedReviews[reviewIndex++]
            return (
              <div key={g.key}>
                <MessageCard
                  submissionActions={submissionActions}
                  entry={g.entry}
                  cwd={cwd}
                  retryableMessageIds={retryableMessageIds}
                  slashCommands={slashCommands}
                  onRetryMessage={onRetryMessage}
                  onOpenPermissions={onOpenPermissions}
                />
                {review && (
                  <RunReviewCard
                    review={review}
                    cwd={cwd}
                    onShowDiff={(path) => onShowDiff?.(review, path)}
                  />
                )}
              </div>
            )
          }
          return (
            <MessageCard
                  submissionActions={submissionActions}
              key={g.key}
              entry={g.entry}
              cwd={cwd}
              retryableMessageIds={retryableMessageIds}
              slashCommands={slashCommands}
              onRetryMessage={onRetryMessage}
                  onOpenPermissions={onOpenPermissions}
            />
          )
        })}
      </div>
      <ChatTimelineNav
        items={timelineVisible ? timelineItems : []}
        activeId={activeTimelineId}
        visibleIds={visibleTimelineIds}
        onSelect={scrollToTimelineItem}
      />
      {autoScroll && !pinnedToBottom && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="跳到底部"
          className="absolute bottom-3 left-1/2 z-10 h-8 -translate-x-1/2 gap-1.5 rounded-full border-border/70 bg-background/85 px-3.5 text-xs shadow-md backdrop-blur-sm transition-colors hover:bg-accent"
          onClick={scrollToBottom}
        >
          {streaming ? (
            <span className="size-1.5 rounded-full bg-connected animate-pulse" />
          ) : (
            <ArrowDown className="size-3.5" />
          )}
          {streaming ? "新内容 · 跳到底部" : "跳到底部"}
        </Button>
      )}
    </ScrollArea>
  )
}
