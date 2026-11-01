import { useSyncExternalStore } from "react"
import { loadSettings } from "@/lib/settings"
import { subscribeSettingsBus } from "@/lib/settingsBus"

/**
 * Wrap streamed prose into per-word spans so newly appended words can fade in.
 *
 * react-markdown keys siblings by tag count (`span-0`, `span-1`, ...). Text only
 * grows at the tail while streaming, so unchanged Markdown subtrees keep their
 * spans and only new nodes animate. Markdown restructuring can replace a subtree.
 * Code is skipped, and completed replies return to ordinary text nodes.
 */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const SKIP_TAGS = new Set(["pre", "code", "kbd", "samp", "script", "style", "svg"])

let segmenter: Intl.Segmenter | null | undefined

function segments(text: string): string[] {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("zh", { granularity: "word" }) : null
  }
  if (segmenter) return Array.from(segmenter.segment(text), (part) => part.segment)
  return text.match(/\s+|[　-鿿＀-￯]|[^\s　-鿿＀-￯]+/g) ?? []
}

export function splitStreamWords(text: string): HastNode[] {
  const nodes: HastNode[] = []
  for (const part of segments(text)) {
    if (!part.trim()) {
      const last = nodes[nodes.length - 1]
      if (last?.type === "text") last.value += part
      else nodes.push({ type: "text", value: part })
    } else {
      nodes.push({ type: "element", tagName: "span", properties: { className: ["stream-word"] }, children: [{ type: "text", value: part }] })
    }
  }
  return nodes
}

export function rehypeStreamWords() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (!node.children || (node.tagName && SKIP_TAGS.has(node.tagName))) return
      const next: HastNode[] = []
      for (const child of node.children) {
        if (child.type === "text" && child.value) next.push(...splitStreamWords(child.value))
        else {
          visit(child)
          next.push(child)
        }
      }
      node.children = next
    }
    visit(tree)
  }
}

let enabled: boolean | null = null

function subscribe(onChange: () => void) {
  return subscribeSettingsBus("settings", () => { enabled = null; onChange() })
}

function snapshot() {
  enabled ??= loadSettings().streamReveal !== false
  return enabled
}

export function useStreamReveal(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
