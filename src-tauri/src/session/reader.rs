use serde::Serialize;
use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub file_path: String,
    pub modified_ts: u64,
    pub size_bytes: u64,
    pub msg_count: usize,
    pub ai_title: Option<String>,
    pub first_user_text: Option<String>,
}

/// Claude CLI 的 cwd 编码规则（导出给 watcher 用）：
/// 把所有非 ASCII 字母数字非连字符的字符替换为 `-`（不压缩连续 `-`）。
/// 例：`F:\project\claude-test` → `F--project-claude-test`
pub fn encode_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// 兼容早期 GUI 版本的编码：Rust `is_alphanumeric` 会保留中文等 Unicode 字符。
fn encode_cwd_unicode_compat(cwd: &str) -> String {
    cwd.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn projects_root() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
    Ok(home.join(".claude").join("projects"))
}

pub(crate) fn project_dirs(cwd: &str) -> Result<Vec<PathBuf>> {
    let root = projects_root()?;
    let mut out = vec![root.join(encode_cwd(cwd))];
    let compat = root.join(encode_cwd_unicode_compat(cwd));
    if compat != out[0] {
        out.push(compat);
    }
    Ok(out)
}

fn primary_projects_dir(cwd: &str) -> Result<PathBuf> {
    let dirs = project_dirs(cwd)?;
    dirs.into_iter()
        .next()
        .ok_or_else(|| Error::Other("project dir not found".into()))
}

fn validate_session_id(session_id: &str) -> Result<()> {
    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return Err(Error::Other(format!("invalid session id: {session_id}")));
    }
    Ok(())
}

fn session_jsonl_path(cwd: &str, session_id: &str) -> Result<PathBuf> {
    validate_session_id(session_id)?;
    let mut best: Option<(u64, PathBuf)> = None;
    for dir in project_dirs(cwd)? {
        let path = dir.join(format!("{}.jsonl", session_id));
        if !path.is_file() {
            continue;
        }
        let modified_ts = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let replace = best
            .as_ref()
            .map(|(existing_ts, _)| modified_ts > *existing_ts)
            .unwrap_or(true);
        if replace {
            best = Some((modified_ts, path));
        }
    }
    if let Some((_, path)) = best {
        return Ok(path);
    }
    Err(Error::Other(format!(
        "transcript not found for session: {session_id}"
    )))
}

fn sidecar_paths(cwd: &str, session_id: &str) -> Result<Vec<PathBuf>> {
    validate_session_id(session_id)?;
    Ok(project_dirs(cwd)?
        .into_iter()
        .map(|dir| dir.join(format!("{}.claudinal.json", session_id)))
        .collect())
}

pub fn list_project_sessions(cwd: &str) -> Result<Vec<SessionMeta>> {
    let dirs = project_dirs(cwd)?;
    if !dirs.iter().any(|dir| dir.is_dir()) {
        return Ok(vec![]);
    }
    let mut by_id: HashMap<String, SessionMeta> = HashMap::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let file_stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if file_stem.is_empty() {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified_ts = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let size_bytes = meta.len();
            let replace_existing = by_id
                .get(&file_stem)
                .map(|existing| modified_ts > existing.modified_ts)
                .unwrap_or(true);
            if !replace_existing {
                continue;
            }
            let (msg_count, ai_title, first_user_text) = scan_jsonl(&path);
            by_id.insert(
                file_stem.clone(),
                SessionMeta {
                    id: file_stem,
                    file_path: path.display().to_string(),
                    modified_ts,
                    size_bytes,
                    msg_count,
                    ai_title,
                    first_user_text,
                },
            );
        }
    }
    let mut out = by_id.into_values().collect::<Vec<_>>();
    out.sort_by(|a, b| b.modified_ts.cmp(&a.modified_ts));
    Ok(out)
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect::<String>()
}

fn scan_jsonl(path: &Path) -> (usize, Option<String>, Option<String>) {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, None, None),
    };
    let reader = std::io::BufReader::new(file);
    let mut count: usize = 0;
    let mut ai_title: Option<String> = None;
    let mut first_user_text: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match t {
            "user" | "assistant" | "message" => count += 1,
            _ => {}
        }
        if ai_title.is_none() && t == "ai-title" {
            if let Some(s) = v.get("aiTitle").and_then(|x| x.as_str()) {
                ai_title = Some(truncate_chars(s, 120));
            }
        }
        if first_user_text.is_none() && t == "user" {
            if let Some(content) = v.pointer("/message/content") {
                if let Some(arr) = content.as_array() {
                    for c in arr {
                        if c.get("type").and_then(|x| x.as_str()) == Some("text") {
                            if let Some(text) = c.get("text").and_then(|x| x.as_str()) {
                                first_user_text = Some(truncate_chars(text, 120));
                                break;
                            }
                        }
                    }
                } else if let Some(s) = content.as_str() {
                    first_user_text = Some(truncate_chars(s, 120));
                }
            }
        }
    }
    (count, ai_title, first_user_text)
}

pub fn read_session_sidecar(cwd: &str, session_id: &str) -> Result<Option<serde_json::Value>> {
    for path in sidecar_paths(cwd, session_id)? {
        if !path.is_file() {
            continue;
        }
        let raw = std::fs::read_to_string(&path)?;
        let v: serde_json::Value = serde_json::from_str(&raw)?;
        return Ok(Some(v));
    }
    Ok(None)
}

pub fn write_session_sidecar(cwd: &str, session_id: &str, data: serde_json::Value) -> Result<()> {
    validate_session_id(session_id)?;
    let dir = session_jsonl_path(cwd, session_id)
        .ok()
        .and_then(|path| path.parent().map(|p| p.to_path_buf()))
        .unwrap_or(primary_projects_dir(cwd)?);
    let path = dir.join(format!("{}.claudinal.json", session_id));
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(Error::from)?;
        }
    }
    let text = serde_json::to_string_pretty(&data)?;
    std::fs::write(&path, text).map_err(Error::from)?;
    Ok(())
}

pub fn delete_session_jsonl(cwd: &str, session_id: &str) -> Result<()> {
    validate_session_id(session_id)?;
    let mut removed = false;
    for dir in project_dirs(cwd)? {
        let path = dir.join(format!("{}.jsonl", session_id));
        if path.is_file() {
            std::fs::remove_file(&path).map_err(Error::from)?;
            removed = true;
        }
    }
    if !removed {
        return Err(Error::Other(format!(
            "transcript not found for session: {session_id}"
        )));
    }
    // 同步删除所有兼容目录下的 sidecar（如果有）
    for sidecar in sidecar_paths(cwd, session_id)? {
        let _ = std::fs::remove_file(sidecar);
    }
    Ok(())
}

pub fn read_session_transcript(cwd: &str, session_id: &str) -> Result<Vec<serde_json::Value>> {
    let path = session_jsonl_path(cwd, session_id)?;
    let file = std::fs::File::open(&path)?;
    let reader = std::io::BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            out.push(v);
        }
    }
    Ok(out)
}
