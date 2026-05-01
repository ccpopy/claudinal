// Buddy 形象的数据与渲染工具。被 React 端 BuddyLoader 引用；
// index.html / public/startup.html 内联脚本另持独立精简副本（不同 origin 无法共享模块）。
// 三处的物种模板、稀有度权重、idle 序列必须同步，以避免视觉割裂。

export type Species = "cat" | "duck" | "owl" | "dragon" | "robot" | "blob"
export type EyeKind =
  | "dot"
  | "round"
  | "happy"
  | "star"
  | "sleepy"
  | "sharp"
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary"
export type Hat = "none" | "cap" | "halo" | "tophat" | "wizard" | "crown"

export interface Bones {
  species: Species
  eye: EyeKind
  rarity: Rarity
  shiny: boolean
  hat: Hat
}

export const SPECIES: readonly Species[] = [
  "cat",
  "duck",
  "owl",
  "dragon",
  "robot",
  "blob"
]

export const EYE_KINDS: readonly EyeKind[] = [
  "dot",
  "round",
  "happy",
  "star",
  "sleepy",
  "sharp"
]

export const RARITIES: readonly Rarity[] = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary"
]

export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1
}

export const HAT_POOLS: Record<Exclude<Rarity, "common">, readonly Hat[]> = {
  uncommon: ["cap", "halo"],
  rare: ["cap", "halo", "tophat"],
  epic: ["tophat", "wizard", "crown"],
  legendary: ["crown", "halo", "wizard"]
}

export const HAT_LINES: Record<Hat, string> = {
  none: "            ",
  cap: "   ____     ",
  halo: "   ====     ",
  tophat: "   _==_     ",
  wizard: "   /\\       ",
  crown: "   /^^\\     "
}

export const EYES: Record<EyeKind, { open: string; closed: string }> = {
  dot: { open: "·   ·", closed: "-   -" },
  round: { open: "o   o", closed: "-   -" },
  happy: { open: "^   ^", closed: "-   -" },
  star: { open: "✦   ✦", closed: "-   -" },
  sleepy: { open: "°   °", closed: "-   -" },
  sharp: { open: "×   ×", closed: "-   -" }
}

export const SPECIES_TEMPLATES: Record<
  Species,
  { idle: string[]; alt1: string[]; alt2: string[] }
> = {
  cat: {
    idle: [
      "            ",
      "   /\\_/\\    ",
      "  ( {EYE})  ",
      "  (   ω  )  ",
      "  (\")_(\")   "
    ],
    alt1: [
      "            ",
      "   /\\_/\\    ",
      "  ( {EYE})  ",
      "  (   ω  )  ",
      "  (\")_(\")~  "
    ],
    alt2: [
      "            ",
      "   /\\-/\\    ",
      "  ( {EYE})  ",
      "  (   ω  )  ",
      "  (\")_(\")   "
    ]
  },
  duck: {
    idle: [
      "            ",
      "    __      ",
      "  <({EYE})  ",
      "   (___)    ",
      "    \" \"     "
    ],
    alt1: [
      "            ",
      "    __      ",
      "  <({EYE})~ ",
      "   (___)    ",
      "    \" \"     "
    ],
    alt2: [
      "            ",
      "    __>     ",
      "  <({EYE})  ",
      "   (___)    ",
      "    \" \"     "
    ]
  },
  owl: {
    idle: [
      "            ",
      "   ,___,    ",
      "  ({EYE})   ",
      "  /)__(\\    ",
      "    \"\"      "
    ],
    alt1: [
      "            ",
      "   ,___,    ",
      "  ({EYE})   ",
      "  /)__(\\~   ",
      "    \"\"      "
    ],
    alt2: [
      "            ",
      "   ,_-_,    ",
      "  ({EYE})   ",
      "  /)__(\\    ",
      "    \"\"      "
    ]
  },
  dragon: {
    idle: [
      "            ",
      "   /\\__/\\   ",
      " <( {EYE})> ",
      "   /~~~~\\   ",
      "  _/    \\_  "
    ],
    alt1: [
      "            ",
      "   /\\__/\\   ",
      " <( {EYE})> ",
      "   /~~~~\\   ",
      "  _/    \\_~ "
    ],
    alt2: [
      "            ",
      "   /\\--/\\   ",
      " <( {EYE})> ",
      "   /~~~~\\   ",
      "  _/    \\_  "
    ]
  },
  robot: {
    idle: [
      "            ",
      "  [-----]   ",
      "  | {EYE}|  ",
      "  |  _  |   ",
      "  /|___|\\   "
    ],
    alt1: [
      "            ",
      "  [--^--]   ",
      "  | {EYE}|  ",
      "  |  _  |   ",
      "  /|___|\\   "
    ],
    alt2: [
      "            ",
      "  [-----]   ",
      "  | {EYE}|  ",
      "  |  o  |   ",
      "  /|___|\\   "
    ]
  },
  blob: {
    idle: [
      "            ",
      "   .----.   ",
      "  ( {EYE})  ",
      "  (  ~  )   ",
      "   '----'   "
    ],
    alt1: [
      "            ",
      "   .----.   ",
      "  ( {EYE})  ",
      "  (  v  )   ",
      "   '----'   "
    ],
    alt2: [
      "            ",
      "   .-~~.    ",
      "  ( {EYE})  ",
      "  (  ~  )   ",
      "   '----'   "
    ]
  }
}

