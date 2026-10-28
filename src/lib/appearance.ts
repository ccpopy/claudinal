import { emitSettingsBus } from "@/lib/settingsBus"

export interface AppearanceConfig {
  accent?: string
  background?: string
  foreground?: string
  fontUI?: string
  fontReading?: string
  fontMono?: string
  translucentSidebar?: boolean
  palette?: Partial<Record<PaletteVar, string>>
}

export interface Appearance {
  light: AppearanceConfig
  dark: AppearanceConfig
}

const KEY = "claudecli.appearance"

// Keep Claude's Latin face, with the bundled Noto font for Chinese reading text.
// Generic families must follow explicit CJK fonts to avoid system serif fallback.
export const CLAUDE_FONT_READING =
  '"Anthropic Serif", "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif'
const LEGACY_CLAUDE_READING_FONTS = new Set([
  '"Anthropic Serif", ui-serif, Georgia, Cambria, "Times New Roman", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif',
  '"Anthropic Serif", ui-serif, Georgia, Cambria, "Times New Roman", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif'
])
export const CLAUDE_FONT_MONO =
  '"Anthropic Mono", ui-monospace, "Cascadia Code", "Cascadia Mono", Menlo, Consolas, monospace'

export const CLAUDE_FONT_UI =
  '"Anthropic Sans", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
const UI_FALLBACK = CLAUDE_FONT_UI
const MONO_FALLBACK =
  'ui-monospace, "Cascadia Code", "Cascadia Mono", Menlo, Consolas, monospace'

const PALETTE_VARS = [
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--sidebar-foreground",
  "--sidebar-muted",
  "--sidebar-border",
  "--sidebar-accent",
  "--user",
  "--user-foreground",
  "--thinking",
  "--tool",
  "--connected",
  "--warn"
] as const

type PaletteVar = (typeof PALETTE_VARS)[number]

const CLAUDINAL_DEFAULT: Appearance = {
  light: {
    accent: "#5b65f0",
    background: "#f7f8ff",
    foreground: "#171a2f",
    translucentSidebar: true,
    palette: {
      "--card": "#ffffff",
      "--card-foreground": "#171a2f",
      "--popover": "#ffffff",
      "--popover-foreground": "#171a2f",
      "--primary-foreground": "#ffffff",
      "--secondary": "#eef1ff",
      "--secondary-foreground": "#252a55",
      "--muted": "#f0f2fb",
      "--muted-foreground": "#626981",
      "--accent": "#ece8ff",
      "--accent-foreground": "#25214d",
      "--destructive": "#c93f58",
      "--destructive-foreground": "#ffffff",
      "--border": "#dfe4f7",
      "--input": "#dfe4f7",
      "--sidebar-foreground": "#171a2f",
      "--sidebar-muted": "#65708f",
      "--sidebar-border": "#d8def5",
      "--sidebar-accent": "#e7ebff",
      "--user": "#eef1ff",
      "--user-foreground": "#252a55",
      "--thinking": "#f2edff",
      "--tool": "#edf5ff",
      "--connected": "#2f7de1",
      "--warn": "#9a6510"
    }
  },
  dark: {
    accent: "#91a4ff",
    background: "#111426",
    foreground: "#eef1ff",
    translucentSidebar: true,
    palette: {
      "--card": "#181c33",
      "--card-foreground": "#eef1ff",
      "--popover": "#181c33",
      "--popover-foreground": "#eef1ff",
      "--primary-foreground": "#0f1224",
      "--secondary": "#242947",
      "--secondary-foreground": "#eef1ff",
      "--muted": "#242947",
      "--muted-foreground": "#a9b0ce",
      "--accent": "#2b2753",
      "--accent-foreground": "#f0edff",
      "--destructive": "#e05a70",
      "--destructive-foreground": "#ffffff",
      "--border": "#313758",
      "--input": "#313758",
      "--sidebar-foreground": "#eef1ff",
      "--sidebar-muted": "#9da6ca",
      "--sidebar-border": "#2b3150",
      "--sidebar-accent": "#242947",
      "--user": "#242a55",
      "--user-foreground": "#eef1ff",
      "--thinking": "#291f4a",
      "--tool": "#1d2d4a",
      "--connected": "#6ab8ff",
      "--warn": "#f1c76f"
    }
  }
}

