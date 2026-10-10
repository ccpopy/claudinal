import type { SubmissionActions } from "./SubmittedInputActions"
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, MessageSquareDashed } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import {
  chatTimelinePreview,
  chatTimelineRoleLabel,
  formatTimelineTime
} from "@/lib/chatTimeline"
import { restoreTimelineAnchor, timelineScrollAnchor, timelineWindow, type TimelineGeometry } from "@/lib/timelineGeometry"
import type { ReviewRunDiff } from "@/lib/diff"
import { matchReviewsToResults } from "@/lib/diff"
import type { SubagentTask } from "@/lib/subagents"
import type { UIBlock, UIEntry, UIMessage } from "@/types/ui"
import { ChatTimelineNav, type ChatTimelineItem } from "./ChatTimelineNav"
import { MessageCard } from "./MessageCard"
import { RunGroup, type RunStep } from "./RunGroup"
import { RunReviewCard } from "./RunReviewCard"
import { FoldReveal } from "@/lib/foldState"
import { entryMatchesTarget, type TranscriptNavigationRequest, type TranscriptTarget } from "@/lib/transcriptNavigation"

interface Props {
  submissionActions?: SubmissionActions
  onOpenPermissions?: () => void
  onRewindMessage?: (message: UIMessage) => void
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
  navigationRequest?: TranscriptNavigationRequest | null
  onNavigationSettled?: (requestId: string, found: boolean) => void
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
const MemoMessageCard = memo(MessageCard)
const visibleMessageCache = new WeakMap<UIMessage, UIMessage>()

function visibleMessage(message: UIMessage, blocks: UIBlock[]): UIMessage {
  if (blocks.length === message.blocks.length && blocks.every((block, i) => block === message.blocks[i])) return message
  let visible = visibleMessageCache.get(message)
  if (!visible) {
    visible = { ...message, blocks }
    visibleMessageCache.set(message, visible)
  }
  return visible
}

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

