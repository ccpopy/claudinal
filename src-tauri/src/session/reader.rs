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

#[derive(Debug, Clone)]
pub(crate) struct SessionFileMeta {
    pub id: String,
    pub file_path: String,
    pub modified_ts: u64,
    pub modified_millis: u64,
    pub size_bytes: u64,
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

pub(crate) fn projects_root() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
    Ok(home.join(".claude").join("projects"))
}

/// 从 jsonl 头部若干行尝试取出原始 cwd 字段（Claude CLI 在 init 事件里写入）。
pub(crate) fn extract_cwd_from_jsonl(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().take(20) {
        let Ok(line) = line else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if let Some(cwd) = v.get("cwd").and_then(|x| x.as_str()) {
            if !cwd.is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
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

pub(crate) fn session_file_meta(path: &Path) -> Result<Option<SessionFileMeta>> {
    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Ok(None);
    }
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return Ok(None);
    };
    let id = stem.to_string();
    if id.is_empty() {
        return Ok(None);
    }
    let meta = std::fs::metadata(path)?;
    let modified = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| {
            Error::Other(format!(
                "file mtime before UNIX_EPOCH: {}: {e}",
                path.display()
            ))
        })?;
    let modified_millis = modified
        .as_secs()
        .checked_mul(1000)
        .and_then(|v| v.checked_add(u64::from(modified.subsec_millis())))
        .ok_or_else(|| Error::Other(format!("file mtime out of range: {}", path.display())))?;
    Ok(Some(SessionFileMeta {
        id,
        file_path: path.display().to_string(),
        modified_ts: modified.as_secs(),
        modified_millis,
        size_bytes: meta.len(),
    }))
}

pub(crate) fn scan_session_meta(file: &SessionFileMeta) -> SessionMeta {
    let (msg_count, ai_title, first_user_text) = scan_jsonl(Path::new(&file.file_path));
    SessionMeta {
        id: file.id.clone(),
        file_path: file.file_path.clone(),
        modified_ts: file.modified_ts,
        size_bytes: file.size_bytes,
        msg_count,
        ai_title,
        first_user_text,
    }
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect::<String>()
}

pub(crate) fn is_internal_command_text(s: &str) -> bool {
    let trimmed = s.trim_start();
    if let Some(rest) = trimmed.strip_prefix("<command-name>") {
        return rest.contains("</command-name>");
    }
    let Some(after_prefix) = trimmed.strip_prefix("<local-command-") else {
        return false;
    };
    let Some(end_idx) = after_prefix.find('>') else {
        return false;
    };
    let tag_suffix = &after_prefix[..end_idx];
    if tag_suffix.is_empty()
        || !tag_suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return false;
    }
    let closing = format!("</local-command-{tag_suffix}>");
    after_prefix[end_idx + 1..].contains(&closing)
}

fn title_candidate(s: &str, max_chars: usize) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() || is_internal_command_text(trimmed) {
        return None;
    }
    Some(truncate_chars(trimmed, max_chars))
}

