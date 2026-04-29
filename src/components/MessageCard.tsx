import { useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Cog,
  DollarSign,
  FileWarning,
  Gauge,
  Loader2,
  Timer
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { UIEntry, UIMessage } from "@/types/ui"
import { BlockView, ExpandableRow, CodeBlock } from "./MessageBlocks"

interface Props {
  entry: UIEntry
}

export function MessageCard({ entry }: Props) {
  if (entry.kind === "message") return <MessageView msg={entry} />
  if (entry.kind === "system_init") return <SystemInitView e={entry} />
  if (entry.kind === "system_status") return null
  if (entry.kind === "result") return <ResultView e={entry} />
  if (entry.kind === "rate_limit") return null
  if (entry.kind === "stderr") {
    return <SimpleRow label="stderr" tone="error" content={entry.line} />
  }
  if (entry.kind === "raw") {
    return <SimpleRow label="raw" content={entry.line ?? ""} />
  }
  return null
}

function MessageView({ msg }: { msg: UIMessage }) {
  if (msg.blocks.length === 0 && msg.streaming) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>思考中…</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 items-stretch">
      {msg.blocks.map((b, i) => (
        <BlockView key={i} role={msg.role} block={b} />
      ))}
    </div>
  )
}

function SimpleRow({
  label,
  tone,
  content
}: {
  label: string
  tone?: "error"
  content: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={tone === "error" ? AlertTriangle : FileWarning}
      label={label}
      tone={tone}
    >
      <CodeBlock>{content}</CodeBlock>
    </ExpandableRow>
  )
}

function fmtMs(ms?: number): string {
  if (typeof ms !== "number") return ""
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function SystemInitView({
  e
}: {
  e: Extract<UIEntry, { kind: "system_init" }>
}) {
  const [open, setOpen] = useState(false)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={Cog}
      label={`会话开始${e.model ? ` · ${e.model}` : ""}`}
    >
      <div className="flex flex-col gap-1.5 text-muted-foreground">
        {e.cwd && <div className="font-mono break-all text-[11px]">{e.cwd}</div>}
        <div className="flex flex-wrap gap-1">
          {e.permissionMode && (
            <Badge variant="outline" className="text-[10px]">
              perm: {e.permissionMode}
            </Badge>
          )}
          {e.outputStyle && (
            <Badge variant="outline" className="text-[10px]">
              style: {e.outputStyle}
            </Badge>
          )}
          {e.fastModeState && (
            <Badge variant="outline" className="text-[10px]">
              fast: {e.fastModeState}
            </Badge>
          )}
          {e.version && (
            <Badge variant="outline" className="text-[10px]">
              v{e.version}
            </Badge>
          )}
        </div>
        {e.mcpServers.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {e.mcpServers.map((m) => (
              <Badge
                key={m.name}
                variant={
                  m.status === "connected"
                    ? "success"
                    : m.status === "needs-auth"
                      ? "warn"
                      : "outline"
                }
                className="text-[10px]"
              >
                {m.name} · {m.status}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </ExpandableRow>
  )
}

function ResultView({ e }: { e: Extract<UIEntry, { kind: "result" }> }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 text-xs pt-1",
        e.isError ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {e.isError ? (
        <AlertTriangle className="size-3.5" />
      ) : (
        <CheckCircle2 className="size-3.5" />
      )}
      <span>{e.isError ? "失败" : "完成"}</span>
      {typeof e.totalCostUsd === "number" && (
        <span className="inline-flex items-center gap-1">
          <DollarSign className="size-3" />
          {e.totalCostUsd.toFixed(4)}
        </span>
      )}
      {typeof e.durationMs === "number" && (
        <span className="inline-flex items-center gap-1">
          <Timer className="size-3" />
          {fmtMs(e.durationMs)}
        </span>
      )}
      {typeof e.numTurns === "number" && (
        <span className="inline-flex items-center gap-1">
          <Gauge className="size-3" />
          {e.numTurns} turn{e.numTurns === 1 ? "" : "s"}
        </span>
      )}
    </div>
  )
}
