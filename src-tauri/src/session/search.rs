//! FTS5 全文搜索 —— 派生 cache，丢失可重建。
//!
//! `session_text` 保存有界正文与真实消息定位；ingest 流程按 jsonl 行增量摄入：
//! `fts_progress.byte_offset` 记录每个文件已索引到的字节偏移，下一次只追加扫描
//! `[fts_offset, eof)`。文件被 truncate / 重建（size 变小或 mtime 倒退）则整个
//! `DELETE FROM session_text WHERE file_path = ?` 后从头重扫，避免重复行。

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

use super::reader::is_internal_generated_event;

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
    pub message_uuid: Option<String>,
    pub transcript_index: u64,
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
    query_fts_index(&conn, trimmed, cap)
}

fn query_fts_index(conn: &Connection, query: &str, cap: usize) -> Result<Vec<SessionSearchHit>> {
    let match_expr = build_match_expr(query);
    let mut stmt = conn.prepare(
        r#"
        SELECT
          t.session_id,
          t.cwd,
          t.role,
          t.ts,
          snippet(session_text, 4, '<<<', '>>>', '…', 16) AS snip,
          t.file_path,
          (SELECT modified_ts FROM session_index s WHERE s.file_path = t.file_path LIMIT 1) AS modified_ts,
          (SELECT ai_title FROM session_index s WHERE s.file_path = t.file_path LIMIT 1) AS ai_title,
          (SELECT first_user_text FROM session_index s WHERE s.file_path = t.file_path LIMIT 1) AS first_user_text,
          (SELECT dir_label FROM session_index s WHERE s.file_path = t.file_path LIMIT 1) AS dir_label,
          t.message_uuid,
          t.transcript_index
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
            message_uuid: r.get(10)?,
            transcript_index: r.get(11)?,
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
    for hit in rows {
        out.push(hit?);
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
    sync_fts_index_at_root(conn, &root)
}

fn sync_fts_index_at_root(conn: &mut Connection, root: &Path) -> Result<()> {
    if !root.is_dir() {
        return Ok(());
    }

    let mut alive: HashSet<String> = HashSet::new();
    let tx = store::begin_write(conn)?;

    for entry in std::fs::read_dir(root)? {
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
                    "SELECT last_size, last_mtime_millis, byte_offset, record_count FROM fts_progress WHERE file_path = ?1",
                    params![path_str.as_str()],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)),
                )
                .ok();

            let (start_offset, record_count, must_purge) = match prev {
                Some((prev_size, prev_mtime, prev_offset, prev_count)) => {
                    if size_i == prev_size && mtime_millis == prev_mtime {
                        upsert_progress(
                            &tx,
                            &path_str,
                            size_i,
                            mtime_millis,
                            prev_offset,
                            prev_count,
                        )?;
                        continue;
                    } else if size_i <= prev_size || mtime_millis < prev_mtime {
                        (0_i64, 0_i64, true)
                    } else {
                        (prev_offset.min(size_i), prev_count, false)
                    }
                }
                None => (0_i64, 0_i64, false),
            };

            if must_purge {
                tx.execute(
                    "DELETE FROM session_text WHERE file_path = ?1",
                    params![path_str],
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

            let (new_offset, new_count) = ingest_fts_increments(
                &tx,
                &path,
                &session_id,
                &cwd_label,
                start_offset,
                record_count,
            )?;
            upsert_progress(&tx, &path_str, size_i, mtime_millis, new_offset, new_count)?;
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
        tx.execute("DELETE FROM session_text WHERE file_path = ?1", params![fp])?;
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
    record_count: i64,
) -> Result<()> {
    tx.execute(
        r#"
        INSERT INTO fts_progress (file_path, last_size, last_mtime_millis, byte_offset, record_count, last_scanned_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(file_path) DO UPDATE SET
          last_size = excluded.last_size,
          last_mtime_millis = excluded.last_mtime_millis,
          byte_offset = excluded.byte_offset,
          record_count = excluded.record_count,
          last_scanned_at = excluded.last_scanned_at
        "#,
        params![path_str, size_i, mtime_millis, byte_offset, record_count, store::now_secs()],
    )?;
    Ok(())
}

fn ingest_fts_increments(
    tx: &rusqlite::Transaction<'_>,
    path: &Path,
    session_id: &str,
    cwd_label: &str,
    start_offset: i64,
    start_record_count: i64,
) -> Result<(i64, i64)> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok((start_offset, start_record_count)),
    };
    let total_len = file.metadata()?.len() as i64;
    if start_offset >= total_len {
        return Ok((total_len, start_record_count));
    }
    let seek_to = start_offset.max(0);
    if file.seek(SeekFrom::Start(seek_to as u64)).is_err() {
        return Ok((start_offset, start_record_count));
    }
    let mut reader = BufReader::new(&mut file);
    let mut bytes_read: i64 = seek_to;
    let mut record_count = start_record_count;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let complete = line.ends_with(b"\n");
        if !complete {
            // 不完整行：偏移停在行首，等下次再读。
            break;
        }
        bytes_read += n as i64;
        let trimmed = match std::str::from_utf8(&line) {
            Ok(line) => line.trim(),
            Err(_) => continue,
        };
        if trimmed.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Match read_session_transcript: count every valid nonempty JSON record,
        // including hidden context/system records, before selecting searchable ones.
        let transcript_index = record_count;
        record_count = record_count
            .checked_add(1)
            .ok_or_else(|| Error::Other("transcript record count out of range".into()))?;
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
        let message_uuid = v
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|uuid| !uuid.trim().is_empty() && uuid.len() <= 256);

        tx.execute(
            r#"
            INSERT INTO session_text (session_id, cwd, role, ts, body, message_uuid, transcript_index, file_path)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![session_id, cwd_label, role, ts, body, message_uuid, transcript_index, path.display().to_string()],
        )?;
    }
    Ok((bytes_read, record_count))
}

