use std::collections::HashMap;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Timelike, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};

use super::store::{self, as_i64};

#[derive(Serialize)]
pub struct ActivityCell {
    pub date: String,
    pub hour: u32,
    pub count: u32,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct ModelUsageAgg {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Serialize)]
pub struct UsageScanError {
    pub path: String,
    pub reason: String,
}

#[derive(Default, Serialize)]
pub struct GlobalUsage {
    pub total_cost_usd: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read: u64,
    pub total_cache_write: u64,
    pub session_count: u32,
    pub with_sidecar_count: u32,
    pub skipped_sidecar_count: u32,
    pub scan_errors: Vec<UsageScanError>,
    pub by_model: HashMap<String, ModelUsageAgg>,
    pub last_updated: i64,
}

fn projects_root() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
    Ok(home.join(".claude").join("projects"))
}

/// 扫描 ~/.claude/projects/<encoded>/* 同时统计：
///   - jsonl 文件总数 → session_count（真实会话数，含 CLI 直接发起的）
///   - claudinal.json sidecar → cost/tokens/by_model 累加
///
/// 实现：sidecar 内容入 SQLite `session_usage` 表，按 (mtime, size) 增量 upsert，
/// 聚合走 SQL。SQLite 是 cache，sidecar 文件本身仍是真理源。
pub fn scan_all_usage_sidecars() -> Result<GlobalUsage> {
    let mut agg = GlobalUsage::default();
    let root = match projects_root() {
        Ok(p) => p,
        Err(_) => return Ok(agg),
    };
    if !root.is_dir() {
        return Ok(agg);
    }

    let mut conn = store::open()?;
    let scan_errors = sync_usage_index(&mut conn, &root, &mut agg)?;
    agg.scan_errors = scan_errors;

    let row = conn.query_row(
        r#"
        SELECT
          COUNT(*),
          COALESCE(SUM(cost_usd), 0),
          COALESCE(SUM(input_tokens), 0),
          COALESCE(SUM(output_tokens), 0),
          COALESCE(SUM(cache_read), 0),
          COALESCE(SUM(cache_write), 0)
        FROM session_usage
        WHERE parse_error IS NULL
        "#,
        [],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        },
    )?;
    agg.with_sidecar_count = row.0.max(0) as u32;
    agg.total_cost_usd = row.1;
    agg.total_input_tokens = row.2.max(0) as u64;
    agg.total_output_tokens = row.3.max(0) as u64;
    agg.total_cache_read = row.4.max(0) as u64;
    agg.total_cache_write = row.5.max(0) as u64;

    let mut stmt = conn.prepare(
        "SELECT by_model_json FROM session_usage WHERE parse_error IS NULL AND by_model_json IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for row in rows {
        let json = match row {
            Ok(j) => j,
            Err(_) => continue,
        };
        let parsed: HashMap<String, ModelUsageAgg> = match serde_json::from_str(&json) {
            Ok(m) => m,
            Err(_) => continue,
        };
        for (model, entry) in parsed {
            let cur = agg.by_model.entry(model).or_default();
            cur.input_tokens += entry.input_tokens;
            cur.output_tokens += entry.output_tokens;
            cur.cache_read_input_tokens += entry.cache_read_input_tokens;
            cur.cache_creation_input_tokens += entry.cache_creation_input_tokens;
            cur.cost_usd += entry.cost_usd;
        }
    }

    agg.last_updated = Utc::now().timestamp();
    Ok(agg)
}

