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
    appearance: EMPTY
  },
  codex: {
    label: "Codex",
    appearance: {
      light: {
        accent: "#cc7d5e",
        background: "#f9f9f7",
        foreground: "#2d2d2b",
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
  absolutely: {
    label: "Absolutely",
    appearance: {
      light: {
        accent: "#cc7d5e",
        background: "#ffffff",
        foreground: "#1a1a1a",
        contrast: 40
      },
      dark: {
        accent: "#cc7d5e",
        background: "#0d0d0d",
        foreground: "#fafafa",
        contrast: 55
      }
    }
  }
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
