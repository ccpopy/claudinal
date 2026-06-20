import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface Props {
  onRetry: () => void | Promise<void>
  className?: string
  ariaLabel?: string
}

export function RetryButton({
  onRetry,
  className,
  ariaLabel = "重试消息"
}: Props) {
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    void onRetry()
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "size-6 text-muted-foreground hover:bg-muted hover:text-foreground",
            className
          )}
          onClick={onClick}
          aria-label={ariaLabel}
        >
          <RotateCcw className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">重试</TooltipContent>
    </Tooltip>
  )
}
