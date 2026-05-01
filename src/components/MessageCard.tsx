import { useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cog,
  DollarSign,
  FileWarning,
  Gauge,
  Loader2,
  ShieldAlert,
  Timer,
  Webhook
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
  if (entry.kind === "hook") return <HookEventView e={entry} />
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
    <div
      className={cn(
        "flex flex-col gap-2 items-stretch",
        msg.queued && "opacity-70"
      )}
    >
      {msg.blocks.map((b, i) => (
        <BlockView key={i} role={msg.role} block={b} />
      ))}
      {msg.queued && msg.role === "user" && (
        <div className="self-end inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock className="size-3" />
          <span>已交给 Claude，等待当前步骤后处理</span>
        </div>
      )}
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

interface PermissionDenial {
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
}

function ResultView({ e }: { e: Extract<UIEntry, { kind: "result" }> }) {
  const denials = (e.permissionDenials as PermissionDenial[] | undefined) ?? []
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <div
        className={cn(
          "flex flex-wrap items-center gap-3 text-xs",
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
      {denials.length > 0 && <PermissionDenialList denials={denials} />}
    </div>
  )
}

function PermissionDenialList({ denials }: { denials: PermissionDenial[] }) {
  const [open, setOpen] = useState(true)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={ShieldAlert}
      label={`权限被拒 · ${denials.length} 个工具`}
      tone="error"
    >
      <div className="space-y-1.5">
        {denials.map((d, i) => (
          <DenialRow key={d.tool_use_id ?? i} d={d} />
        ))}
        <div className="text-[11px] text-muted-foreground">
          运行 <code className="font-mono px-1 bg-muted rounded">/permissions</code> 把上述工具加白名单后重试。
        </div>
      </div>
    </ExpandableRow>
  )
}

function DenialRow({ d }: { d: PermissionDenial }) {
  const name = d.tool_name ?? "?"
  const input = d.tool_input ?? {}
  const cmd = (input.command as string) ?? null
  const fp = (input.file_path as string) ?? (input.path as string) ?? null
  const summary = cmd ?? fp ?? JSON.stringify(input).slice(0, 120)

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-destructive">{name}</div>
      </div>
      <div className="font-mono break-all text-foreground/80">{summary}</div>
    </div>
  )
}

function HookEventView({ e }: { e: Extract<UIEntry, { kind: "hook" }> }) {
  const [open, setOpen] = useState(false)
  return (
    <ExpandableRow
      open={open}
      onToggle={() => setOpen(!open)}
      icon={Webhook}
      label={`hook · ${e.hookEventName ?? "event"}${e.toolName ? ` · ${e.toolName}` : ""}`}
    >
      <CodeBlock>{JSON.stringify(e.raw, null, 2)}</CodeBlock>
    </ExpandableRow>
  )
}
