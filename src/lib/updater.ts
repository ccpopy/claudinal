import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"
import { toast } from "sonner"
import { formatProxyUrl, loadProxyAsync } from "@/lib/proxy"

type CheckOptions = {
  silent?: boolean
  throwOnError?: boolean
}

let checkInFlight = false
let installInFlight = false

function describeUpdate(update: Update): string {
  const date = update.date ? new Date(update.date) : null
  const published =
    date && !Number.isNaN(date.getTime())
      ? `发布时间：${date.toLocaleString("zh-CN")}`
      : null
  const body = update.body?.trim()
  return [published, body].filter(Boolean).join("\n")
}

function formatProgress(event: DownloadEvent, state: { downloaded: number; total: number }) {
  if (event.event === "Started") {
    state.downloaded = 0
    state.total = event.data.contentLength ?? 0
  } else if (event.event === "Progress") {
    state.downloaded += event.data.chunkLength
  }
  if (state.total <= 0) return "正在下载更新包..."
  const percent = Math.min(100, Math.round((state.downloaded / state.total) * 100))
  return `正在下载更新包... ${percent}%`
}

async function updaterProxyUrl(): Promise<string | undefined> {
  try {
    const proxy = await loadProxyAsync()
    if (!proxy.enabled || !proxy.host || !proxy.port) return undefined
    return formatProxyUrl(proxy)
  } catch {
    return undefined
  }
}

export async function checkForAppUpdate(options: CheckOptions = {}): Promise<Update | null> {
  if (import.meta.env.DEV) {
    if (!options.silent) toast.info("开发模式不会检查应用更新")
    return null
  }
  if (checkInFlight) return null
  checkInFlight = true
  try {
    const proxy = await updaterProxyUrl()
    const update = await check({
      timeout: 30_000,
      ...(proxy ? { proxy } : {})
    } as Parameters<typeof check>[0])
    if (!update) {
      if (!options.silent) toast.success("当前已是最新版本")
      return null
    }

    toast.message(`发现新版本 ${update.version}`, {
      description: describeUpdate(update),
      action: {
        label: "安装并重启",
        onClick: () => {
          void installAppUpdate(update)
        }
      }
    })
    return update
  } catch (error) {
    if (options.silent) {
      console.error("检查应用更新失败:", error)
    } else {
      toast.error(`检查更新失败: ${String(error)}`)
    }
    if (options.throwOnError) throw error
    return null
  } finally {
    checkInFlight = false
  }
}

export async function installAppUpdate(update: Update): Promise<void> {
  if (installInFlight) return
  installInFlight = true
  const progress = { downloaded: 0, total: 0 }
  const toastId = toast.loading("正在准备更新...")
  try {
    await update.downloadAndInstall((event) => {
      toast.loading(formatProgress(event, progress), { id: toastId })
    })
    toast.success("更新安装完成，正在重启应用", { id: toastId })
    await relaunch()
  } catch (error) {
    toast.error(`安装更新失败: ${String(error)}`, { id: toastId })
  } finally {
    installInFlight = false
    await update.close().catch((error) => {
      console.error("释放 updater resource 失败:", error)
    })
  }
}
