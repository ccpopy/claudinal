const SQLITE_LOCK_ERRORS = ["database is locked", "database table is locked"]

/** SQLite 派生索引的跨进程锁竞争是可重试状态，不应覆盖已有会话列表。 */
export function isTransientSessionIndexLockError(error: unknown): boolean {
  const message = String(error).toLowerCase()
  return (
    message.includes("sqlite") &&
    SQLITE_LOCK_ERRORS.some((lockError) => message.includes(lockError))
  )
}
