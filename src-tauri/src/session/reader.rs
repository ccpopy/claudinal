use serde::Serialize;
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
/// 把所有非字母数字非连字符的字符替换为 `-`（不压缩连续 `-`）。
/// 例：`F:\project\claude-test` → `F--project-claude-test`
pub fn encode_cwd(cwd: &str) -> String {
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

fn projects_dir(cwd: &str) -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
    Ok(home.join(".claude").join("projects").join(encode_cwd(cwd)))
}

pub fn list_project_sessions(cwd: &str) -> Result<Vec<SessionMeta>> {
    let dir = projects_dir(cwd)?;
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out: Vec<SessionMeta> = Vec::new();
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
        let (msg_count, ai_title, first_user_text) = scan_jsonl(&path);
        out.push(SessionMeta {
            id: file_stem,
            file_path: path.display().to_string(),
            modified_ts,
            size_bytes,
            msg_count,
            ai_title,
            first_user_text,
        });
    }
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

fn sidecar_path(cwd: &str, session_id: &str) -> Result<PathBuf> {
    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return Err(Error::Other(format!("invalid session id: {session_id}")));
    }
    let dir = projects_dir(cwd)?;
    Ok(dir.join(format!("{}.claudinal.json", session_id)))
}

pub fn read_session_sidecar(cwd: &str, session_id: &str) -> Result<Option<serde_json::Value>> {
    let path = sidecar_path(cwd, session_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    let v: serde_json::Value = serde_json::from_str(&raw)?;
    Ok(Some(v))
}

pub fn write_session_sidecar(cwd: &str, session_id: &str, data: serde_json::Value) -> Result<()> {
    let path = sidecar_path(cwd, session_id)?;
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
    if session_id.contains('/') || session_id.contains('\\') || session_id.contains("..") {
        return Err(Error::Other(format!("invalid session id: {session_id}")));
    }
    let dir = projects_dir(cwd)?;
    let path = dir.join(format!("{}.jsonl", session_id));
    if !path.is_file() {
        return Err(Error::Other(format!(
            "transcript not found: {}",
            path.display()
        )));
    }
    std::fs::remove_file(&path).map_err(Error::from)?;
    // 同步删除 sidecar（如果有）
    let sidecar = sidecar_path(cwd, session_id)?;
    let _ = std::fs::remove_file(&sidecar);
    Ok(())
}

pub fn read_session_transcript(cwd: &str, session_id: &str) -> Result<Vec<serde_json::Value>> {
    let dir = projects_dir(cwd)?;
    let path = dir.join(format!("{}.jsonl", session_id));
    if !path.is_file() {
        return Err(Error::Other(format!(
            "transcript not found: {}",
            path.display()
        )));
    }
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
