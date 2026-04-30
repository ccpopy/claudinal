use std::collections::HashMap;
use std::io::BufRead;
use std::path::PathBuf;

use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Timelike, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

#[derive(Serialize)]
pub struct ActivityCell {
    pub date: String, // "2026-04-15"（按本地时区）
    pub hour: u32,    // 0–23
    pub count: u32,
}

#[derive(Default, Serialize, Clone)]
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
    /// 全部 jsonl 文件数 = 真实会话数（含 CLI 直接发起、未经过 GUI 的）
    pub session_count: u32,
    /// 含 sidecar 的会话数 —— cost/tokens 仅来自这些会话（GUI 端写过 result）
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

fn merge_model_usage(agg: &mut GlobalUsage, model_usage: &Value) {
    let map = match model_usage.as_object() {
        Some(m) => m,
        None => return,
    };
    for (model, entry) in map {
        let cur = agg.by_model.entry(model.clone()).or_default();
        let input = entry
            .get("inputTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let output = entry
            .get("outputTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_read = entry
            .get("cacheReadInputTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_create = entry
            .get("cacheCreationInputTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cost = entry.get("costUSD").and_then(|v| v.as_f64()).unwrap_or(0.0);
        cur.input_tokens += input;
        cur.output_tokens += output;
        cur.cache_read_input_tokens += cache_read;
        cur.cache_creation_input_tokens += cache_create;
        cur.cost_usd += cost;
        agg.total_input_tokens += input;
        agg.total_output_tokens += output;
        agg.total_cache_read += cache_read;
        agg.total_cache_write += cache_create;
    }
}

fn record_sidecar_error(agg: &mut GlobalUsage, path: &std::path::Path, reason: impl Into<String>) {
    agg.skipped_sidecar_count += 1;
    agg.scan_errors.push(UsageScanError {
        path: path.display().to_string(),
        reason: reason.into(),
    });
}

/// 扫描 ~/.claude/projects/<encoded>/* 同时统计：
///   - jsonl 文件总数 → session_count（真实会话数，含 CLI 直接发起的）
///   - claudinal.json sidecar → cost/tokens/by_model 累加（仅 GUI 端写过 result）
pub fn scan_all_usage_sidecars() -> Result<GlobalUsage> {
    let mut agg = GlobalUsage::default();
    let root = match projects_root() {
        Ok(p) => p,
        Err(_) => return Ok(agg),
    };
    if !root.is_dir() {
        return Ok(agg);
    }
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.path().is_dir() {
            continue;
        }
        for f in std::fs::read_dir(entry.path())? {
            let f = f?;
            let path = f.path();
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            // 1) 真实会话数：每个 .jsonl 计 1
            if name.ends_with(".jsonl") {
                agg.session_count += 1;
                continue;
            }
            // 2) GUI sidecar 累加 cost/tokens
            if !name.ends_with(".claudinal.json") {
                continue;
            }
            let raw = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(e) => {
                    record_sidecar_error(&mut agg, &path, format!("read failed: {e}"));
                    continue;
                }
            };
            let v: Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(e) => {
                    record_sidecar_error(&mut agg, &path, format!("json parse failed: {e}"));
                    continue;
                }
            };
            let result = match v.get("result") {
                Some(r) => r,
                None => {
                    record_sidecar_error(&mut agg, &path, "missing result");
                    continue;
                }
            };
            agg.with_sidecar_count += 1;
            if let Some(cost) = result.get("total_cost_usd").and_then(|x| x.as_f64()) {
                agg.total_cost_usd += cost;
            }
            if let Some(mu) = result.get("modelUsage") {
                merge_model_usage(&mut agg, mu);
            }
        }
    }
    agg.last_updated = Utc::now().timestamp();
    Ok(agg)
}

/// 扫描 ~/.claude/projects/<encoded>/*.jsonl，按本地时区把 timestamp 桶到 (date, hour, count)。
/// 仅保留过去 `days` 天内的事件。文件 mtime 早于窗口的整文件跳过加速。
pub fn scan_activity_heatmap(days: u32) -> Result<Vec<ActivityCell>> {
    let mut buckets: HashMap<(String, u32), u32> = HashMap::new();
    let root = match projects_root() {
        Ok(p) => p,
        Err(_) => return Ok(vec![]),
    };
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let cutoff = Local::now() - Duration::days(days as i64);
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.path().is_dir() {
            continue;
        }
        for f in std::fs::read_dir(entry.path())? {
            let f = f?;
            let path = f.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(meta) = f.metadata() {
                if let Ok(modified) = meta.modified() {
                    let dt: DateTime<Utc> = modified.into();
                    if dt.with_timezone(&Local) < cutoff {
                        continue;
                    }
                }
            }
            let file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let reader = std::io::BufReader::new(file);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => continue,
                };
                if line.is_empty() {
                    continue;
                }
                let v: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let ts_str = match v.get("timestamp").and_then(|x| x.as_str()) {
                    Some(s) => s,
                    None => continue,
                };
                let dt = match DateTime::parse_from_rfc3339(ts_str) {
                    Ok(d) => d.with_timezone(&Local),
                    Err(_) => continue,
                };
                if dt < cutoff {
                    continue;
                }
                // 仅统计 user / assistant 消息，过滤 attachment / queue-operation 等内部事件
                let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                if !matches!(t, "user" | "assistant" | "message") {
                    continue;
                }
                let date = format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day());
                let hour = dt.hour();
                *buckets.entry((date, hour)).or_insert(0) += 1;
            }
        }
    }
    let cells = buckets
        .into_iter()
        .map(|((date, hour), count)| ActivityCell { date, hour, count })
        .collect::<Vec<_>>();
    Ok(cells)
}

#[allow(dead_code)]
fn _silence_timezone_unused(_: chrono::FixedOffset) {
    // chrono::TimeZone trait import keeper
    let _ = chrono::Utc.timestamp_opt(0, 0);
}
