import { useState } from "react"
import { Loader2, Play, TerminalSquare } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { runProjectAction, type ProjectActionResult } from "@/lib/ipc"
import type { ProjectEnvAction } from "@/lib/projectEnv"

interface Props {
  cwd: string
  actions: ProjectEnvAction[]
}

interface ActionRun {
  action: ProjectEnvAction
  result: ProjectActionResult
}

export function ProjectActionsBar({ cwd, actions }: Props) {
  const [runningId, setRunningId] = useState<string | null>(null)
  const [run, setRun] = useState<ActionRun | null>(null)

  if (actions.length === 0) return null

  const start = async (action: ProjectEnvAction) => {
    setRunningId(action.id)
    try {
      const result = await runProjectAction({ cwd, command: action.command })
      setRun({ action, result })
      if (result.exit_code === 0) {
        toast.success(`操作完成：${action.label}`)
      } else {
        toast.error(`操作失败：${action.label}，exit ${result.exit_code}`)
      }
    } catch (error) {
      toast.error(`操作执行失败：${String(error)}`)
    } finally {
      setRunningId(null)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <TerminalSquare className="size-3.5" />
          项目操作
        </span>
        {actions.map((action) => {
          const running = runningId === action.id
          return (
            <Button
              key={action.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={!!runningId}
              onClick={() => start(action)}
              title={action.command}
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {action.label}
            </Button>
          )
        })}
      </div>

      <Dialog open={!!run} onOpenChange={(open) => !open && setRun(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{run?.action.label}</DialogTitle>
            <DialogDescription>
              exit {run?.result.exit_code} · {run?.action.command}
            </DialogDescription>
          </DialogHeader>
          {run && (
            <div className="max-h-[60vh] space-y-4 overflow-auto">
              <OutputBlock title="stdout" value={run.result.stdout} />
              <OutputBlock title="stderr" value={run.result.stderr} />
              {!run.result.stdout && !run.result.stderr && (
                <div className="rounded-md border bg-muted/35 p-3 text-sm text-muted-foreground">
                  命令没有输出。
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function OutputBlock({ title, value }: { title: string; value: string }) {
  if (!value) return null
  return (
    <section className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <pre className="whitespace-pre-wrap rounded-md border bg-background p-3 font-mono text-xs leading-5">
        {value}
      </pre>
    </section>
  )
}
