import { useState } from "react"
import { Monitor, Moon, RotateCcw, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { useTheme, type Theme } from "@/lib/theme"
import {
  applyAppearance,
  loadAppearance,
  PRESETS,
  resetAppearance,
  saveAppearance,
  type Appearance,
  type AppearanceConfig
} from "@/lib/appearance"

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

  const persist = (next: Appearance) => {
    setA(next)
    saveAppearance(next)
    applyAppearance(resolvedTheme, next)
  }

  const update = (mode: "light" | "dark", patch: Partial<AppearanceConfig>) => {
    persist({ ...a, [mode]: { ...a[mode], ...patch } })
  }

  const applyPreset = (id: string) => {
    const preset = PRESETS[id]
    if (!preset) return
    persist(preset.appearance)
  }

  const resetAll = () => {
    resetAppearance()
    setA({ light: {}, dark: {} })
    applyAppearance(resolvedTheme, { light: {}, dark: {} })
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0">
        <h2 className="text-xl font-semibold">外观</h2>
        <p className="text-sm text-muted-foreground mt-1">
          浅色与深色独立配置，实时生效。
        </p>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 pb-8 max-w-3xl space-y-8">

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
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(PRESETS).map(([id, p]) => (
            <Button
              key={id}
              variant="outline"
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
          ))}
        </div>
      </section>

      <Separator />

      {(["light", "dark"] as const).map((mode) => (
        <ModeSection
          key={mode}
          mode={mode}
          cfg={a[mode]}
          onUpdate={(patch) => update(mode, patch)}
          onReset={() => update(mode, {})}
        />
      ))}
        </div>
      </ScrollArea>
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
        placeholder='ui-sans-serif, system-ui, "Segoe UI"'
        onChange={(v) => onUpdate({ fontUI: v })}
      />
      <FontRow
        label="代码字体"
        value={cfg.fontMono}
        placeholder='ui-monospace, "Cascadia Code", Menlo'
        onChange={(v) => onUpdate({ fontMono: v })}
      />
      <ToggleRow
        label="半透明侧栏"
        checked={!!cfg.translucentSidebar}
        onChange={(v) => onUpdate({ translucentSidebar: v })}
      />
      <RangeRow
        label="对比度"
        value={cfg.contrast ?? 50}
        onChange={(v) => onUpdate({ contrast: v })}
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

function RangeRow({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <Label className="w-20 text-xs shrink-0">{label}</Label>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-primary"
      />
      <span className="text-xs w-8 text-right tabular-nums text-muted-foreground">
        {value}
      </span>
    </div>
  )
}
