/** Runtime-scoped receipts suppress duplicate UI and reply side effects. */
export class PermissionRequestReceipts {
  private pending = new Set<string>()
  private answered = new Map<string, true>()
  constructor(private limit = 512) {}
  private key(runtimeId: string, requestId: string) { return JSON.stringify([runtimeId, requestId]) }
  claim(runtimeId: string, requestId: string): boolean {
    const key = this.key(runtimeId, requestId)
    if (this.pending.has(key) || this.answered.has(key)) return false
    this.pending.add(key)
    return true
  }
  isPending(runtimeId: string, requestId: string): boolean { return this.pending.has(this.key(runtimeId, requestId)) }
  settle(runtimeId: string, requestId: string) {
    const key = this.key(runtimeId, requestId)
    this.pending.delete(key); this.answered.set(key, true)
    while (this.answered.size > this.limit) this.answered.delete(this.answered.keys().next().value!)
  }
  forgetRuntime(runtimeId: string) {
    for (const key of [...this.pending, ...this.answered.keys()]) {
      if ((JSON.parse(key) as [string, string])[0] === runtimeId) { this.pending.delete(key); this.answered.delete(key) }
    }
  }
}
