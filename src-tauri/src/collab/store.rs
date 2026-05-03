use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

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

pub fn storage_root() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| Error::Other("unable to resolve data directory".into()))?;
    Ok(base.join("Claudinal").join("collaboration-v1"))
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
    ensure_storage()?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(flows_dir()?).map_err(Error::from)? {
        let entry = entry.map_err(Error::from)?;
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let raw = std::fs::read_to_string(&path).map_err(Error::from)?;
        let flow: CollabFlow = serde_json::from_str(&raw).map_err(Error::from)?;
        if cwd.is_some_and(|target| flow.cwd != target) {
            continue;
        }
        out.push(flow);
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
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
