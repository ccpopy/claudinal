import type { ClaudeEvent } from "@/types/events"

/** Only display text/thinking may wait for a paint frame. ACK, tool input,
 * permissions and terminal records remain synchronous ordering barriers. */
export function isDeferredTextEvent(event: ClaudeEvent): boolean {
  if (event.type !== "stream_event") return false
  const inner = (event as { event?: { type?: string; delta?: { type?: string } } }).event
  return inner?.type === "content_block_delta" && ["text_delta", "thinking_delta"].includes(inner.delta?.type ?? "")
}

type Schedule = (publish: () => void) => () => void
const scheduleFrame: Schedule = (publish) => {
  if (typeof requestAnimationFrame === "function" && document.visibilityState === "visible") {
    const id = requestAnimationFrame(publish)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(publish, 16)
  return () => clearTimeout(id)
}

/** Domain state is already authoritative; this batches only its publication. */
export class FramePublication {
  private cancelScheduled?: () => void
  constructor(private publish: () => void, private schedule: Schedule = scheduleFrame) {}
  defer() {
    if (this.cancelScheduled) return
    this.cancelScheduled = this.schedule(() => { this.cancelScheduled = undefined; this.publish() })
  }
  flush() {
    if (!this.cancelScheduled) return
    this.cancelScheduled(); this.cancelScheduled = undefined; this.publish()
  }
  immediate() { this.cancelScheduled?.(); this.cancelScheduled = undefined; this.publish() }
  cancel() { this.cancelScheduled?.(); this.cancelScheduled = undefined }
}
