import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import {
  HEART_FRAMES,
  IDLE_SEQUENCE,
  SPEAK_SEQUENCE,
  hashString,
  rollBones,
  renderFrame,
  type Bones,
  type Rarity,
  type Species
} from "@/lib/buddyBones"

// 取消 buddy.md 描述的"账号级稳定 seed"。当前项目无账号级 userId；
// 改为每次 BuddyLoader 挂载随机抽签，并优先接管 index.html 内联已 roll 的同一只，
// 避免主应用加载前后（vite html → React mount）出现物种突变。

interface Reaction {
  text: string
  fading: boolean
}

type TimerRef = { current: number | null }

const RARITY_TONE: Record<Rarity, string> = {
  common: "text-foreground",
  uncommon: "text-connected",
  rare: "text-primary",
  epic: "text-warn",
  legendary: "text-primary [text-shadow:0_0_8px_var(--primary)]"
}

const RARITY_BADGE: Record<Rarity, string> = {
  common: "border-border bg-muted/35 text-foreground/80",
  uncommon: "border-connected/30 bg-connected/10 text-connected",
  rare: "border-primary/30 bg-primary/10 text-primary",
  epic: "border-warn/35 bg-warn/10 text-warn",
  legendary: "border-primary/40 bg-primary/15 text-primary"
}

const RARITY_LABEL: Record<Rarity, string> = {
  common: "普通",
  uncommon: "罕见",
  rare: "稀有",
  epic: "史诗",
  legendary: "传说"
}

const SPECIES_LABEL: Record<Species, string> = {
  cat: "猫",
  duck: "鸭",
  owl: "猫头鹰",
  dragon: "龙",
  robot: "机器人",
  blob: "团子"
}

const PET_REACTIONS = [
  "我在旁边看着。",
  "收到抚摸，继续等结果。",
  "这次加载我盯着。",
  "心情稳定，尾巴不稳定。",
  "我会安静占住这个角落。"
]

interface HandoffSnapshot {
  bones: Bones
  tick: number
}

// 抓取 inline 已 roll 的那只并立即停掉 inline interval，避免 React 接管后重影。
function consumeHandoff(): HandoffSnapshot | null {
  if (typeof window === "undefined") return null
  const handoff = window.__buddyHandoff
  if (!handoff) return null
  const snapshot: HandoffSnapshot = {
    bones: handoff.bones,
    tick: handoff.tick
  }
  try {
    handoff.cleanup()
  } catch {
    // inline 已被替换或异常时忽略
  }
  delete window.__buddyHandoff
  return snapshot
}

function clearTimer(ref: TimerRef) {
  if (ref.current === null) return
  window.clearTimeout(ref.current)
  ref.current = null
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const handleChange = () => setReduced(query.matches)
    handleChange()
    query.addEventListener("change", handleChange)
    return () => query.removeEventListener("change", handleChange)
  }, [])

  return reduced
}

interface Props {
  label?: string
  className?: string
}

