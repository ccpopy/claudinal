import * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/lib/theme-context"

function Toaster({ position = "top-center", ...props }: ToasterProps) {
  const { resolvedTheme } = useTheme()
  return (
    <Sonner
      theme={resolvedTheme}
      position={position}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--card-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--card)",
          "--success-text": "var(--card-foreground)",
          "--success-border": "var(--connected)",
          "--error-bg": "var(--card)",
          "--error-text": "var(--card-foreground)",
          "--error-border": "var(--destructive)"
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
