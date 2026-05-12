import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"
import { toast } from "sonner"
import {
  appRuntimeInfo,
  normalizeProxyUrlForHttpClient,
  openExternal,
  type AppRuntimeInfo
} from "@/lib/ipc"
import { formatProxyUrl, loadProxyAsync } from "@/lib/proxy"

type CheckOptions = {
  silent?: boolean
  throwOnError?: boolean
}

let checkInFlight = false
let installInFlight = false
let runtimeInfoCache: AppRuntimeInfo | null = null
const RELEASE_TAG_URL = "https://github.com/ccpopy/claudinal/releases/tag"
const COMPACT_UPDATE_ACTION_BUTTON_STYLE = { marginLeft: 4, marginRight: 0 }

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
  const proxy = await loadProxyAsync()
  if (!proxy.enabled || !proxy.host || !proxy.port) return undefined
  return normalizeProxyUrlForHttpClient(formatProxyUrl(proxy))
}

function releasePageUrl(version: string): string {
  const tag = version.trim().startsWith("v") ? version.trim() : `v${version.trim()}`
  return `${RELEASE_TAG_URL}/${encodeURIComponent(tag)}`
}

async function openUpdateRelease(version: string): Promise<void> {
  try {
    await openExternal(releasePageUrl(version))
  } catch (error) {
    toast.error(`打开更新页面失败: ${String(error)}`)
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

    toast.message(`检测到有更新：${update.version}`, {
      cancel: {
        label: "查看更新",
        onClick: () => {
          void openUpdateRelease(update.version)
        }
      },
      action: {
        label: "安装并重启",
        onClick: () => {
          void installAppUpdate(update)
        }
      },
      actionButtonStyle: COMPACT_UPDATE_ACTION_BUTTON_STYLE
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
    toastId = toast.loading("正在准备更新...", {
      description: runtime?.executable_dir
        ? `目标目录：${runtime.executable_dir}`
        : undefined
    })
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
