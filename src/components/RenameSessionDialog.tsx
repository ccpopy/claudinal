import { useEffect, useState } from "react"
import { Pencil } from "lucide-react"
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

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: string
  onSubmit: (title: string) => void
}

export function RenameSessionDialog({
  open,
  onOpenChange,
  initial,
  onSubmit
}: Props) {
  const [value, setValue] = useState("")

  useEffect(() => {
    if (open) setValue(initial ?? "")
  }, [open, initial])

  const submit = () => {
    onSubmit(value)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-4" />
            重命名会话
          </DialogTitle>
          <DialogDescription>
            自定义标题只在本机显示，留空恢复默认。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor="session-title">标题</Label>
          <Input
            id="session-title"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="例如：调试 Composer 排队 bug"
            autoFocus
            maxLength={200}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
