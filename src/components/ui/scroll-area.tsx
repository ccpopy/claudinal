import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import { cn } from "@/lib/utils"

type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string
  scrollbarOrientation?: "vertical" | "horizontal" | "both"
  /** 局部覆盖滚动条 thumb 样式（如 diff 横向滚动需要更醒目的 thumb）。 */
  thumbClassName?: string
}

function ScrollArea({
  className,
  viewportClassName,
  scrollbarOrientation = "vertical",
  thumbClassName,
  children,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&>div]:!block [&>div]:!min-w-0 [&>div]:!w-full",
          viewportClassName
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {(scrollbarOrientation === "vertical" || scrollbarOrientation === "both") && (
        <ScrollBar thumbClassName={thumbClassName} />
      )}
      {(scrollbarOrientation === "horizontal" || scrollbarOrientation === "both") && (
        <ScrollBar orientation="horizontal" thumbClassName={thumbClassName} />
      )}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  thumbClassName,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar> & {
  thumbClassName?: string
}) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none select-none transition-colors p-px",
        orientation === "vertical" && "h-full w-2 border-l border-l-transparent",
        orientation === "horizontal" && "h-2 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className={cn("bg-border rounded-full relative flex-1", thumbClassName)}
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
