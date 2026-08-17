use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use crate::error::{Error, Result};
use crate::fs_atomic::atomic_write_str;

const SKILL_META_PROMPT_PREFIX: &str = "Base directory for this skill:";
const INTERRUPTED_USER_SENTINEL: &str = "[Request interrupted by user]";
const NO_RESPONSE_SENTINEL: &str = "No response requested.";

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTranscriptChunk {
    pub events: Vec<serde_json::Value>,
    pub next_offset: u64,
    pub file_size: u64,
    pub truncated: bool,
    pub reset: bool,
    pub available: bool,
}

const MAX_SUBAGENT_CHUNK_BYTES: u64 = 512 * 1024;
const MAX_SUBAGENT_JSONL_LINE_BYTES: usize = 4 * 1024 * 1024;

fn discard_until_newline<R: BufRead>(reader: &mut R) -> std::io::Result<()> {
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(());
        }
        if let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
            reader.consume(index + 1);
            return Ok(());
        }
        let length = buffer.len();
        reader.consume(length);
    }
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

pub(crate) fn cwd_matches_jsonl(requested_cwd: &str, jsonl_cwd: &str) -> bool {
    normalize_cwd_for_match(requested_cwd) == normalize_cwd_for_match(jsonl_cwd)
}

pub(crate) fn jsonl_belongs_to_cwd(requested_cwd: &str, path: &Path) -> bool {
    extract_cwd_from_jsonl(path)
        .as_deref()
        .is_some_and(|jsonl_cwd| cwd_matches_jsonl(requested_cwd, jsonl_cwd))
}

fn normalize_cwd_for_match(cwd: &str) -> String {
    let mut normalized = cwd.trim().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
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

fn validate_agent_id(agent_id: &str) -> Result<()> {
    if agent_id.is_empty()
        || agent_id.len() > 128
        || !agent_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(Error::Other(format!("invalid agent id: {agent_id}")));
    }
    Ok(())
}

fn session_jsonl_path(cwd: &str, session_id: &str) -> Result<PathBuf> {
    validate_session_id(session_id)?;
    let mut best: Option<(u64, PathBuf)> = None;
    for dir in project_dirs(cwd)? {
        let path = dir.join(format!("{}.jsonl", session_id));
        if !path.is_file() || !jsonl_belongs_to_cwd(cwd, &path) {
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

fn subagent_jsonl_path(cwd: &str, session_id: &str, agent_id: &str) -> Result<PathBuf> {
    validate_agent_id(agent_id)?;
    let session_path = session_jsonl_path(cwd, session_id)?;
    let parent = session_path
        .parent()
        .ok_or_else(|| Error::Other("session transcript has no parent directory".into()))?;
    Ok(parent
        .join(session_id)
        .join("subagents")
        .join(format!("agent-{agent_id}.jsonl")))
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
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with(
        "caveat: the messages below were generated by the user while running local commands.",
    ) {
        return true;
    }
    for tag in [
        "command-name",
        "command-message",
        "command-args",
        "bash-input",
        "bash-stdout",
        "bash-stderr",
        "system-reminder",
        "task-notification",
        "local-command-caveat",
    ] {
        let opening = format!("<{tag}>");
        let closing = format!("</{tag}>");
        if lower.starts_with(&opening) && lower.contains(&closing) {
            return true;
        }
    }
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

pub(crate) fn strip_internal_text_sections(s: &str) -> String {
    [
        "system-reminder",
        "local-command-caveat",
        "task-notification",
    ]
    .into_iter()
    .fold(s.to_string(), remove_tag_section)
}

fn remove_tag_section(input: String, tag: &str) -> String {
    let opening = format!("<{tag}>");
    let closing = format!("</{tag}>");
    let mut out = String::with_capacity(input.len());
    let mut rest = input.as_str();
    while let Some(start) = rest.find(&opening) {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + opening.len()..];
        let Some(end) = after_open.find(&closing) else {
            return out;
        };
        rest = &after_open[end + closing.len()..];
    }
    out.push_str(rest);
    out
}

fn title_candidate(s: &str, max_chars: usize) -> Option<String> {
    let cleaned = strip_internal_text_sections(s);
    let trimmed = cleaned.trim();
    let internal = is_internal_command_text(trimmed) || is_skill_meta_prompt_text(trimmed);
    if trimmed.is_empty() || internal {
        return None;
    }
    // CLI 在 stream-json 会话里不写 ai-title，标题回落到首条用户消息；
    // 以 slash 命令开头的消息（"/frontend-design 帮我…"）剥离命令 token，让标题说人话。
    // 整条消息只有命令（"/effort"）时保留原文，避免标题变空。
    let without_command = strip_leading_slash_command(trimmed);
    let candidate = if without_command.is_empty() {
        trimmed
    } else {
        without_command
    };
    Some(truncate_chars(candidate, max_chars))
}

/// 剥离前导 slash 命令 token（"/frontend-design 帮我…" → "帮我…"）。
/// 命令名允许字母/数字/._- 和作用域冒号（plugin:skill 形式）；
/// 命令名后必须跟空白或结束（"/path/to/x" 这类路径开头不误剥）；
/// 整条消息只有命令时返回空串，由调用方回落原文。
fn strip_leading_slash_command(s: &str) -> &str {
    let rest = match s.strip_prefix('/') {
        Some(rest) => rest,
        None => return s,
    };
    let name_len = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':')))
        .unwrap_or(rest.len());
    if name_len == 0 {
        return s;
    }
    let after = &rest[name_len..];
    if after.is_empty() {
        return "";
    }
    if !after.starts_with(char::is_whitespace) {
        return s;
    }
    after.trim_start()
}

