import type { PermissionRequestPayload } from "@/lib/ipc"
import type { AppSettings } from "@/lib/settings"

export interface PermissionAutoApproval {
  response: Record<string, unknown>
  reason: string
}

/** Ordinary modes leave CLI requests interactive. Full access is an explicit
 * app-owned authorization for tool requests delivered to this runtime's host;
 * it cannot override CLI hard denials or native desktop window consent. */
export function autoApprovePermissionRequest(
  request: PermissionRequestPayload,
  mode: AppSettings["defaultPermissionMode"]
): PermissionAutoApproval | null {
  if (mode !== "fullAccess") return null
  const tool = request.request?.tool_name
  if (typeof tool !== "string" || !tool.trim() || tool === "AskUserQuestion"
    || tool === "ExitPlanMode" || tool === "EnterPlanMode") return null
  return { response: buildPermissionAllowResponse(request), reason: "当前会话已启用全部权限" }
}

export function buildPermissionAllowResponse(request: PermissionRequestPayload): Record<string, unknown> {
  const response: Record<string, unknown> = { behavior: "allow" }
  if (request.request.input !== undefined) response.updatedInput = request.request.input
  return response
}
