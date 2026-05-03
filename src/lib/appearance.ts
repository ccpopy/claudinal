import { emitSettingsBus } from "@/lib/settingsBus"

export interface AppearanceConfig {
  accent?: string
  background?: string
  foreground?: string
  fontUI?: string
  fontMono?: string
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
        translucentSidebar: true
      },
      dark: {
        accent: "#339cff",
        background: "#181818",
        foreground: "#ffffff",
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

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function sameConfig(a: AppearanceConfig, b: AppearanceConfig): boolean {
  return (
    trimOptional(a.accent) === trimOptional(b.accent) &&
    trimOptional(a.background) === trimOptional(b.background) &&
    trimOptional(a.foreground) === trimOptional(b.foreground) &&
    trimOptional(a.fontUI) === trimOptional(b.fontUI) &&
    trimOptional(a.fontMono) === trimOptional(b.fontMono) &&
    !!a.translucentSidebar === !!b.translucentSidebar
  )
}

function matchPresetColors(a: Appearance): string | null {
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

/// 完整比较预设字段。只改了字体时也应显示为自定义，
/// 否则不同机器会同时显示为 Claude 默认但实际字体不一致。
export function matchPreset(a: Appearance): string | null {
  for (const [id, p] of Object.entries(PRESETS)) {
    if (sameConfig(a.light, p.appearance.light) && sameConfig(a.dark, p.appearance.dark)) {
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
    // 迁移仅针对 Claude 预设：旧版本可能保存了 Sans 版字体栈或留空，
    // 这里把它们规范成新的 Serif 默认。其他预设/自定义状态保持原样，
    // 避免把用户清空的字段回填成 Anthropic Serif 这种"漏字段"。
    let migrated = false
    if (matchPresetColors(merged) === "claude") {
      for (const mode of ["light", "dark"] as const) {
        const fontUI = merged[mode].fontUI
        if (!fontUI || fontUI === SANS_CLAUDE_FONT_UI) {
          merged[mode].fontUI = CLAUDE_FONT_UI
          migrated = true
        }
        if (!merged[mode].fontMono) {
          merged[mode].fontMono = CLAUDE_FONT_MONO
          migrated = true
        }
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
  emitSettingsBus("appearance")
}

export function resetAppearance() {
  localStorage.removeItem(KEY)
  emitSettingsBus("appearance")
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
  const presetId = matchPreset(a)
  // index.css 根级 --font-sans 写死了 Anthropic Serif，所以即使 cfg.fontUI 为空，
  // 不主动覆盖就会"看起来还是 Claude"。这里按预设算一组兜底字体，确保切到
  // Codex / GitHub / 自定义且未填字体时也能回到系统 sans / mono。
  const fallbackUI = presetId === "claude" ? CLAUDE_FONT_UI : SANS_CLAUDE_FONT_UI
  const fallbackMono = presetId === "claude" ? CLAUDE_FONT_MONO : MONO_FALLBACK
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
  const userFontUI = cfg.fontUI?.trim()
  const fontUI = userFontUI ? withFallback(userFontUI, UI_FALLBACK) : fallbackUI
  root.style.setProperty("--font-sans", fontUI)
  root.style.setProperty("font-family", fontUI)
  const userFontMono = cfg.fontMono?.trim()
  const fontMono = userFontMono
    ? withFallback(userFontMono, MONO_FALLBACK)
    : fallbackMono
  root.style.setProperty("--font-mono", fontMono)
  if (cfg.translucentSidebar) {
    root.style.setProperty("--sidebar", "transparent")
  }
}
