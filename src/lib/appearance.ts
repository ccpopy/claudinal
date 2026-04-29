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

const EMPTY: Appearance = { light: {}, dark: {} }

export const PRESETS: Record<string, { label: string; appearance: Appearance }> = {
  claude: {
    label: "Claude（默认）",
    appearance: {
      light: {
        accent: "#cc7d5e",
        background: "#f9f9f7",
        foreground: "#2d2d2b"
      },
      dark: {
        accent: "#cc7d5e",
        background: "#2d2d2b",
        foreground: "#f9f9f7"
      }
    }
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
/// 6 字段全 undefined（重置 / 首次启动）= 走 token 默认 = Claude。
export function matchPreset(a: Appearance): string | null {
  const allEmpty =
    !a.light.accent &&
    !a.light.background &&
    !a.light.foreground &&
    !a.dark.accent &&
    !a.dark.background &&
    !a.dark.foreground
  if (allEmpty) return "claude"
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

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw)
    return {
      light: { ...EMPTY.light, ...(parsed?.light ?? {}) },
      dark: { ...EMPTY.dark, ...(parsed?.dark ?? {}) }
    }
  } catch {
    return EMPTY
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
  "--font-mono",
  "--sidebar"
] as const

function clearDynamic(root: HTMLElement) {
  for (const v of DYNAMIC_VARS) root.style.removeProperty(v)
  root.style.removeProperty("font-family")
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
    root.style.setProperty("font-family", cfg.fontUI)
  }
  if (cfg.fontMono) {
    root.style.setProperty("--font-mono", cfg.fontMono)
  }
  if (cfg.translucentSidebar) {
    root.style.setProperty("--sidebar", "transparent")
  }
}