export function BuddyLoader({ label = "正在召回会话…", className }: Props) {
  // 优先接管 inline 已经 roll 出来并正在显示的那只；接不到再现抽。
  // useState lazy init 保证 StrictMode 下也只 consume 一次。
  const [handoff] = useState(consumeHandoff)
  const [bones] = useState<Bones>(() => handoff?.bones ?? rollBones())
  const initialTick = handoff?.tick ?? 0
  const reducedMotion = usePrefersReducedMotion()
  const [tick, setTick] = useState(initialTick)
  const [heartIdx, setHeartIdx] = useState<number | null>(null)
  const [reaction, setReaction] = useState<Reaction | null>(null)
  const heartTimerRef = useRef<number | null>(null)
  const reactionFadeTimerRef = useRef<number | null>(null)
  const reactionClearTimerRef = useRef<number | null>(null)
  const petCountRef = useRef(0)

  const showReaction = useCallback(
    (text: string) => {
      clearTimer(reactionFadeTimerRef)
      clearTimer(reactionClearTimerRef)
      setReaction({ text, fading: false })

      if (!reducedMotion) {
        reactionFadeTimerRef.current = window.setTimeout(() => {
          setReaction((current) =>
            current ? { ...current, fading: true } : current
          )
        }, 7000)
      }

      reactionClearTimerRef.current = window.setTimeout(() => {
        setReaction(null)
        reactionClearTimerRef.current = null
      }, 10000)
    },
    [reducedMotion]
  )

  const triggerHeart = useCallback(
    (showBubble: boolean) => {
      clearTimer(heartTimerRef)
      setHeartIdx(0)

      if (showBubble) {
        petCountRef.current += 1
        const reactionIndex =
          hashString(`${bones.species}:${petCountRef.current}`) %
          PET_REACTIONS.length
        showReaction(PET_REACTIONS[reactionIndex]!)
      }

      if (reducedMotion) {
        heartTimerRef.current = window.setTimeout(() => {
          setHeartIdx(null)
          heartTimerRef.current = null
        }, 900)
        return
      }

      let nextFrame = 1
      const step = () => {
        if (nextFrame >= HEART_FRAMES.length) {
          setHeartIdx(null)
          heartTimerRef.current = null
          return
        }
        setHeartIdx(nextFrame)
        nextFrame += 1
        heartTimerRef.current = window.setTimeout(step, 140)
      }
      heartTimerRef.current = window.setTimeout(step, 140)
    },
    [bones.species, reducedMotion, showReaction]
  )

  // 接管成功时不再播挂载心动效（inline 已经在显示 idle 的同一只），避免突兀；
  // 没有 handoff 时（独立路由触发的二次挂载）才打个招呼。
  useEffect(() => {
    if (handoff) return
    triggerHeart(false)
  }, [handoff, triggerHeart])

  const excited = heartIdx !== null || reaction !== null

  useEffect(() => {
    if (reducedMotion) return
    const delay = excited ? 260 : 500
    const id = window.setInterval(() => {
      setTick((current) => (current + 1) % 1000)
    }, delay)
    return () => window.clearInterval(id)
  }, [excited, reducedMotion])

  useEffect(() => {
    return () => {
      clearTimer(heartTimerRef)
      clearTimer(reactionFadeTimerRef)
      clearTimer(reactionClearTimerRef)
    }
  }, [])

  const sequence = excited ? SPEAK_SEQUENCE : IDLE_SEQUENCE
  const frame = reducedMotion ? 0 : sequence[tick % sequence.length]!
  const lines = renderFrame(bones, frame)
  const rarityCls = RARITY_TONE[bones.rarity]
  const shinyLabel = bones.shiny ? "·闪光" : ""
  const liftClass =
    !reducedMotion && heartIdx !== null
      ? "-translate-y-1"
      : !reducedMotion && frame === 1
        ? "-translate-y-0.5"
        : !reducedMotion && frame === 2
          ? "translate-y-0.5"
          : ""

  return (
    <button
      type="button"
      title="点击抚摸 Buddy"
      aria-label={`Buddy，${RARITY_LABEL[bones.rarity]}${SPECIES_LABEL[bones.species]}，点击抚摸，当前状态：${label}`}
      onClick={() => triggerHeart(true)}
      className={cn(
        "group/buddy inline-flex flex-col items-center justify-center gap-2.5 rounded-lg border border-transparent bg-transparent px-4 py-3 text-center select-none outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none",
        className
      )}
    >
      <div className="relative grid h-[5.35rem] w-[8.75rem] place-items-center">
        {reaction && (
          <div
            className={cn(
              "pointer-events-none absolute -top-9 left-1/2 max-w-[min(15rem,calc(100vw-2rem))] -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] leading-tight text-popover-foreground shadow-sm transition-opacity duration-300 motion-reduce:transition-none",
              reaction.fading && "opacity-35"
            )}
          >
            {reaction.text}
          </div>
        )}
        <pre
          aria-hidden
          className={cn(
            "font-mono text-[14px] leading-tight whitespace-pre transition-transform duration-150 motion-reduce:transition-none",
            rarityCls,
            liftClass,
            bones.shiny && !reducedMotion && "animate-pulse"
          )}
        >
          {lines.join("\n")}
        </pre>
        <pre
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 font-mono text-[12px] leading-tight whitespace-pre text-primary transition-opacity duration-150 motion-reduce:transition-none",
            heartIdx === null && "opacity-0"
          )}
        >
          {heartIdx !== null ? HEART_FRAMES[heartIdx] : HEART_FRAMES[0]}
        </pre>
      </div>
      <div className="flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5 text-[10px] leading-none tabular-nums",
            RARITY_BADGE[bones.rarity]
          )}
        >
          {RARITY_LABEL[bones.rarity]}·{SPECIES_LABEL[bones.species]}
          {shinyLabel}
        </span>
        <span className="min-w-0 max-w-full truncate">{label}</span>
      </div>
    </button>
  )
}