/** One warm hue (claude.ai ivory / charcoal); dark surfaces sit above the page. */
const CLAUDE_DEFAULT: Appearance = {
  light: {
    accent: "#cc7d5e",
    background: "#faf9f5",
    foreground: "#262624",
    translucentSidebar: true,
    fontUI: CLAUDE_FONT_UI,
    fontReading: CLAUDE_FONT_READING,
    fontMono: CLAUDE_FONT_MONO,
    palette: {
      "--card": "#ffffff",
      "--card-foreground": "#262624",
      "--popover": "#ffffff",
      "--popover-foreground": "#262624",
      "--primary-foreground": "#ffffff",
      "--secondary": "#f0eee6",
      "--secondary-foreground": "#3d3929",
      "--muted": "#f0eee6",
      "--muted-foreground": "#73726c",
      "--accent": "#ece9df",
      "--accent-foreground": "#262624",
      "--destructive": "#b4392b",
      "--destructive-foreground": "#ffffff",
      "--border": "#e6e3d8",
      "--input": "#e6e3d8",
      "--sidebar-foreground": "#262624",
      "--sidebar-muted": "#73726c",
      "--sidebar-border": "#e6e3d8",
      "--sidebar-accent": "#ece9df",
      "--user": "#f0eee6",
      "--user-foreground": "#262624",
      "--thinking": "#f5f3ec",
      "--tool": "#f5f3ec",
      "--connected": "#3f8f5a",
      "--warn": "#a0670f"
    }
  },
  dark: {
    accent: "#d97757",
    background: "#262624",
    foreground: "#f5f4ee",
    translucentSidebar: true,
    fontUI: CLAUDE_FONT_UI,
    fontReading: CLAUDE_FONT_READING,
    fontMono: CLAUDE_FONT_MONO,
    palette: {
      "--card": "#30302e",
      "--card-foreground": "#f5f4ee",
      "--popover": "#30302e",
      "--popover-foreground": "#f5f4ee",
      "--primary-foreground": "#1f1e1d",
      "--secondary": "#3a3936",
      "--secondary-foreground": "#f5f4ee",
      "--muted": "#33322f",
      "--muted-foreground": "#a6a39b",
      "--accent": "#3d3c38",
      "--accent-foreground": "#f5f4ee",
      "--destructive": "#e0705f",
      "--destructive-foreground": "#1f1e1d",
      "--border": "#3e3d38",
      "--input": "#3e3d38",
      "--sidebar-foreground": "#f5f4ee",
      "--sidebar-muted": "#a6a39b",
      "--sidebar-border": "#34332f",
      "--sidebar-accent": "#33322f",
      "--user": "#3a3936",
      "--user-foreground": "#f5f4ee",
      "--thinking": "#2e2d2b",
      "--tool": "#2e2d2b",
      "--connected": "#6fbf8a",
      "--warn": "#e8b562"
    }
  }
}

/** Colors of the first Claude preset; palettes were not user-editable. */
function isLegacyClaudePreset(a: Appearance): boolean {
  return a.light.accent === "#cc7d5e" && a.light.background === "#f9f9f7" && a.light.foreground === "#2d2d2b"
    && a.dark.accent === "#cc7d5e" && a.dark.background === "#2d2d2b" && a.dark.foreground === "#f9f9f7"
}

