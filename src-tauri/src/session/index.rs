use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{Error, Result};

use super::reader::{
    extract_cwd_from_jsonl, project_dirs, projects_root, scan_session_meta, session_file_meta,
    SessionFileMeta, SessionMeta,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSessionMeta {
    #[serde(flatten)]
    pub meta: SessionMeta,
    /// 原始 cwd（若能从 jsonl 第一段事件抽到）
    pub cwd: Option<String>,
    /// `~/.claude/projects/<name>` 的目录名，作为兜底标签
    pub dir_label: String,
}

pub fn list_recent_sessions_all(limit: usize) -> Result<Vec<GlobalSessionMeta>> {
    let root = projects_root()?;
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut all_files: Vec<(String, SessionFileMeta)> = Vec::new();
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_label = entry.file_name().to_string_lossy().into_owned();
        for f in std::fs::read_dir(&path)? {
            let f = match f {
                Ok(f) => f,
                Err(_) => continue,
            };
            if let Ok(Some(meta)) = session_file_meta(&f.path()) {
                all_files.push((dir_label.clone(), meta));
            }
        }
    }
    if all_files.is_empty() {
        return Ok(vec![]);
    }
    all_files.sort_by(|a, b| b.1.modified_ts.cmp(&a.1.modified_ts));
    let cap = limit.max(1);
    let mut out: Vec<GlobalSessionMeta> = Vec::with_capacity(cap.min(all_files.len()));
    for (dir_label, file) in all_files.into_iter().take(cap) {
        let path = PathBuf::from(&file.file_path);
        let cwd = extract_cwd_from_jsonl(&path);
        let meta = scan_session_meta(&file);
        out.push(GlobalSessionMeta {
            meta,
            cwd,
            dir_label,
        });
    }
    Ok(out)
}

const SCHEMA_VERSION: i64 = 1;

pub fn list_project_sessions(cwd: &str) -> Result<Vec<SessionMeta>> {
    let files = collect_files(cwd)?;
    if files.is_empty() {
        return Ok(vec![]);
    }

    let mut conn = open_index()?;
    let tx = conn.transaction()?;
    let mut out = Vec::with_capacity(files.len());

    for file in files.values() {
        let cached = tx
            .query_row(
                r#"
                SELECT session_id, file_path, modified_ts, size_bytes, msg_count, ai_title, first_user_text
                FROM session_index
                WHERE cwd = ?1 AND session_id = ?2 AND file_path = ?3
                  AND modified_millis = ?4 AND size_bytes = ?5
                "#,
                params![
                    cwd,
                    &file.id,
                    &file.file_path,
                    as_i64(file.modified_millis, "modified_millis")?,
                    as_i64(file.size_bytes, "size_bytes")?,
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()?;

        let meta = match cached {
            Some(row) => meta_from_row(row)?,
            None => {
                let meta = scan_session_meta(file);
                tx.execute(
                    r#"
                    INSERT INTO session_index
                      (cwd, session_id, file_path, modified_ts, modified_millis, size_bytes, msg_count, ai_title, first_user_text, indexed_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CAST(strftime('%s','now') AS INTEGER))
                    ON CONFLICT(cwd, session_id) DO UPDATE SET
                      file_path = excluded.file_path,
                      modified_ts = excluded.modified_ts,
                      modified_millis = excluded.modified_millis,
                      size_bytes = excluded.size_bytes,
                      msg_count = excluded.msg_count,
                      ai_title = excluded.ai_title,
                      first_user_text = excluded.first_user_text,
                      indexed_at = excluded.indexed_at
                    "#,
                    params![
                        cwd,
                        &meta.id,
                        &meta.file_path,
                        as_i64(meta.modified_ts, "modified_ts")?,
                        as_i64(file.modified_millis, "modified_millis")?,
                        as_i64(meta.size_bytes, "size_bytes")?,
                        as_i64(meta.msg_count, "msg_count")?,
                        &meta.ai_title,
                        &meta.first_user_text,
                    ],
                )?;
                meta
            }
        };
        out.push(meta);
    }

    prune_missing(&tx, cwd, &files)?;
    tx.commit()?;
    out.sort_by(|a, b| b.modified_ts.cmp(&a.modified_ts));
    Ok(out)
}

fn collect_files(cwd: &str) -> Result<HashMap<String, SessionFileMeta>> {
    let mut files = HashMap::<String, SessionFileMeta>::new();
    for dir in project_dirs(cwd)?.into_iter().filter(|dir| dir.is_dir()) {
        for entry in std::fs::read_dir(dir)? {
            let Some(file) = session_file_meta(&entry?.path())? else {
                continue;
            };
            if files
                .get(&file.id)
                .is_none_or(|old| file.modified_millis > old.modified_millis)
            {
                files.insert(file.id.clone(), file);
            }
        }
    }
    Ok(files)
}

fn open_index() -> Result<Connection> {
    let path = index_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let conn = Connection::open(&path)?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != 0 && version != SCHEMA_VERSION {
        return Err(Error::Other(format!(
            "session index schema version {version} is unsupported: {}",
            path.display()
        )));
    }

    conn.pragma_update(None, "journal_mode", "WAL")?;
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
        "#,
    )?;
    ensure_indexed_at_column(&conn)?;
    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_session_index_cwd_modified
          ON session_index(cwd, modified_ts DESC);
        PRAGMA user_version = 1;
        "#,
    )?;
    Ok(conn)
}

fn ensure_indexed_at_column(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(session_index)")?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == "indexed_at" {
            return Ok(());
        }
    }
    conn.execute(
        "ALTER TABLE session_index ADD COLUMN indexed_at INTEGER NOT NULL DEFAULT 0",
        [],
    )?;
    Ok(())
}

fn prune_missing(
    tx: &rusqlite::Transaction<'_>,
    cwd: &str,
    current: &HashMap<String, SessionFileMeta>,
) -> Result<()> {
    let mut stmt = tx.prepare("SELECT session_id FROM session_index WHERE cwd = ?1")?;
    let rows = stmt.query_map(params![cwd], |row| row.get::<_, String>(0))?;
    for row in rows {
        let id = row?;
        if !current.contains_key(&id) {
            tx.execute(
                "DELETE FROM session_index WHERE cwd = ?1 AND session_id = ?2",
                params![cwd, id],
            )?;
        }
    }
    Ok(())
}

fn index_path() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| Error::Other("data dir not found for session index".into()))?;
    Ok(base.join("Claudinal").join("session-index-v1.sqlite3"))
}

fn meta_from_row(
    row: (
        String,
        String,
        i64,
        i64,
        i64,
        Option<String>,
        Option<String>,
    ),
) -> Result<SessionMeta> {
    let (id, file_path, modified_ts, size_bytes, msg_count, ai_title, first_user_text) = row;
    if modified_ts < 0 || size_bytes < 0 || msg_count < 0 {
        return Err(Error::Other(format!(
            "invalid negative values in session index: {id}"
        )));
    }
    Ok(SessionMeta {
        id,
        file_path,
        modified_ts: modified_ts as u64,
        size_bytes: size_bytes as u64,
        msg_count: msg_count as usize,
        ai_title,
        first_user_text,
    })
}

fn as_i64<T>(value: T, field: &str) -> Result<i64>
where
    T: TryInto<i64> + Copy + std::fmt::Display,
{
    value
        .try_into()
        .map_err(|_| Error::Other(format!("{field} out of sqlite range: {value}")))
}
