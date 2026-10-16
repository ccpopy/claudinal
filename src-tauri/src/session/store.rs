//! SQLite store —— 派生 cache，绝不是真理源。
//!
//! 真理源恒为 `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` 与同目录
//! `<session_id>.claudinal.json` sidecar。本模块所有表都可被 drop 后从文件重建，
//! 因此 schema 演进策略为：
//!
//! * 已知旧版本 → 探测式 ALTER 加列 / CREATE IF NOT EXISTS。
//! * `user_version` 大于本程序认识的 `SCHEMA_VERSION`（即用户从更新版本回退）→
//!   把旧库整体重命名为 `*.bak.<ts>` 后重建空库；用户**不会**因此丢任何会话数据。
//!
//! 同样的保证扩展到所有派生表（usage / activity_bucket / FTS）：写盘的真理源永远是
//! jsonl + sidecar，重建库只是丢失 cache。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::app_paths::claudinal_dir;
use crate::error::{Error, Result};

pub const SCHEMA_VERSION: i64 = 7;

pub fn db_path() -> Result<PathBuf> {
    Ok(claudinal_dir()?.join("session-index-v1.sqlite3"))
}

/// 全局共享 Connection。
///
/// 所有 store 调用方走同一个连接 + 进程内 Mutex 串行化，避免在 WAL 模式下
/// 多个 writer 同时持有写锁时撞 `database is locked`（busy_timeout 到期）。
/// 调用方通过 `open()` 拿到 `LockedConn`（即 `MutexGuard<Connection>`），
/// 离开作用域时锁自动释放。
static CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

/// 首次初始化时用来防止两个线程同时打开 / 迁移数据库的入口锁。
/// 一旦 `CONN` 被填好，后续走 fast path，永远不再触碰 `INIT`。
static INIT: Mutex<()> = Mutex::new(());

pub type LockedConn = MutexGuard<'static, Connection>;

/// 拿到全局 Connection 的独占锁。首次调用会打开 / 迁移数据库。
pub fn open() -> Result<LockedConn> {
    if let Some(m) = CONN.get() {
        return Ok(m.lock().unwrap_or_else(|e| e.into_inner()));
    }
    let _init_guard = INIT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(m) = CONN.get() {
        return Ok(m.lock().unwrap_or_else(|e| e.into_inner()));
    }

    let path = db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let conn = match try_open_and_migrate(&path) {
        Ok(c) => c,
        Err(Error::Sqlite(e)) if is_rebuildable_database_error(&e) => {
            tracing::warn!("session db corrupted, rebuilding: {e}");
            backup_and_recreate(&path)?
        }
        Err(Error::Other(msg)) if msg.starts_with("SCHEMA_DOWNGRADE") => {
            tracing::warn!("session db newer than supported, rebuilding: {msg}");
            backup_and_recreate(&path)?
        }
        Err(e) => return Err(e),
    };

    let _ = CONN.set(Mutex::new(conn));
    Ok(CONN
        .get()
        .expect("CONN just set")
        .lock()
        .unwrap_or_else(|e| e.into_inner()))
}

fn is_rebuildable_database_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, _)
            if matches!(
                code.code,
                rusqlite::ffi::ErrorCode::DatabaseCorrupt
                    | rusqlite::ffi::ErrorCode::NotADatabase
            )
    )
}

fn try_open_and_migrate(path: &std::path::Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    apply_pragmas(&conn)?;
    create_or_migrate_schema(&mut conn)?;
    Ok(conn)
}

fn backup_and_recreate(path: &std::path::Path) -> Result<Connection> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for suffix in ["", "-wal", "-shm"] {
        let from = path.with_file_name(format!(
            "{}{}",
            path.file_name().and_then(|s| s.to_str()).unwrap_or("db"),
            suffix
        ));
        if from.is_file() {
            let to = from.with_extension(format!("bak.{ts}"));
            let _ = std::fs::rename(&from, &to);
        }
    }
    let mut conn = Connection::open(path)?;
    apply_pragmas(&conn)?;
    create_or_migrate_schema(&mut conn)?;
    Ok(conn)
}

