import type { AppSettings } from "@/lib/settings"

export type PermissionMode = AppSettings["defaultPermissionMode"]
export type SessionPermissionModeSource = "default" | "session"
export const FULL_ACCESS_DESCRIPTION = "允许联网和访问工作区外文件，关闭命令沙箱、放宽部分命令安全检查，并自动批准工具请求"

export const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string; description: string }> = [
  { value: "default", label: "默认权限", description: "使用 Claude CLI 默认权限策略" },
  { value: "acceptEdits", label: "接受编辑", description: "允许文件编辑，仍保留其它权限请求" },
  { value: "plan", label: "计划模式", description: "只规划，不直接执行修改" },
  { value: "bypassPermissions", label: "跳过权限", description: "跳过常规确认，保留 CLI 安全拦截" },
  { value: "fullAccess", label: "全部权限", description: FULL_ACCESS_DESCRIPTION }
]

/** Shared orange accent marking the full-access mode wherever it is shown. */
export const FULL_ACCESS_TEXT = "text-orange-700 hover:text-orange-800 focus:text-orange-800 data-[highlighted]:text-orange-800 dark:text-orange-400 dark:hover:text-orange-300 dark:focus:text-orange-300 dark:data-[highlighted]:text-orange-300"

const PERMISSION_MODES = new Set(PERMISSION_OPTIONS.map((item) => item.value))

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
