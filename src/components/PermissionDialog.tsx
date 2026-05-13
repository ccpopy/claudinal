import { useEffect, useMemo, useState } from "react"
import { ShieldAlert, ShieldCheck, XCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  resolvePermissionRequest,
  type PermissionRequestPayload,
  type PermissionUpdate
} from "@/lib/ipc"
import {
  canRememberExactPermission,
  canRememberCategoryPermission,
  classifyPermissionRequestCategory,
  rememberCategoryPermissionRequest,
  rememberExactPermissionRequest
} from "@/lib/permissionMemory"

interface Props {
  request: PermissionRequestPayload | null
  onSettled: (requestId: string) => void
}

export function PermissionDialog({ request, onSettled }: Props) {
  const [busy, setBusy] = useState(false)
  const addRulesSuggestion = useMemo(
    () => firstAddRulesSuggestion(request),
    [request]
  )
  const acceptEditsSuggestion = useMemo(
    () => firstAcceptEditsSuggestion(request),
    [request]
  )
  const canRememberExact = canRememberExactPermission(request)
  const canRememberCategory = canRememberCategoryPermission(request)
  const permissionCategory = useMemo(
    () => classifyPermissionRequestCategory(request),
    [request]
  )
  const isEdit = isEditRequest(request)
  const supportsPermissionUpdates = request?.transport !== "mcp"

  useEffect(() => {
    setBusy(false)
  }, [request?.request_id])

  const settle = async (response: Record<string, unknown>) => {
    if (!request || busy) return
    setBusy(true)
    try {
      await resolvePermissionRequest({
        sessionId: request.session_id,
        requestId: request.request_id,
        transport: request.transport ?? null,
        response
      })
      onSettled(request.request_id)
    } catch (e) {
      toast.error(`权限响应失败: ${String(e)}`)
      setBusy(false)
    }
  }

  const deny = () =>
    settle({
      behavior: "deny",
      message: "用户拒绝了这次权限请求，请不要执行该操作。"
    })

  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open && request && !busy) deny()
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden"
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-warn" />
            需要授权
          </DialogTitle>
          <DialogDescription>
            Claude Code 请求执行一个需要确认的操作。
          </DialogDescription>
        </DialogHeader>

        {request && (
          <div className="min-h-0 space-y-3 overflow-y-auto pr-1 text-sm scrollbar-thin">
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <div className="text-xs text-muted-foreground mb-1">工具</div>
              <div className="font-mono break-all">
                {request.request.display_name ??
                  request.request.tool_name ??
                  "未知工具"}
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <div className="text-xs text-muted-foreground mb-1">来源</div>
              <div className="space-y-1 font-mono text-xs">
                <div className="break-all">session: {request.session_id}</div>
                {request.cwd && <div className="break-all">cwd: {request.cwd}</div>}
              </div>
            </div>
            {request.request.description && (
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="text-xs text-muted-foreground mb-1">说明</div>
                <div className="break-all">{request.request.description}</div>
              </div>
            )}
            <div>
              <div className="text-xs text-muted-foreground mb-1">参数</div>
              <ToolInputView input={request.request.input} />
            </div>
          </div>
        )}

        <DialogFooter className="shrink-0 flex-wrap sm:justify-between">
          <Button
            type="button"
            variant="destructive"
            onClick={deny}
            disabled={!request || busy}
          >
            <XCircle />
            否
          </Button>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (request) settle(allowResponse(request))
              }}
              disabled={!request || busy}
            >
              <ShieldCheck />
              是
            </Button>
            {supportsPermissionUpdates && isEdit && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!request) return
                  settle(
                    allowResponse(request, [
                      withDestination(
                        acceptEditsSuggestion ?? {
                          type: "setMode",
                          mode: "acceptEdits"
                        },
                        "session"
                      )
                    ])
                  )
                }}
                disabled={!request || busy}
              >
                此次会话允许所有编辑
              </Button>
            )}
            {supportsPermissionUpdates && addRulesSuggestion && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!request) return
                  settle(
                    allowResponse(request, [
                      withDestination(addRulesSuggestion, "session")
                    ])
                  )
                }}
                disabled={!request || busy}
              >
                此次会话允许此类工具
              </Button>
            )}
            {supportsPermissionUpdates && addRulesSuggestion && (
              <Button
                type="button"
                onClick={() => {
                  if (!request) return
                  settle(
                    allowResponse(request, [
                      withDestination(addRulesSuggestion, "localSettings")
                    ])
                  )
                }}
                disabled={!request || busy}
              >
                以后允许此类工具
              </Button>
            )}
            {canRememberCategory && (
              <Button
                type="button"
                variant="outline"
                title={permissionCategory?.description}
                onClick={() => {
                  if (!request) return
                  try {
                    const rule = rememberCategoryPermissionRequest(request)
                    toast.success(`已记住此项目下的分类规则: ${rule.label}`)
                    settle(allowResponse(request))
                  } catch (e) {
                    toast.error(String(e))
                  }
                }}
                disabled={!request || busy}
              >
                以后允许此类命令
              </Button>
            )}
            {canRememberExact && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!request) return
                  try {
                    rememberExactPermissionRequest(request)
                    toast.success("已记住此项目下的精确命令")
                    settle(allowResponse(request))
                  } catch (e) {
                    toast.error(String(e))
                  }
                }}
                disabled={!request || busy}
              >
                以后允许此精确命令
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function firstAddRulesSuggestion(
  request: PermissionRequestPayload | null
): PermissionUpdate | null {
  const suggestions = request?.request.permission_suggestions
  if (!Array.isArray(suggestions)) return null
  return (
    suggestions.find(
      (s) =>
        s &&
        typeof s === "object" &&
        s.type === "addRules" &&
        s.behavior === "allow" &&
        Array.isArray(s.rules) &&
        s.rules.length > 0
    ) ?? null
  )
}

