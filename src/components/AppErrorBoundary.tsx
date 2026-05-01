import React from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

interface State {
  error: Error | null
}

export class AppErrorBoundary extends React.Component<
  React.PropsWithChildren,
  State
> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("React render failed:", error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    const error = this.state.error
    return (
      <div className="grid h-screen place-items-center bg-background p-6 text-foreground">
        <div className="w-full max-w-2xl rounded-lg border bg-card p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-5" />
            <h1 className="text-base font-semibold">界面渲染失败</h1>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            前端遇到了未处理的渲染异常。错误已经写入控制台，下面是当前异常信息。
          </p>
          <pre className="max-h-72 overflow-auto rounded-md border bg-muted/50 p-3 text-xs">
            {error.stack ?? error.message}
          </pre>
          <div className="mt-4 flex justify-end">
            <Button type="button" onClick={() => window.location.reload()}>
              <RefreshCw className="size-4" />
              重新加载界面
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
