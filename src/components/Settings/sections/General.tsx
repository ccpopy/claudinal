import { useState } from "react"
import { Cog, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { loadSettings, saveSettings, type AppSettings } from "@/lib/settings"

export function General() {
  const [cfg, setCfg] = useState<AppSettings>(() => loadSettings())
  const [dirty, setDirty] = useState(false)

  const update = (patch: Partial<AppSettings>) => {
    setCfg((c) => ({ ...c, ...patch }))
    setDirty(true)
  }

  const save = () => {
    saveSettings(cfg)
    setDirty(false)
    toast.success("已保存")
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Cog className="size-5" />
          常规
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          应用启动行为与更新检查。
        </p>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 pb-6 max-w-3xl space-y-6">
          <section className="space-y-4 rounded-lg border bg-card p-5">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm">自动检查更新</Label>
                <div className="text-xs text-muted-foreground mt-0.5">
                  启动时静默检查 GitHub release。
                </div>
              </div>
              <Switch
                checked={cfg.autoCheckUpdate}
                onCheckedChange={(v) => update({ autoCheckUpdate: v })}
              />
            </div>
            <Separator />
            <div className="text-xs text-muted-foreground">
              启动 / 关闭行为待 P4 实现（kill 进程确认、后台保留等）。
            </div>
          </section>
        </div>
      </ScrollArea>

      <div className="px-8 py-4 shrink-0 flex items-center gap-2">
        <Button onClick={save} disabled={!dirty}>
          <Save />
          保存
        </Button>
        {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
      </div>
    </div>
  )
}
