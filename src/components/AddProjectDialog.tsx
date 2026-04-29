import { useEffect, useState } from "react"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { FolderOpen, FolderPlus, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createDir, defaultWorkspaceRoot, pathExists } from "@/lib/ipc"
import { addProject, type Project } from "@/lib/projects"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  onAdded: (p: Project) => void
}

function suggestSubdir(root: string): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const seq = String(Date.now()).slice(-4)
  return `${root}/session-${today}-${seq}`.replace(/\\/g, "/")
}

export function AddProjectDialog({ open, onOpenChange, onAdded }: Props) {
  const [path, setPath] = useState("")
  const [busy, setBusy] = useState(false)
  const [defaultRoot, setDefaultRoot] = useState("")

  useEffect(() => {
    if (!open) return
    setPath("")
    defaultWorkspaceRoot()
      .then((root) => setDefaultRoot(root))
      .catch((e) => toast.error(`读取默认目录失败: ${e}`))
  }, [open])

  const browse = async () => {
    try {
      const sel = await openDialog({ directory: true, multiple: false })
      if (typeof sel === "string") setPath(sel.replace(/\\/g, "/"))
    } catch (e) {
      toast.error(String(e))
    }
  }

  const useDefault = () => {
    if (defaultRoot) setPath(suggestSubdir(defaultRoot))
  }

  const submit = async () => {
    const p = path.trim()
    if (!p) return
    setBusy(true)
    try {
      const exists = await pathExists(p)
      if (!exists) {
        await createDir(p)
        toast.success(`已创建目录：${p}`)
      }
      const proj = addProject(p)
      onAdded(proj)
      onOpenChange(false)
    } catch (e) {
      toast.error(`无法添加: ${e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="size-4" />
            添加项目
          </DialogTitle>
          <DialogDescription>
            选择已有目录，或填入新路径自动创建。Claude CLI 将以此目录作为 cwd 启动。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor="cwd-path">目录路径</Label>
          <div className="flex gap-2">
            <Input
              id="cwd-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/your/workspace"
              className="font-mono text-xs"
              autoFocus
            />
            <Button
              variant="outline"
              onClick={browse}
              disabled={busy}
              type="button"
            >
              <FolderOpen />
              浏览
            </Button>
          </div>
          {defaultRoot && (
            <button
              type="button"
              onClick={useDefault}
              className="text-xs text-muted-foreground hover:text-foreground text-left transition-colors"
            >
              使用默认根：
              <span className="font-mono">{defaultRoot}</span>/session-…
            </button>
          )}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={!path.trim() || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <FolderPlus />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