export const PRESETS: Record<string, { label: string; appearance: Appearance }> = {
  claudinal: {
    label: "Claudinal（默认）",
    appearance: CLAUDINAL_DEFAULT
  },
  claude: {
    label: "Claude",
    appearance: CLAUDE_DEFAULT
  },
  codex: {
    label: "Codex",
    appearance: {
      light: {
        accent: "#0169cc",
        background: "#ffffff",
        foreground: "#0d0d0d",
        translucentSidebar: true,
        palette: {
          "--card": "#ffffff",
          "--card-foreground": "#0d0d0d",
          "--popover": "#ffffff",
          "--popover-foreground": "#0d0d0d",
          "--primary-foreground": "#ffffff",
          "--secondary": "#f4f4f5",
          "--secondary-foreground": "#27272a",
          "--muted": "#f4f4f5",
          "--muted-foreground": "#71717a",
          "--accent": "#f4f4f5",
          "--accent-foreground": "#18181b",
          "--destructive": "#dc2626",
          "--destructive-foreground": "#ffffff",
          "--border": "#e4e4e7",
          "--input": "#e4e4e7",
          "--sidebar-foreground": "#0d0d0d",
          "--sidebar-muted": "#71717a",
          "--sidebar-border": "#e4e4e7",
          "--sidebar-accent": "#f4f4f5",
          "--user": "#f4f8ff",
          "--user-foreground": "#0d0d0d",
          "--thinking": "#f6f4ff",
          "--tool": "#eff6ff",
          "--connected": "#16803c",
          "--warn": "#a16207"
        }
      },
      dark: {
        accent: "#339cff",
        background: "#181818",
        foreground: "#ffffff",
        translucentSidebar: true,
        palette: {
          "--card": "#1f1f1f",
          "--card-foreground": "#ffffff",
          "--popover": "#1f1f1f",
          "--popover-foreground": "#ffffff",
          "--primary-foreground": "#08111d",
          "--secondary": "#262626",
          "--secondary-foreground": "#f5f5f5",
          "--muted": "#262626",
          "--muted-foreground": "#a1a1aa",
          "--accent": "#2a2a2a",
          "--accent-foreground": "#ffffff",
          "--destructive": "#ef4444",
          "--destructive-foreground": "#ffffff",
          "--border": "#2f2f2f",
          "--input": "#2f2f2f",
          "--sidebar-foreground": "#ffffff",
          "--sidebar-muted": "#a1a1aa",
          "--sidebar-border": "#2f2f2f",
          "--sidebar-accent": "#262626",
          "--user": "#172033",
          "--user-foreground": "#ffffff",
          "--thinking": "#241d36",
          "--tool": "#132033",
          "--connected": "#4ade80",
          "--warn": "#fbbf24"
        }
      }
    }
  },
  github: {
    label: "GitHub",
    appearance: {
      light: {
        accent: "#0969da",
        background: "#ffffff",
        foreground: "#1f2328",
        translucentSidebar: true,
        palette: {
          "--card": "#ffffff",
          "--card-foreground": "#1f2328",
          "--popover": "#ffffff",
          "--popover-foreground": "#1f2328",
          "--primary-foreground": "#ffffff",
          "--secondary": "#f6f8fa",
          "--secondary-foreground": "#24292f",
          "--muted": "#f6f8fa",
          "--muted-foreground": "#57606a",
          "--accent": "#f6f8fa",
          "--accent-foreground": "#24292f",
          "--destructive": "#cf222e",
          "--destructive-foreground": "#ffffff",
          "--border": "#d0d7de",
          "--input": "#d0d7de",
          "--sidebar-foreground": "#1f2328",
          "--sidebar-muted": "#57606a",
          "--sidebar-border": "#d0d7de",
          "--sidebar-accent": "#f6f8fa",
          "--user": "#ddf4ff",
          "--user-foreground": "#1f2328",
          "--thinking": "#f6f8fa",
          "--tool": "#dafbe1",
          "--connected": "#1a7f37",
          "--warn": "#9a6700"
        }
      },
      dark: {
        accent: "#1f6feb",
        background: "#0d1117",
        foreground: "#e6edf3",
        translucentSidebar: true,
        palette: {
          "--card": "#161b22",
          "--card-foreground": "#e6edf3",
          "--popover": "#161b22",
          "--popover-foreground": "#e6edf3",
          "--primary-foreground": "#ffffff",
          "--secondary": "#21262d",
          "--secondary-foreground": "#e6edf3",
          "--muted": "#21262d",
          "--muted-foreground": "#8b949e",
          "--accent": "#21262d",
          "--accent-foreground": "#e6edf3",
          "--destructive": "#f85149",
          "--destructive-foreground": "#ffffff",
          "--border": "#30363d",
          "--input": "#30363d",
          "--sidebar-foreground": "#e6edf3",
          "--sidebar-muted": "#8b949e",
          "--sidebar-border": "#30363d",
          "--sidebar-accent": "#21262d",
          "--user": "#1f2b3d",
          "--user-foreground": "#e6edf3",
          "--thinking": "#2b213a",
          "--tool": "#17311f",
          "--connected": "#3fb950",
          "--warn": "#d29922"
        }
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
    trimOptional(a.fontReading) === trimOptional(b.fontReading) &&
    trimOptional(a.fontMono) === trimOptional(b.fontMono) &&
    !!a.translucentSidebar === !!b.translucentSidebar &&
    samePalette(a.palette, b.palette)
  )
}

function samePalette(
  a: AppearanceConfig["palette"],
  b: AppearanceConfig["palette"]
): boolean {
  return PALETTE_VARS.every((v) => trimOptional(a?.[v]) === trimOptional(b?.[v]))
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

function cloneConfig(config: AppearanceConfig): AppearanceConfig {
  return {
    ...config,
    palette: config.palette ? { ...config.palette } : undefined
  }
}

function cloneAppearance(a: Appearance): Appearance {
  return {
    light: cloneConfig(a.light),
    dark: cloneConfig(a.dark)
  }
}

export function defaultAppearance(): Appearance {
  return cloneAppearance(CLAUDINAL_DEFAULT)
}

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaultAppearance()
    const parsed = JSON.parse(raw)
    const merged: Appearance = {
      light: { ...(parsed?.light ?? {}) },
      dark: { ...(parsed?.dark ?? {}) }
    }
    // 兼容旧版本：核心 6 字段全空时升级为当前默认预设，避免「激活但值丢失」。
    const allEmpty =
      !merged.light.accent &&
      !merged.light.background &&
      !merged.light.foreground &&
      !merged.dark.accent &&
      !merged.dark.background &&
      !merged.dark.foreground
    if (allEmpty) return defaultAppearance()
    let migrated = false
    if (isLegacyClaudePreset(merged)) {
      for (const mode of ["light", "dark"] as const) {
        const next = CLAUDE_DEFAULT[mode]
        merged[mode] = {
          ...merged[mode],
          accent: next.accent,
          background: next.background,
          foreground: next.foreground,
          palette: { ...next.palette }
        }
      }
      migrated = true
    }
    const colorPresetId = matchPresetColors(merged)
    if (colorPresetId) {
      const preset = PRESETS[colorPresetId]
      for (const mode of ["light", "dark"] as const) {
        if (!merged[mode].palette && preset.appearance[mode].palette) {
          merged[mode].palette = { ...preset.appearance[mode].palette }
          migrated = true
        }
        if (
          merged[mode].translucentSidebar === undefined &&
          preset.appearance[mode].translucentSidebar !== undefined
        ) {
          merged[mode].translucentSidebar =
            preset.appearance[mode].translucentSidebar
          migrated = true
        }
      }
    }
    // Only migrate the shipped serif UI default. Explicit custom stacks stay unchanged.
    if (colorPresetId === "claude") {
      for (const mode of ["light", "dark"] as const) {
        if (!merged[mode].fontUI || LEGACY_CLAUDE_READING_FONTS.has(merged[mode].fontUI)) {
          merged[mode].fontUI = CLAUDE_FONT_UI
          migrated = true
        }
        if (!merged[mode].fontReading || LEGACY_CLAUDE_READING_FONTS.has(merged[mode].fontReading)) {
          merged[mode].fontReading = CLAUDE_FONT_READING
          migrated = true
        }
        if (!merged[mode].fontMono) { merged[mode].fontMono = CLAUDE_FONT_MONO; migrated = true }
      }
    }
    if (migrated) saveAppearance(merged)
    return merged
  } catch {
    return defaultAppearance()
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
  "--font-reading",
  "--sidebar",
  ...PALETTE_VARS
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
  const fallbackUI = CLAUDE_FONT_UI
  const fallbackMono = presetId === "claude" ? CLAUDE_FONT_MONO : MONO_FALLBACK
  const root = document.documentElement
  clearDynamic(root)
  if (cfg.palette) {
    for (const [key, value] of Object.entries(cfg.palette)) {
      if (value) root.style.setProperty(key, value)
    }
  }
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
  root.style.setProperty("--font-reading", cfg.fontReading?.trim() ? withFallback(cfg.fontReading, UI_FALLBACK) : fontUI)
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