pub(crate) fn scan_jsonl(path: &Path) -> (usize, Option<String>, Option<String>) {
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
                ai_title = title_candidate(s, 120);
            }
        }
        if first_user_text.is_none() && t == "user" {
            if let Some(content) = v.pointer("/message/content") {
                if let Some(arr) = content.as_array() {
                    for c in arr {
                        if c.get("type").and_then(|x| x.as_str()) == Some("text") {
                            if let Some(text) = c.get("text").and_then(|x| x.as_str()) {
                                if let Some(title) = title_candidate(text, 120) {
                                    first_user_text = Some(title);
                                    break;
                                }
                            }
                        }
                    }
                } else if let Some(s) = content.as_str() {
                    first_user_text = title_candidate(s, 120);
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
    // 原子写：先写临时文件再 rename，避免半截 sidecar 影响后续 composer 偏好恢复。
    let tmp = path.with_extension(format!("json.tmp.{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(Error::from)?;
    if let Err(err) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::from(err));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_candidate_rejects_internal_command_payload() {
        let raw = "<command-name>/effort</command-name>\n\
            <command-message>effort</command-message>\n\
            <command-args>max</command-args>";
        let stdout = "<local-command-stdout>Set effort level to max</local-command-stdout>";

        assert_eq!(title_candidate(raw, 120), None);
        assert_eq!(title_candidate(stdout, 120), None);
        assert_eq!(
            title_candidate(" 更新 plan.md 和项目事件 ", 120),
            Some("更新 plan.md 和项目事件".to_string())
        );
    }

    #[test]
    fn title_candidate_returns_none_for_blank_input() {
        assert_eq!(title_candidate("   ", 120), None);
        assert_eq!(title_candidate("", 120), None);
    }

    #[test]
    fn title_candidate_truncates_to_char_limit_without_panicking_on_multibyte() {
        // 5 chars 限制，每个汉字算一个 char
        assert_eq!(
            title_candidate("一二三四五六七八", 5),
            Some("一二三四五".to_string())
        );
    }

    #[test]
    fn encode_cwd_replaces_non_ascii_alphanumeric_with_dash() {
        // ASCII：字母数字 / 连字符保留，其他每个字符被替换为单独一个 -（不压缩相邻 -）
        assert_eq!(
            encode_cwd("F:\\project\\claude-test"),
            "F--project-claude-test"
        );
        assert_eq!(encode_cwd("/Users/me/repo"), "-Users-me-repo");
        assert_eq!(encode_cwd("with space"), "with-space");
        // 中文不属于 ASCII alphanumeric，每个字符各替换为一个 -
        // F:\项目\demo → F + - + - + - + - + - + d + e + m + o
        assert_eq!(encode_cwd("F:\\项目\\demo"), "F-----demo");
    }

    #[test]
    fn encode_cwd_unicode_compat_preserves_non_ascii_alphanumerics() {
        // 兼容编码把中文当作 alphanumeric 保留下来；分隔符仍各自被替换为一个 -
        // F:\项目\demo → F + - + - + 项 + 目 + - + d + e + m + o
        assert_eq!(encode_cwd_unicode_compat("F:\\项目\\demo"), "F--项目-demo");
        assert_eq!(
            encode_cwd_unicode_compat("F:\\project\\claude-test"),
            "F--project-claude-test"
        );
    }

    #[test]
    fn project_dirs_contains_distinct_ascii_and_unicode_paths_when_relevant() {
        let dirs = project_dirs("F:\\项目\\demo").expect("dirs");
        // ASCII 编码结果
        assert!(dirs.iter().any(|p| p.ends_with("F-----demo")));
        // Unicode 兼容编码结果
        assert!(dirs.iter().any(|p| p.ends_with("F--项目-demo")));
        assert_eq!(dirs.len(), 2);

        // ASCII-only 路径下两个编码结果一致，应该只保留一个
        let ascii_dirs = project_dirs("F:\\project\\demo").expect("ascii dirs");
        assert_eq!(ascii_dirs.len(), 1);
    }

    #[test]
    fn validate_session_id_blocks_path_separators_and_traversal() {
        assert!(validate_session_id("abc-123").is_ok());
        assert!(validate_session_id("good_id-2026").is_ok());
        assert!(validate_session_id("../escape").is_err());
        assert!(validate_session_id("with/slash").is_err());
        assert!(validate_session_id("with\\backslash").is_err());
        assert!(validate_session_id("dot..segment").is_err());
    }

    #[test]
    fn is_internal_command_text_recognizes_command_blocks() {
        assert!(is_internal_command_text(
            "<command-name>/help</command-name>"
        ));
        assert!(is_internal_command_text(
            "  <local-command-stdout>ok</local-command-stdout>"
        ));
        // 闭合标签未出现 → 不算命令文本
        assert!(!is_internal_command_text("<command-name>/help"));
        // 标签后缀含非法字符 → 不算
        assert!(!is_internal_command_text(
            "<local-command-bad name>x</local-command-bad name>"
        ));
        // 空字符串 / 普通文本
        assert!(!is_internal_command_text(""));
        assert!(!is_internal_command_text("普通用户消息"));
    }
}
