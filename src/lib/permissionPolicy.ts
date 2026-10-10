import type { PermissionRequestPayload } from "@/lib/ipc"
import type { AppSettings } from "@/lib/settings"

export interface PermissionAutoApproval {
  response: Record<string, unknown>
  reason: string
}

/** A CLI request already reflects its mode, rules and hooks. Do not override it
 * with a second shell-word classifier or a tool allowlist. Explicit remembered
 * rules are handled separately by the permission dialog. */
export function autoApprovePermissionRequest(
  _request: PermissionRequestPayload,
  _mode: AppSettings["defaultPermissionMode"]
): PermissionAutoApproval | null {
  return null
}

export function buildPermissionAllowResponse(request: PermissionRequestPayload): Record<string, unknown> {
  const response: Record<string, unknown> = { behavior: "allow" }
  if (request.request.input !== undefined) response.updatedInput = request.request.input
  return response
}
