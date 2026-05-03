//! FTS5 全文搜索 —— 派生 cache，丢失可重建。
//!
//! `session_text` 作为 contentless FTS5 索引；ingest 流程按 jsonl 行增量摄入：
//! `jsonl_scan_progress.fts_offset` 记录每个文件已索引到的字节偏移，下一次只追加扫描
//! `[fts_offset, eof)`。文件被 truncate / 重建（size 变小或 mtime 倒退）则整个
//! `DELETE FROM session_text WHERE session_id = ?` 后从头重扫，避免重复行。

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

use super::reader::is_internal_command_text;

use crate::error::{Error, Result};

use super::reader::extract_cwd_from_jsonl;
use super::store::{self, as_i64};

const MAX_BODY_CHARS: usize = 4000;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    pub session_id: String,
    pub cwd: String,
    pub role: String,
    pub ts: Option<String>,
    pub snippet: String,
    pub file_path: Option<String>,
    pub modified_ts: Option<u64>,
    pub ai_title: Option<String>,
    pub first_user_text: Option<String>,
    pub dir_label: Option<String>,
}

pub fn search_sessions(query: &str, limit: usize) -> Result<Vec<SessionSearchHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }
    let cap = limit.clamp(1, 200);

    let mut conn = store::open()?;
    sync_fts_index(&mut conn)?;

    let match_expr = build_match_expr(trimmed);
    let mut stmt = conn.prepare(
        r#"
        SELECT
          t.session_id,
          t.cwd,
          t.role,
          t.ts,
          snippet(session_text, 4, '<<<', '>>>', '…', 16) AS snip,
          (SELECT file_path FROM session_index s WHERE s.session_id = t.session_id LIMIT 1) AS file_path,
          (SELECT modified_ts FROM session_index s WHERE s.session_id = t.session_id LIMIT 1) AS modified_ts,
          (SELECT ai_title FROM session_index s WHERE s.session_id = t.session_id LIMIT 1) AS ai_title,
          (SELECT first_user_text FROM session_index s WHERE s.session_id = t.session_id LIMIT 1) AS first_user_text,
          (SELECT dir_label FROM session_index s WHERE s.session_id = t.session_id LIMIT 1) AS dir_label
        FROM session_text t
        WHERE session_text MATCH ?1
        ORDER BY bm25(session_text) ASC
        LIMIT ?2
        "#,
    )?;
    let rows = stmt.query_map(params![match_expr, as_i64(cap, "limit")?], |r| {
        Ok(SessionSearchHit {
            session_id: r.get(0)?,
            cwd: r.get(1)?,
            role: r.get(2)?,
            ts: r.get(3)?,
            snippet: r.get(4)?,
            file_path: r.get(5)?,
            modified_ts: r.get::<_, Option<i64>>(6)?.map(|v| v.max(0) as u64),
            ai_title: r.get(7)?,
            first_user_text: r.get(8)?,
            dir_label: r.get(9)?,
        })
    })?;
    let mut out = Vec::new();
    for hit in rows.flatten() {
        out.push(hit);
    }
    Ok(out)
}

fn build_match_expr(query: &str) -> String {
    // FTS5 把 "" 视作 phrase；用户原始输入直接传可能含特殊字符（- " (）触发语法错误。
    // 简化处理：按空白拆词，每个词加双引号转义内部引号；多词隐含 AND。
    let tokens: Vec<String> = query
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(|tok| {
            let escaped = tok.replace('"', "\"\"");
            format!("\"{escaped}\"")
        })
        .collect();
    if tokens.is_empty() {
        String::new()
    } else {
        tokens.join(" ")
    }
}

fn projects_root() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
    Ok(home.join(".claude").join("projects"))
}