fn apply_pragmas(conn: &Connection) -> Result<()> {
    // busy_timeout 必须先于任何可能抢锁的 PRAGMA / schema migration 设置。
    // 多个 Claudinal 实例同时启动时，journal_mode 也可能遇到跨进程 writer。
    conn.busy_timeout(std::time::Duration::from_secs(15))?;
    let journal_mode: String = conn.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        conn.pragma_update(None, "journal_mode", "WAL")?;
    }
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    let _ = conn.pragma_update(None, "mmap_size", 268_435_456_i64);
    Ok(())
}

/// 派生索引的写事务必须在开始时就取得 writer reservation。
///
/// `DEFERRED` 事务先读缓存、再写更新时，如果另一个 Claudinal 进程已提交写入，
/// SQLite 会以 `SQLITE_BUSY_SNAPSHOT` 拒绝读事务升级，而且不会等待 busy timeout。
/// `IMMEDIATE` 让竞争发生在事务入口，SQLite 因而可以按 busy timeout 等待。
pub fn begin_write(conn: &mut Connection) -> Result<Transaction<'_>> {
    Ok(conn.transaction_with_behavior(TransactionBehavior::Immediate)?)
}

fn create_or_migrate_schema(conn: &mut Connection) -> Result<()> {
    // Read the schema version only after reserving the writer. Another process
    // may finish the same upgrade while this connection waits for the lock.
    let tx = begin_write(conn)?;
    let conn = &tx;
    let from_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if from_version > SCHEMA_VERSION {
        return Err(Error::Other(format!(
            "SCHEMA_DOWNGRADE current={from_version} max_supported={SCHEMA_VERSION}"
        )));
    }
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS session_index (
          cwd TEXT NOT NULL,
          session_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          modified_ts INTEGER NOT NULL,
          modified_millis INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          msg_count INTEGER NOT NULL,
          ai_title TEXT,
          first_user_text TEXT,
          indexed_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (cwd, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_session_index_cwd_modified
          ON session_index(cwd, modified_ts DESC);
        "#,
    )?;
    ensure_column(
        conn,
        "session_index",
        "indexed_at",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "session_index", "cwd_raw", "TEXT")?;
    ensure_column(conn, "session_index", "dir_label", "TEXT")?;
    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_session_index_modified
          ON session_index(modified_ts DESC);

        CREATE TABLE IF NOT EXISTS session_usage (
          session_id TEXT PRIMARY KEY,
          sidecar_path TEXT NOT NULL,
          sidecar_mtime_millis INTEGER NOT NULL,
          sidecar_size INTEGER NOT NULL,
          cost_usd REAL NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0,
          cache_write INTEGER NOT NULL DEFAULT 0,
          by_model_json TEXT,
          parse_error TEXT,
          indexed_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS activity_bucket (
          date TEXT NOT NULL,
          hour INTEGER NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY(date, hour)
        );
        CREATE INDEX IF NOT EXISTS idx_activity_bucket_date
          ON activity_bucket(date);

        CREATE TABLE IF NOT EXISTS heatmap_progress (
          file_path TEXT PRIMARY KEY,
          last_size INTEGER NOT NULL,
          last_mtime_millis INTEGER NOT NULL,
          byte_offset INTEGER NOT NULL DEFAULT 0,
          last_scanned_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS fts_progress (
          file_path TEXT PRIMARY KEY,
          last_size INTEGER NOT NULL,
          last_mtime_millis INTEGER NOT NULL,
          byte_offset INTEGER NOT NULL DEFAULT 0,
          record_count INTEGER NOT NULL DEFAULT 0,
          last_scanned_at INTEGER NOT NULL DEFAULT 0
        );

        DROP TABLE IF EXISTS jsonl_scan_progress;

        "#,
    )?;

    ensure_column(
        conn,
        "fts_progress",
        "record_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;

    if from_version < 6 {
        // FTS virtual tables cannot gain locator columns through ALTER TABLE.
        // Rebuild this derived cache once, including unchanged transcripts.
        conn.execute_batch(
            r#"
            DROP TABLE IF EXISTS session_text;
            DELETE FROM fts_progress;
            "#,
        )?;
    }

    conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS session_text USING fts5(
          session_id UNINDEXED,
          cwd UNINDEXED,
          role UNINDEXED,
          ts UNINDEXED,
          body,
          message_uuid UNINDEXED,
          transcript_index UNINDEXED,
          file_path UNINDEXED,
          tokenize = 'unicode61 remove_diacritics 2'
        );
        "#,
    )?;

    if from_version < 5 {
        // v5 excludes CLI-generated context by provenance; rebuild derived
        // search/title caches so unchanged transcripts also get reclassified.
        conn.execute_batch(
            r#"
            DELETE FROM session_index;
            DELETE FROM fts_progress;
            DELETE FROM session_text;
            "#,
        )?;
    }

    if from_version < 7 {
        // Old title candidates truncated the serialized command before it
        // could be decoded. Refresh affected metadata even if its JSONL has
        // not changed; a frontend-only decoder cannot repair a partial tag.
        // This is a one-time cache invalidation, including literal examples,
        // rather than a condition that would rescan those examples forever.
        conn.execute_batch(
            r#"
            DELETE FROM session_index
            WHERE first_user_text LIKE '<command-message>%'
               OR first_user_text LIKE '<command-name>%'
               OR ai_title LIKE '<command-message>%'
               OR ai_title LIKE '<command-name>%';
            "#,
        )?;
    }

    if from_version != SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn test_connection() -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    create_or_migrate_schema(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
pub(super) fn test_migrate_schema(conn: &mut Connection) -> Result<()> {
    create_or_migrate_schema(conn)
}

fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
        [],
    )?;
    Ok(())
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// SQLite 索引诊断结构。仅用作 GUI 透明展示派生 cache 状态，
/// 真理源仍是磁盘上的 jsonl + sidecar。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexDiagnostics {
    pub path: String,
    pub schema_version: i64,
    pub expected_schema_version: i64,
    pub file_size_bytes: u64,
    pub session_index_rows: i64,
    pub session_usage_rows: i64,
    pub activity_bucket_rows: i64,
    pub heatmap_progress_rows: i64,
    pub fts_progress_rows: i64,
    pub session_text_rows: i64,
}

/// 读取诊断信息：文件大小 + schema 版本 + 各派生表行数。
/// 损坏 / 缺失表会让计数报错；返回错误时 GUI 会引导用户重建索引。
pub fn diagnostics() -> Result<SessionIndexDiagnostics> {
    let path = db_path()?;
    let file_size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    let conn = open()?;
    let schema_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let count = |table: &str| -> Result<i64> {
        Ok(
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })?,
        )
    };

    Ok(SessionIndexDiagnostics {
        path: path.display().to_string(),
        schema_version,
        expected_schema_version: SCHEMA_VERSION,
        file_size_bytes,
        session_index_rows: count("session_index")?,
        session_usage_rows: count("session_usage")?,
        activity_bucket_rows: count("activity_bucket")?,
        heatmap_progress_rows: count("heatmap_progress")?,
        fts_progress_rows: count("fts_progress")?,
        session_text_rows: count("session_text")?,
    })
}

