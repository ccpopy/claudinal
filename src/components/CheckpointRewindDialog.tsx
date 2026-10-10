import { useEffect, useState, useSyncExternalStore } from "react"
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CheckpointRewindController, type CheckpointRewindMode } from "@/lib/checkpoints"

export function CheckpointRewindDialog({ controller }: { controller: CheckpointRewindController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [mode, setMode] = useState<CheckpointRewindMode>("files")
  const busy = state.phase === "previewing" || state.phase === "executing"
  const ready = state.phase === "ready"
  const complete = state.phase === "complete"

  useEffect(() => { setMode("files") }, [state.target])
  useEffect(() => {
    if (!ready || !state.expiresAt) return
    const timer = window.setTimeout(() => controller.invalidate("回退预览已过期，请重新预览"), Math.max(0, state.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [controller, ready, state.expiresAt])

  const files = (complete ? state.result : state.preview)?.filesChanged
  return <Dialog open={state.phase !== "closed"} onOpenChange={(open) => { if (!open) controller.close() }}>
    <DialogContent showCloseButton={state.phase !== "executing"} className="max-w-xl" onEscapeKeyDown={(event) => { if (state.phase === "executing") event.preventDefault() }}
      onInteractOutside={(event) => { if (state.phase === "executing") event.preventDefault() }}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><RotateCcw className="size-4" />{complete ? "文件回退结果" : "回退本次及之后的受支持文件修改"}</DialogTitle>
        <DialogDescription>恢复到所选输入之前的文件检查点。只覆盖 CLI 实际追踪的 Write、Edit 和 NotebookEdit 修改。</DialogDescription>
      </DialogHeader>
      {state.target && <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <p className="line-clamp-3 whitespace-pre-wrap break-words">{state.target.messageLabel}</p>
        <p className="break-all text-muted-foreground">{state.target.cwd}</p>
      </div>}
      {!complete && <div className="flex gap-2 rounded-md border border-warn/30 bg-warn/5 p-3 text-xs leading-relaxed text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
        <p>Bash、外部工具及未被检查点追踪的子代理修改不在覆盖范围内。链接可能跳过，外部变更或冲突可能阻止回退；执行前会再次检查范围。</p>
      </div>}
      {busy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{state.phase === "executing" ? "正在回退所选会话的文件…" : "正在预览文件回退范围…"}</p>}
      {state.error && <p role="alert" className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{state.error}</p>}
      {(ready || complete) && <div className="space-y-2 text-sm">
        <p className="font-medium">{complete ? "CLI 返回的文件范围" : "将回退的文件范围"}{files ? ` · ${files.length} 个文件` : ""}</p>
        {files?.length ? <ul className="max-h-44 space-y-1 overflow-auto rounded-md border p-3 font-mono text-xs">{files.map((file, index) => <li className="break-all" key={`${index}:${file}`}>{file}</li>)}</ul>
          : <p className="text-xs text-muted-foreground">{files ? "CLI 未列出需要回退的文件修改。" : "CLI 未提供逐文件列表，范围以检查点实际追踪的文件为准。"}</p>}
        {state.preview && !complete && (state.preview.insertions !== undefined || state.preview.deletions !== undefined) && <p className="text-xs text-muted-foreground">追踪行数：新增 {state.preview.insertions ?? "未知"}，删除 {state.preview.deletions ?? "未知"}</p>}
      </div>}
      {ready && <fieldset className="space-y-2 text-sm">
        <legend className="mb-2 font-medium">执行方式</legend>
        <label className="flex items-center gap-2"><input type="radio" name="checkpoint-rewind-mode" checked={mode === "files"} onChange={() => setMode("files")} />只回退文件，保留当前对话</label>
        <label className="flex items-center gap-2 text-muted-foreground"><input type="radio" name="checkpoint-rewind-mode" checked={mode === "files_and_branch"} disabled={!controller.canFork()} onChange={() => setMode("files_and_branch")} />回退文件并准备新会话分支</label>
        {!controller.canFork() && <p className="text-xs text-muted-foreground">当前运行环境未确认支持此位置的会话分支。</p>}
      </fieldset>}
      {complete && <div role="status" className="space-y-2 rounded-md border p-3 text-sm">
        <p>{state.result?.error ? `CLI 返回：${state.result.error}` : "CLI 已返回文件回退成功，请检查工作目录的文件。"}</p>
        {!!state.result?.skippedLinks && <p className="text-warn">已跳过 {state.result.skippedLinks} 个链接；这些路径没有恢复。</p>}
        {state.branchCreated && <p>新会话分支已准备，下一条输入由你手动发送。</p>}
        {state.branchError && <p className="text-warn">{state.branchError}</p>}
      </div>}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={state.phase === "executing"} onClick={() => controller.close()}>{complete ? "关闭" : "取消"}</Button>
        {!busy && !complete && state.target && <Button type="button" variant="outline" onClick={() => { if (state.target) void controller.open(state.target) }}>重新预览</Button>}
        {!complete && <Button type="button" disabled={!ready} onClick={() => { void controller.confirm(mode) }}>{state.phase === "executing" ? "回退中…" : "确认回退文件"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