export const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]
export const SPEAK_SEQUENCE = [1, 0, 2, 0, -1, 1, 0, 2]

export const HEART_FRAMES = [
  "♥    ♥      ",
  "  ♥  ♥   ♥  ",
  " ♥   ♥  ♥   ",
  "♥  ♥      ♥ ",
  "·    ·   ·  "
]

export function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)]!
}

export function pickWeighted<T extends string>(
  order: readonly T[],
  weights: Record<T, number>,
  rng: () => number
): T {
  const total = order.reduce((sum, key) => sum + weights[key], 0)
  let roll = rng() * total
  for (const key of order) {
    roll -= weights[key]
    if (roll < 0) return key
  }
  return order[0]!
}

// 从 crypto 取 32-bit 真随机种子；不可用时回退到 Math.random，避免抛异常。
export function freshSeed(): number {
  const cryptoApi =
    typeof window !== "undefined" ? window.crypto : undefined
  if (cryptoApi?.getRandomValues) {
    const buf = new Uint32Array(1)
    cryptoApi.getRandomValues(buf)
    return buf[0]! >>> 0
  }
  return (Math.random() * 0x100000000) >>> 0
}

export function rollBones(rng?: () => number): Bones {
  const rand = rng ?? mulberry32(freshSeed())
  const species = pick(SPECIES, rand)
  const eye = pick(EYE_KINDS, rand)
  const rarity = pickWeighted(RARITIES, RARITY_WEIGHTS, rand)
  const shiny = rand() < 0.01
  const hat = rarity === "common" ? "none" : pick(HAT_POOLS[rarity], rand)
  return { species, eye, rarity, shiny, hat }
}

export function applyEye(
  template: string[],
  eyes: { open: string; closed: string },
  blink: boolean
): string[] {
  const eye = blink ? eyes.closed : eyes.open
  return template.map((line) => line.replace("{EYE}", eye))
}

export function renderFrame(bones: Bones, frame: number): string[] {
  const template = SPECIES_TEMPLATES[bones.species]
  const base =
    frame === 1 ? template.alt1 : frame === 2 ? template.alt2 : template.idle
  const lines = applyEye(base, EYES[bones.eye], frame === -1)
  if (bones.hat !== "none") lines[0] = HAT_LINES[bones.hat]
  return lines
}

// vite html 内联脚本通过 window.__buddyHandoff 传递给 React 接管的状态。
// React 接管时调用 cleanup() 让 inline interval 停下，并用 tick 续帧避免动画重置。
export interface BuddyHandoff {
  bones: Bones
  tick: number
  cleanup: () => void
}

declare global {
  interface Window {
    __buddyHandoff?: BuddyHandoff
  }
}
