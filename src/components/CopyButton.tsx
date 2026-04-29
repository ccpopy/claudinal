import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface Props {
  text: string
  className?: string
  label?: string
  ariaLabel?: string
}

export function CopyButton({
  text,
  className,
  label = "已复制",
  ariaLabel = "复制内容"
}: Props) {
  const [copied, setCopied] = useState(false)

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      toast.success(label)
      setTimeout(() => setCopied(false), 1200)
    } catch (err) {
      toast.error(`复制失败: ${String(err)}`)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "size-6 text-muted-foreground hover:text-foreground hover:bg-muted",
            className
          )}
          onClick={onClick}
          aria-label={ariaLabel}
        >
          {copied ? (
            <Check className="size-3 text-connected" />
          ) : (
            <Copy className="size-3" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">复制</TooltipContent>
    </Tooltip>
  )
}
