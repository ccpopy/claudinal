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

/** 设置卡片：所有设置分组统一的卡片原语。space-y/padding 特例用 className 覆盖（twMerge）。 */
export function SettingsCard({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-4 rounded-lg border bg-card p-5", className)}>
      {children}
    </div>
  )
}

/** 卡片 eyebrow 小标题；可选 description 渲染为紧随其后的描述行。 */
export function SettingsCardTitle({
  children,
  description,
  className
}: {
  children: ReactNode
  description?: ReactNode
  className?: string
}) {
  const title = (
    <div
      className={cn(
        "text-xs uppercase tracking-wider text-muted-foreground",
        className
      )}
    >
      {children}
    </div>
  )
  if (description == null) return title
  return (
    <>
      {title}
      <div className="mt-1 text-xs text-muted-foreground">{description}</div>
    </>
  )
}

/** muted 语气的提示盒。 */
export function SettingsHint({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground",
        className
      )}
    >
      {children}
    </div>
  )
}

/** 带语气的信息盒：warn 警示 / info 同 hint。 */
export function SettingsCallout({
  tone,
  children,
  className
}: {
  tone: "warn" | "info"
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs",
        tone === "warn"
          ? "border-warn/40 bg-warn/10 text-warn"
          : "bg-muted/40 text-muted-foreground",
        className
      )}
    >
      {children}
    </div>
  )
}

/** dashed 空状态盒。 */
export function SettingsEmptyState({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex h-40 flex-col items-center justify-center rounded-lg border border-dashed text-center",
        className
      )}
    >
      {children}
    </div>
  )
}
