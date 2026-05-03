import { useCallback, useEffect, useState } from "react"
import { Download, ExternalLink, Save, Settings2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  claudeSettingsPath,
  openPath,
  readClaudeSettings,
  writeClaudeSettings
} from "@/lib/ipc"
import { ConfigExportPage } from "./ConfigExportDialog"
import {
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionFooter,
  SettingsSectionHeader
} from "./layout"

// 官方 settings.json 字段（来自 https://code.claude.com/docs/en/settings）
// effortLevel 取值：low / medium / high / xhigh / max / auto
const EFFORT_OPTIONS = [
  { value: "", label: "（默认）" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
  { value: "auto", label: "auto" }
]

interface CliSettings {
  model?: string
  effortLevel?: string
  language?: string
  alwaysThinkingEnabled?: boolean
  env?: Record<string, string>
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] }
  [k: string]: unknown
}

export function Config() {
  const [cliSettings, setCliSettings] = useState<CliSettings>({})
  const [filePath, setFilePath] = useState<string>("")
  const [loading, setLoading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [showExport, setShowExport] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const path = await claudeSettingsPath("global")
      setFilePath(path)
      const raw = await readClaudeSettings("global")
      setCliSettings((raw as CliSettings | null) ?? {})
      setDirty(false)
    } catch (e) {
      toast.error(`读取失败: ${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const update = (patch: Partial<CliSettings>) => {
    setCliSettings((c) => ({ ...c, ...patch }))
    setDirty(true)
  }

  const save = async () => {
    try {
      await writeClaudeSettings("global", cliSettings as Record<string, unknown>)
      setDirty(false)
      toast.success("已保存到 settings.json，下次启动会话生效")
    } catch (e) {
      toast.error(`保存失败: ${String(e)}`)
    }
  }

  if (showExport) {
    return (
      <ConfigExportPage
        settings={cliSettings as Record<string, unknown>}
        onBack={() => setShowExport(false)}
      />
    )
  }

  return (
    <SettingsSection>
      <SettingsSectionHeader
        icon={Settings2}
        title="配置"
        description={
          <>
            直接读写 <code className="font-mono text-xs">~/.claude/settings.json</code>，环境变量 / 鉴权请直接编辑文件。
          </>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              filePath && openPath(filePath).catch((e) => toast.error(String(e)))
            }
            disabled={!filePath}
          >
            <ExternalLink className="size-3.5" />
            打开 settings.json
          </Button>
        }
      />

      <SettingsSectionBody>
          <section className="rounded-lg border bg-card p-5 space-y-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              CLI 行为
            </div>
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              这里写到 <code className="font-mono">~/.claude/settings.json</code>，对 Claude CLI 全局生效。会话级临时切换（包括 max effort）请用对话页 Composer 的 Model / Effort 选择器，不会写回此处；权限模式默认在「常规」页配置。
            </div>
            <Row label="模型">
              <Input
                value={(cliSettings.model as string) ?? ""}
                onChange={(e) => update({ model: e.target.value })}
                placeholder="如 sonnet / opusplan / 完整模型名"
                className="font-mono text-xs flex-1"
                disabled={loading}
              />
            </Row>
            <Row label="effortLevel">
              <Select
                value={(cliSettings.effortLevel as string) ?? ""}
                onChange={(e) => update({ effortLevel: e.target.value })}
                options={EFFORT_OPTIONS}
                triggerClassName="max-w-[260px]"
                disabled={loading}
              />
            </Row>
            <Row label="语言">
              <Input
                value={(cliSettings.language as string) ?? ""}
                onChange={(e) => update({ language: e.target.value })}
                placeholder="Chinese / English / japanese"
                className="text-xs flex-1"
                disabled={loading}
              />
            </Row>
            <Row label="深思">
              <Switch
                checked={!!cliSettings.alwaysThinkingEnabled}
                onCheckedChange={(v) => update({ alwaysThinkingEnabled: v })}
                disabled={loading}
              />
            </Row>
            <Row label="">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowExport(true)}
                disabled={loading}
              >
                <Download className="size-3.5" />
                导出配置
              </Button>
            </Row>
          </section>
      </SettingsSectionBody>

      <SettingsSectionFooter>
        <Button onClick={save} disabled={!dirty || loading}>
          <Save />
          保存到 settings.json
        </Button>
        {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
      </SettingsSectionFooter>
    </SettingsSection>
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
      <Label className="w-24 text-xs shrink-0">{label}</Label>
      {children}
    </div>
  )
}
