import { Image } from "@tauri-apps/api/image"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  isPermissionGranted,
  requestPermission,
  sendNotification
} from "@tauri-apps/plugin-notification"

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)

/** 首次开启时申请系统通知权限；返回是否可发送。 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true
  return (await requestPermission()) === "granted"
}

export async function notifyCompletion(title: string, body: string): Promise<void> {
  if (!(await isPermissionGranted())) return
  sendNotification({ title, body })
}

/** 截取 result 文本首行作为通知正文。 */
export function completionPreview(result: unknown, max = 80): string {
  if (typeof result !== "string") return ""
  const line = result.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? ""
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * 任务栏未读数：Windows 不支持 badge count，改用 overlay icon 绘制数字；
 * macOS / Linux 走原生 badge。count 为 0 时清除。
 */
export async function setUnreadBadge(count: number): Promise<void> {
  const win = getCurrentWindow()
  if (!isWindows) {
    await win.setBadgeCount(count > 0 ? count : undefined)
    return
  }
  await win.setOverlayIcon(count > 0 ? await overlayImage(count) : undefined)
}

async function overlayImage(count: number): Promise<Image> {
  const size = 32
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "#e5484d"
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()
  const label = count > 9 ? "9+" : String(count)
  ctx.fillStyle = "#fff"
  ctx.font = `bold ${label.length > 1 ? 17 : 22}px "Segoe UI", sans-serif`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(label, size / 2, size / 2 + 1)
  const { data } = ctx.getImageData(0, 0, size, size)
  return Image.new(new Uint8Array(data.buffer), size, size)
}
