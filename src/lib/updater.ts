import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"
import { toast } from "sonner"
import { appRuntimeInfo, openExternal, type AppRuntimeInfo } from "@/lib/ipc"
import { formatProxyUrl, loadProxyAsync } from "@/lib/proxy"

type CheckOptions = {
  silent?: boolean
  throwOnError?: boolean
}

const RELEASES_URL = "https://github.com/ccpopy/claudinal/releases/latest"

let checkInFlight = false
let installInFlight = false
let runtimeInfoCache: AppRuntimeInfo | null = null

async function readRuntimeInfo(): Promise<AppRuntimeInfo | null> {
  if (runtimeInfoCache) return runtimeInfoCache
  try {
    runtimeInfoCache = await appRuntimeInfo()
    return runtimeInfoCache
  } catch (error) {
    console.error("读取应用运行信息失败:", error)
    return null
  }
}

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

function portableUpdateDescription(update: Update, runtime: AppRuntimeInfo): string {
  return [
    describeUpdate(update),
    "当前运行的是 Windows 绿色版，自动更新包是安装版，不会替换当前 exe。",
    `当前运行路径：${runtime.executable_path}`,
    "请下载 portable.zip 后覆盖当前目录，或改用安装版。"
  ]
    .filter(Boolean)
    .join("\n")
}

function closeUpdateQuietly(update: Update): void {
  void update.close().catch((error) => {
    console.error("释放 updater resource 失败:", error)
  })
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

    const runtime = await readRuntimeInfo()
    if (runtime?.windows_portable) {
      toast.message(`发现新版本 ${update.version}`, {
        description: portableUpdateDescription(update, runtime),
        action: {
          label: "打开下载页",
          onClick: () => {
            void openExternal(RELEASES_URL).catch((error) =>
              toast.error(String(error))
            )
          }
        }
      })
      closeUpdateQuietly(update)
      return update
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
  let toastId: string | number | null = null
  try {
    const runtime = await readRuntimeInfo()
    if (runtime?.windows_portable) {
      toast.warning("绿色版不会被自动更新替换", {
        description: portableUpdateDescription(update, runtime),
        action: {
          label: "打开下载页",
          onClick: () => {
            void openExternal(RELEASES_URL).catch((error) =>
              toast.error(String(error))
            )
          }
        }
      })
      return
    }
    toastId = toast.loading("正在准备更新...")
    await update.downloadAndInstall((event) => {
      toast.loading(formatProgress(event, progress), { id: toastId ?? undefined })
    })
    toast.success("更新安装完成，正在重启应用", { id: toastId ?? undefined })
    await relaunch()
  } catch (error) {
    toast.error(`安装更新失败: ${String(error)}`, {
      id: toastId ?? undefined
    })
  } finally {
    installInFlight = false
    await update.close().catch((error) => {
      console.error("释放 updater resource 失败:", error)
    })
  }
}
