import { useEffect, useRef, useState } from "react"
import { ChevronDown, Loader2 } from "lucide-react"
import type { SubagentTask } from "@/lib/subagents"
import { cn, formatRunDuration } from "@/lib/utils"
import type { UIBlock } from "@/types/ui"
import { BlockView } from "./MessageBlocks"

export interface RunStep {
  key: string
  block: UIBlock
}

interface Props {
  steps: RunStep[]
  running: boolean
  cwd?: string | null
  durationMs?: number
  startTs?: number
  endTs?: number
  pendingSubagentCount?: number
  subagents?: SubagentTask[]
  onOpenSubagent?: (agentId: string) => void
}

function computeRunMs(
  startTs: number | undefined,
  endTs: number | undefined,
  running: boolean,
  now: number
): number {
  if (!startTs) return 0
  const end = running ? now : (endTs ?? now)
  return Math.max(0, end - startTs)
}

export function RunGroup({
  steps,
  running,
  cwd,
  durationMs,
  startTs,
  endTs,
  pendingSubagentCount = 0,
  subagents = [],
  onOpenSubagent
}: Props) {
  const [open, setOpen] = useState<boolean>(running)
  const wasRunning = useRef<boolean>(running)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    if (!wasRunning.current && running) setOpen(true)
    wasRunning.current = running
  }, [running])

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [running])

  const subagentByToolUseId = new Map(
    subagents.flatMap((agent) =>
      agent.toolUseId ? ([[agent.toolUseId, agent]] as const) : []
    )
  )
  // Agent launch metadata is emitted as a tool_result immediately after the
  // Agent tool_use. Once the lifecycle is known, the named Agent link is the
  // useful representation; showing the internal metadata as another generic
  // "工具完成" row only adds noise.
  const visibleSteps = steps.filter(
    (step) =>
      !(
        step.block.type === "tool_result" &&
        step.block.toolUseId &&
        subagentByToolUseId.has(step.block.toolUseId)
      )
  )
  const hasSteps = visibleSteps.length > 0
  if (!hasSteps && !running) return null

  // 时长口径：优先 result.duration_ms（CLI 全程墙钟，含 TTFT 与末尾 text）；
  // 其次 user 消息 ts → 该轮最后一个事件 ts；流式中最后值取 now，与 CLI 对齐
  const total =
    typeof durationMs === "number"
      ? durationMs
      : computeRunMs(startTs, endTs, running, Date.now())

  const hasTime = total > 0
  const stepInfo = hasSteps ? ` · ${visibleSteps.length} 步` : ""
  const subagentInfo =
    running && pendingSubagentCount > 0
      ? ` · ${pendingSubagentCount} 个子智能体`
      : ""
  const label = running
    ? hasTime
      ? `处理中… ${formatRunDuration(total, running)}${stepInfo}${subagentInfo}`
      : `处理中…${subagentInfo}`
    : hasTime
      ? `已处理 ${formatRunDuration(total, running)}${stepInfo}`
      : `已处理${stepInfo || ""}`

  return (
    <div className="self-stretch flex flex-col">
      {hasSteps && (
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="overflow-hidden">
            <div
              className={cn(
                "border-l-2 border-border/70 pl-3 ml-1 space-y-2",
                open && "py-1.5"
              )}
            >
              {visibleSteps.map((s) => {
                const subagent = s.block.toolUseId
                  ? subagentByToolUseId.get(s.block.toolUseId)
                  : undefined
                return (
                  <BlockView
                    key={s.key}
                    role="assistant"
                    block={s.block}
                    variant="activity"
                    cwd={cwd}
                    subagent={subagent}
                    onOpenSubagent={onOpenSubagent}
                  />
                )
              })}
            </div>
          </div>
        </div>
      )}
      <div
        className={cn(
          "w-full",
          hasSteps && (open ? "border-t border-border/60 mt-1" : "border-b border-border/40")
        )}
      >
        <button
          type="button"
          onClick={() => hasSteps && setOpen((v) => !v)}
          disabled={!hasSteps}
          className={cn(
            "inline-flex items-center gap-1.5 text-xs py-1.5 transition-colors",
            hasSteps
              ? "text-muted-foreground hover:text-foreground"
              : "text-muted-foreground/80 cursor-default"
          )}
          aria-expanded={open}
        >
          {running ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <ChevronDown
              className={cn(
                "size-3 transition-transform duration-150",
                open && "rotate-180"
              )}
            />
          )}
          <span>{label}</span>
        </button>
      </div>
    </div>
  )
}
