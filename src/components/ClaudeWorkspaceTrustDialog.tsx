import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import type { ClaudeWorkspaceTrustInfo } from "@/lib/claudeWorkspaceTrust"

interface Props {
  open: boolean
  info: ClaudeWorkspaceTrustInfo
  onCancel: () => void
  onTrust: () => Promise<void>
}

export function ClaudeWorkspaceTrustDialog({
  open,
  info,
  onCancel,
  onTrust
}: Props) {
  const focusRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setBusy(false)
    setError(null)
  }, [info.projectKey, open])

  const trust = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onTrust()
    } catch (cause) {
      setError(`写入 Claude 工作区信任失败：${String(cause)}`)
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel()
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusRef.current?.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <div ref={focusRef} tabIndex={-1} className="outline-none">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" />
              信任此 Claude 工作区？
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  这个项目包含 {info.allowCount} 条本地权限规则。信任后，Claude
                  CLI 会加载该目录中的项目级 Claude 配置与这些权限规则。
                </p>
                <div className="rounded-lg border bg-muted/40 p-3 text-xs text-foreground">
                  <div className="font-medium">将信任的工作区</div>
                  <code className="mt-1 block break-all font-mono text-muted-foreground">
                    {info.projectKey}
                  </code>
                  <div className="mt-3 font-medium">检测到规则的配置</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {info.settingsSources.map((source) => (
                      <code
                        key={source}
                        className="rounded bg-background px-1.5 py-0.5 font-mono text-muted-foreground"
                      >
                        {source}
                      </code>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-foreground">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>
                    仅在你确认此目录及其中的 Claude 配置可信时继续。接受编辑权限与工作区信任是两个独立设置。
                  </span>
                </div>
                {error && (
                  <div
                    role="alert"
                    className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
                  >
                    {error}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消发送</AlertDialogCancel>
          <Button type="button" onClick={() => void trust()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            {busy ? "正在写入…" : "信任并继续"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
