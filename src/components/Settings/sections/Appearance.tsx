import { useState, type ComponentProps, type ComponentType } from "react"
import {
  Check,
  Monitor,
  Moon,
  Paintbrush,
  PanelLeft,
  RotateCcw,
  Sliders,
  Sun,
  Type
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useTheme, type Theme } from "@/lib/theme-context"
import {
  applyAppearance,
  CLAUDE_FONT_UI,
  CLAUDE_FONT_MONO,
  defaultAppearance,
  loadAppearance,
  matchPreset,
  PRESETS,
  resetAppearance,
  saveAppearance,
  type Appearance,
  type AppearanceConfig
} from "@/lib/appearance"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionHeader
} from "./layout"

const themeOptions: Array<{
  value: Theme
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
}> = [
  { value: "system", label: "跟随系统", description: "使用操作系统外观", icon: Monitor },
  { value: "light", label: "浅色", description: "固定浅色界面", icon: Sun },
  { value: "dark", label: "深色", description: "固定深色界面", icon: Moon }
]

const colorFields: Array<{
  key: "accent" | "background" | "foreground"
  label: string
  description: string
}> = [
  { key: "accent", label: "强调色", description: "按钮、焦点和高亮" },
  { key: "background", label: "背景", description: "主窗口底色" },
  { key: "foreground", label: "前景", description: "主要文字颜色" }
]

export function Appearance() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const [a, setA] = useState<Appearance>(() => loadAppearance())
  const [presetSelection, setPresetSelection] = useState<string | null>(null)

  const persist = (next: Appearance) => {
    setA(next)
    saveAppearance(next)
    applyAppearance(resolvedTheme, next)
  }

  const update = (mode: "light" | "dark", patch: Partial<AppearanceConfig>) => {
    setPresetSelection("custom")
    persist({ ...a, [mode]: { ...a[mode], ...patch } })
  }

  const resetMode = (mode: "light" | "dark") => {
    setPresetSelection("custom")
    persist({ ...a, [mode]: { ...defaultAppearance()[mode] } })
  }

  const applyPreset = (id: string) => {
    const preset = PRESETS[id]
    if (!preset) return
    setPresetSelection(id)
    persist(preset.appearance)
  }

  const matchedPresetId = matchPreset(a)
  const activePresetId = presetSelection ?? matchedPresetId ?? "custom"

  const resetAll = () => {
    resetAppearance()
    const next = defaultAppearance()
    setPresetSelection(matchPreset(next) ?? "custom")
    setA(next)
    applyAppearance(resolvedTheme, next)
  }

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={Sliders}
        title="外观"
        description="默认跟随系统；浅色与深色可独立微调，修改后实时生效。"
      />
      <SettingsSectionBody className="space-y-5">
      <section className="rounded-lg border bg-card p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <Label className="text-sm font-medium">主题模式</Label>
            <div className="mt-1 text-xs text-muted-foreground">
              当前生效：{resolvedTheme === "dark" ? "深色" : "浅色"}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {themeOptions.map((opt) => {
            const Icon = opt.icon
            const active = theme === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTheme(opt.value)}
                className={cn(
                  "group flex min-h-[82px] items-center gap-3 rounded-lg border bg-background px-3 py-3 text-left transition-colors hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  active && "border-primary/45 bg-primary/5"
                )}
              >
                <span
                  className={cn(
                    "grid size-10 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground transition-colors",
                    active && "border-primary/25 bg-primary/10 text-primary"
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{opt.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {opt.description}
                  </span>
                </span>
                {active && <Check className="size-4 shrink-0 text-primary" />}
              </button>
            )
          })}
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <Label className="text-sm font-medium">预设主题</Label>
            <div className="mt-1 text-xs text-muted-foreground">
              预设会同时替换浅色、深色和对应细节色板。
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={resetAll}>
            <RotateCcw className="size-3.5" />
            全部重置
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {Object.entries(PRESETS).map(([id, p]) => {
            const active = activePresetId === id
            return (
              <PresetButton
                key={id}
                label={p.label}
                appearance={p.appearance}
                active={active}
                onClick={() => applyPreset(id)}
              />
            )
          })}
          <PresetButton
            label="自定义"
            appearance={a}
            active={activePresetId === "custom"}
            onClick={() => setPresetSelection("custom")}
            aria-label="切换到自定义配色"
          />
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <Label className="text-sm font-medium">自定义细节</Label>
            <div className="mt-1 text-xs text-muted-foreground">
              保留预设结构，只调整你关心的颜色、字体和侧栏透明度。
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {(["light", "dark"] as const).map((mode) => (
            <ModeSection
              key={mode}
              mode={mode}
              cfg={a[mode]}
              onUpdate={(patch) => update(mode, patch)}
              onReset={() => resetMode(mode)}
            />
          ))}
        </div>
      </section>
      </SettingsSectionBody>
    </SettingsSection>
  )
}

function PresetButton({
  label,
  appearance,
  active,
  onClick,
  ...props
}: {
  label: string
  appearance: Appearance
  active: boolean
  onClick: () => void
} & Omit<ComponentProps<"button">, "onClick">) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative min-h-[112px] rounded-lg border bg-background p-3 text-left transition-colors hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active && "border-primary/45 bg-primary/5"
      )}
      {...props}
    >
      <ThemeMiniPreview appearance={appearance} />
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{label}</span>
        {active && <Check className="size-4 shrink-0 text-primary" />}
      </div>
    </button>
  )
}