/// 重建索引：清空所有派生表 + FTS。schema 与 db 文件保留，
/// 下次列表 / 用量扫描会按 jsonl + sidecar 重新填充。
///
/// 不动 jsonl、不动 sidecar、不动 keychain；仅重置 cache。
pub fn rebuild() -> Result<()> {
    let conn = open()?;
    conn.execute_batch(
        r#"
        DELETE FROM session_index;
        DELETE FROM session_usage;
        DELETE FROM activity_bucket;
        DELETE FROM heatmap_progress;
        DELETE FROM fts_progress;
        DELETE FROM session_text;
        "#,
    )?;
    let _ = conn.execute_batch("VACUUM;");
    Ok(())
}

pub fn as_i64<T>(value: T, field: &str) -> Result<i64>
where
    T: TryInto<i64> + Copy + std::fmt::Display,
{
    value
        .try_into()
        .map_err(|_| Error::Other(format!("{field} out of sqlite range: {value}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::time::Duration;

    #[test]
    fn lock_contention_is_not_treated_as_database_corruption() {
        for code in [rusqlite::ffi::SQLITE_BUSY, rusqlite::ffi::SQLITE_LOCKED] {
            let error = rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                Some("database is locked".into()),
            );
            assert!(!is_rebuildable_database_error(&error));
        }

        for code in [rusqlite::ffi::SQLITE_CORRUPT, rusqlite::ffi::SQLITE_NOTADB] {
            let error = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), None);
            assert!(is_rebuildable_database_error(&error));
        }
    }

    #[test]
    fn write_transaction_reserves_the_writer_before_reading() -> Result<()> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "claudinal-immediate-transaction-{}-{nonce}.sqlite3",
            std::process::id()
        ));

        {
            let setup = Connection::open(&path)?;
            setup.pragma_update(None, "journal_mode", "WAL")?;
            setup.execute("CREATE TABLE items (value INTEGER NOT NULL)", [])?;
        }

        let mut first = Connection::open(&path)?;
        first.busy_timeout(Duration::from_secs(2))?;
        let first_tx = begin_write(&mut first)?;
        let _: i64 = first_tx.query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))?;

        let writer_path = path.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let mut second = Connection::open(writer_path).expect("open competing connection");
            second
                .busy_timeout(Duration::from_secs(2))
                .expect("set competing busy timeout");
            started_tx.send(()).expect("signal competing writer start");
            let second_tx = begin_write(&mut second).expect("wait for writer reservation");
            second_tx
                .execute("INSERT INTO items (value) VALUES (2)", [])
                .expect("write from competing connection");
            acquired_tx
                .send(())
                .expect("signal competing writer acquisition");
            second_tx.commit().expect("commit competing connection");
        });

        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("competing writer should start");
        assert!(matches!(
            acquired_rx.recv_timeout(Duration::from_millis(300)),
            Err(RecvTimeoutError::Timeout)
        ));

        first_tx.execute("INSERT INTO items (value) VALUES (1)", [])?;
        first_tx.commit()?;
        acquired_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("competing writer should proceed after commit");
        writer.join().expect("competing writer thread");
        drop(first);

        for candidate in [
            path.clone(),
            path.with_file_name(format!(
                "{}-wal",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("")
            )),
            path.with_file_name(format!(
                "{}-shm",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("")
            )),
        ] {
            let _ = std::fs::remove_file(candidate);
        }
        Ok(())
    }

    #[test]
    fn v4_migration_invalidates_visibility_dependent_caches() -> Result<()> {
        let mut conn = Connection::open_in_memory()?;
        create_or_migrate_schema(&mut conn)?;
        conn.execute(
            r#"
            INSERT INTO session_index
              (cwd, session_id, file_path, modified_ts, modified_millis, size_bytes,
               msg_count, indexed_at)
            VALUES ('cwd', 'session', 'session.jsonl', 1, 1, 1, 2, 1)
            "#,
            [],
        )?;
        conn.execute(
            r#"
            INSERT INTO fts_progress
              (file_path, last_size, last_mtime_millis, byte_offset, last_scanned_at)
            VALUES ('session.jsonl', 1, 1, 1, 1)
            "#,
            [],
        )?;
        conn.execute(
            r#"
            INSERT INTO session_text (session_id, cwd, role, ts, body)
            VALUES ('session', 'cwd', 'user', NULL, '[Request interrupted by user]')
            "#,
            [],
        )?;

        conn.execute("INSERT INTO session_usage (session_id, sidecar_path, sidecar_mtime_millis, sidecar_size, cost_usd) VALUES ('session', 'sidecar', 1, 1, 2.5)", [])?;
        // Opening a current database must keep its caches intact.
        create_or_migrate_schema(&mut conn)?;
        let cached: i64 =
            conn.query_row("SELECT COUNT(*) FROM session_text", [], |row| row.get(0))?;
        assert_eq!(cached, 1);

        conn.pragma_update(None, "user_version", 4)?;
        create_or_migrate_schema(&mut conn)?;

        for table in ["session_index", "fts_progress", "session_text"] {
            let rows: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            assert_eq!(rows, 0, "{table} should be invalidated");
        }
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, SCHEMA_VERSION);
        let cost: f64 = conn.query_row(
            "SELECT cost_usd FROM session_usage WHERE session_id = 'session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(cost, 2.5);
        Ok(())
    }

    #[test]
    fn v5_migration_rebuilds_search_locators_without_erasing_other_caches() -> Result<()> {
        let mut conn = test_connection()?;
        conn.execute_batch(
            r#"
            DROP TABLE session_text;
            CREATE VIRTUAL TABLE session_text USING fts5(
              session_id UNINDEXED, cwd UNINDEXED, role UNINDEXED,
              ts UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2'
            );
            DROP TABLE fts_progress;
            CREATE TABLE fts_progress (
              file_path TEXT PRIMARY KEY, last_size INTEGER NOT NULL,
              last_mtime_millis INTEGER NOT NULL, byte_offset INTEGER NOT NULL DEFAULT 0,
              last_scanned_at INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO session_text (session_id, cwd, role, body)
            VALUES ('session', 'cwd', 'user', 'cached body without locator');
            INSERT INTO fts_progress (file_path, last_size, last_mtime_millis, byte_offset)
            VALUES ('session.jsonl', 200, 1, 200);
            INSERT INTO session_index
              (cwd, session_id, file_path, modified_ts, modified_millis, size_bytes, msg_count)
            VALUES ('cwd', 'session', 'session.jsonl', 1, 1, 200, 1);
            INSERT INTO session_usage
              (session_id, sidecar_path, sidecar_mtime_millis, sidecar_size, cost_usd)
            VALUES ('session', 'sidecar', 1, 1, 2.5);
            PRAGMA user_version = 5;
            "#,
        )?;
        create_or_migrate_schema(&mut conn)?;
        for table in ["fts_progress", "session_text"] {
            let count: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 0, "old locator-less {table} must rebuild");
        }
        let metadata_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM session_index", [], |row| row.get(0))?;
        assert_eq!(metadata_count, 1);
        let cost: f64 = conn.query_row(
            "SELECT cost_usd FROM session_usage WHERE session_id = 'session'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(cost, 2.5);
        conn.execute(
            "INSERT INTO session_text (session_id, cwd, role, body, message_uuid, transcript_index, file_path) VALUES ('session', 'cwd', 'user', 'rebuiltneedle', 'uuid', 7, 'session.jsonl')",
            [],
        )?;
        conn.execute("INSERT INTO fts_progress (file_path, last_size, last_mtime_millis, record_count) VALUES ('session.jsonl', 200, 1, 8)", [])?;
        create_or_migrate_schema(&mut conn)?;
        let locator: (String, i64) = conn.query_row(
            "SELECT message_uuid, transcript_index FROM session_text WHERE session_text MATCH 'rebuiltneedle'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(locator, ("uuid".into(), 7));
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, SCHEMA_VERSION);
        Ok(())
    }

    #[test]
    fn v6_migration_refreshes_only_command_title_metadata_once() -> Result<()> {
        let mut conn = test_connection()?;
        conn.execute_batch(
            r#"
            INSERT INTO session_index
              (cwd, session_id, file_path, modified_ts, modified_millis, size_bytes, msg_count, ai_title, first_user_text)
            VALUES
              ('cwd', 'command', 'command.jsonl', 1, 1, 200, 1, NULL, '<command-message>skill</command-message><command-name>/plugin:skill'),
              ('cwd', 'command-ai', 'command-ai.jsonl', 1, 1, 200, 1, '<command-name>/skill</command-name>', 'ordinary'),
              ('cwd', 'ordinary', 'ordinary.jsonl', 1, 1, 100, 1, 'Custom title', 'ordinary text');
            INSERT INTO session_usage
              (session_id, sidecar_path, sidecar_mtime_millis, sidecar_size, cost_usd)
            VALUES ('command', 'sidecar', 1, 1, 2.5);
            INSERT INTO session_text (session_id, cwd, role, body, message_uuid, transcript_index, file_path)
            VALUES ('command', 'cwd', 'user', 'cachedneedle', 'uuid', 2, 'command.jsonl');
            INSERT INTO fts_progress (file_path, last_size, last_mtime_millis, record_count)
            VALUES ('command.jsonl', 200, 1, 3);
            INSERT INTO activity_bucket (date, hour, count) VALUES ('2026-10-16', 12, 2);
            INSERT INTO heatmap_progress (file_path, last_size, last_mtime_millis)
            VALUES ('command.jsonl', 200, 1);
            PRAGMA user_version = 6;
            "#,
        )?;
        create_or_migrate_schema(&mut conn)?;
        let retained: (String, String) = conn.query_row(
            "SELECT session_id, ai_title FROM session_index",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(retained, ("ordinary".into(), "Custom title".into()));
        let metadata_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM session_index", [], |row| row.get(0))?;
        assert_eq!(metadata_count, 1);
        for table in [
            "session_usage",
            "session_text",
            "fts_progress",
            "activity_bucket",
            "heatmap_progress",
        ] {
            let count: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 1, "{table} must remain intact");
        }
        // The new parser can legitimately retain a literal tag example. A
        // later open must preserve it rather than repeatedly invalidate it.
        conn.execute(
            "INSERT INTO session_index (cwd, session_id, file_path, modified_ts, modified_millis, size_bytes, msg_count, first_user_text) VALUES ('cwd', 'literal', 'literal.jsonl', 1, 1, 100, 1, '<command-message>example</command-message> is literal prose')",
            [],
        )?;
        create_or_migrate_schema(&mut conn)?;
        let metadata_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM session_index", [], |row| row.get(0))?;
        assert_eq!(metadata_count, 2);
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, SCHEMA_VERSION);
        Ok(())
    }

    #[test]
    fn concurrent_schema_upgrade_rechecks_version_after_writer_reservation() -> Result<()> {
        let path = std::env::temp_dir().join(format!(
            "claudinal-search-migration-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let mut first = try_open_and_migrate(&path)?;
        // The second connection still sees v5 until the first upgrade commits.
        first.pragma_update(None, "user_version", 5)?;
        let first_tx = begin_write(&mut first)?;
        first_tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        first_tx.execute(
            "INSERT INTO session_text (session_id, cwd, role, body, message_uuid, transcript_index, file_path) VALUES ('session', 'cwd', 'user', 'freshneedle', 'fresh-uuid', 9, 'session.jsonl')",
            [],
        )?;

        let second_path = path.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let mut conn = Connection::open(second_path).expect("open second schema connection");
            apply_pragmas(&conn).expect("configure second schema connection");
            let old_version: i64 = conn
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .expect("read old committed version");
            assert_eq!(old_version, 5);
            ready_tx.send(()).expect("signal old version observed");
            create_or_migrate_schema(&mut conn).expect("wait and recheck schema version");
            let uuid: String = conn
                .query_row(
                    "SELECT message_uuid FROM session_text WHERE session_text MATCH 'freshneedle'",
                    [],
                    |row| row.get(0),
                )
                .expect("concurrent upgrade must preserve freshly rebuilt rows");
            finished_tx.send(uuid).expect("signal migration completed");
        });
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("second schema connection ready");
        assert!(matches!(
            finished_rx.recv_timeout(Duration::from_millis(100)),
            Err(RecvTimeoutError::Timeout)
        ));
        first_tx.commit()?;
        assert_eq!(
            finished_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("second upgrade completed"),
            "fresh-uuid"
        );
        second.join().expect("second schema thread");
        drop(first);
        let _ = std::fs::remove_file(&path);
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(path.with_file_name(format!(
                "{}{}",
                path.file_name().unwrap().to_string_lossy(),
                suffix
            )));
        }
        Ok(())
    }
}