  const ensureRun = (startTs?: number, sourceId?: string): RunPlaceholder => {
    if (state.current) {
      if (startTs && !state.current.startTs) state.current.startTs = startTs
      return state.current
    }
    const r: RunPlaceholder = {
      kind: "run",
      key: sourceId ? `run-${sourceId}` : `run-${state.counter++}`,
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
    const duplicate = text ? run.steps.find(
        (existing) =>
          existing.block.type === "text" && existing.block.text?.trim() === text
      ) : undefined
    if (duplicate) {
      if (step.messageId) duplicate.sourceMessageIds = [...(duplicate.sourceMessageIds ?? []), step.messageId]
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
        appendStep(state.current, { key: `${e.kind}-${e.id}`, block, messageId: e.id, messageUuid: e.kind === "activity" ? e.eventId : undefined })
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
          const run = ensureRun(undefined, m.id)
          for (let k = 0; k < toolResults.length; k++) {
            appendStep(run, {
              key: `${m.id}-tr-${k}`,
              block: toolResults[k], messageId: m.id, messageUuid: m.transcriptUuid
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
              msg: visibleMessage(m, userVisible)
            })
            continue
          }
          if (m.deliveryState && ["preparing", "needs_confirmation", "queued", "paused", "cancelled", "failed", "delivery_unknown"].includes(m.deliveryState)) {
            groups.push({ kind: "msg", key: `msg-${m.id}`, msg: visibleMessage(m, userVisible) }); continue
          }
          if (state.current) state.current.running = false
          state.current = null
          groups.push({
            kind: "msg",
            key: `msg-${m.id}`,
            msg: visibleMessage(m, userVisible)
          })
          // 立即开一个新的 run，给"处理中…"占位让用户可见秒表
          ensureRun(m.ts, m.id)
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
          const run = ensureRun(undefined, m.id)
          for (let k = 0; k < stepBlocks.length; k++) {
            appendStep(run, {
              key: `${m.id}-st-${k}`,
              block: stepBlocks[k], messageId: m.id, messageUuid: m.transcriptUuid
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
            msg: visibleMessage(m, visibleBlocks)
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

export function resolveGroupNavigation(groups: Group[], target: TranscriptTarget): { groupKey: string; stepKey?: string } | null {
  const candidates: Array<{ groupKey: string; stepKey?: string; text: string }> = []
  const searchText = (block: UIBlock) => block.type === "tool_use" ? `[tool] ${block.toolName ?? ""}` : block.text ?? ""
  for (const group of groups) {
    if (group.kind === "msg" && entryMatchesTarget(group.msg, target)) candidates.push({ groupKey: group.key, text: group.msg.blocks.map(searchText).join("\n") })
    if (group.kind === "entry" && entryMatchesTarget(group.entry, target)) candidates.push({ groupKey: group.key, text: group.entry.kind === "activity" ? group.entry.blocks.map(searchText).join("\n") : "" })
    if (group.kind !== "run") continue
    const matches = group.steps.filter((step) => target.toolUseId
      ? step.block.type === "tool_use" && step.block.toolUseId === target.toolUseId
      : (target.messageId !== undefined && (step.messageId === target.messageId || step.sourceMessageIds?.includes(target.messageId)))
        || (target.messageUuid !== undefined && step.messageUuid === target.messageUuid))
    for (const step of matches) candidates.push({ groupKey: group.key, stepKey: step.key, text: searchText(step.block) })
  }
  const terms = [...(target.snippet ?? "").matchAll(/<<<([\s\S]*?)>>>/g)].map((match) => match[1].toLocaleLowerCase())
  // A single assistant record can split into folded thinking and a final reply.
  // Search evidence chooses across every visual candidate for that identity.
  const selected = candidates.find((candidate) => terms.length > 0 && terms.every((term) => candidate.text.toLocaleLowerCase().includes(term))) ?? candidates[0]
  return selected ? { groupKey: selected.groupKey, ...(selected.stepKey ? { stepKey: selected.stepKey } : {}) } : null
}

export function MessageStream({
  submissionActions,
  onOpenPermissions,
  onRewindMessage,
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
  slashCommands,
  navigationRequest,
  onNavigationSettled
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const timelineTargetRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const timelineRefCallbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>())
  const geometryRef = useRef<TimelineGeometry[]>([])
  const geometryDirtyRef = useRef(true)
  const geometryIdsKeyRef = useRef("")
  const observerRef = useRef<ResizeObserver | null>(null)
  const trackingFrameRef = useRef<number | null>(null)
  const trackingGenerationRef = useRef(0)
  const updateTimelineStateRef = useRef<() => void>(() => {})
  const pinnedToBottomRef = useRef(true)
  const activeTimelineIdRef = useRef<string | null>(null)
  const visibleTimelineIdsKeyRef = useRef("")
  const [pinnedToBottom, setPinnedToBottom] = useState(true)
  const [activeTimelineId, setActiveTimelineId] = useState<string | null>(null)
  const [visibleTimelineIds, setVisibleTimelineIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [timelineVisible, setTimelineVisible] = useState(false)
  const scheduleTimelineUpdate = useCallback(() => {
    if (trackingFrameRef.current !== null) return
    const generation = trackingGenerationRef.current
    trackingFrameRef.current = requestAnimationFrame(() => {
      if (generation !== trackingGenerationRef.current) return
      trackingFrameRef.current = null
      updateTimelineStateRef.current()
    })
  }, [])

  const groups = useMemo(() => buildGroups(entries, streaming), [entries, streaming])
  const navigation = useMemo(() => navigationRequest ? resolveGroupNavigation(groups, navigationRequest.target) : null, [groups, navigationRequest])
  const navigationSettledRef = useRef<string | null>(null)
  const onNavigationSettledRef = useRef(onNavigationSettled)
  onNavigationSettledRef.current = onNavigationSettled

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
    const validIds = new Set(groups.map((group) => group.key))
    for (const id of timelineTargetRefs.current.keys()) {
      if (!validIds.has(id)) timelineTargetRefs.current.delete(id)
    }
    for (const id of timelineRefCallbacks.current.keys()) {
      if (!validIds.has(id)) timelineRefCallbacks.current.delete(id)
    }
    if (!activeTimelineIdRef.current || !validIds.has(activeTimelineIdRef.current)) {
      const next = timelineItems[0]?.id ?? null
      activeTimelineIdRef.current = next
      setActiveTimelineId(next)
    }
  }, [timelineItems, groups])

  const getTimelineTargetRef = useCallback(
    (id: string) => {
      let callback = timelineRefCallbacks.current.get(id)
      if (!callback) {
        callback = (node) => {
          const previous = timelineTargetRefs.current.get(id)
          if (previous === node) return
          if (previous) observerRef.current?.unobserve(previous)
          if (node) {
            timelineTargetRefs.current.set(id, node)
            observerRef.current?.observe(node)
          } else timelineTargetRefs.current.delete(id)
          geometryDirtyRef.current = true
        }
        timelineRefCallbacks.current.set(id, callback)
      }
      return callback
    },
    []
  )

  const updateTimelineState = useCallback(() => {
    const el = ref.current
    const viewport = el?.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    if (!viewport) return
    const viewportHeight = viewport.clientHeight
    if (geometryDirtyRef.current) {
      const anchor = timelineScrollAnchor(geometryRef.current, viewport.scrollTop)
      const viewportRect = viewport.getBoundingClientRect()
      const top = viewport.scrollTop
      geometryRef.current = timelineItems.flatMap((item) => {
        const target = timelineTargetRefs.current.get(item.id)
        if (!target) return []
        const rect = target.getBoundingClientRect()
        return [{ id: item.id, top: rect.top - viewportRect.top + top, height: rect.height }]
      })
      geometryDirtyRef.current = false
      if (autoScroll && pinnedToBottomRef.current) viewport.scrollTop = viewport.scrollHeight
      else {
        const restored = restoreTimelineAnchor(geometryRef.current, anchor)
        if (restored !== null) viewport.scrollTop = restored
      }
    }
    const { activeId: next, visibleIds: nextVisibleIds } = timelineWindow(geometryRef.current, viewport.scrollTop, viewportHeight)
    setTimelineVisible(viewport.scrollHeight > viewportHeight)
    const nextVisibleKey = nextVisibleIds.join("\u0000")
    if (nextVisibleKey !== visibleTimelineIdsKeyRef.current) {
      visibleTimelineIdsKeyRef.current = nextVisibleKey
      setVisibleTimelineIds(new Set(nextVisibleIds))
    }
    if (next === activeTimelineIdRef.current) return
    activeTimelineIdRef.current = next
    setActiveTimelineId(next)
  }, [timelineItems, autoScroll])

  useLayoutEffect(() => {
    updateTimelineStateRef.current = updateTimelineState
    const idsKey = timelineItems.map((item) => item.id).join("\u0000")
    if (idsKey !== geometryIdsKeyRef.current) {
      geometryIdsKeyRef.current = idsKey
      geometryDirtyRef.current = true
    }
    // Preserve the reader's anchor before painting a changed transcript.
    updateTimelineState()
  }, [updateTimelineState])

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
      if (autoScroll) {
        pinnedToBottomRef.current = distance < 32
        setPinnedToBottom(pinnedToBottomRef.current)
      }
      scheduleTimelineUpdate()
    }
    viewport.addEventListener("scroll", onScroll, { passive: true })
    const content = el.querySelector<HTMLElement>("[data-message-stream-content]")
    const invalidate = () => {
      geometryDirtyRef.current = true
      scheduleTimelineUpdate()
    }
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(invalidate)
    observerRef.current = observer
    observer?.observe(viewport)
    if (content) observer?.observe(content)
    for (const target of timelineTargetRefs.current.values()) observer?.observe(target)
    window.addEventListener("resize", invalidate)
    scheduleTimelineUpdate()
    return () => {
      viewport.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", invalidate)
      observer?.disconnect()
      observerRef.current = null
      trackingGenerationRef.current++
      if (trackingFrameRef.current !== null) cancelAnimationFrame(trackingFrameRef.current)
      trackingFrameRef.current = null
    }
  }, [autoScroll, scheduleTimelineUpdate, entries.length === 0])

  const scrollToBottom = () => {
    const el = ref.current
    const viewport = el?.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    pinnedToBottomRef.current = true
    setPinnedToBottom(true)
    scheduleTimelineUpdate()
  }

  useEffect(() => {
    if (!autoScroll || !pinnedToBottom) return
    scrollToBottom()
  }, [entries, streaming, autoScroll, pinnedToBottom])

  const scrollToTarget = useCallback((id: string, target: HTMLElement, behavior: ScrollBehavior) => {
    const el = ref.current
    const viewport = el?.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    if (!viewport || !target) return
    pinnedToBottomRef.current = false
    setPinnedToBottom(false)
    viewport.scrollTo({
      top: Math.max(target.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 24, 0),
      behavior
    })
    activeTimelineIdRef.current = id
    setActiveTimelineId(id)
    target.focus({ preventScroll: true })
  }, [])

  const scrollToTimelineItem = useCallback((id: string) => {
    const target = timelineTargetRefs.current.get(id)
    if (target) scrollToTarget(id, target, "smooth")
  }, [scrollToTarget])

  useLayoutEffect(() => {
    if (!navigationRequest || navigationSettledRef.current === navigationRequest.id) return
    pinnedToBottomRef.current = false
    setPinnedToBottom(false)
    // Parent run and its nested folds mount during this commit. Wait until both
    // are laid out before measuring; cleanup invalidates old session requests.
    let secondFrame: number | null = null
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const group = navigation ? timelineTargetRefs.current.get(navigation.groupKey) : null
        const step = navigation?.stepKey && group
          ? [...group.querySelectorAll<HTMLElement>("[data-navigation-step]")].find((node) => node.dataset.navigationStep === navigation.stepKey) : null
        const target = navigation?.stepKey ? step : group
        if (target && navigation) {
          geometryDirtyRef.current = true
          updateTimelineStateRef.current()
          scrollToTarget(navigation.groupKey, target, "instant")
          scheduleTimelineUpdate()
        }
        navigationSettledRef.current = navigationRequest.id
        onNavigationSettledRef.current?.(navigationRequest.id, !!target)
      })
    })
    return () => { cancelAnimationFrame(firstFrame); if (secondFrame !== null) cancelAnimationFrame(secondFrame) }
  }, [navigationRequest, navigation?.groupKey, navigation?.stepKey, scrollToTarget, scheduleTimelineUpdate])

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
    <ScrollArea ref={ref} className="relative flex-1 min-h-0 overflow-hidden" viewportClassName="[overflow-anchor:none]">
      <div
        data-message-stream-content
        className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6 xl:max-w-4xl 2xl:max-w-5xl"
      >
        {groups.map((g) => {
          if (g.kind === "msg") {
            return (
              <div
                key={g.key}
                ref={getTimelineTargetRef(g.key)}
                data-timeline-target={g.key}
                tabIndex={-1}
                className="scroll-mt-6 rounded-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <FoldReveal requestId={navigation?.groupKey === g.key ? navigationRequest?.id : undefined}>
                <MemoMessageCard
                  submissionActions={submissionActions}
                  entry={g.msg}
                  cwd={cwd}
                  retryableMessageIds={retryableMessageIds}
                  slashCommands={slashCommands}
                  onRetryMessage={onRetryMessage}
                  onOpenPermissions={onOpenPermissions}
                  onRewindMessage={onRewindMessage}
                />
                </FoldReveal>
              </div>
            )
          }
          if (g.kind === "run") {
            return (
              <div key={g.key} ref={getTimelineTargetRef(g.key)} data-navigation-group={g.key}>
              <RunGroup
                steps={g.steps}
                running={g.running}
                cwd={cwd}
                durationMs={g.durationMs}
                startTs={g.startTs}
                endTs={g.endTs}
                pendingSubagentCount={g.running ? pendingSubagentCount : 0}
                subagents={subagents}
                onOpenSubagent={onOpenSubagent}
                navigation={navigation?.groupKey === g.key && navigation.stepKey && navigationRequest
                  ? { requestId: navigationRequest.id, stepKey: navigation.stepKey } : undefined}
              />
              </div>
            )
          }
          if (g.entry.kind === "result") {
            const review = matchedReviews[reviewIndex++]
            return (
              <div key={g.key}>
                <MemoMessageCard
                  submissionActions={submissionActions}
                  entry={g.entry}
                  cwd={cwd}
                  retryableMessageIds={retryableMessageIds}
                  slashCommands={slashCommands}
                  onRetryMessage={onRetryMessage}
                  onOpenPermissions={onOpenPermissions}
                  onRewindMessage={onRewindMessage}
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
            <div key={g.key} ref={getTimelineTargetRef(g.key)} tabIndex={-1} className="rounded-sm focus:outline-none focus:ring-2 focus:ring-primary/40">
            <FoldReveal requestId={navigation?.groupKey === g.key ? navigationRequest?.id : undefined}>
            <MemoMessageCard
                  submissionActions={submissionActions}
              key={g.key}
              entry={g.entry}
              cwd={cwd}
              retryableMessageIds={retryableMessageIds}
              slashCommands={slashCommands}
              onRetryMessage={onRetryMessage}
                  onOpenPermissions={onOpenPermissions}
              onRewindMessage={onRewindMessage}
            />
            </FoldReveal>
            </div>
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