pub(crate) fn is_internal_generated_event(v: &serde_json::Value) -> bool {
    v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false)
        || v.get("isSidechain")
            .and_then(|x| x.as_bool())
            .unwrap_or(false)
        || is_skill_meta_prompt_event(v)
        || is_synthetic_interruption_event(v)
}

fn sole_text_content(v: &serde_json::Value) -> Option<&str> {
    let content = v.pointer("/message/content")?;
    if let Some(text) = content.as_str() {
        return Some(text.trim());
    }
    let items = content.as_array()?;
    if items.len() != 1 || items[0].get("type").and_then(|x| x.as_str()) != Some("text") {
        return None;
    }
    items[0].get("text").and_then(|x| x.as_str()).map(str::trim)
}

fn is_synthetic_interruption_event(v: &serde_json::Value) -> bool {
    let event_type = v.get("type").and_then(|x| x.as_str());
    let role = v.pointer("/message/role").and_then(|x| x.as_str());
    let text = sole_text_content(v);
    if event_type == Some("user") {
        return role == Some("user")
            && text == Some(INTERRUPTED_USER_SENTINEL)
            && v.get("promptId").and_then(|x| x.as_str()).is_some()
            && v.get("userType").and_then(|x| x.as_str()) == Some("external")
            && v.get("entrypoint").and_then(|x| x.as_str()) == Some("sdk-cli");
    }
    if event_type != Some("assistant") || role != Some("assistant") {
        return false;
    }
    let synthetic_model = v
        .pointer("/message/model")
        .and_then(|x| x.as_str())
        .map(|model| {
            model
                .split_whitespace()
                .collect::<String>()
                .eq_ignore_ascii_case("<synthetic>")
        })
        .unwrap_or(false);
    let stop_reason = v.pointer("/message/stop_reason").and_then(|x| x.as_str());
    synthetic_model
        && text == Some(NO_RESPONSE_SENTINEL)
        && matches!(stop_reason, None | Some("stop_sequence"))
        && v.get("isApiErrorMessage").and_then(|x| x.as_bool()) != Some(true)
}

pub(crate) fn is_synthetic_api_error_event(v: &serde_json::Value) -> bool {
    if v.get("type").and_then(|x| x.as_str()) != Some("assistant") {
        return false;
    }
    let model = v.pointer("/message/model").and_then(|x| x.as_str());
    let synthetic_model = model
        .map(|s| {
            s.split_whitespace()
                .collect::<String>()
                .eq_ignore_ascii_case("<synthetic>")
        })
        .unwrap_or(false);
    if !synthetic_model {
        return false;
    }
    v.get("isApiErrorMessage")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
        || v.get("apiErrorStatus").is_some()
        || v.get("api_error_status").is_some()
}

fn is_skill_meta_prompt_text(s: &str) -> bool {
    s.trim_start().starts_with(SKILL_META_PROMPT_PREFIX)
}

