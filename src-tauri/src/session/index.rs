use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{Error, Result};

use super::reader::{
    extract_cwd_from_jsonl, project_dirs, projects_root, scan_session_meta, session_file_meta,
    SessionFileMeta, SessionMeta,
};
use super::store::{self, as_i64};

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
    let cap = limit.max(1);
    let root = projects_root()?;
    if !root.is_dir() {
        return Ok(vec![]);
    }

    let files = collect_all_files(&root)?;
    if files.is_empty() {
        let conn = store::open()?;
        conn.execute("DELETE FROM session_index", [])?;
        return Ok(vec![]);
    }

    let mut conn = store::open()?;
    sync_global_index(&mut conn, &files)?;

    let mut stmt = conn.prepare(
        r#"
        SELECT session_id, file_path, modified_ts, size_bytes, msg_count,
               ai_title, first_user_text, cwd_raw, dir_label
        FROM session_index
        ORDER BY modified_ts DESC
        LIMIT ?1
        "#,
    )?;
    let rows = stmt.query_map(params![as_i64(cap, "limit")?], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<String>>(8)?,
        ))
    })?;
    let mut out = Vec::with_capacity(cap);
    for row in rows {
        let (
            id,
            file_path,
            modified_ts,
            size_bytes,
            msg_count,
            ai_title,
            first_user_text,
            cwd_raw,
            dir_label,
        ) = row?;
        if modified_ts < 0 || size_bytes < 0 || msg_count < 0 {
            continue;
        }
        out.push(GlobalSessionMeta {
            meta: SessionMeta {
                id,
                file_path,
                modified_ts: modified_ts as u64,
                size_bytes: size_bytes as u64,
                msg_count: msg_count as usize,
                ai_title,
                first_user_text,
            },
            cwd: cwd_raw,
            dir_label: dir_label.unwrap_or_default(),
        });
    }
    Ok(out)
}