fn sync_usage_index(
    conn: &mut Connection,
    root: &Path,
    agg: &mut GlobalUsage,
) -> Result<Vec<UsageScanError>> {
    let mut errors: Vec<UsageScanError> = Vec::new();

    #[derive(Default)]
    struct DiskFile {
        sidecar: Option<(PathBuf, u64, i64)>,
    }
    let mut disk: HashMap<String, DiskFile> = HashMap::new();
    let mut session_count: u32 = 0;

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.path().is_dir() {
            continue;
        }
        for f in std::fs::read_dir(entry.path())? {
            let f = match f {
                Ok(f) => f,
                Err(_) => continue,
            };
            let path = f.path();
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if name.ends_with(".jsonl") {
                session_count += 1;
                continue;
            }
            if !name.ends_with(".claudinal.json") {
                continue;
            }
            let session_id = name.trim_end_matches(".claudinal.json").to_string();
            let meta = match path.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime_millis = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            disk.insert(
                session_id,
                DiskFile {
                    sidecar: Some((path, meta.len(), mtime_millis)),
                },
            );
        }
    }
    agg.session_count = session_count;

    let tx = conn.transaction()?;

    let mut existing: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut stmt =
            tx.prepare("SELECT session_id, sidecar_mtime_millis, sidecar_size FROM session_usage")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (sid, mtime, size) = row?;
            existing.insert(sid, (mtime, size));
        }
    }

    for (session_id, file) in &disk {
        let Some((path, size, mtime)) = file.sidecar.as_ref() else {
            continue;
        };
        let size_i = as_i64(*size, "sidecar_size")?;
        let prev = existing.remove(session_id);
        if let Some((prev_mtime, prev_size)) = prev {
            if prev_mtime == *mtime && prev_size == size_i {
                continue;
            }
        }

        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                upsert_error(
                    &tx,
                    session_id,
                    path,
                    *size,
                    *mtime,
                    format!("read failed: {e}"),
                )?;
                agg.skipped_sidecar_count += 1;
                errors.push(UsageScanError {
                    path: path.display().to_string(),
                    reason: format!("read failed: {e}"),
                });
                continue;
            }
        };
        let v: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                upsert_error(
                    &tx,
                    session_id,
                    path,
                    *size,
                    *mtime,
                    format!("json parse failed: {e}"),
                )?;
                agg.skipped_sidecar_count += 1;
                errors.push(UsageScanError {
                    path: path.display().to_string(),
                    reason: format!("json parse failed: {e}"),
                });
                continue;
            }
        };
        let result = match v.get("result") {
            Some(r) => r,
            None => {
                upsert_error(&tx, session_id, path, *size, *mtime, "missing result")?;
                agg.skipped_sidecar_count += 1;
                errors.push(UsageScanError {
                    path: path.display().to_string(),
                    reason: "missing result".into(),
                });
                continue;
            }
        };
        let cost_usd = result
            .get("total_cost_usd")
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0);
        let mut input_tokens: u64 = 0;
        let mut output_tokens: u64 = 0;
        let mut cache_read: u64 = 0;
        let mut cache_write: u64 = 0;
        let mut by_model_map: HashMap<String, ModelUsageAgg> = HashMap::new();
        if let Some(obj) = result.get("modelUsage").and_then(|x| x.as_object()) {
            for (model, entry) in obj {
                let i = entry
                    .get("inputTokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let o = entry
                    .get("outputTokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let cr = entry
                    .get("cacheReadInputTokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let cw = entry
                    .get("cacheCreationInputTokens")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0);
                let c = entry.get("costUSD").and_then(|x| x.as_f64()).unwrap_or(0.0);
                input_tokens += i;
                output_tokens += o;
                cache_read += cr;
                cache_write += cw;
                by_model_map.insert(
                    model.clone(),
                    ModelUsageAgg {
                        input_tokens: i,
                        output_tokens: o,
                        cache_read_input_tokens: cr,
                        cache_creation_input_tokens: cw,
                        cost_usd: c,
                    },
                );
            }
        }
        let by_model_json = serde_json::to_string(&by_model_map).ok();

        tx.execute(
            r#"
            INSERT INTO session_usage
              (session_id, sidecar_path, sidecar_mtime_millis, sidecar_size,
               cost_usd, input_tokens, output_tokens, cache_read, cache_write,
               by_model_json, parse_error, indexed_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)
            ON CONFLICT(session_id) DO UPDATE SET
              sidecar_path = excluded.sidecar_path,
              sidecar_mtime_millis = excluded.sidecar_mtime_millis,
              sidecar_size = excluded.sidecar_size,
              cost_usd = excluded.cost_usd,
              input_tokens = excluded.input_tokens,
              output_tokens = excluded.output_tokens,
              cache_read = excluded.cache_read,
              cache_write = excluded.cache_write,
              by_model_json = excluded.by_model_json,
              parse_error = NULL,
              indexed_at = excluded.indexed_at
            "#,
            params![
                session_id,
                path.display().to_string(),
                *mtime,
                size_i,
                cost_usd,
                as_i64(input_tokens, "input_tokens")?,
                as_i64(output_tokens, "output_tokens")?,
                as_i64(cache_read, "cache_read")?,
                as_i64(cache_write, "cache_write")?,
                by_model_json,
                store::now_secs(),
            ],
        )?;
    }

    for (sid, _) in existing {
        if !disk.contains_key(&sid) {
            tx.execute(
                "DELETE FROM session_usage WHERE session_id = ?1",
                params![sid],
            )?;
        }
    }

    tx.commit()?;
    Ok(errors)
}

