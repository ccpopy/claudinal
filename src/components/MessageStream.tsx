import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, MessageSquareDashed } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import {
  chatTimelinePreview,
  chatTimelineRoleLabel,
  formatTimelineTime
} from "@/lib/chatTimeline"
import type { ReviewRunDiff } from "@/lib/diff"
import type { UIBlock, UIEntry, UIMessage } from "@/types/ui"
import { ChatTimelineNav, type ChatTimelineItem } from "./ChatTimelineNav"
import { MessageCard } from "./MessageCard"
import { RunGroup, type RunStep } from "./RunGroup"
import { RunReviewCard } from "./RunReviewCard"

interface Props {
  entries: UIEntry[]
  streaming: boolean
  /** 默认 true：每次 entries / streaming 变化把 viewport 滚到底部（直播会话用）。
   *  传 false 表示纯只读预览（如归档预览），从顶部开始让用户自行下滚。 */
  autoScroll?: boolean
  reviews?: ReviewRunDiff[]
  onShowDiff?: () => void
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

function buildGroups(entries: UIEntry[], liveStreaming: boolean): Group[] {
  const groups: Group[] = []
  const state: { current: RunPlaceholder | null; counter: number } = {
    current: null,
    counter: 0
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

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.kind === "message") {
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
            run.steps.push({
              key: `${m.id}-tr-${k}`,
              block: toolResults[k]
            })
          }
          stamp(m.ts)
        }
        if (userVisible.length > 0) {
          if (m.queued) {
            // 已提交给 CLI 的后续 user 消息先挂在当前 run 后面，不关掉当前 run。
            groups.push({
              kind: "msg",
              key: `msg-${m.id}`,
              msg: { ...m, blocks: userVisible }
            })
          } else {
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
        }
      } else {
        const stepBlocks: UIBlock[] = []
        const visibleBlocks: UIBlock[] = []
        for (const b of m.blocks) {
          if (!b) continue
          if (b.type === "thinking" || b.type === "tool_use") stepBlocks.push(b)
          else visibleBlocks.push(b)
        }
        if (stepBlocks.length > 0) {
          const run = ensureRun()
          for (let k = 0; k < stepBlocks.length; k++) {
            run.steps.push({
              key: `${m.id}-st-${k}`,
              block: stepBlocks[k]
            })
          }
        }
        // assistant 消息（含末尾 text 段）也算入当前轮的 endTs
        // 优先 stopTs（message_stop 时间），其次 ts（message_start 时间）
        stamp(m.stopTs ?? m.ts)
        if (visibleBlocks.length > 0) {
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
      groups.push({ kind: "entry", key: `result-${i}`, entry: e })
      state.current = null
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
  entries,
  streaming,
  autoScroll = true,
  reviews = [],
  onShowDiff
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const timelineTargetRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const activeTimelineIdRef = useRef<string | null>(null)
  const [pinnedToBottom, setPinnedToBottom] = useState(true)
  const [activeTimelineId, setActiveTimelineId] = useState<string | null>(null)
  const [timelineVisible, setTimelineVisible] = useState(false)

  const groups = useMemo(() => buildGroups(entries, streaming), [entries, streaming])

  const timelineItems = useMemo<ChatTimelineItem[]>(
    () =>
      groups.flatMap((g) =>
        g.kind === "msg"
          ? [
              {
                id: g.key,
                role: g.msg.role,
                label: chatTimelineRoleLabel(g.msg.role),
                preview: chatTimelinePreview(g.msg),
                time: formatTimelineTime(g.msg.stopTs ?? g.msg.ts),
                queued: g.msg.queued
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

  const updateActiveTimeline = useCallback(() => {
    const el = ref.current
    const viewport = el?.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    if (!viewport || timelineItems.length === 0) return
    const anchorTop = viewport.scrollTop + viewport.clientHeight * 0.32
    let next = timelineItems[0].id
    for (const item of timelineItems) {
      const target = timelineTargetRefs.current.get(item.id)
      if (!target) continue
      if (target.offsetTop <= anchorTop) next = item.id
      else break
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
      updateActiveTimeline()
    }
    viewport.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => viewport.removeEventListener("scroll", onScroll)
  }, [autoScroll, updateActiveTimeline])

  const scrollToBottom = () => {
    const el = ref.current
    const viewport = el?.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    setPinnedToBottom(true)
    updateActiveTimeline()
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
    <ScrollArea ref={ref} className="relative flex-1 min-h-0">
      <div className="flex flex-col gap-5 px-6 py-6 max-w-3xl mx-auto w-full">
        {groups.map((g) => {
          if (g.kind === "msg") {
            return (
              <div
                key={g.key}
                ref={(node) => setTimelineTargetRef(g.key, node)}
                data-timeline-target={g.key}
                className="scroll-mt-6"
              >
                <MessageCard entry={g.msg} />
              </div>
            )
          }
          if (g.kind === "run") {
            return (
              <RunGroup
                key={g.key}
                steps={g.steps}
                running={g.running}
                durationMs={g.durationMs}
                startTs={g.startTs}
                endTs={g.endTs}
              />
            )
          }
          if (g.entry.kind === "result") {
            const review = reviews[reviewIndex++]
            return (
              <div key={g.key}>
                <MessageCard entry={g.entry} />
                {review && (
                  <RunReviewCard review={review} onShowDiff={onShowDiff} />
                )}
              </div>
            )
          }
          return <MessageCard key={g.key} entry={g.entry} />
        })}
      </div>
      <ChatTimelineNav
        items={timelineVisible ? timelineItems : []}
        activeId={activeTimelineId}
        onSelect={scrollToTimelineItem}
      />
      {autoScroll && !pinnedToBottom && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="absolute bottom-3 left-1/2 z-10 h-8 -translate-x-1/2 gap-1 rounded-full bg-background/95 px-3 text-xs shadow"
          onClick={scrollToBottom}
        >
          <ArrowDown className="size-3.5" />
          跳到底部
        </Button>
      )}
    </ScrollArea>
  )
}