fn extract_message_text(v: &Value) -> Option<String> {
    // Forwarded child records are rendered in the Agent panel, not in the
    // main transcript addressed by these hits. Preserve their record positions.
    if is_internal_generated_event(v)
        || ["parent_tool_use_id", "agent_id"].iter().any(|key| {
            v.get(key)
                .and_then(Value::as_str)
                .is_some_and(|id| !id.trim().is_empty())
        })
    {
        return None;
    }
    let content = v.pointer("/message/content")?;
    if let Some(s) = content.as_str() {
        let cleaned = s;
        let trimmed = cleaned.trim();
        if trimmed.is_empty() {
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
                    let cleaned = s;
                    let trimmed = cleaned.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(trimmed);
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
    if trimmed.is_empty() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct SearchFixture {
        root: PathBuf,
        dirs: Vec<PathBuf>,
        files: Vec<PathBuf>,
    }

    impl SearchFixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("claudinal-search-locator-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).expect("create isolated search fixture");
            Self {
                root,
                dirs: vec![],
                files: vec![],
            }
        }

        fn transcript(&mut self, dir: &str, session: &str, contents: &[u8]) -> PathBuf {
            let parent = self.root.join(dir);
            if !parent.is_dir() {
                std::fs::create_dir(&parent).expect("create fixture project");
                self.dirs.push(parent.clone());
            }
            let path = parent.join(format!("{session}.jsonl"));
            std::fs::write(&path, contents).expect("write fixture transcript");
            self.files.push(path.clone());
            path
        }
    }

    impl Drop for SearchFixture {
        fn drop(&mut self) {
            for path in &self.files {
                let _ = std::fs::remove_file(path);
            }
            for path in &self.dirs {
                let _ = std::fs::remove_dir(path);
            }
            let _ = std::fs::remove_dir(&self.root);
        }
    }

    #[test]
    fn search_hits_keep_real_uuid_and_original_replay_record_index() -> Result<()> {
        let mut fixture = SearchFixture::new();
        let path = fixture.transcript(
            "project",
            "session",
            concat!(
                "{\"type\":\"system\",\"cwd\":\"F:/isolated/project\"}\n",
                "not json\n\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"content\":\"hiddenneedle\"}}\n",
                "null\n",
                "{\"type\":\"user\",\"uuid\":\"user-uuid\",\"message\":{\"content\":\"authoredneedle\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"snapshot-one\",\"message\":{\"id\":\"shared-message\",\"content\":[{\"type\":\"text\",\"text\":\"firstneedle\"}]}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"snapshot-two\",\"message\":{\"id\":\"shared-message\",\"content\":[{\"type\":\"tool_use\",\"name\":\"Agent\",\"id\":\"tool-one\"}]}}\n",
                "{\"type\":\"assistant\",\"agent_id\":\"child\",\"message\":{\"content\":\"forwardedneedle\"}}\n",
                "{\"type\":\"assistant\",\"parent_tool_use_id\":\"child-tool\",\"message\":{\"content\":\"forwardedneedle\"}}\n",
            )
            .as_bytes(),
        );
        let mut conn = store::test_connection()?;
        sync_fts_index_at_root(&mut conn, &fixture.root)?;
        for (query, uuid, index) in [
            ("authoredneedle", "user-uuid", 3),
            ("firstneedle", "snapshot-one", 4),
            ("Agent", "snapshot-two", 5),
        ] {
            let hits = query_fts_index(&conn, query, 50)?;
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].message_uuid.as_deref(), Some(uuid));
            assert_eq!(hits[0].transcript_index, index);
            assert_eq!(hits[0].file_path, Some(path.display().to_string()));
            assert_eq!(hits[0].cwd, "F:/isolated/project");
            let wire = serde_json::to_value(&hits[0])?;
            assert_eq!(wire["messageUuid"], uuid);
            assert_eq!(wire["transcriptIndex"], index);
        }
        assert!(query_fts_index(&conn, "hiddenneedle", 50)?.is_empty());
        assert!(query_fts_index(&conn, "forwardedneedle", 50)?.is_empty());
        Ok(())
    }

    #[test]
    fn incremental_index_counts_hidden_records_and_waits_for_complete_lines() -> Result<()> {
        let mut fixture = SearchFixture::new();
        let mut contents = concat!(
            "{\"type\":\"user\",\"message\":{\"content\":\"initialneedle\"}}\n",
            "{\"type\":\"system\",\"subtype\":\"compact_boundary\"}\n",
        )
        .as_bytes()
        .to_vec();
        contents.extend_from_slice(b"\xff\xfe\n");
        contents.extend_from_slice(
            b"{\"type\":\"assistant\",\"uuid\":\"\",\"message\":{\"content\":\"completedneedle\"}}",
        );
        let path = fixture.transcript("project", "session", &contents);
        let mut conn = store::test_connection()?;
        sync_fts_index_at_root(&mut conn, &fixture.root)?;
        assert!(query_fts_index(&conn, "completedneedle", 50)?.is_empty());

        let mut file = std::fs::OpenOptions::new().append(true).open(&path)?;
        file.write_all(concat!(
            "\n{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"content\":\"hiddenneedle\"}}\n",
            "{\"type\":\"assistant\",\"uuid\":\"later-uuid\",\"message\":{\"content\":\"laterneedle\"}}\n",
        ).as_bytes())?;
        drop(file);
        sync_fts_index_at_root(&mut conn, &fixture.root)?;
        sync_fts_index_at_root(&mut conn, &fixture.root)?;

        let completed = query_fts_index(&conn, "completedneedle", 50)?;
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].transcript_index, 2);
        assert_eq!(completed[0].message_uuid, None);
        let later = query_fts_index(&conn, "laterneedle", 50)?;
        assert_eq!(later.len(), 1);
        assert_eq!(later[0].transcript_index, 4);
        assert_eq!(later[0].message_uuid.as_deref(), Some("later-uuid"));
        assert!(query_fts_index(&conn, "hiddenneedle", 50)?.is_empty());
        let record_count: i64 = conn.query_row(
            "SELECT record_count FROM fts_progress WHERE file_path = ?1",
            params![path.display().to_string()],
            |row| row.get(0),
        )?;
        assert_eq!(record_count, 5);
        Ok(())
    }

    #[test]
    fn source_file_ownership_survives_duplicate_session_ids_and_rewrites() -> Result<()> {
        let mut fixture = SearchFixture::new();
        let first = fixture.transcript("project-one", "same-session", b"{\"type\":\"user\",\"uuid\":\"first\",\"message\":{\"content\":\"sharedneedle oldfirst\"}}\n");
        let second = fixture.transcript("project-two", "same-session", b"{\"type\":\"user\",\"uuid\":\"second\",\"message\":{\"content\":\"sharedneedle oldsecond\"}}\n");
        let mut conn = store::test_connection()?;
        sync_fts_index_at_root(&mut conn, &fixture.root)?;
        assert_eq!(query_fts_index(&conn, "sharedneedle", 50)?.len(), 2);
        std::fs::remove_file(&first)?;
        sync_fts_index_at_root(&mut conn, &fixture.root)?;
        let surviving = query_fts_index(&conn, "sharedneedle", 50)?;
        assert_eq!(surviving.len(), 1);
        assert_eq!(surviving[0].message_uuid.as_deref(), Some("second"));
        assert_eq!(surviving[0].file_path, Some(second.display().to_string()));

        // A same-size rewrite must reset both byte and record offsets.
        let previous = std::fs::read_to_string(&second)?;
        let rewritten = previous.replace("oldsecond", "newsecond");
        assert_eq!(previous.len(), rewritten.len());
        std::fs::write(&second, rewritten)?;
        conn.execute(
            "UPDATE fts_progress SET last_mtime_millis = last_mtime_millis - 1",
            [],
        )?;
        sync_fts_index_at_root(&mut conn, &fixture.root)?;
        assert!(query_fts_index(&conn, "oldsecond", 50)?.is_empty());
        let rewritten_hits = query_fts_index(&conn, "newsecond", 50)?;
        assert_eq!(rewritten_hits.len(), 1);
        assert_eq!(rewritten_hits[0].transcript_index, 0);

        std::fs::write(
            &second,
            b"{\"type\":\"user\",\"message\":{\"content\":\"shortneedle\"}}\n",
        )?;
        sync_fts_index_at_root(&mut conn, &fixture.root)?;
        assert!(query_fts_index(&conn, "newsecond", 50)?.is_empty());
        let truncated_hits = query_fts_index(&conn, "shortneedle", 50)?;
        assert_eq!(truncated_hits.len(), 1);
        assert_eq!(truncated_hits[0].message_uuid, None);
        assert_eq!(truncated_hits[0].transcript_index, 0);
        Ok(())
    }

    #[test]
    fn locator_metadata_does_not_expand_the_bounded_search_body() -> Result<()> {
        let mut fixture = SearchFixture::new();
        let event = serde_json::json!({
            "type": "user",
            "uuid": {"invalid": true},
            "message": {"content": format!("{} tailneedle", "x".repeat(MAX_BODY_CHARS))}
        });
        let path = fixture.transcript("project", "session", format!("{event}\n").as_bytes());
        let mut conn = store::test_connection()?;
        sync_fts_index_at_root(&mut conn, &fixture.root)?;
        let (body, uuid, index): (String, Option<String>, u64) = conn.query_row(
            "SELECT body, message_uuid, transcript_index FROM session_text WHERE file_path = ?1",
            params![path.display().to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(body.chars().count(), MAX_BODY_CHARS);
        assert_eq!(uuid, None);
        assert_eq!(index, 0);
        assert!(query_fts_index(&conn, "tailneedle", 50)?.is_empty());
        Ok(())
    }

    #[test]
    fn extract_message_text_ignores_synthetic_interruption_artifacts() {
        let interrupted = serde_json::json!({
            "type": "user",
            "promptId": "prompt-interrupted",
            "userType": "external",
            "entrypoint": "sdk-cli",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "[Request interrupted by user]" }]
            }
        });
        let no_response = serde_json::json!({
            "type": "assistant",
            "isApiErrorMessage": false,
            "message": {
                "role": "assistant",
                "model": "<synthetic>",
                "stop_reason": "stop_sequence",
                "content": [{ "type": "text", "text": "No response requested." }]
            }
        });

        assert_eq!(extract_message_text(&interrupted), None);
        assert_eq!(extract_message_text(&no_response), None);
    }

    #[test]
    fn extract_message_text_keeps_similar_genuine_content() {
        let genuine = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "text",
                    "text": "解释 [Request interrupted by user] 的含义"
                }]
            }
        });

        assert_eq!(
            extract_message_text(&genuine),
            Some("解释 [Request interrupted by user] 的含义".to_string())
        );

        let exact_without_sdk_metadata = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "[Request interrupted by user]" }]
            }
        });
        assert_eq!(
            extract_message_text(&exact_without_sdk_metadata),
            Some("[Request interrupted by user]".to_string())
        );
    }
}
