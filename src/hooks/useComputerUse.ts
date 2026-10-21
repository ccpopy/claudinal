import { useEffect, useSyncExternalStore } from "react"
import { computerUse } from "@/lib/computerUse"
import { listenComputerUsePermission, listenComputerUseStatus } from "@/lib/ipc"

export function useComputerUse(conversationKey: string, runtimeId: string | null, isRuntimeAlive: (id: string) => boolean, isViewCurrent: (key: string, runtimeId: string) => boolean) {
  const snapshot = useComputerUseSnapshot()
  computerUse.isRuntimeAlive = isRuntimeAlive
  computerUse.isViewCurrent = isViewCurrent
  useEffect(() => { computerUse.selectView(conversationKey, runtimeId) }, [conversationKey, runtimeId])
  useEffect(() => {
    let released = false
    const unlisten: Array<() => void> = []
    const retain = (stop: () => void) => { if (released) stop(); else unlisten.push(stop) }
    void listenComputerUseStatus((status) => {
      if (released) return
      computerUse.acceptStatus(status)
      if (status.runtime?.runtimeId !== computerUse.getSnapshot().runtimeId) void computerUse.refresh()
    }).then(retain).catch(() => { if (!released) void computerUse.refresh() })
    void listenComputerUsePermission((request) => { if (!released) { computerUse.acceptRequest(request); void computerUse.refresh() } }).then(retain).catch(() => {})
    void computerUse.refresh()
    const refresh = () => { void computerUse.refresh() }
    window.addEventListener("focus", refresh)
    return () => { released = true; unlisten.forEach((stop) => stop()); window.removeEventListener("focus", refresh) }
  }, [])
  return snapshot
}
export function useComputerUseSnapshot() {
  return useSyncExternalStore(computerUse.subscribe, computerUse.getSnapshot, computerUse.getSnapshot)
}
