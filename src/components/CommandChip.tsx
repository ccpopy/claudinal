import { forwardRef } from "react"
import { Package, SquareSlash } from "lucide-react"
import { composerCommandLabel } from "@/lib/composerCommand"
import { cn } from "@/lib/utils"

/**
 * slash 命令的行内标识：输入框与已发送消息共用同一形态。
 * 插件作用域命令（含 ":"）用包图标，内置命令用斜杠图标；
 * 原始 token 放在 title 里，悬停可见。
 */
export const CommandChip = forwardRef<
  HTMLSpanElement,
  { command: string; className?: string }
>(function CommandChip({ command, className }, ref) {
  const raw = command.startsWith("/") ? command : `/${command}`
  const Icon = raw.includes(":") ? Package : SquareSlash
  return (
    <span
      ref={ref}
      title={raw}
      className={cn(
        "inline-flex h-[22px] max-w-full select-none items-center gap-1 whitespace-nowrap rounded-md bg-warn/10 px-1.5 align-middle text-[13px] font-medium leading-none text-warn",
        className
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{composerCommandLabel(raw)}</span>
    </span>
  )
})
