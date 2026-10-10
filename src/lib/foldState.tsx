import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react"

type ScrollPosition = { top: number; left: number }
type ScrollPositions = Map<string, ScrollPosition>

/** Only UI receipts are retained: no elements, content, or transcript payloads. */
export interface FoldStateStore {
  expanded: Map<string, boolean>
  scroll: Map<string, ScrollPositions>
}

export function createFoldStateStore(): FoldStateStore {
  return { expanded: new Map(), scroll: new Map() }
}

interface FoldScope { store: FoldStateStore; path: string[] }
const FoldContext = createContext<FoldScope | null>(null)
const FoldRevealContext = createContext<string | null>(null)

/** A one-shot navigation request expands only the targeted subtree. */
export function FoldReveal({ requestId, children }: { requestId?: string; children: ReactNode }) {
  return <FoldRevealContext.Provider value={requestId ?? null}>{children}</FoldRevealContext.Provider>
}

export function FoldStateScope({ store, scope, children }: {
  store?: FoldStateStore
  scope: string
  children: ReactNode
}) {
  const parent = useContext(FoldContext)
  const value = useMemo(() => {
    const owner = store ?? parent?.store
    return owner ? { store: owner, path: [...(store ? [] : parent?.path ?? []), scope] } : null
  }, [store, parent, scope])
  return <FoldContext.Provider value={value}>{children}</FoldContext.Provider>
}

export function useFoldOpen(name: string, initiallyOpen = false) {
  const scope = useContext(FoldContext)
  const reveal = useContext(FoldRevealContext)
  const revealedRef = useRef<string | null>(null)
  const key = JSON.stringify([...(scope?.path ?? []), name])
  const [open, setOpen] = useState(() => reveal !== null || (scope?.store.expanded.get(key) ?? initiallyOpen))
  const update = useCallback((value: SetStateAction<boolean>) => {
    setOpen((previous) => {
      const next = typeof value === "function" ? value(previous) : value
      scope?.store.expanded.set(key, next)
      return next
    })
  }, [scope, key])
  useLayoutEffect(() => {
    if (reveal !== null && revealedRef.current !== reveal) { revealedRef.current = reveal; update(true) }
  }, [reveal, update])
  return [open, update] as const
}

function elementPath(root: HTMLElement, target: HTMLElement): string | null {
  const path: number[] = []
  let node: Element | null = target
  while (node && node !== root) {
    const parent: Element | null = node.parentElement
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.children, node))
    node = parent
  }
  return node === root ? path.join("/") : null
}

export function captureFoldScroll(root: HTMLElement, positions: ScrollPositions): void {
  positions.clear()
  for (const node of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    if (!node.scrollTop && !node.scrollLeft) continue
    const path = elementPath(root, node)
    if (path !== null) positions.set(path, { top: node.scrollTop, left: node.scrollLeft })
  }
}

export function restoreFoldScroll(root: HTMLElement, positions: ScrollPositions): void {
  for (const [path, position] of positions) {
    let node: Element | undefined = root
    if (path) for (const index of path.split("/")) node = node?.children[Number(index)]
    if (!node) continue
    node.scrollTop = position.top
    node.scrollLeft = position.left
  }
}

function MountedFoldBody({ positions, className, children }: {
  positions: ScrollPositions
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const rememberRef = useCallback((node: HTMLDivElement | null) => {
    if (!node && ref.current) captureFoldScroll(ref.current, positions)
    ref.current = node
  }, [positions])
  useLayoutEffect(() => {
    if (ref.current) restoreFoldScroll(ref.current, positions)
  }, [positions])
  return <div ref={rememberRef} className={className}>{children}</div>
}

/** Closing actually unmounts heavy descendants; reopening restores their scroll. */
export function FoldBody({ open, name = "body", className, children }: {
  open: boolean
  name?: string
  className?: string
  children: ReactNode
}) {
  const scope = useContext(FoldContext)
  const local = useRef<ScrollPositions>(new Map())
  const key = JSON.stringify([...(scope?.path ?? []), name])
  let positions = scope?.store.scroll.get(key)
  if (!positions) {
    positions = local.current
    scope?.store.scroll.set(key, positions)
  }
  return open ? <MountedFoldBody positions={positions} className={className}>{children}</MountedFoldBody> : null
}