fn is_skill_meta_prompt_event(v: &serde_json::Value) -> bool {
    if v.get("type").and_then(|x| x.as_str()) != Some("user") {
        return false;
    }
    let Some(content) = v.pointer("/message/content") else {
        return false;
    };
    if let Some(s) = content.as_str() {
        return is_skill_meta_prompt_text(s);
    }
    let Some(items) = content.as_array() else {
        return false;
    };
    items.iter().any(|item| {
        item.get("type").and_then(|x| x.as_str()) == Some("text")
            && item
                .get("text")
                .and_then(|x| x.as_str())
                .is_some_and(is_skill_meta_prompt_text)
    })
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
        let internal = is_internal_generated_event(&v) || is_synthetic_api_error_event(&v);
        if !internal {
            match t {
                "user" | "assistant" | "message" => count += 1,
                _ => {}
            }
        }
        if ai_title.is_none() && t == "ai-title" {
            if let Some(s) = v.get("aiTitle").and_then(|x| x.as_str()) {
                ai_title = title_candidate(s, 120);
            }
        }
        if first_user_text.is_none() && t == "user" && !internal {
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

fn session_sidecar_path(cwd: &str, session_id: &str) -> Result<PathBuf> {
    validate_session_id(session_id)?;
    let dir = session_jsonl_path(cwd, session_id)
        .and_then(|path| {
            path.parent().map(|p| p.to_path_buf()).ok_or_else(|| {
                Error::Other(format!("transcript path has no parent: {}", path.display()))
            })
        })
        .or_else(|_| {
            let dir = primary_projects_dir(cwd)?;
            if dir.is_dir() {
                Ok(dir)
            } else {
                Err(Error::Other(format!(
                    "transcript not found for session: {session_id}"
                )))
            }
        })?;
    Ok(dir.join(format!("{}.claudinal.json", session_id)))
}

fn sidecar_locks() -> &'static Mutex<HashMap<PathBuf, Weak<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sidecar_lock(path: &Path) -> Arc<Mutex<()>> {
    let mut locks = sidecar_locks()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    // Keep locks only while an operation owns or waits on them. Session paths are
    // unbounded over the lifetime of the app, so dead weak entries must not accumulate.
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    lock
}

fn read_sidecar_path(path: &Path) -> Result<Option<serde_json::Value>> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&raw)?))
}

fn write_sidecar_path(path: &Path, data: &serde_json::Value) -> Result<()> {
    let text = serde_json::to_string_pretty(&data)?;
    atomic_write_str(path, &text)
}

fn replace_sidecar_path(path: &Path, data: &serde_json::Value) -> Result<()> {
    let lock = sidecar_lock(path);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    write_sidecar_path(path, data)
}

fn patch_sidecar_path(
    path: &Path,
    patch: &serde_json::Map<String, serde_json::Value>,
    set_if_missing: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<()> {
    let lock = sidecar_lock(path);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    let mut current = match read_sidecar_path(path)? {
        Some(serde_json::Value::Object(object)) => object,
        Some(_) | None => serde_json::Map::new(),
    };
    if let Some(defaults) = set_if_missing {
        for (key, value) in defaults {
            if !value.is_null() && !current.contains_key(key) {
                current.insert(key.clone(), value.clone());
            }
        }
    }
    for (key, value) in patch {
        if value.is_null() {
            current.remove(key);
        } else {
            current.insert(key.clone(), value.clone());
        }
    }
    write_sidecar_path(path, &serde_json::Value::Object(current))
}

pub fn read_session_sidecar(cwd: &str, session_id: &str) -> Result<Option<serde_json::Value>> {
    let path = match session_jsonl_path(cwd, session_id) {
        Ok(path) => path.with_extension("claudinal.json"),
        Err(_) => return Ok(None),
    };
    let lock = sidecar_lock(&path);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    read_sidecar_path(&path)
}

pub fn write_session_sidecar(cwd: &str, session_id: &str, data: serde_json::Value) -> Result<()> {
    let path = session_sidecar_path(cwd, session_id)?;
    replace_sidecar_path(&path, &data)
}

/// Merge top-level sidecar fields against the latest on-disk object while holding
/// the same per-session lock used by full writes. A null patch value deletes a key;
/// `set_if_missing` supplies defaults without overwriting a concurrently persisted value.
pub fn patch_session_sidecar(
    cwd: &str,
    session_id: &str,
    patch: serde_json::Value,
    set_if_missing: Option<serde_json::Value>,
) -> Result<()> {
    let patch = patch
        .as_object()
        .ok_or_else(|| Error::Other("sidecar patch must be a JSON object".into()))?;
    let set_if_missing = set_if_missing
        .as_ref()
        .map(|value| {
            value
                .as_object()
                .ok_or_else(|| Error::Other("sidecar defaults must be a JSON object".into()))
        })
        .transpose()?;
    let path = session_sidecar_path(cwd, session_id)?;
    patch_sidecar_path(&path, patch, set_if_missing)
}

pub fn delete_session_jsonl(cwd: &str, session_id: &str) -> Result<()> {
    validate_session_id(session_id)?;
    let mut removed = false;
    let mut removed_sidecars = Vec::new();
    for dir in project_dirs(cwd)? {
        let path = dir.join(format!("{}.jsonl", session_id));
        if path.is_file() && jsonl_belongs_to_cwd(cwd, &path) {
            std::fs::remove_file(&path).map_err(Error::from)?;
            removed_sidecars.push(path.with_extension("claudinal.json"));
            removed = true;
        }
    }
    if !removed {
        return Err(Error::Other(format!(
            "transcript not found for session: {session_id}"
        )));
    }
    // 只删除已确认属于当前 cwd 的 transcript 同目录 sidecar，避免 encoded 目录碰撞时误删别的项目。
    for sidecar in removed_sidecars {
        let _ = std::fs::remove_file(sidecar);
    }
    Ok(())
}

fn json_event_ts_millis(value: &serde_json::Value) -> Option<u64> {
    let raw = value.get("timestamp").or_else(|| value.get("ts"))?;
    if let Some(n) = raw.as_u64() {
        return Some(n);
    }
    if let Some(n) = raw.as_i64() {
        return u64::try_from(n).ok();
    }
    if let Some(n) = raw.as_f64() {
        if n.is_finite() && n >= 0.0 {
            return Some(n as u64);
        }
    }
    let text = raw.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .and_then(|dt| u64::try_from(dt.timestamp_millis()).ok())
}

fn atomic_write_session_text(path: &Path, contents: &str) -> Result<()> {
    atomic_write_str(path, contents)
}

fn truncate_jsonl_at_timestamp(path: &Path, cutoff_ts_millis: u64) -> Result<()> {
    let raw = std::fs::read_to_string(path).map_err(Error::from)?;
    let mut kept = String::with_capacity(raw.len());
    let mut found_cutoff = false;

    for segment in raw.split_inclusive('\n') {
        let line = segment.trim();
        if !line.is_empty() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                if json_event_ts_millis(&value).is_some_and(|ts| ts >= cutoff_ts_millis) {
                    found_cutoff = true;
                    break;
                }
            }
        }
        kept.push_str(segment);
    }

    if !found_cutoff {
        return Err(Error::Other(
            "retry cutoff did not match any transcript event".into(),
        ));
    }
    if kept == raw {
        return Ok(());
    }
    atomic_write_session_text(path, &kept)
}