fn upsert_error(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    path: &Path,
    size: u64,
    mtime: i64,
    reason: impl Into<String>,
) -> Result<()> {
    let size_i = as_i64(size, "sidecar_size")?;
    tx.execute(
        r#"
        INSERT INTO session_usage
          (session_id, sidecar_path, sidecar_mtime_millis, sidecar_size,
           cost_usd, input_tokens, output_tokens, cache_read, cache_write,
           by_model_json, parse_error, indexed_at)
        VALUES (?1, ?2, ?3, ?4, 0, 0, 0, 0, 0, NULL, ?5, ?6)
        ON CONFLICT(session_id) DO UPDATE SET
          sidecar_path = excluded.sidecar_path,
          sidecar_mtime_millis = excluded.sidecar_mtime_millis,
          sidecar_size = excluded.sidecar_size,
          cost_usd = 0,
          input_tokens = 0,
          output_tokens = 0,
          cache_read = 0,
          cache_write = 0,
          by_model_json = NULL,
          parse_error = excluded.parse_error,
          indexed_at = excluded.indexed_at
        "#,
        params![
            session_id,
            path.display().to_string(),
            mtime,
            size_i,
            reason.into(),
            store::now_secs(),
        ],
    )?;
    Ok(())
}

/// 扫描 ~/.claude/projects/<encoded>/*.jsonl，按本地时区把 timestamp 桶到 (date, hour, count)。
///
/// 实现：每个 jsonl 在 `heatmap_progress` 里记录 `(last_size, last_mtime, byte_offset)`，
/// 下次只追加扫描 `byte_offset..eof` 的新行。文件被 truncate / 重建（size 变小或
/// mtime 倒退）则整个重扫。**ingest 时不过滤 days**——所有历史事件都入桶，查询时按
/// `days` 切片。这样用户从 days=7 切到 days=30 不会丢早期数据。
pub fn scan_activity_heatmap(days: u32) -> Result<Vec<ActivityCell>> {
    let root = match projects_root() {
        Ok(p) => p,
        Err(_) => return Ok(vec![]),
    };
    if !root.is_dir() {
        return Ok(vec![]);
    }

    let cutoff_local = Local::now() - Duration::days(days as i64);
    let cutoff_date = format!(
        "{:04}-{:02}-{:02}",
        cutoff_local.year(),
        cutoff_local.month(),
        cutoff_local.day()
    );

    let mut conn = store::open()?;
    sync_heatmap_index(&mut conn, &root)?;

    let mut stmt = conn.prepare(
        "SELECT date, hour, count FROM activity_bucket WHERE date >= ?1 ORDER BY date, hour",
    )?;
    let rows = stmt.query_map(params![cutoff_date], |r| {
        Ok(ActivityCell {
            date: r.get(0)?,
            hour: r.get::<_, i64>(1)?.max(0) as u32,
            count: r.get::<_, i64>(2)?.max(0) as u32,
        })
    })?;
    let mut out = Vec::new();
    for cell in rows.flatten() {
        out.push(cell);
    }
    Ok(out)
}

