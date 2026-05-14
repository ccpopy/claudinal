import type { AppSettings } from "@/lib/settings"

export type PermissionMode = AppSettings["defaultPermissionMode"]
export type SessionPermissionModeSource = "default" | "session"

const PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions"
])

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODES.has(value as PermissionMode)
}

export function pickPermissionModeFromSidecar(sidecar: unknown): PermissionMode | null {
  if (!sidecar || typeof sidecar !== "object") return null
  const raw = (sidecar as { permissionMode?: unknown }).permissionMode
  return isPermissionMode(raw) ? raw : null
}

export function mergeSidecarPermissionMode(
  sidecar: unknown,
  mode: PermissionMode | null
): Record<string, unknown> {
  const base =
    sidecar && typeof sidecar === "object" && !Array.isArray(sidecar)
      ? { ...(sidecar as Record<string, unknown>) }
      : {}
  if (mode) {
    base.permissionMode = mode
  } else {
    delete base.permissionMode
  }
  return base
}