pub fn truncate_session_transcript(
    cwd: &str,
    session_id: &str,
    cutoff_ts_millis: u64,
) -> Result<()> {
    if cutoff_ts_millis == 0 {
        return Err(Error::Other("retry cutoff timestamp is required".into()));
    }
    let path = session_jsonl_path(cwd, session_id)?;
    truncate_jsonl_at_timestamp(&path, cutoff_ts_millis)
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

fn read_subagent_jsonl_chunk_at_path(
    path: &Path,
    requested_offset: u64,
    requested_max_bytes: u64,
) -> Result<SubagentTranscriptChunk> {
    if !path.is_file() {
        return Ok(SubagentTranscriptChunk {
            events: Vec::new(),
            next_offset: 0,
            file_size: 0,
            truncated: false,
            reset: requested_offset > 0,
            available: false,
        });
    }

    let initial_size = std::fs::metadata(path)?.len();
    let reset = requested_offset > initial_size;
    let mut offset = if reset { 0 } else { requested_offset };
    let limit = requested_max_bytes.clamp(16 * 1024, MAX_SUBAGENT_CHUNK_BYTES);
    let file = std::fs::File::open(path)?;
    let mut reader = std::io::BufReader::new(file);

    // Returned offsets always point to a JSONL boundary. Align arbitrary or
    // stale callers to the next complete line instead of parsing a fragment.
    if offset > 0 {
        reader.seek(SeekFrom::Start(offset - 1))?;
        let mut previous = [0_u8; 1];
        reader.read_exact(&mut previous)?;
        if previous[0] != b'\n' {
            let mut discarded = Vec::new();
            reader.read_until(b'\n', &mut discarded)?;
            offset = reader.stream_position()?;
        } else {
            reader.seek(SeekFrom::Start(offset))?;
        }
    }

    let chunk_start = offset;
    let mut next_offset = offset;
    let mut events = Vec::new();
    let mut waiting_for_complete_line = false;
    loop {
        let line_start = reader.stream_position()?;
        if line_start > chunk_start && line_start.saturating_sub(chunk_start) >= limit {
            break;
        }
        let mut line = Vec::new();
        let read = reader
            .by_ref()
            .take((MAX_SUBAGENT_JSONL_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if read > MAX_SUBAGENT_JSONL_LINE_BYTES {
            if !line.ends_with(b"\n") {
                discard_until_newline(&mut reader)?;
            }
            next_offset = reader.stream_position()?;
            continue;
        }
        let line_end = reader.stream_position()?;
        let complete_line = line.ends_with(b"\n");
        if line.iter().all(|byte| byte.is_ascii_whitespace()) {
            next_offset = line_end;
            continue;
        }
        match serde_json::from_slice::<serde_json::Value>(&line) {
            Ok(value) => {
                events.push(value);
                next_offset = line_end;
            }
            Err(_) if !complete_line => {
                reader.seek(SeekFrom::Start(line_start))?;
                next_offset = line_start;
                waiting_for_complete_line = true;
                break;
            }
            Err(_) => {
                // Match the main reader: one malformed complete record should
                // not hide later valid transcript events.
                next_offset = line_end;
            }
        }
    }

    let file_size = std::fs::metadata(path)?.len();
    Ok(SubagentTranscriptChunk {
        events,
        next_offset,
        file_size,
        truncated: !waiting_for_complete_line && next_offset < file_size,
        reset,
        available: true,
    })
}

pub fn read_subagent_transcript_chunk(
    cwd: &str,
    session_id: &str,
    agent_id: &str,
    offset: u64,
    max_bytes: u64,
) -> Result<SubagentTranscriptChunk> {
    let path = subagent_jsonl_path(cwd, session_id, agent_id)?;
    read_subagent_jsonl_chunk_at_path(&path, offset, max_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subagent_chunk_reader_is_incremental_and_waits_for_complete_jsonl() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-subagent-chunk-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("agent-test.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n{\"type\":",
        )?;

        let first = read_subagent_jsonl_chunk_at_path(&path, 0, 16 * 1024)?;
        assert_eq!(first.events.len(), 2);
        assert!(!first.truncated);
        let incomplete_offset = first.next_offset;

        std::fs::write(
            &path,
            "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n{\"type\":\"result\"}\n",
        )?;
        let second = read_subagent_jsonl_chunk_at_path(&path, incomplete_offset, 16 * 1024)?;
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.events[0]["type"], "result");
        assert!(!second.truncated);

        let reset = read_subagent_jsonl_chunk_at_path(&path, u64::MAX, 16 * 1024)?;
        assert!(reset.reset);
        assert_eq!(reset.events.len(), 3);
        std::fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn subagent_chunk_reader_tolerates_partial_utf8_and_bounds_malformed_input() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-subagent-chunk-utf8-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("agent-test.jsonl");
        let mut partial = b"{\"type\":\"user\"}\n{\"type\":\"assistant\",\"text\":\"".to_vec();
        partial.push(0xe4);
        std::fs::write(&path, partial)?;

        let first = read_subagent_jsonl_chunk_at_path(&path, 0, 16 * 1024)?;
        assert_eq!(first.events.len(), 1);
        assert!(!first.truncated);

        std::fs::write(
            &path,
            "{\"type\":\"user\"}\n{\"type\":\"assistant\",\"text\":\"中文\"}\n",
        )?;
        let completed = read_subagent_jsonl_chunk_at_path(&path, first.next_offset, 16 * 1024)?;
        assert_eq!(completed.events.len(), 1);
        assert_eq!(completed.events[0]["text"], "中文");

        let malformed = (0..20)
            .map(|_| format!("{{not-json:{}}}\n", "x".repeat(2048)))
            .collect::<String>();
        std::fs::write(&path, malformed.as_bytes())?;
        let bounded = read_subagent_jsonl_chunk_at_path(&path, 0, 16 * 1024)?;
        assert!(bounded.events.is_empty());
        assert!(bounded.truncated);
        assert!(bounded.next_offset < bounded.file_size);

        let oversized = format!(
            "{{\"text\":\"{}\"}}\n{{\"type\":\"result\"}}\n",
            "x".repeat(MAX_SUBAGENT_JSONL_LINE_BYTES)
        );
        std::fs::write(&path, oversized.as_bytes())?;
        let skipped = read_subagent_jsonl_chunk_at_path(&path, 0, 16 * 1024)?;
        assert!(skipped.events.is_empty());
        assert!(skipped.truncated);
        let after_oversized =
            read_subagent_jsonl_chunk_at_path(&path, skipped.next_offset, 16 * 1024)?;
        assert_eq!(after_oversized.events.len(), 1);
        assert_eq!(after_oversized.events[0]["type"], "result");

        std::fs::remove_dir_all(dir).ok();
        Ok(())
    }

    #[test]
    fn subagent_id_validation_rejects_path_escape() {
        assert!(validate_agent_id("agent_123-abc").is_ok());
        assert!(validate_agent_id("../escape").is_err());
        assert!(validate_agent_id("nested\\escape").is_err());
        assert!(validate_agent_id("").is_err());
    }

    #[test]
    fn title_candidate_rejects_internal_command_payload() {
        let raw = "<command-name>/effort</command-name>\n\
            <command-message>effort</command-message>\n\
            <command-args>max</command-args>";
        let stdout = "<local-command-stdout>Set effort level to max</local-command-stdout>";
        let task = "<task-notification><summary>done</summary></task-notification>";

        assert_eq!(title_candidate(raw, 120), None);
        assert_eq!(title_candidate(stdout, 120), None);
        assert_eq!(title_candidate(task, 120), None);
        assert_eq!(
            title_candidate(" 更新 plan.md 和项目事件 ", 120),
            Some("更新 plan.md 和项目事件".to_string())
        );
    }

    #[test]
    fn title_candidate_strips_system_reminder_sections() {
        let raw = "真实需求\n<system-reminder>internal</system-reminder>";
        assert_eq!(title_candidate(raw, 120), Some("真实需求".to_string()));
    }

    #[test]
    fn scan_jsonl_skips_sidechain_first_user_text() -> Result<()> {
        let dir =
            std::env::temp_dir().join(format!("claudinal-reader-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("sidechain.jsonl");
        let lines = [
            serde_json::json!({
                "type": "user",
                "isSidechain": true,
                "message": { "role": "user", "content": "internal task prompt" }
            }),
            serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": "真实用户消息" }
            }),
        ];
        let body = lines
            .into_iter()
            .map(|line| serde_json::to_string(&line))
            .collect::<std::result::Result<Vec<_>, _>>()?
            .join("\n");
        std::fs::write(&path, body)?;

        let (_, _, first_user_text) = scan_jsonl(&path);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
        assert_eq!(first_user_text, Some("真实用户消息".to_string()));
        Ok(())
    }

    #[test]
    fn scan_jsonl_skips_meta_skill_prompts_from_count_and_first_user_text() -> Result<()> {
        let dir =
            std::env::temp_dir().join(format!("claudinal-reader-meta-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("meta-skill.jsonl");
        let lines = [
            serde_json::json!({
                "type": "user",
                "isMeta": true,
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "text",
                        "text": "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design\n\nARGUMENTS: 优化前端"
                    }]
                }
            }),
            serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": "真实用户消息" }
            }),
            serde_json::json!({
                "type": "assistant",
                "isMeta": true,
                "message": { "role": "assistant", "content": "internal assistant note" }
            }),
            serde_json::json!({
                "type": "assistant",
                "message": { "role": "assistant", "content": "可见回复" }
            }),
        ];
        let body = lines
            .into_iter()
            .map(|line| serde_json::to_string(&line))
            .collect::<std::result::Result<Vec<_>, _>>()?
            .join("\n");
        std::fs::write(&path, body)?;

        let (msg_count, _, first_user_text) = scan_jsonl(&path);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
        assert_eq!(msg_count, 2);
        assert_eq!(first_user_text, Some("真实用户消息".to_string()));
        Ok(())
    }

    #[test]
    fn scan_jsonl_skips_skill_prompt_even_without_meta_flag() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-reader-skill-prefix-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("skill-prefix.jsonl");
        let lines = [
            serde_json::json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "text",
                        "text": "Base directory for this skill: C:\\Users\\me\\.claude\\skills\\frontend-design\n\nARGUMENTS: 优化前端"
                    }]
                },
                "sourceToolUseID": "toolu_skill"
            }),
            serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": "真实用户消息" }
            }),
        ];
        let body = lines
            .into_iter()
            .map(|line| serde_json::to_string(&line))
            .collect::<std::result::Result<Vec<_>, _>>()?
            .join("\n");
        std::fs::write(&path, body)?;

        let (msg_count, _, first_user_text) = scan_jsonl(&path);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
        assert_eq!(msg_count, 1);
        assert_eq!(first_user_text, Some("真实用户消息".to_string()));
        Ok(())
    }

    #[test]
    fn scan_jsonl_ignores_synthetic_api_error_assistant_count() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-reader-synthetic-error-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("synthetic-error.jsonl");
        let lines = [
            serde_json::json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "给我讲讲这个项目" }]
                }
            }),
            serde_json::json!({
                "type": "assistant",
                "isApiErrorMessage": true,
                "apiErrorStatus": 429,
                "message": {
                    "role": "assistant",
                    "model": "<synthetic>",
                    "content": [{
                        "type": "text",
                        "text": "API Error: Request rejected (429) · Service Unavailable"
                    }]
                }
            }),
        ];
        let body = lines
            .into_iter()
            .map(|line| serde_json::to_string(&line))
            .collect::<std::result::Result<Vec<_>, _>>()?
            .join("\n");
        std::fs::write(&path, body)?;

        let (msg_count, _, first_user_text) = scan_jsonl(&path);
        assert_eq!(msg_count, 1);
        assert_eq!(first_user_text, Some("给我讲讲这个项目".to_string()));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
        Ok(())
    }

    #[test]
    fn scan_jsonl_ignores_synthetic_interruption_pair() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-reader-interruption-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("interrupted.jsonl");
        let lines = [
            serde_json::json!({
                "type": "user",
                "promptId": "prompt-interrupted",
                "userType": "external",
                "entrypoint": "sdk-cli",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": INTERRUPTED_USER_SENTINEL }]
                }
            }),
            serde_json::json!({
                "type": "assistant",
                "isApiErrorMessage": false,
                "message": {
                    "role": "assistant",
                    "model": "<synthetic>",
                    "stop_reason": "stop_sequence",
                    "content": [{ "type": "text", "text": NO_RESPONSE_SENTINEL }]
                }
            }),
            serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": "继续" }
            }),
        ];
        let body = lines
            .into_iter()
            .map(|line| serde_json::to_string(&line))
            .collect::<std::result::Result<Vec<_>, _>>()?
            .join("\n");
        std::fs::write(&path, body)?;

        let (msg_count, _, first_user_text) = scan_jsonl(&path);
        assert_eq!(msg_count, 1);
        assert_eq!(first_user_text, Some("继续".to_string()));

        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn scan_jsonl_counts_real_assistant_reply() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-reader-real-assistant-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("real-assistant.jsonl");
        let lines = [
            serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": "给我讲讲这个项目" }
            }),
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "model": "claude-sonnet",
                    "content": "真实回复"
                }
            }),
        ];
        let body = lines
            .into_iter()
            .map(|line| serde_json::to_string(&line))
            .collect::<std::result::Result<Vec<_>, _>>()?
            .join("\n");
        std::fs::write(&path, body)?;

        let (msg_count, _, first_user_text) = scan_jsonl(&path);
        assert_eq!(msg_count, 2);
        assert_eq!(first_user_text, Some("给我讲讲这个项目".to_string()));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
        Ok(())
    }

    #[test]
    fn interruption_user_sentinel_requires_sdk_metadata() {
        let genuine = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": INTERRUPTED_USER_SENTINEL }]
            }
        });

        assert!(!is_synthetic_interruption_event(&genuine));
    }

    #[test]
    fn title_candidate_returns_none_for_blank_input() {
        assert_eq!(title_candidate("   ", 120), None);
        assert_eq!(title_candidate("", 120), None);
    }

    #[test]
    fn title_candidate_strips_leading_slash_command() {
        // "/frontend-design 帮我…" → "帮我…"
        assert_eq!(
            title_candidate("/frontend-design 帮我重新调整下样式", 120),
            Some("帮我重新调整下样式".to_string())
        );
        // plugin 作用域形式
        assert_eq!(
            title_candidate("/frontend-design:frontend-design 优化面板", 120),
            Some("优化面板".to_string())
        );
        // 整条只有命令：保留原文，避免标题变空
        assert_eq!(title_candidate("/effort", 120), Some("/effort".to_string()));
        // 路径开头不误剥
        assert_eq!(
            title_candidate("/usr/local/bin 这个目录看下", 120),
            Some("/usr/local/bin 这个目录看下".to_string())
        );
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
    fn cwd_matches_jsonl_normalizes_separators_and_trailing_slashes() {
        assert!(cwd_matches_jsonl(
            "F:/project/claude-test/",
            "F:\\project\\claude-test"
        ));
        assert!(!cwd_matches_jsonl(
            "F:/project/claude-test",
            "F:\\project\\claude_test"
        ));
    }

    #[test]
    fn jsonl_belongs_to_cwd_requires_matching_embedded_cwd() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-reader-cwd-filter-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let matching = dir.join("matching.jsonl");
        let foreign = dir.join("foreign.jsonl");
        let missing = dir.join("missing.jsonl");
        std::fs::write(
            &matching,
            serde_json::to_string(&serde_json::json!({
                "type": "system",
                "cwd": "F:\\project\\claude-test"
            }))?,
        )?;
        std::fs::write(
            &foreign,
            serde_json::to_string(&serde_json::json!({
                "type": "system",
                "cwd": "F:\\project\\claude_test"
            }))?,
        )?;
        std::fs::write(
            &missing,
            serde_json::to_string(&serde_json::json!({
                "type": "system"
            }))?,
        )?;

        assert!(jsonl_belongs_to_cwd("F:/project/claude-test", &matching));
        assert!(!jsonl_belongs_to_cwd("F:/project/claude-test", &foreign));
        assert!(!jsonl_belongs_to_cwd("F:/project/claude-test", &missing));

        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
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
    fn truncate_jsonl_at_timestamp_removes_cutoff_line_and_after() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-reader-truncate-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("retry.jsonl");
        let lines = [
            serde_json::json!({
                "type": "system",
                "timestamp": "2026-06-20T01:00:00.000Z"
            }),
            serde_json::json!({
                "type": "user",
                "timestamp": "2026-06-20T01:00:01.000Z",
                "message": { "role": "user", "content": "retry me" }
            }),
            serde_json::json!({
                "type": "result",
                "timestamp": "2026-06-20T01:00:02.000Z",
                "is_error": true
            }),
        ];
        let body = lines
            .iter()
            .map(serde_json::to_string)
            .collect::<std::result::Result<Vec<_>, _>>()?
            .join("\n");
        std::fs::write(&path, format!("{body}\n"))?;

        truncate_jsonl_at_timestamp(&path, 1_781_917_201_000)?;
        let out = std::fs::read_to_string(&path)?;
        assert!(out.contains("\"type\":\"system\""));
        assert!(!out.contains("\"type\":\"user\""));
        assert!(!out.contains("\"type\":\"result\""));

        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn truncate_jsonl_at_timestamp_accepts_numeric_ts() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-reader-truncate-numeric-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("retry.jsonl");
        std::fs::write(
            &path,
            [
                r#"{"type":"system","ts":100}"#,
                r#"{"type":"user","ts":200}"#,
                r#"{"type":"result","ts":300}"#,
            ]
            .join("\n"),
        )?;

        truncate_jsonl_at_timestamp(&path, 200)?;
        assert_eq!(
            std::fs::read_to_string(&path)?,
            "{\"type\":\"system\",\"ts\":100}\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn truncate_jsonl_at_timestamp_keeps_file_when_cutoff_missing() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-reader-truncate-miss-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("retry.jsonl");
        let body = "{\"type\":\"system\",\"ts\":100}\n";
        std::fs::write(&path, body)?;

        let err = truncate_jsonl_at_timestamp(&path, 200).unwrap_err();
        assert!(format!("{err}").contains("retry cutoff"));
        assert_eq!(std::fs::read_to_string(&path)?, body);

        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn concurrent_sidecar_patches_preserve_independent_fields() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-sidecar-patch-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("session.claudinal.json");
        replace_sidecar_path(&path, &serde_json::json!({ "base": true }))?;

        let mut threads = Vec::new();
        for index in 0..24 {
            let path = path.clone();
            threads.push(std::thread::spawn(move || {
                let mut patch = serde_json::Map::new();
                patch.insert(format!("field{index}"), serde_json::json!(index));
                patch_sidecar_path(&path, &patch, None)
            }));
        }
        for thread in threads {
            thread.join().expect("sidecar patch thread panicked")?;
        }

        let sidecar = read_sidecar_path(&path)?.expect("sidecar should exist");
        assert_eq!(sidecar.get("base"), Some(&serde_json::json!(true)));
        for index in 0..24 {
            assert_eq!(
                sidecar.get(&format!("field{index}")),
                Some(&serde_json::json!(index))
            );
        }
        let leftovers = std::fs::read_dir(&dir)?
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp."))
            .count();
        assert_eq!(leftovers, 0);

        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn sidecar_patch_deletes_null_and_sets_defaults_only_when_missing() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "claudinal-sidecar-defaults-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("session.claudinal.json");
        replace_sidecar_path(
            &path,
            &serde_json::json!({ "composer": { "model": "existing" }, "removeMe": true }),
        )?;
        let patch = serde_json::json!({ "removeMe": null, "result": { "type": "result" } });
        let defaults = serde_json::json!({
            "composer": { "model": "default" },
            "permissionMode": "plan"
        });
        patch_sidecar_path(
            &path,
            patch.as_object().expect("patch object"),
            Some(defaults.as_object().expect("defaults object")),
        )?;

        let sidecar = read_sidecar_path(&path)?.expect("sidecar should exist");
        assert_eq!(
            sidecar.pointer("/composer/model"),
            Some(&serde_json::json!("existing"))
        );
        assert_eq!(
            sidecar.get("permissionMode"),
            Some(&serde_json::json!("plan"))
        );
        assert!(sidecar.get("removeMe").is_none());
        assert_eq!(
            sidecar.pointer("/result/type"),
            Some(&serde_json::json!("result"))
        );

        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
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
