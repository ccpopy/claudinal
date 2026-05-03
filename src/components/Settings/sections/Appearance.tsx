import { useState } from "react"
import { Monitor, Moon, RotateCcw, Sliders, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
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
  icon: React.ComponentType<{ className?: string }>
}> = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor }
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
        description="浅色与深色独立配置，实时生效。"
      />
      <SettingsSectionBody>

      <section className="space-y-3">
        <Label>主题</Label>
        <div className="grid grid-cols-3 gap-2">
          {themeOptions.map((opt) => {
            const Icon = opt.icon
            const active = theme === opt.value
            return (
              <Button
                key={opt.value}
                variant={active ? "default" : "outline"}
                className="h-auto flex-col gap-1.5 py-3"
                onClick={() => setTheme(opt.value)}
              >
                <Icon className="size-4" />
                <span className="text-xs font-normal">{opt.label}</span>
              </Button>
            )
          })}
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>预设主题</Label>
          <Button variant="ghost" size="sm" onClick={resetAll}>
            <RotateCcw className="size-3.5" />
            全部重置
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Object.entries(PRESETS).map(([id, p]) => {
            const active = activePresetId === id
            return (
              <Button
                key={id}
                variant={active ? "default" : "outline"}
                onClick={() => applyPreset(id)}
                className="h-auto py-3 flex-col gap-1"
              >
                <div className="flex gap-1">
                  {[
                    p.appearance.light.accent ?? "#d97757",
                    p.appearance.light.background ?? "#faf9f5",
                    p.appearance.dark.accent ?? "#e89270",
                    p.appearance.dark.background ?? "#1a1a17"
                  ].map((c, i) => (
                    <span
                      key={i}
                      className="size-3 rounded-full border"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <span className="text-xs font-normal">{p.label}</span>
              </Button>
            )
          })}
          <Button
            variant={activePresetId === "custom" ? "default" : "outline"}
            onClick={() => setPresetSelection("custom")}
            className="h-auto py-3 flex-col gap-1"
            aria-label="切换到自定义配色"
          >
            <div className="flex gap-1">
              {[
                a.light.accent ?? "#d97757",
                a.light.background ?? "#faf9f5",
                a.dark.accent ?? "#e89270",
                a.dark.background ?? "#1a1a17"
              ].map((c, i) => (
                <span
                  key={i}
                  className="size-3 rounded-full border transition-colors"
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <span className="text-xs font-normal">自定义</span>
          </Button>
        </div>
      </section>

      <Separator />

      {(["light", "dark"] as const).map((mode) => (
        <ModeSection
          key={mode}
          mode={mode}
          cfg={a[mode]}
          onUpdate={(patch) => update(mode, patch)}
          onReset={() => resetMode(mode)}
        />
      ))}
      </SettingsSectionBody>
    </SettingsSection>
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
  const placeholders = {
    accent: mode === "light" ? "#d97757" : "#e89270",
    background: mode === "light" ? "#faf9f5" : "#1a1a17",
    foreground: mode === "light" ? "#1d1c19" : "#f5f3ee"
  }
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Button size="sm" variant="ghost" onClick={onReset}>
          <RotateCcw className="size-3.5" />
          重置此主题
        </Button>
      </div>
      <ColorRow
        label="强调色"
        value={cfg.accent}
        placeholder={placeholders.accent}
        onChange={(v) => onUpdate({ accent: v })}
      />
      <ColorRow
        label="背景"
        value={cfg.background}
        placeholder={placeholders.background}
        onChange={(v) => onUpdate({ background: v })}
      />
      <ColorRow
        label="前景"
        value={cfg.foreground}
        placeholder={placeholders.foreground}
        onChange={(v) => onUpdate({ foreground: v })}
      />
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
  value,
  placeholder,
  onChange
}: {
  label: string
  value?: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  const colorValue = value && value.startsWith("#") ? value : "#000000"
  return (
    <div className="flex items-center gap-3">
      <Label className="w-20 text-xs shrink-0">{label}</Label>
      <input
        type="color"
        value={colorValue}
        onChange={(e) => onChange(e.target.value)}
        className="size-9 rounded border bg-transparent cursor-pointer"
        aria-label={`${label} 颜色选择器`}
      />
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs flex-1"
        placeholder={placeholder}
      />
    </div>
  )
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
    <div className="flex items-center gap-3">
      <Label className="w-20 text-xs shrink-0">{label}</Label>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs flex-1"
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
    <div className="flex items-center justify-between">
      <Label className="text-xs">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

