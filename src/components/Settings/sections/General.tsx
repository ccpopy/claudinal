import { useState } from "react"
import { Cog, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { loadSettings, saveSettings, type AppSettings } from "@/lib/settings"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionFooter,
  SettingsSectionHeader
} from "./layout"

const PERMISSION_OPTIONS = [
  { value: "default", label: "default" },
  { value: "acceptEdits", label: "acceptEdits" },
  { value: "plan", label: "plan" },
  { value: "bypassPermissions", label: "bypassPermissions" }
]

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
    <SettingsSection>
      <SettingsSectionHeader
        icon={Cog}
        title="常规"
        description="应用启动行为与更新检查。"
      />

      <SettingsSectionBody>
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
            <div className="space-y-3">
              <div>
                <Label className="text-sm">默认权限模式</Label>
                <div className="text-xs text-muted-foreground mt-0.5">
                  新会话启动时传给 Claude CLI 的 permission-mode。
                </div>
              </div>
              <Select
                value={cfg.defaultPermissionMode}
                onChange={(e) =>
                  update({
                    defaultPermissionMode: e.target
                      .value as AppSettings["defaultPermissionMode"]
                  })
                }
                options={PERMISSION_OPTIONS}
                triggerClassName="max-w-[260px]"
              />
            </div>
            <Separator />
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label className="text-sm">使用 MCP 权限工具</Label>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    关闭时使用内置 stdio 权限弹窗；开启后把权限请求交给 MCP 工具。
                  </div>
                </div>
                <Switch
                  checked={cfg.permissionMcpEnabled}
                  onCheckedChange={(v) => update({ permissionMcpEnabled: v })}
                />
              </div>

              <div className="space-y-3">
                <div>
                  <Label className="text-sm">MCP 权限工具</Label>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    传给 --permission-prompt-tool；默认指向内置 Rust MCP server。
                  </div>
                </div>
                <Input
                  value={cfg.permissionPromptTool}
                  onChange={(e) =>
                    update({ permissionPromptTool: e.target.value })
                  }
                  disabled={!cfg.permissionMcpEnabled}
                  className="font-mono text-xs"
                />
              </div>

              <div className="space-y-3">
                <div>
                  <Label className="text-sm">MCP 配置 JSON</Label>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    传给 --mcp-config；${"{CLAUDINAL_EXE}"} 会在启动时替换为当前应用二进制路径。
                  </div>
                </div>
                <Textarea
                  value={cfg.permissionMcpConfig}
                  onChange={(e) =>
                    update({ permissionMcpConfig: e.target.value })
                  }
                  disabled={!cfg.permissionMcpEnabled}
                  className="min-h-32 font-mono text-xs"
                />
              </div>
            </div>
          </section>
      </SettingsSectionBody>

      <SettingsSectionFooter>
        <Button onClick={save} disabled={!dirty}>
          <Save />
          保存
        </Button>
        {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
      </SettingsSectionFooter>
    </SettingsSection>
  )
}