fn sync_fts_index(conn: &mut Connection) -> Result<()> {
    let root = projects_root()?;
    if !root.is_dir() {
        return Ok(());
    }

    let mut alive: HashSet<String> = HashSet::new();
    let tx = conn.transaction()?;

    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let dir_label = entry.file_name().to_string_lossy().into_owned();
        for f in std::fs::read_dir(&dir)? {
            let f = match f {
                Ok(f) => f,
                Err(_) => continue,
            };
            let path = f.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let session_id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let path_str = path.display().to_string();
            alive.insert(path_str.clone());

            let meta = match path.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let size_i = as_i64(meta.len(), "size")?;
            let mtime_millis = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);

            let prev = tx
                .query_row(
                    "SELECT last_size, last_mtime_millis, byte_offset FROM fts_progress WHERE file_path = ?1",
                    params![path_str.as_str()],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
                )
                .ok();

            let (start_offset, must_purge) = match prev {
                Some((prev_size, prev_mtime, prev_offset)) => {
                    if size_i == prev_size && mtime_millis == prev_mtime {
                        upsert_progress(&tx, &path_str, size_i, mtime_millis, prev_offset)?;
                        continue;
                    } else if size_i < prev_size || mtime_millis < prev_mtime {
                        (0_i64, true)
                    } else {
                        (prev_offset.min(size_i), false)
                    }
                }
                None => (0_i64, false),
            };

            if must_purge {
                tx.execute(
                    "DELETE FROM session_text WHERE session_id = ?1",
                    params![session_id],
                )?;
            }

            // 优先 jsonl 头里的真实 cwd；session_index 仅作二选；否则降级 dir_label。
            let cwd_label: String = extract_cwd_from_jsonl(&path)
                .or_else(|| {
                    tx.query_row(
                        "SELECT COALESCE(cwd_raw, cwd) FROM session_index WHERE session_id = ?1 LIMIT 1",
                        params![session_id],
                        |r| r.get::<_, String>(0),
                    )
                    .ok()
                })
                .unwrap_or_else(|| dir_label.clone());

            let new_offset =
                ingest_fts_increments(&tx, &path, &session_id, &cwd_label, start_offset)?;
            upsert_progress(&tx, &path_str, size_i, mtime_millis, new_offset)?;
        }
    }

    // 清理已删除文件的 FTS 行 + progress 行
    let mut to_delete: Vec<String> = Vec::new();
    {
        let mut stmt = tx.prepare("SELECT file_path FROM fts_progress")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for row in rows {
            let fp = row?;
            if !alive.contains(&fp) {
                to_delete.push(fp);
            }
        }
    }
    for fp in to_delete {
        if let Some(stem) = Path::new(&fp).file_stem().and_then(|s| s.to_str()) {
            tx.execute(
                "DELETE FROM session_text WHERE session_id = ?1",
                params![stem],
            )?;
        }
        tx.execute("DELETE FROM fts_progress WHERE file_path = ?1", params![fp])?;
    }

    tx.commit()?;
    Ok(())
}

fn upsert_progress(
    tx: &rusqlite::Transaction<'_>,
    path_str: &str,
    size_i: i64,
    mtime_millis: i64,
    byte_offset: i64,
) -> Result<()> {
    tx.execute(
        r#"
        INSERT INTO fts_progress (file_path, last_size, last_mtime_millis, byte_offset, last_scanned_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(file_path) DO UPDATE SET
          last_size = excluded.last_size,
          last_mtime_millis = excluded.last_mtime_millis,
          byte_offset = excluded.byte_offset,
          last_scanned_at = excluded.last_scanned_at
        "#,
        params![path_str, size_i, mtime_millis, byte_offset, store::now_secs()],
    )?;
    Ok(())
}

fn ingest_fts_increments(
    tx: &rusqlite::Transaction<'_>,
    path: &Path,
    session_id: &str,
    cwd_label: &str,
    start_offset: i64,
) -> Result<i64> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(start_offset),
    };
    let total_len = file.metadata()?.len() as i64;
    if start_offset >= total_len {
        return Ok(total_len);
    }
    let seek_to = start_offset.max(0);
    if file.seek(SeekFrom::Start(seek_to as u64)).is_err() {
        return Ok(start_offset);
    }
    let mut reader = BufReader::new(&mut file);
    let mut bytes_read: i64 = seek_to;
    let mut line = String::new();
    loop {
        line.clear();
        let n = match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let complete = line.ends_with('\n');
        if !complete {
            // 不完整行：偏移停在行首，等下次再读。
            break;
        }
        bytes_read += n as i64;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let role = match t {
            "user" | "assistant" => t,
            _ => continue,
        };
        let ts = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let body = match extract_message_text(&v) {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        let body = truncate_chars(&body, MAX_BODY_CHARS);

        tx.execute(
            r#"
            INSERT INTO session_text (session_id, cwd, role, ts, body)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![session_id, cwd_label, role, ts, body],
        )?;
    }
    Ok(bytes_read)
}

fn extract_message_text(v: &Value) -> Option<String> {
    let content = v.pointer("/message/content")?;
    if let Some(s) = content.as_str() {
        let trimmed = s.trim();
        if trimmed.is_empty() || is_internal_command_text(trimmed) {
            return None;
        }
        return Some(trimmed.to_string());
    }
    let arr = content.as_array()?;
    let mut buf = String::new();
    for c in arr {
        let kind = c.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match kind {
            "text" => {
                if let Some(s) = c.get("text").and_then(|x| x.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(s);
                }
            }
            "tool_use" => {
                if let Some(name) = c.get("name").and_then(|x| x.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str("[tool] ");
                    buf.push_str(name);
                }
            }
            _ => {}
        }
        if buf.len() > MAX_BODY_CHARS * 4 {
            break;
        }
    }
    let trimmed = buf.trim();
    if trimmed.is_empty() || is_internal_command_text(trimmed) {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max_chars {
            break;
        }
        out.push(ch);
    }
    out
}
