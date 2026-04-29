import { useEffect, useMemo, useState } from "react"
import { Eraser, Monitor } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { clearUsage, loadUsage, type UsageSnapshot } from "@/lib/settings"

const API_KEY_LABELS: Record<string, string> = {
  none: "未登录 / OAuth Anthropic",
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY 环境变量",
  bedrock: "AWS Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Azure Foundry"
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function Account() {
  const [usage, setUsage] = useState<UsageSnapshot>(() => loadUsage())
  const [apiKeySource, setApiKeySource] = useState<string | null>(null)

  useEffect(() => {
    // localStorage 里保存最近一次 system_init 的 apiKeySource（App 写入）
    try {
      const v = localStorage.getItem("claudinal.api-key-source")
      setApiKeySource(v)
    } catch {
      // ignore
    }
  }, [])

  const reset = () => {
    if (!window.confirm("清空累计 usage？此操作不可恢复。")) return
    clearUsage()
    setUsage(loadUsage())
    toast.success("usage 已清空")
  }

  const sortedModels = useMemo(
    () =>
      Object.entries(usage.byModel).sort(
        (a, b) => b[1].costUsd - a[1].costUsd
      ),
    [usage]
  )

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-8 pt-8 pb-4 shrink-0">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Monitor className="size-5" />
          账号 & Usage
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          登录方式来自 system/init.apiKeySource；usage 累计自每轮 result.modelUsage。
        </p>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-8 pb-6 max-w-3xl space-y-6">
          <section className="rounded-lg border bg-card p-5 space-y-2">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              登录
            </div>
            <div className="text-sm font-mono">
              {apiKeySource
                ? API_KEY_LABELS[apiKeySource] ?? apiKeySource
                : "未检测到（启动一次会话后会自动写入）"}
            </div>
          </section>

          <section className="rounded-lg border bg-card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                累计
              </div>
              {usage.updatedAt > 0 && (
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  最后更新：{new Date(usage.updatedAt).toLocaleString()}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="总成本" value={`$${usage.totalCostUsd.toFixed(4)}`} />
              <Stat label="输入 tokens" value={fmt(usage.totalInputTokens)} />
              <Stat label="输出 tokens" value={fmt(usage.totalOutputTokens)} />
              <Stat label="cache_read" value={fmt(usage.totalCacheRead)} />
              <Stat label="cache_write" value={fmt(usage.totalCacheWrite)} />
            </div>
            <Separator />
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                按模型拆分
              </div>
              {sortedModels.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  暂无数据 — 完成一轮对话后这里会更新。
                </div>
              ) : (
                <div className="rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-medium">模型</th>
                        <th className="text-right px-3 py-1.5 font-medium">成本</th>
                        <th className="text-right px-3 py-1.5 font-medium">输入</th>
                        <th className="text-right px-3 py-1.5 font-medium">输出</th>
                        <th className="text-right px-3 py-1.5 font-medium">缓存读</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedModels.map(([model, m]) => (
                        <tr key={model} className="border-t">
                          <td className="px-3 py-1.5 font-mono break-all">{model}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            ${m.costUsd.toFixed(4)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmt(m.inputTokens)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmt(m.outputTokens)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmt(m.cacheReadInputTokens)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </div>
      </ScrollArea>

      <div className="px-8 py-4 shrink-0 flex items-center gap-2">
        <Button variant="outline" onClick={reset}>
          <Eraser />
          清空 usage
        </Button>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/30 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-mono tabular-nums">{value}</div>
    </div>
  )
}
