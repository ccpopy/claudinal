import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

interface SelectProps
  extends Omit<React.ComponentProps<"select">, "children"> {
  options: Array<{ value: string; label: string }>
  triggerClassName?: string
}

function Select({
  className,
  triggerClassName,
  options,
  ...props
}: SelectProps) {
  return (
    <div
      className={cn(
        "relative inline-flex items-center w-full max-w-full rounded-md border border-input bg-background shadow-xs transition-[color,box-shadow] focus-within:ring-2 focus-within:ring-ring/50 has-[:disabled]:opacity-50 has-[:disabled]:cursor-not-allowed",
        triggerClassName
      )}
    >
      <select
        data-slot="select"
        className={cn(
          "appearance-none bg-transparent border-0 outline-none w-full h-9 pl-3 pr-8 text-sm leading-none cursor-pointer disabled:cursor-not-allowed",
          className
        )}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 pointer-events-none text-muted-foreground" />
    </div>
  )
}

export { Select }