fn sync_heatmap_index(conn: &mut Connection, root: &Path) -> Result<()> {
    let tx = conn.transaction()?;

    let mut progress: HashMap<String, (i64, i64, i64)> = HashMap::new();
    {
        let mut stmt = tx.prepare(
            "SELECT file_path, last_size, last_mtime_millis, byte_offset FROM heatmap_progress",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        for row in rows {
            let (fp, size, mtime, offset) = row?;
            progress.insert(fp, (size, mtime, offset));
        }
    }

    let mut alive: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.path().is_dir() {
            continue;
        }
        for f in std::fs::read_dir(entry.path())? {
            let f = match f {
                Ok(f) => f,
                Err(_) => continue,
            };
            let path = f.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let path_str = path.display().to_string();
            alive.insert(path_str.clone());

            let meta = match path.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified = match meta.modified() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime_millis = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let size_i = as_i64(meta.len(), "size")?;

            let prev = progress.remove(&path_str);

            let (start_offset, do_scan) = match prev {
                Some((prev_size, prev_mtime, prev_offset)) => {
                    if size_i == prev_size && mtime_millis == prev_mtime {
                        (prev_offset, false)
                    } else if size_i < prev_size || mtime_millis < prev_mtime {
                        (0, true)
                    } else {
                        (prev_offset.min(size_i), true)
                    }
                }
                None => (0, true),
            };

            let new_offset = if do_scan {
                ingest_heatmap_increments(&tx, &path, start_offset)?
            } else {
                start_offset
            };

            tx.execute(
                r#"
                INSERT INTO heatmap_progress (file_path, last_size, last_mtime_millis, byte_offset, last_scanned_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(file_path) DO UPDATE SET
                  last_size = excluded.last_size,
                  last_mtime_millis = excluded.last_mtime_millis,
                  byte_offset = excluded.byte_offset,
                  last_scanned_at = excluded.last_scanned_at
                "#,
                params![
                    path_str,
                    size_i,
                    mtime_millis,
                    new_offset,
                    store::now_secs(),
                ],
            )?;
        }
    }

    for (fp, _) in progress {
        if !alive.contains(&fp) {
            tx.execute(
                "DELETE FROM heatmap_progress WHERE file_path = ?1",
                params![fp],
            )?;
        }
    }

    tx.commit()?;
    Ok(())
}

fn ingest_heatmap_increments(
    tx: &rusqlite::Transaction<'_>,
    path: &Path,
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
    let mut buckets: HashMap<(String, u32), u32> = HashMap::new();
    loop {
        line.clear();
        let n = match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        // 不完整行（末尾无 \n）：保留偏移到行首，下次再读。
        let complete = line.ends_with('\n');
        if !complete {
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
        if !matches!(t, "user" | "assistant" | "message") {
            continue;
        }
        let ts_str = match v.get("timestamp").and_then(|x| x.as_str()) {
            Some(s) => s,
            None => continue,
        };
        let dt = match DateTime::parse_from_rfc3339(ts_str) {
            Ok(d) => d.with_timezone(&Local),
            Err(_) => continue,
        };
        let date = format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day());
        let hour = dt.hour();
        *buckets.entry((date, hour)).or_insert(0) += 1;
    }

    for ((date, hour), count) in buckets {
        tx.execute(
            r#"
            INSERT INTO activity_bucket (date, hour, count) VALUES (?1, ?2, ?3)
            ON CONFLICT(date, hour) DO UPDATE SET count = count + excluded.count
            "#,
            params![date, hour as i64, count as i64],
        )?;
    }

    Ok(bytes_read)
}

#[allow(dead_code)]
fn _silence_timezone_unused(_: chrono::FixedOffset) {
    let _ = chrono::Utc.timestamp_opt(0, 0);
}