function firstAcceptEditsSuggestion(
  request: PermissionRequestPayload | null
): PermissionUpdate | null {
  const suggestions = request?.request.permission_suggestions
  if (!Array.isArray(suggestions)) return null
  return (
    suggestions.find(
      (s) =>
        s &&
        typeof s === "object" &&
        s.type === "setMode" &&
        s.mode === "acceptEdits"
    ) ?? null
  )
}

function withDestination(
  update: PermissionUpdate,
  destination: "session" | "localSettings"
): PermissionUpdate {
  return { ...update, destination }
}

function isEditRequest(request: PermissionRequestPayload | null): boolean {
  const name = request?.request.tool_name?.toLowerCase()
  return (
    name === "write" ||
    name === "edit" ||
    name === "multiedit" ||
    name === "notebookedit"
  )
}

function allowResponse(
  request: PermissionRequestPayload,
  updatedPermissions?: PermissionUpdate[]
): Record<string, unknown> {
  const response: Record<string, unknown> = { behavior: "allow" }
  if (request.request.input !== undefined) {
    response.updatedInput = request.request.input
  }
  if (updatedPermissions?.length) {
    response.updatedPermissions = updatedPermissions
  }
  return response
}

function ToolInputView({
  input
}: {
  input: Record<string, unknown> | undefined
}) {
  const entries = input ? Object.entries(input) : []
  if (entries.length === 0) {
    return (
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        无参数
      </div>
    )
  }
  return (
    <div className="max-h-[38vh] space-y-2 overflow-auto rounded-md border bg-muted/30 p-3 text-xs scrollbar-thin">
      {entries.map(([key, value]) => (
        <ToolInputField key={key} name={key} value={value} />
      ))}
    </div>
  )
}

function ToolInputField({ name, value }: { name: string; value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-muted-foreground">{name}:</span>
        <span className="font-mono">{String(value)}</span>
      </div>
    )
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return (
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-muted-foreground">{name}:</span>
        <span className="font-mono">{String(value)}</span>
      </div>
    )
  }
  if (typeof value === "string") {
    const isLong = value.includes("\n") || value.length > 80
    if (isLong) {
      return (
        <div className="space-y-1">
          <div className="font-mono text-muted-foreground">{name}</div>
          <pre className="max-h-72 overflow-auto rounded border bg-background p-2 font-mono whitespace-pre-wrap break-words scrollbar-thin">
            {value}
          </pre>
        </div>
      )
    }
    return (
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-muted-foreground">{name}:</span>
        <span className="font-mono break-all">{value}</span>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <div className="font-mono text-muted-foreground">{name}</div>
      <pre className="max-h-72 overflow-auto rounded border bg-background p-2 font-mono whitespace-pre-wrap break-words scrollbar-thin">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}
