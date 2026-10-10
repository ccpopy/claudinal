import { findSessionInputReceipts, type InputReceiptQuery, type InputReceiptScan } from "./ipc"
import { removeOutboxAttempt, type OutboxHeader } from "./outbox"

export interface OutboxRecoveryScope {
  cwd?: string
  liveMessageIds: readonly string[]
  activeRuntimeIds: readonly string[]
}

export function isOrphanOutbox(input: OutboxHeader, scope: OutboxRecoveryScope): boolean {
  return input.cwd === scope.cwd && !scope.liveMessageIds.includes(input.id)
    && (!input.runtimeId || !scope.activeRuntimeIds.includes(input.runtimeId))
}

interface RecoveryAdapter {
  find(cwd: string, inputs: InputReceiptQuery[]): Promise<InputReceiptScan>
  remove(id: string, attemptId: string): Promise<boolean>
  /** Recheck runtime/UI ownership after asynchronous filesystem work. */
  stillOrphan?(input: OutboxHeader): boolean
}

/** Reconcile only exact current-attempt receipts; never send or rewrite input. */
export async function reconcileOutboxHeaders(
  headers: OutboxHeader[], scope: OutboxRecoveryScope,
  adapter: RecoveryAdapter = { find: findSessionInputReceipts, remove: removeOutboxAttempt }
): Promise<{ headers: OutboxHeader[]; unavailableReason?: string }> {
  const candidates = headers.filter((input) => isOrphanOutbox(input, scope) && !!input.attemptId)
  if (!scope.cwd || !candidates.length) return { headers }
  let scan: InputReceiptScan
  try {
    scan = await adapter.find(scope.cwd, candidates.map((input) => ({ attemptId: input.attemptId!, sessionId: input.conversationId })))
  } catch {
    return { headers, unavailableReason: "无法核对会话接收记录，本地输入已保留；恢复前请先检查原会话" }
  }
  if (!scan.complete) return { headers, unavailableReason: scan.reason ?? "会话接收记录暂不可核对，本地输入已保留" }
  const removed = new Set<string>()
  for (const input of candidates) {
    if (!scan.accepted.some((receipt) => receipt.attemptId === input.attemptId
      && (!input.conversationId || receipt.sessionId === input.conversationId))) continue
    if (adapter.stillOrphan?.(input) === false) continue
    try {
      if (await adapter.remove(input.id, input.attemptId!)) removed.add(input.id)
    } catch {
      return { headers: headers.filter((input) => !removed.has(input.id)), unavailableReason: "已确认接收，但清理本地副本失败；请检查原会话" }
    }
  }
  return { headers: headers.filter((input) => !removed.has(input.id)) }
}
