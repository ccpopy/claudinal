import { useState } from "react"
import {
  claudeCapabilities, claudeInstallations, claudeRuntimeDiagnostics,
  selectClaudeInstallation, writeTextFile,
  type CliCapabilities, type CliInstallations, type RuntimeDiagnostics,
} from "@/lib/ipc"
import { save } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import { Button } from "./ui/button"
import { CopyButton } from "./CopyButton"

export function CliDiagnostics() {
  const [info, setInfo] = useState<CliCapabilities | null>(null)
  const [installations, setInstallations] = useState<CliInstallations | null>(null)
  const [selectedPath, setSelectedPath] = useState("")
  const [timeline, setTimeline] = useState<RuntimeDiagnostics | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [previewExport, setPreviewExport] = useState(false)

  const probe = async () => {
    setBusy(true)
    setError("")
    setPreviewExport(false)
    const [capabilities, choices, diagnostics] = await Promise.allSettled([
      claudeCapabilities(), claudeInstallations(), claudeRuntimeDiagnostics(),
    ])
    setInfo(capabilities.status === "fulfilled" ? capabilities.value : null)
    setTimeline(diagnostics.status === "fulfilled" ? diagnostics.value : null)
    setInstallations(choices.status === "fulfilled" ? choices.value : null)
    if (choices.status === "fulfilled") setSelectedPath(choices.value.selectedPath ?? "")
    setError([capabilities, choices, diagnostics]
      .filter((result) => result.status === "rejected")
      .map((result) => String(result.reason)).join("；"))
    setBusy(false)
  }

  const selectInstallation = async (path: string | null) => {
    setBusy(true)
    setError("")
    try {
      await selectClaudeInstallation(path)
      window.dispatchEvent(new Event("claudinal:cli-installation-changed"))
      toast.success("CLI 选择已保存，下次启动进程时生效")
      await probe()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }

  const labels = { supported: "支持", unsupported: "不支持", unknown: "待确认" }
  const exportText = JSON.stringify({ capabilities: info, runtime: timeline }, null, 2)
  const exportSummary = async () => {
    try {
      const path = await save({ defaultPath: "claudinal-diagnostics.json", filters: [{ name: "JSON", extensions: ["json"] }] })
      if (path) {
        await writeTextFile(path, exportText)
        toast.success("诊断已导出")
      }
    } catch (error) {
      toast.error(`导出失败：${String(error)}`)
    }
  }

  return <details className="rounded-lg border p-3 text-sm">
    <summary className="cursor-pointer">运行环境诊断</summary>
    <div className="mt-3 space-y-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void probe()}>{busy ? "检测中…" : "检测实际 CLI"}</Button>
      <p className="text-xs text-muted-foreground">仅读取版本和帮助信息。诊断包含安装路径及本次应用运行的最近 500 条状态记录，不包含消息、凭据或 stderr 原文。</p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {installations && <div className="space-y-2">
        <label className="block text-xs" htmlFor="cli-installation">CLI 安装项</label>
        <select id="cli-installation" className="w-full min-w-0 rounded border bg-background p-2 text-xs" value={selectedPath}
          disabled={busy || installations.environmentLocked} onChange={(event) => setSelectedPath(event.target.value)}>
          <option value="">自动选择可运行的安装项</option>
          {installations.installations.map((entry) => <option key={entry.path} value={entry.path} disabled={!entry.runnable}>
            {entry.path} · {entry.version ?? "不可运行"}
          </option>)}
        </select>
        {installations.environmentLocked
          ? <p className="text-xs text-muted-foreground">已由 CLAUDE_CLI_PATH 固定，需修改环境变量后重启应用。</p>
          : <Button size="sm" variant="outline" disabled={busy || selectedPath === (installations.selectedPath ?? "")}
            onClick={() => void selectInstallation(selectedPath || null)}>应用到后续进程</Button>}
        <p className="text-xs text-muted-foreground">运行中的会话继续使用原进程。所选安装不可用时会提示错误，请重新选择。</p>
      </div>}
      {error && !installations && <Button size="sm" variant="outline" disabled={busy} onClick={() => void selectInstallation(null)}>恢复自动选择</Button>}
      {info && <>
        <p className="break-all font-mono text-xs">{info.executablePath}</p>
        <p>{info.resolvedVersion} · {info.installKind}</p>
        <p className="text-xs text-muted-foreground">检测时间：{new Date(info.checkedAt).toLocaleString()}</p>
        <dl className="grid grid-cols-2 gap-1 text-xs">
          <dt>用户消息确认</dt><dd>{labels[info.userMessageReplay]}</dd>
          <dt>引导</dt><dd>{labels[info.midTurnInput]}</dd>
          <dt>Hook 事件</dt><dd>{labels[info.hookEvents]}</dd>
          <dt>原生 Ultracode</dt><dd>{labels[info.nativeUltracodeEffort]}</dd>
          <dt>历史分支</dt><dd>{labels[info.forkSession]}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">能力依据：CLI 帮助及已记录的版本规则；尚未完成此安装的端到端认证。</p>
      </>}
      {(info || timeline) && <>
        {timeline && <p className="text-xs text-muted-foreground">运行记录：{timeline.events.length} 条{timeline.droppedEvents > 0 ? `，已丢弃较早的 ${timeline.droppedEvents} 条` : ""}。点击检测可刷新快照。</p>}
        <CopyButton text={exportText} ariaLabel="复制诊断摘要" label="诊断摘要已复制" />
        <Button variant="outline" size="sm" onClick={() => setPreviewExport(!previewExport)}>预览诊断导出</Button>
        {previewExport && <div className="space-y-2">
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs">{exportText}</pre>
          <Button size="sm" onClick={() => void exportSummary()}>保存以上内容</Button>
        </div>}
      </>}
    </div>
  </details>
}
