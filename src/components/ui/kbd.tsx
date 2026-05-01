import * as React from "react"
import { cn } from "@/lib/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-[1.25rem] items-center justify-center gap-0.5 rounded border border-border bg-muted px-1 font-sans text-[10.5px] font-medium leading-none text-muted-foreground shadow-[inset_0_-1px_0_0_var(--border)] [&_svg]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="kbd-group"
      className={cn(
        "inline-flex items-center gap-1 align-middle text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
