import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export function SettingsSection({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>
}

export function SettingsSectionHeader({
  title,
  description,
  icon: Icon,
  actions,
  eyebrow
}: {
  title: ReactNode
  description?: ReactNode
  icon?: LucideIcon
  actions?: ReactNode
  eyebrow?: ReactNode
}) {
  return (
    <div className="shrink-0 px-8 pb-4 pt-8">
      {eyebrow && <div className="mb-4">{eyebrow}</div>}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            {Icon && <Icon className="size-5 shrink-0" />}
            <span className="truncate">{title}</span>
          </h2>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  )
}

export function SettingsSectionBody({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className={cn("w-full space-y-6 px-8 pb-6 pt-2", className)}>
        {children}
      </div>
    </ScrollArea>
  )
}

export function SettingsSectionFooter({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex shrink-0 items-center gap-2 px-8 py-4", className)}>
      {children}
    </div>
  )
}
