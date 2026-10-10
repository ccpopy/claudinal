import { useState } from "react"
import { ChevronDown, ChevronUp, RefreshCw, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { buildCompactCommand, type CompactBoundary, type ContextUsageSummary, type PromptSuggestion } from "@/lib/agentFeatures"

export interface AgentFeaturesPanelProps {
  defaultExpanded?: boolean
  suggestion?: PromptSuggestion | null
  onInsertSuggestion?: (text: string) => void
  onDismissSuggestion?: () => void
  context?: ContextUsageSummary | null
  contextCapability?: "supported" | "unsupported" | "unknown"
  contextLoading?: boolean
  contextError?: string | null
  onRefreshContext?: () => void
  compactBoundary?: CompactBoundary | null
  compactSupported?: boolean
  compacting?: boolean
  busy?: boolean
  onCompact?: (rawCommand: string) => void
  onOpenHistory?: (boundary: CompactBoundary) => void
}

function count(value: number | undefined): string {
  return value === undefined ? "未知" : value.toLocaleString("zh-CN")
}

export function AgentFeaturesPanel({
  defaultExpanded = false,
  suggestion, onInsertSuggestion, onDismissSuggestion,
  context, contextCapability = "unknown", contextLoading = false, contextError,
  onRefreshContext, compactBoundary, compactSupported = false, compacting = false,
  busy = false, onCompact, onOpenHistory
}: AgentFeaturesPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [instructions, setInstructions] = useState("")
  return <div className="space-y-2 text-xs">
    {suggestion && <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-muted-foreground">后续输入建议</div>
        <button type="button" disabled={!onInsertSuggestion} onClick={() => onInsertSuggestion?.(suggestion.text)}
          className="w-full whitespace-pre-wrap break-words text-left hover:text-primary disabled:opacity-50">
          {suggestion.text}
        </button>
        <div className="mt-1 text-muted-foreground">点击追加到草稿，发送前可编辑。</div>
      </div>
      {onDismissSuggestion && <button type="button" onClick={onDismissSuggestion} className="shrink-0 text-muted-foreground hover:text-foreground">关闭建议</button>}
    </div>}
    <div className="rounded-md border bg-muted/20">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="flex items-center gap-1.5">
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          上下文与压缩
          {context && <span className="text-muted-foreground">· {count(context.usedTokens)} tokens{context.percentage !== undefined ? ` · ${context.percentage}%` : ""}</span>}
          {compacting && <span role="status" className="text-muted-foreground">压缩中</span>}
        </button>
        <Button type="button" variant="ghost" size="sm" className="h-6 text-xs" disabled={contextCapability !== "supported" || contextLoading || busy || !onRefreshContext}
          onClick={() => { setExpanded(true); onRefreshContext?.() }}>
          <RefreshCw className={`size-3 ${contextLoading ? "animate-spin" : ""}`} />
          {contextLoading ? "查询中" : "查询上下文"}
        </Button>
      </div>
      {expanded && <div className="space-y-3 border-t px-3 py-3">
        {contextError && <div role="alert" className="break-words text-destructive">查询失败：{contextError}</div>}
        {contextCapability !== "supported" && <div className="text-muted-foreground">{contextCapability === "unsupported" ? "当前 CLI 不支持上下文查询。" : "上下文查询能力尚未确认。"}</div>}
        {!context && !contextError && contextCapability === "supported" && <div className="text-muted-foreground">点击查询读取 CLI summary；不会额外请求完整 token 计数。</div>}
        {context && <div className="space-y-1.5">
          <div className="text-muted-foreground">CLI 本地估算，可能不完整{context.model ? ` · ${context.model}` : ""}</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1"><span>已用：{count(context.usedTokens)} tokens</span><span>窗口：{count(context.contextWindow)} tokens</span></div>
          {!context.windowKnown && <div className="text-muted-foreground">当前模型窗口未确认，剩余比例未知。</div>}
          <div>自动压缩：{context.isAutoCompactEnabled === undefined ? "未知" : context.isAutoCompactEnabled ? "开启" : "关闭"}{context.autoCompactThreshold !== undefined ? ` · 阈值 ${count(context.autoCompactThreshold)} tokens` : ""}</div>
          {context.categories.length > 0 && <ul className="space-y-1 text-muted-foreground">
            {context.categories.filter((category) => context.windowKnown || category.kind === "used" || category.kind === "deferred").map((category, index) =>
              <li key={`${category.name}:${index}`} className="flex justify-between gap-3"><span>{category.name}</span><span>{count(category.tokens)} tokens</span></li>)}
          </ul>}
        </div>}
        {onCompact && <div className="space-y-2">
          <Input aria-label="压缩时保留的工作重点" placeholder="可选：压缩时保留的工作重点" value={instructions} disabled={busy || compacting || !compactSupported}
            className="h-8 text-xs" onChange={(event) => setInstructions(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation() } }} />
          <Button type="button" variant="outline" size="sm" disabled={busy || compacting || !compactSupported} onClick={() => onCompact(buildCompactCommand(instructions))}>
            {compacting ? "压缩中" : "立即压缩"}
          </Button>
          {!compactSupported && <div className="text-muted-foreground">当前会话的 /compact 能力尚未确认。</div>}
        </div>}
        {compactBoundary && <div className="space-y-1 border-t pt-2">
          <div>{compactBoundary.trigger === "auto" ? "自动压缩" : "手动压缩"}边界 · 压缩前 {count(compactBoundary.preTokens)} tokens</div>
          <div className="text-muted-foreground">压缩后：{compactBoundary.postTokens === undefined ? "CLI 未报告" : `${count(compactBoundary.postTokens)} tokens`}{compactBoundary.durationMs !== undefined ? ` · ${compactBoundary.durationMs} ms` : ""}</div>
          <div className="text-muted-foreground">原始对话记录仍保留。</div>
          {onOpenHistory && <button type="button" onClick={() => onOpenHistory(compactBoundary)} className="text-primary hover:underline">查看原始记录</button>}
        </div>}
      </div>}
    </div>
  </div>
}