function ThemeMiniPreview({ appearance }: { appearance: Appearance }) {
  return (
    <div className="overflow-hidden rounded-md border bg-muted">
      <div className="grid h-14 grid-cols-2">
        <PreviewHalf cfg={appearance.light} side="left" />
        <PreviewHalf cfg={appearance.dark} side="right" />
      </div>
    </div>
  )
}

function PreviewHalf({
  cfg,
  side
}: {
  cfg: AppearanceConfig
  side: "left" | "right"
}) {
  const background = previewColor(cfg.background, side === "left" ? "#f7f8ff" : "#111426")
  const foreground = previewColor(cfg.foreground, side === "left" ? "#171a2f" : "#eef1ff")
  const accent = previewColor(cfg.accent, side === "left" ? "#5b65f0" : "#91a4ff")
  const card = previewColor(
    cfg.palette?.["--card"],
    side === "left" ? "#ffffff" : "#181c33"
  )
  const border = previewColor(
    cfg.palette?.["--border"],
    side === "left" ? "#dfe4f7" : "#313758"
  )

  return (
    <div
      className={cn("flex h-full gap-1.5 p-1.5", side === "right" && "border-l")}
      style={{ backgroundColor: background, borderColor: border }}
    >
      <div
        className="h-full w-3 rounded-sm"
        style={{ backgroundColor: accent }}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div
          className="h-4 rounded-sm border"
          style={{ backgroundColor: card, borderColor: border }}
        />
        <div
          className="h-1.5 w-4/5 rounded-full opacity-80"
          style={{ backgroundColor: foreground }}
        />
        <div
          className="h-1.5 w-1/2 rounded-full opacity-35"
          style={{ backgroundColor: foreground }}
        />
      </div>
    </div>
  )
}

function ModeSection({
  mode,
  cfg,
  onUpdate,
  onReset
}: {
  mode: "light" | "dark"
  cfg: AppearanceConfig
  onUpdate: (p: Partial<AppearanceConfig>) => void
  onReset: () => void
}) {
  const title = mode === "light" ? "浅色主题" : "深色主题"
  const Icon = mode === "light" ? Sun : Moon
  const placeholders = {
    accent: mode === "light" ? "#d97757" : "#e89270",
    background: mode === "light" ? "#faf9f5" : "#1a1a17",
    foreground: mode === "light" ? "#1d1c19" : "#f5f3ee"
  }
  const updateColor = (
    key: "accent" | "background" | "foreground",
    value: string
  ) => {
    if (key === "accent") onUpdate({ accent: value })
    else if (key === "background") onUpdate({ background: value })
    else onUpdate({ foreground: value })
  }
  return (
    <section className="space-y-4 rounded-lg border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </span>
          <h3 className="truncate text-sm font-semibold">{title}</h3>
        </div>
        <Button size="sm" variant="ghost" onClick={onReset}>
          <RotateCcw className="size-3.5" />
          重置此主题
        </Button>
      </div>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Paintbrush className="size-3.5" />
          色彩
        </div>
        {colorFields.map((field) => (
          <ColorRow
            key={field.key}
            label={field.label}
            description={field.description}
            value={cfg[field.key]}
            placeholder={placeholders[field.key]}
            onChange={(v) => updateColor(field.key, v)}
          />
        ))}
      </div>
      <Separator />
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Type className="size-3.5" />
          字体
        </div>
        <FontRow
          label="UI 字体"
          value={cfg.fontUI}
          placeholder={CLAUDE_FONT_UI}
          onChange={(v) => onUpdate({ fontUI: v })}
        />
        <FontRow
          label="代码字体"
          value={cfg.fontMono}
          placeholder={CLAUDE_FONT_MONO}
          onChange={(v) => onUpdate({ fontMono: v })}
        />
      </div>
      <Separator />
      <ToggleRow
        label="半透明侧栏"
        checked={!!cfg.translucentSidebar}
        onChange={(v) => onUpdate({ translucentSidebar: v })}
      />
    </section>
  )
}

function ColorRow({
  label,
  description,
  value,
  placeholder,
  onChange
}: {
  label: string
  description: string
  value?: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  const displayColor = previewColor(value, placeholder ?? "#000000")
  const pickerValue = hexColor(value) ?? hexColor(placeholder) ?? "#000000"
  return (
    <div className="grid grid-cols-[minmax(88px,112px)_1fr] items-center gap-3">
      <div className="min-w-0">
        <Label className="text-xs font-medium">{label}</Label>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <label
          className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted/60"
          aria-label={`${label} 颜色选择器`}
        >
          <span
            className="size-7 rounded-sm border shadow-sm"
            style={{ backgroundColor: displayColor }}
          />
          <input
            type="color"
            value={pickerValue}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 opacity-0"
            aria-label={`${label} 颜色选择器`}
          />
        </label>
        <Input
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 font-mono text-xs"
          placeholder={placeholder}
        />
      </div>
    </div>
  )
}

function previewColor(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback
  if (typeof CSS !== "undefined" && CSS.supports?.("color", candidate)) {
    return candidate
  }
  return fallback
}

function hexColor(value: string | undefined): string | null {
  const candidate = value?.trim()
  if (!candidate) return null
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : null
}

function FontRow({
  label,
  value,
  placeholder,
  onChange
}: {
  label: string
  value?: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  return (
    <div className="grid grid-cols-[minmax(88px,112px)_1fr] items-center gap-3">
      <Label className="text-xs font-medium">{label}</Label>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 font-mono text-xs"
        placeholder={placeholder}
      />
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <PanelLeft className="size-3.5 text-muted-foreground" />
        <Label className="text-xs font-medium">{label}</Label>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

