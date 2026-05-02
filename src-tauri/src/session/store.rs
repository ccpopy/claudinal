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

use rusqlite::Connection;

use crate::error::{Error, Result};

pub const SCHEMA_VERSION: i64 = 2;

pub fn db_path() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| Error::Other("data dir not found for session index".into()))?;
    Ok(base.join("Claudinal").join("session-index-v1.sqlite3"))
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
        Err(Error::Sqlite(e)) if matches!(e, rusqlite::Error::SqliteFailure(_, _)) => {
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

fn try_open_and_migrate(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    apply_pragmas(&conn)?;

    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(Error::Other(format!(
            "SCHEMA_DOWNGRADE current={version} max_supported={SCHEMA_VERSION}"
        )));
    }

    create_or_migrate_schema(&conn, version)?;
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
    let conn = Connection::open(path)?;
    apply_pragmas(&conn)?;
    create_or_migrate_schema(&conn, 0)?;
    Ok(conn)
}

fn apply_pragmas(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    let _ = conn.pragma_update(None, "mmap_size", 268_435_456_i64);
    conn.busy_timeout(std::time::Duration::from_secs(15))?;
    Ok(())
}

fn create_or_migrate_schema(conn: &Connection, from_version: i64) -> Result<()> {
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
          last_scanned_at INTEGER NOT NULL DEFAULT 0
        );

        DROP TABLE IF EXISTS jsonl_scan_progress;

        CREATE VIRTUAL TABLE IF NOT EXISTS session_text USING fts5(
          session_id UNINDEXED,
          cwd UNINDEXED,
          role UNINDEXED,
          ts UNINDEXED,
          body,
          tokenize = 'unicode61 remove_diacritics 2'
        );
        "#,
    )?;

    if from_version != SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
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

pub fn as_i64<T>(value: T, field: &str) -> Result<i64>
where
    T: TryInto<i64> + Copy + std::fmt::Display,
{
    value
        .try_into()
        .map_err(|_| Error::Other(format!("{field} out of sqlite range: {value}")))
}
