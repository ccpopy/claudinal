import { useEffect, useMemo, useRef } from "react"
import { MessageSquareDashed } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { UIBlock, UIEntry, UIMessage } from "@/types/ui"
import { MessageCard } from "./MessageCard"
import { RunGroup, type RunStep } from "./RunGroup"

interface Props {
  entries: UIEntry[]
  streaming: boolean
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

export function MessageStream({ entries, streaming }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const viewport = el.querySelector(
      "[data-slot='scroll-area-viewport']"
    ) as HTMLElement | null
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [entries, streaming])

  const groups = useMemo(() => buildGroups(entries, streaming), [entries, streaming])

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

  return (
    <ScrollArea ref={ref} className="flex-1 min-h-0">
      <div className="flex flex-col gap-5 px-6 py-6 max-w-3xl mx-auto w-full">
        {groups.map((g) => {
          if (g.kind === "msg") {
            return <MessageCard key={g.key} entry={g.msg} />
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
          return <MessageCard key={g.key} entry={g.entry} />
        })}
      </div>
    </ScrollArea>
  )
}
