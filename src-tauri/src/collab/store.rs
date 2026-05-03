use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::app_paths::claudinal_dir;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabFlow {
    pub id: String,
    pub cwd: String,
    pub claude_session_id: Option<String>,
    pub user_prompt: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub steps: Vec<CollabStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabStep {
    pub id: String,
    pub index: u32,
    pub provider: String,
    pub responsibility_scope: String,
    pub allowed_paths: Vec<String>,
    pub write_allowed: bool,
    pub status: String,
    pub input_prompt: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub agent_run: Option<AgentRun>,
    pub changed_files: Vec<FileChangeRecord>,
    pub validation_results: Vec<VerificationRecord>,
    pub approval: Option<ApprovalRecord>,
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub provider: String,
    pub command: Vec<String>,
    pub cwd: String,
    pub permission_mode: String,
    pub started_at: String,
    pub ended_at: String,
    pub exit_code: i32,
    pub stdout_path: String,
    pub stderr_path: String,
    pub output_path: Option<String>,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub structured_output: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRecord {
    pub path: String,
    pub change_type: String,
    pub allowed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRecord {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub started_at: String,
    pub ended_at: String,
    pub exit_code: i32,
    pub stdout_path: String,
    pub stderr_path: String,
    pub stdout_preview: String,
    pub stderr_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    pub decision: String,
    pub note: Option<String>,
    pub recorded_at: String,
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

/// 协同存储根目录：跟随 Claudinal 应用本身的位置，不污染用户的 %APPDATA%
/// 也不污染每个项目的 cwd。
/// - 开发模式：current_exe 通常在 `target/debug/`，会沿 target → src-tauri 上溯到
///   仓库根，写到 `<repo>/.claudinal/collaboration-v1/`（cargo clean 不会清掉）
/// - Windows / Linux 打包：`<exe-dir>/.claudinal/collaboration-v1/`
/// - macOS .app bundle：跳出 `Foo.app/Contents/MacOS/` 写到 .app 同级目录
pub fn storage_root() -> Result<PathBuf> {
    Ok(claudinal_dir()?.join("collaboration-v1"))
}

pub fn flows_dir() -> Result<PathBuf> {
    Ok(storage_root()?.join("flows"))
}

pub fn runs_dir() -> Result<PathBuf> {
    Ok(storage_root()?.join("runs"))
}

pub fn schemas_dir() -> Result<PathBuf> {
    Ok(storage_root()?.join("schemas"))
}

fn runtime_sessions_path() -> Result<PathBuf> {
    Ok(storage_root()?.join("runtime-sessions.json"))
}

pub fn ensure_storage() -> Result<()> {
    std::fs::create_dir_all(flows_dir()?).map_err(Error::from)?;
    std::fs::create_dir_all(runs_dir()?).map_err(Error::from)?;
    std::fs::create_dir_all(schemas_dir()?).map_err(Error::from)?;
    Ok(())
}

pub fn flow_path(flow_id: &str) -> Result<PathBuf> {
    validate_id(flow_id)?;
    Ok(flows_dir()?.join(format!("{flow_id}.json")))
}

pub fn read_flow(flow_id: &str) -> Result<CollabFlow> {
    let path = flow_path(flow_id)?;
    let raw = std::fs::read_to_string(&path).map_err(Error::from)?;
    serde_json::from_str(&raw).map_err(Error::from)
}

pub fn write_flow(flow: &mut CollabFlow) -> Result<()> {
    ensure_storage()?;
    flow.updated_at = now_rfc3339();
    let path = flow_path(&flow.id)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(flow).map_err(Error::from)?;
    std::fs::write(&tmp, text).map_err(Error::from)?;
    std::fs::rename(&tmp, &path).map_err(Error::from)?;
    Ok(())
}

pub fn list_flows(cwd: Option<&str>) -> Result<Vec<CollabFlow>> {
    let dir = flows_dir()?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let target = cwd.map(normalize_cwd_for_match);
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(Error::from)? {
        let entry = entry.map_err(Error::from)?;
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let raw = std::fs::read_to_string(&path).map_err(Error::from)?;
        let flow: CollabFlow = serde_json::from_str(&raw).map_err(Error::from)?;
        if let Some(t) = target.as_deref() {
            if normalize_cwd_for_match(&flow.cwd) != t {
                continue;
            }
        }
        out.push(flow);
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

pub fn delete_flow(flow_id: &str) -> Result<bool> {
    let flow = match read_flow(flow_id) {
        Ok(flow) => flow,
        Err(Error::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    delete_flow_artifacts(&flow)?;
    remove_file_if_exists(&flow_path(flow_id)?)?;
    remove_file_if_exists(&flows_dir()?.join(format!("{flow_id}.lock")))?;
    Ok(true)
}

pub fn delete_flows_for_session(cwd: &str, session_id: &str) -> Result<usize> {
    let flows = list_flows(Some(cwd))?;
    let mut deleted = 0;
    for flow in flows {
        let stored_session_id = flow.claude_session_id.as_deref();
        let resolved_session_id = stored_session_id
            .map(resolve_runtime_session_id)
            .transpose()?
            .flatten();
        let matches_session = stored_session_id == Some(session_id)
            || resolved_session_id.as_deref() == Some(session_id);
        if matches_session && delete_flow(&flow.id)? {
            deleted += 1;
        }
    }
    Ok(deleted)
}

fn delete_flow_artifacts(flow: &CollabFlow) -> Result<()> {
    for step in &flow.steps {
        if let Some(run) = &step.agent_run {
            remove_run_dir_if_exists(&run.id)?;
        }
        for record in &step.validation_results {
            remove_run_dir_if_exists(&record.id)?;
        }
    }
    Ok(())
}

fn remove_run_dir_if_exists(run_id: &str) -> Result<()> {
    validate_id(run_id)?;
    let dir = runs_dir()?.join(run_id);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(Error::from(err)),
    }
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(Error::from(err)),
    }
}

pub fn record_runtime_session(runtime_session_id: &str, claude_session_id: &str) -> Result<()> {
    validate_id(runtime_session_id)?;
    validate_id(claude_session_id)?;
    ensure_storage()?;

    let path = runtime_sessions_path()?;
    let mut map = if path.is_file() {
        let raw = std::fs::read_to_string(&path).map_err(Error::from)?;
        serde_json::from_str::<std::collections::BTreeMap<String, String>>(&raw)
            .map_err(Error::from)?
    } else {
        std::collections::BTreeMap::new()
    };
    map.insert(
        runtime_session_id.to_string(),
        claude_session_id.to_string(),
    );
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&map).map_err(Error::from)?;
    std::fs::write(&tmp, text).map_err(Error::from)?;
    std::fs::rename(&tmp, &path).map_err(Error::from)?;
    rebind_flows_for_runtime_session(runtime_session_id, claude_session_id)?;
    Ok(())
}

pub fn resolve_runtime_session_id(session_id: &str) -> Result<Option<String>> {
    validate_id(session_id)?;
    let path = runtime_sessions_path()?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(Error::from)?;
    let map = serde_json::from_str::<std::collections::BTreeMap<String, String>>(&raw)
        .map_err(Error::from)?;
    Ok(map.get(session_id).cloned())
}

fn rebind_flows_for_runtime_session(
    runtime_session_id: &str,
    claude_session_id: &str,
) -> Result<()> {
    let mut flows = list_flows(None)?;
    for flow in &mut flows {
        if flow.claude_session_id.as_deref() == Some(runtime_session_id) {
            flow.claude_session_id = Some(claude_session_id.to_string());
            write_flow(flow)?;
        }
    }
    Ok(())
}

/// 跨平台 / 跨写法的 cwd 相等比较：
/// Windows 上 `F:\project\x` 与 `F:/project/x` 是同一目录，但严格字符串比较会判不等。
fn normalize_cwd_for_match(cwd: &str) -> String {
    let unified = cwd.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/').to_string();
    if cfg!(target_os = "windows") {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed
    }
}

pub fn run_dir(run_id: &str) -> Result<PathBuf> {
    validate_id(run_id)?;
    let dir = runs_dir()?.join(run_id);
    std::fs::create_dir_all(&dir).map_err(Error::from)?;
    Ok(dir)
}

pub fn write_text(path: &Path, text: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(Error::from)?;
    }
    std::fs::write(path, text).map_err(Error::from)
}

pub fn preview(text: &str) -> String {
    const MAX: usize = 4000;
    let normalized = text.replace('\0', "");
    let mut out = normalized.chars().take(MAX).collect::<String>();
    if normalized.chars().count() > MAX {
        out.push_str("\n...<truncated>");
    }
    out
}

pub struct FlowLock {
    path: PathBuf,
}

impl FlowLock {
    pub fn acquire(flow_id: &str) -> Result<Self> {
        ensure_storage()?;
        validate_id(flow_id)?;
        let path = flows_dir()?.join(format!("{flow_id}.lock"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        match options.open(&path) {
            Ok(mut file) => {
                use std::io::Write;
                write!(
                    file,
                    "{{\"pid\":{},\"createdAt\":\"{}\"}}",
                    std::process::id(),
                    now_rfc3339()
                )
                .map_err(Error::from)?;
                Ok(Self { path })
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Err(Error::Other(
                format!("协同流程 {flow_id} 已有运行中的步骤，不能并发写入"),
            )),
            Err(err) => Err(Error::from(err)),
        }
    }
}

impl Drop for FlowLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn validate_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    if ok {
        Ok(())
    } else {
        Err(Error::Other(format!("invalid collaboration id: {id}")))
    }
}
