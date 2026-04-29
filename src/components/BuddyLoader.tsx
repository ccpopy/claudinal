import { useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"

// 简化复刻 buddy.md：3 物种 × 3 眼睛 × 5 稀有度 × 1% 闪光
// 每只宠物 5 行 × 12 列 ASCII，IDLE_SEQUENCE 走 15 帧 / 500ms（buddy.md §2.5 原版口径）
// 每次挂载随机抽签，loading 期间 idle + 抚摸特效自动循环。

type Species = "cat" | "duck" | "owl"
type EyeKind = "round" | "dot" | "happy"
type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary"

interface Bones {
  species: Species
  eye: EyeKind
  rarity: Rarity
  shiny: boolean
}

const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1
}

const RARITY_TONE: Record<Rarity, string> = {
  common: "text-foreground",
  uncommon: "text-connected",
  rare: "text-primary",
  epic: "text-warn",
  legendary: "text-primary [text-shadow:0_0_8px_var(--primary)]"
}

const RARITY_LABEL: Record<Rarity, string> = {
  common: "普通",
  uncommon: "罕见",
  rare: "稀有",
  epic: "史诗",
  legendary: "传说"
}

const EYES: Record<EyeKind, { open: string; closed: string }> = {
  round: { open: "o   o", closed: "-   -" },
  dot: { open: "·   ·", closed: "-   -" },
  happy: { open: "^   ^", closed: "-   -" }
}

// 三物种模板：第 1 行眼睛位置用 {EYE} 占位
const SPECIES_TEMPLATES: Record<
  Species,
  { idle: string[]; alt1: string[]; alt2: string[] }
> = {
  cat: {
    idle: [
      "  /\\_/\\    ",
      " ( {EYE})  ",
      " (   ω   ) ",
      " (\")_(\")   ",
      "           "
    ],
    alt1: [
      "  /\\_/\\    ",
      " ( {EYE})  ",
      " (   ω   ) ",
      " (\")_(\")~  ",
      "           "
    ],
    alt2: [
      "  /\\-/\\    ",
      " ( {EYE})  ",
      " (   ω   ) ",
      " (\")_(\")   ",
      "           "
    ]
  },
  duck: {
    idle: [
      "    __     ",
      "  <({EYE}) ",
      "   (___)   ",
      "    \" \"    ",
      "           "
    ],
    alt1: [
      "    __     ",
      "  <({EYE})~",
      "   (___)   ",
      "    \" \"    ",
      "           "
    ],
    alt2: [
      "    __>    ",
      "  <({EYE}) ",
      "   (___)   ",
      "    \" \"    ",
      "           "
    ]
  },
  owl: {
    idle: [
      "   ,___,   ",
      "  ({EYE})  ",
      "  /)__(\\  ",
      "    \"\"     ",
      "           "
    ],
    alt1: [
      "   ,___,   ",
      "  ({EYE})  ",
      "  /)__(\\~ ",
      "    \"\"     ",
      "           "
    ],
    alt2: [
      "   ,_-_,   ",
      "  ({EYE})  ",
      "  /)__(\\  ",
      "    \"\"     ",
      "           "
    ]
  }
}

// 静 静 静 静 抖 静 静 静 眨眼 静 静 特殊 静 静 静
const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]

const HEART_FRAMES = [
  "♥    ♥      ",
  "  ♥  ♥   ♥  ",
  " ♥   ♥  ♥   ",
  "♥  ♥      ♥ ",
  "·    ·   ·  "
]

function pickWeighted<T extends string>(
  weights: Record<T, number>,
  rng: () => number
): T {
  const keys = Object.keys(weights) as T[]
  const total = keys.reduce((a, k) => a + weights[k], 0)
  let roll = rng() * total
  for (const k of keys) {
    roll -= weights[k]
    if (roll < 0) return k
  }
  return keys[0]
}

function rollBones(): Bones {
  const rng = Math.random
  const species: Species = (["cat", "duck", "owl"] as const)[
    Math.floor(rng() * 3)
  ]
  const eye: EyeKind = (["round", "dot", "happy"] as const)[
    Math.floor(rng() * 3)
  ]
  const rarity = pickWeighted(RARITY_WEIGHTS, rng)
  const shiny = rng() < 0.01
  return { species, eye, rarity, shiny }
}

function applyEye(template: string[], eyes: { open: string; closed: string }, blink: boolean): string[] {
  const e = blink ? eyes.closed : eyes.open
  return template.map((line) => line.replace("{EYE}", e))
}

interface Props {
  label?: string
  className?: string
}

export function BuddyLoader({ label = "正在召回会话…", className }: Props) {
  const bones = useMemo(rollBones, [])
  const [tick, setTick] = useState(0)
  const [heartIdx, setHeartIdx] = useState<number | null>(null)

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => (t + 1) % 1000), 500)
    return () => window.clearInterval(id)
  }, [])

  // 自动每 5 秒触发一次抚摸特效（loading 期间总能看到）
  useEffect(() => {
    let raf = 0
    const trigger = () => {
      let i = 0
      setHeartIdx(0)
      const id = window.setInterval(() => {
        i++
        if (i > 4) {
          window.clearInterval(id)
          setHeartIdx(null)
        } else {
          setHeartIdx(i)
        }
      }, 140)
    }
    trigger()
    raf = window.setInterval(trigger, 5000)
    return () => window.clearInterval(raf)
  }, [])

  const seqVal = IDLE_SEQUENCE[tick % IDLE_SEQUENCE.length]
  const tpl = SPECIES_TEMPLATES[bones.species]
  const base =
    seqVal === 1 ? tpl.alt1 : seqVal === 2 ? tpl.alt2 : tpl.idle
  const blink = seqVal === -1
  const lines = applyEye(base, EYES[bones.eye], blink)

  const rarityCls = RARITY_TONE[bones.rarity]
  const shinyTag = bones.shiny ? " ✨" : ""

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 select-none",
        className
      )}
    >
      <pre
        aria-hidden
        className={cn(
          "font-mono text-[14px] leading-tight",
          rarityCls,
          bones.shiny && "animate-pulse"
        )}
      >
        {lines.join("\n")}
      </pre>
      <pre
        aria-hidden
        className="font-mono text-[12px] leading-tight text-primary h-4 -mt-1 text-center"
      >
        {heartIdx !== null ? HEART_FRAMES[heartIdx] : ""}
      </pre>
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
        <span className={cn("text-[10px] tabular-nums", rarityCls)}>
          [{RARITY_LABEL[bones.rarity]}{shinyTag}]
        </span>
        <span>{label}</span>
      </div>
    </div>
  )
}
