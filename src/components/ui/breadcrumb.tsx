import { ChevronRight } from "lucide-react"
import * as React from "react"
import { cn } from "@/lib/utils"

function Breadcrumb({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      aria-label="breadcrumb"
      className={cn("flex items-center gap-1.5 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function BreadcrumbItem({
  className,
  current,
  onClick,
  ...props
}: React.ComponentProps<"button"> & { current?: boolean }) {
  if (current) {
    return (
      <span
        aria-current="page"
        className={cn("font-medium text-foreground", className)}
      >
        {props.children}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-sm text-muted-foreground transition-colors hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function BreadcrumbSeparator({ className }: { className?: string }) {
  return <ChevronRight className={cn("size-3.5", className)} />
}

export { Breadcrumb, BreadcrumbItem, BreadcrumbSeparator }
