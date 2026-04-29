import { useState } from "react"
import { Save, Settings2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { loadSettings, saveSettings, type AppSettings } from "@/lib/settings"

const EFFORT_OPTIONS = [
  { value: "", label: "默认" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" }
]

const PERMISSION_OPTIONS = [
  { value: "default", label: "default（每次询问）" },
  { value: "acceptEdits", label: "acceptEdits（自动批准编辑）" },
  { value: "plan", label: "plan（仅规划，不执行）" },
  { value: "bypassPermissions", label: "bypassPermissions（全放行）" }
] as const

export function Config() {
  const [cfg, setCfg] = useState<AppSettings>(() => loadSettings())
  const [dirty, setDirty] = useState(false)

  const update = (patch: Partial<AppSettings>) => {
    setCfg((c) => ({ ...c, ...patch }))
    setDirty(true)
  }

  const save = () => {
    saveSettings(cfg)
    setDirty(false)
    toast.success("已保存，下次启动会话生效")
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Settings2 className="size-5" />
          配置
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          spawn 默认参数与 CLI 路径覆盖，下次启动会话生效。
        </p>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 pb-6 max-w-3xl space-y-6">
          <section className="space-y-4 rounded-lg border bg-card p-5">
            <Row label="模型">
              <Input
                value={cfg.defaultModel}
                onChange={(e) => update({ defaultModel: e.target.value })}
                placeholder="留空使用 CLI 默认（如 claude-opus-4-7）"
                className="font-mono text-xs flex-1"
              />
            </Row>
            <Row label="effort">
              <Select
                value={cfg.defaultEffort}
                onChange={(e) => update({ defaultEffort: e.target.value })}
                options={EFFORT_OPTIONS}
                triggerClassName="max-w-[260px]"
              />
            </Row>
            <Row label="权限">
              <Select
                value={cfg.defaultPermissionMode}
                onChange={(e) =>
                  update({
                    defaultPermissionMode: e.target
                      .value as AppSettings["defaultPermissionMode"]
                  })
                }
                options={PERMISSION_OPTIONS as unknown as Array<{ value: string; label: string }>}
                triggerClassName="max-w-[280px]"
              />
            </Row>
            <Separator />
            <Row label="CLI 路径">
              <Input
                value={cfg.claudeCliPath}
                onChange={(e) => update({ claudeCliPath: e.target.value })}
                placeholder="留空走 PATH 自动定位"
                className="font-mono text-xs flex-1"
              />
            </Row>
            <div className="text-[11px] text-muted-foreground">
              覆盖 CLAUDE_CLI_PATH 环境变量；填后启动会话时通过 env 注入。
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

function Row({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <Label className="w-20 text-xs shrink-0">{label}</Label>
      {children}
    </div>
  )
}