pub fn list_project_sessions(cwd: &str) -> Result<Vec<SessionMeta>> {
    let files = collect_files(cwd)?;
    if files.is_empty() {
        let conn = store::open()?;
        conn.execute("DELETE FROM session_index WHERE cwd = ?1", params![cwd])?;
        return Ok(vec![]);
    }

    let mut conn = store::open()?;
    let dir_label_lookup = derive_dir_label_lookup(&files);
    let tx = conn.transaction()?;
    let mut out = Vec::with_capacity(files.len());

    for file in files.values() {
        let cached = tx
            .query_row(
                r#"
                SELECT session_id, file_path, modified_ts, size_bytes, msg_count, ai_title, first_user_text,
                       cwd_raw, dir_label
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
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .optional()?;

        let meta = match cached {
            Some((id, file_path, mt, sb, mc, ai, fu, cwd_raw, dir_label_cached)) => {
                if cwd_raw.is_none() || dir_label_cached.is_none() {
                    let backfill_cwd = extract_cwd_from_jsonl(std::path::Path::new(&file_path));
                    let backfill_dir = dir_label_lookup.get(&file_path).cloned();
                    tx.execute(
                        r#"
                        UPDATE session_index
                        SET cwd_raw = COALESCE(cwd_raw, ?3),
                            dir_label = COALESCE(dir_label, ?4)
                        WHERE cwd = ?1 AND session_id = ?2
                        "#,
                        params![cwd, &id, &backfill_cwd, &backfill_dir],
                    )?;
                }
                meta_from_row((id, file_path, mt, sb, mc, ai, fu))?
            }
            None => {
                let meta = scan_session_meta(file);
                let cwd_raw = extract_cwd_from_jsonl(std::path::Path::new(&meta.file_path));
                let dir_label = dir_label_lookup
                    .get(&meta.file_path)
                    .cloned()
                    .unwrap_or_default();
                tx.execute(
                    r#"
                    INSERT INTO session_index
                      (cwd, session_id, file_path, modified_ts, modified_millis, size_bytes,
                       msg_count, ai_title, first_user_text, indexed_at, cwd_raw, dir_label)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                    ON CONFLICT(cwd, session_id) DO UPDATE SET
                      file_path = excluded.file_path,
                      modified_ts = excluded.modified_ts,
                      modified_millis = excluded.modified_millis,
                      size_bytes = excluded.size_bytes,
                      msg_count = excluded.msg_count,
                      ai_title = excluded.ai_title,
                      first_user_text = excluded.first_user_text,
                      indexed_at = excluded.indexed_at,
                      cwd_raw = excluded.cwd_raw,
                      dir_label = excluded.dir_label
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
                        store::now_secs(),
                        &cwd_raw,
                        &dir_label,
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

/// 把 `~/.claude/projects/` 下所有 jsonl 与 session_index 同步：新增/变更行 upsert，
/// 不再存在的行删除。以 file_path 作为「真实存在」的指针——同一个 session_id 的
/// jsonl 永远只对应一个文件路径，比 (cwd, session_id) PK 更稳。
fn sync_global_index(conn: &mut Connection, files: &[(String, SessionFileMeta)]) -> Result<()> {
    let tx = conn.transaction()?;
    let mut existing: HashMap<String, (String, String, i64, i64)> = HashMap::new();
    {
        let mut stmt = tx.prepare(
            "SELECT cwd, session_id, file_path, modified_millis, size_bytes FROM session_index",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows {
            let (cwd, sid, fp, mtime, size) = row?;
            existing.insert(fp, (cwd, sid, mtime, size));
        }
    }

    for (dir_label, file) in files {
        let modified_millis = as_i64(file.modified_millis, "modified_millis")?;
        let size_bytes = as_i64(file.size_bytes, "size_bytes")?;
        let prev = existing.remove(&file.file_path);

        let unchanged = prev
            .as_ref()
            .map(|(_, _, m, s)| *m == modified_millis && *s == size_bytes)
            .unwrap_or(false);
        if unchanged {
            continue;
        }

        let meta = scan_session_meta(file);
        let cwd_raw = extract_cwd_from_jsonl(std::path::Path::new(&meta.file_path));
        // 解析不到真实 cwd 的会话不写入全局索引：dir_label 是 encoded 串，与 real_cwd
        // 不一致会和 list_project_sessions(real_cwd) 写入的行因 PK 不同而产生重复。
        // 跳过时**不删除** prev row —— 它可能来自 list_project_sessions（real_cwd 作 PK）。
        let Some(resolved_cwd) = cwd_raw.clone() else {
            continue;
        };

        if let Some((old_cwd, old_sid, _, _)) = prev.as_ref() {
            if old_cwd != &resolved_cwd || old_sid != &meta.id {
                tx.execute(
                    "DELETE FROM session_index WHERE cwd = ?1 AND session_id = ?2",
                    params![old_cwd, old_sid],
                )?;
            }
        }

        tx.execute(
            r#"
            INSERT INTO session_index
              (cwd, session_id, file_path, modified_ts, modified_millis, size_bytes,
               msg_count, ai_title, first_user_text, indexed_at, cwd_raw, dir_label)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(cwd, session_id) DO UPDATE SET
              file_path = excluded.file_path,
              modified_ts = excluded.modified_ts,
              modified_millis = excluded.modified_millis,
              size_bytes = excluded.size_bytes,
              msg_count = excluded.msg_count,
              ai_title = excluded.ai_title,
              first_user_text = excluded.first_user_text,
              indexed_at = excluded.indexed_at,
              cwd_raw = excluded.cwd_raw,
              dir_label = excluded.dir_label
            "#,
            params![
                &resolved_cwd,
                &meta.id,
                &meta.file_path,
                as_i64(meta.modified_ts, "modified_ts")?,
                modified_millis,
                size_bytes,
                as_i64(meta.msg_count, "msg_count")?,
                &meta.ai_title,
                &meta.first_user_text,
                store::now_secs(),
                &cwd_raw,
                dir_label,
            ],
        )?;
    }

    for (_, (cwd, sid, _, _)) in existing {
        tx.execute(
            "DELETE FROM session_index WHERE cwd = ?1 AND session_id = ?2",
            params![cwd, sid],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn collect_all_files(root: &std::path::Path) -> Result<Vec<(String, SessionFileMeta)>> {
    let mut out: Vec<(String, SessionFileMeta)> = Vec::new();
    for entry in std::fs::read_dir(root)? {
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
                out.push((dir_label.clone(), meta));
            }
        }
    }
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

fn derive_dir_label_lookup(files: &HashMap<String, SessionFileMeta>) -> HashMap<String, String> {
    files
        .values()
        .filter_map(|f| {
            let path = PathBuf::from(&f.file_path);
            let parent = path.parent()?;
            let label = parent.file_name()?.to_string_lossy().into_owned();
            Some((f.file_path.clone(), label))
        })
        .collect()
}

fn prune_missing(
    tx: &rusqlite::Transaction<'_>,
    cwd: &str,
    current: &HashMap<String, SessionFileMeta>,
) -> Result<()> {
    let mut stmt = tx.prepare("SELECT session_id FROM session_index WHERE cwd = ?1")?;
    let rows = stmt.query_map(params![cwd], |row| row.get::<_, String>(0))?;
    let mut to_delete = Vec::new();
    for row in rows {
        let id = row?;
        if !current.contains_key(&id) {
            to_delete.push(id);
        }
    }
    drop(stmt);
    for id in to_delete {
        tx.execute(
            "DELETE FROM session_index WHERE cwd = ?1 AND session_id = ?2",
            params![cwd, id],
        )?;
    }
    Ok(())
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
