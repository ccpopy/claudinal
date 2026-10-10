import { useEffect, useSyncExternalStore } from "react"
import { installedCliCapabilities } from "@/lib/installedCliCapabilities"

export function useInstalledCliCapabilities() {
  const snapshot = useSyncExternalStore(installedCliCapabilities.subscribe, installedCliCapabilities.getSnapshot, installedCliCapabilities.getSnapshot)
  useEffect(() => {
    const refresh = () => { installedCliCapabilities.invalidate(); void installedCliCapabilities.refresh() }
    void installedCliCapabilities.refresh()
    window.addEventListener("claudinal:cli-installation-changed", refresh)
    return () => {
      window.removeEventListener("claudinal:cli-installation-changed", refresh)
      installedCliCapabilities.invalidate()
    }
  }, [])
  return snapshot
}
