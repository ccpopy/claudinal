import { useCallback, useEffect, useState } from "react"
import { Download, ExternalLink, Save, Settings2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  claudeSettingsPath,
  openPath,
  readClaudeSettings,
  writeClaudeSettings
} from "@/lib/ipc"
import { ConfigExportDialog } from "./ConfigExportDialog"

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
  const [exportOpen, setExportOpen] = useState(false)

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

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Settings2 className="size-5" />
            配置
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            直接读写 <code className="font-mono text-xs">~/.claude/settings.json</code>，环境变量 / 鉴权请直接编辑文件。
          </p>
        </div>
        <div className="flex flex-col gap-2 mt-6 shrink-0">
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
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 pb-6 w-full space-y-6">
          <section className="rounded-lg border bg-card p-5 space-y-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              CLI 行为
            </div>
            <Row label="模型">
              <Input
                value={(cliSettings.model as string) ?? ""}
                onChange={(e) => update({ model: e.target.value })}
                placeholder="如 claude-sonnet-4-6 / opus[1m]"
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
                onClick={() => setExportOpen(true)}
                disabled={loading}
              >
                <Download className="size-3.5" />
                导出配置
              </Button>
            </Row>
          </section>
        </div>
      </ScrollArea>

      <div className="px-8 py-4 shrink-0 flex items-center gap-2">
        <Button onClick={save} disabled={!dirty || loading}>
          <Save />
          保存到 settings.json
        </Button>
        {dirty && <span className="text-xs text-warn">有未保存的修改</span>}
      </div>

      <ConfigExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        settings={cliSettings as Record<string, unknown>}
      />
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
      <Label className="w-24 text-xs shrink-0">{label}</Label>
      {children}
    </div>
  )
}
