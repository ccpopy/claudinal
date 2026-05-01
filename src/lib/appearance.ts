export interface AppearanceConfig {
  accent?: string
  background?: string
  foreground?: string
  fontUI?: string
  fontMono?: string
  contrast?: number
  translucentSidebar?: boolean
}

export interface Appearance {
  light: AppearanceConfig
  dark: AppearanceConfig
}

const KEY = "claudecli.appearance"

export const CLAUDE_FONT_UI =
  '"Anthropic Serif", ui-serif, Georgia, Cambria, "Times New Roman", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif'
export const CLAUDE_FONT_MONO =
  '"Anthropic Mono", ui-monospace, "Cascadia Code", "Cascadia Mono", Menlo, Consolas, monospace'

const SANS_CLAUDE_FONT_UI =
  '"Anthropic Sans", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
const UI_FALLBACK =
  'ui-serif, Georgia, Cambria, "Times New Roman", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif'
const MONO_FALLBACK =
  'ui-monospace, "Cascadia Code", "Cascadia Mono", Menlo, Consolas, monospace'

const CLAUDE_DEFAULT: Appearance = {
  light: {
    accent: "#cc7d5e",
    background: "#f9f9f7",
    foreground: "#2d2d2b",
    fontUI: CLAUDE_FONT_UI,
    fontMono: CLAUDE_FONT_MONO
  },
  dark: {
    accent: "#cc7d5e",
    background: "#2d2d2b",
    foreground: "#f9f9f7",
    fontUI: CLAUDE_FONT_UI,
    fontMono: CLAUDE_FONT_MONO
  }
}

export const PRESETS: Record<string, { label: string; appearance: Appearance }> = {
  claude: {
    label: "Claude（默认）",
    appearance: CLAUDE_DEFAULT
  },
  codex: {
    label: "Codex",
    appearance: {
      light: {
        accent: "#0169cc",
        background: "#ffffff",
        foreground: "#0d0d0d",
        contrast: 45,
        translucentSidebar: true
      },
      dark: {
        accent: "#339cff",
        background: "#181818",
        foreground: "#ffffff",
        contrast: 60,
        translucentSidebar: true
      }
    }
  },
  github: {
    label: "GitHub",
    appearance: {
      light: {
        accent: "#0969da",
        background: "#ffffff",
        foreground: "#1f2328"
      },
      dark: {
        accent: "#1f6feb",
        background: "#0d1117",
        foreground: "#e6edf3"
      }
    }
  }
}

/// 比较核心三色 × 双模式 = 6 字段，全等才视为匹配该预设。
/// 其他字段（contrast / fontUI / fontMono / translucentSidebar）不参与匹配，
/// 用户在某预设基础上微调这些不影响 "激活态" 高亮。
export function matchPreset(a: Appearance): string | null {
  for (const [id, p] of Object.entries(PRESETS)) {
    const l = p.appearance.light
    const d = p.appearance.dark
    if (
      a.light.accent === l.accent &&
      a.light.background === l.background &&
      a.light.foreground === l.foreground &&
      a.dark.accent === d.accent &&
      a.dark.background === d.background &&
      a.dark.foreground === d.foreground
    ) {
      return id
    }
  }
  return null
}

function cloneClaudeDefault(): Appearance {
  return {
    light: { ...CLAUDE_DEFAULT.light },
    dark: { ...CLAUDE_DEFAULT.dark }
  }
}

export function defaultAppearance(): Appearance {
  return cloneClaudeDefault()
}

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return cloneClaudeDefault()
    const parsed = JSON.parse(raw)
    const merged: Appearance = {
      light: { ...(parsed?.light ?? {}) },
      dark: { ...(parsed?.dark ?? {}) }
    }
    // 兼容旧版本：核心 6 字段全空时升级为 Claude 预设，避免「激活但值丢失」。
    const allEmpty =
      !merged.light.accent &&
      !merged.light.background &&
      !merged.light.foreground &&
      !merged.dark.accent &&
      !merged.dark.background &&
      !merged.dark.foreground
    if (allEmpty) return cloneClaudeDefault()
    let migrated = false
    const presetId = matchPreset(merged)
    for (const mode of ["light", "dark"] as const) {
      const fontUI = merged[mode].fontUI
      if (!fontUI || (presetId === "claude" && fontUI === SANS_CLAUDE_FONT_UI)) {
        merged[mode].fontUI = CLAUDE_FONT_UI
        migrated = true
      }
      if (!merged[mode].fontMono && presetId === "claude") {
        merged[mode].fontMono = CLAUDE_FONT_MONO
        migrated = true
      }
    }
    if (migrated) saveAppearance(merged)
    return merged
  } catch {
    return cloneClaudeDefault()
  }
}

export function saveAppearance(a: Appearance) {
  localStorage.setItem(KEY, JSON.stringify(a))
}

export function resetAppearance() {
  localStorage.removeItem(KEY)
}

const DYNAMIC_VARS = [
  "--primary",
  "--ring",
  "--background",
  "--foreground",
  "--font-sans",
  "--font-mono",
  "--sidebar"
] as const

function clearDynamic(root: HTMLElement) {
  for (const v of DYNAMIC_VARS) root.style.removeProperty(v)
  root.style.removeProperty("font-family")
}

function hasGenericFontFamily(stack: string): boolean {
  return /(^|,)\s*(serif|sans-serif|monospace|ui-sans-serif|ui-serif|ui-monospace|system-ui)\s*($|,)/i.test(
    stack
  )
}

function withFallback(stack: string, fallback: string): string {
  const trimmed = stack.trim()
  if (!trimmed) return fallback
  return hasGenericFontFamily(trimmed) ? trimmed : `${trimmed}, ${fallback}`
}

export function applyAppearance(theme: "light" | "dark", a: Appearance) {
  const cfg = theme === "dark" ? a.dark : a.light
  const root = document.documentElement
  clearDynamic(root)
  if (cfg.accent) {
    root.style.setProperty("--primary", cfg.accent)
    root.style.setProperty("--ring", `${cfg.accent}66`)
  }
  if (cfg.background) {
    root.style.setProperty("--background", cfg.background)
  }
  if (cfg.foreground) {
    root.style.setProperty("--foreground", cfg.foreground)
  }
  if (cfg.fontUI) {
    const fontUI = withFallback(cfg.fontUI, UI_FALLBACK)
    root.style.setProperty("--font-sans", fontUI)
    root.style.setProperty("font-family", fontUI)
  }
  if (cfg.fontMono) {
    root.style.setProperty("--font-mono", withFallback(cfg.fontMono, MONO_FALLBACK))
  }
  if (cfg.translucentSidebar) {
    root.style.setProperty("--sidebar", "transparent")
  }
}
