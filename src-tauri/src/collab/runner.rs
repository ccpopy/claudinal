use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;
use uuid::Uuid;

use crate::child_process::hide_tokio_window;
use crate::collab::changes::{capture_workspace, diff_snapshots, normalize_allowed_paths};
use crate::collab::providers::executable_for_provider;
use crate::collab::store::{
    now_rfc3339, preview, run_dir, schemas_dir, write_flow, write_text, AgentRun, ApprovalRecord,
    CollabFlow, CollabStep, FlowLock, VerificationRecord,
};
use crate::error::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabStartFlowRequest {
    pub cwd: String,
    pub user_prompt: String,
    pub claude_session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabDelegateRequest {
    pub flow_id: String,
    pub cwd: String,
    pub provider: String,
    pub prompt: String,
    pub responsibility_scope: String,
    #[serde(default)]
    pub allowed_paths: Vec<String>,
    #[serde(default)]
    pub write_allowed: bool,
    pub model: Option<String>,
    pub approval_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabApprovalRequest {
    pub flow_id: String,
    pub step_id: String,
    pub decision: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabVerificationRequest {
    pub flow_id: String,
    pub step_id: Option<String>,
    pub cwd: Option<String>,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabCommandResult {
    pub flow: CollabFlow,
    pub step_id: String,
}

pub async fn start_flow(req: CollabStartFlowRequest) -> Result<CollabFlow> {
    if !Path::new(&req.cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {}", req.cwd)));
    }
    let now = now_rfc3339();
    let mut flow = CollabFlow {
        id: Uuid::new_v4().to_string(),
        cwd: req.cwd,
        claude_session_id: req.claude_session_id,
        user_prompt: req.user_prompt,
        status: "draft".into(),
        created_at: now.clone(),
        updated_at: now,
        steps: Vec::new(),
    };
    write_flow(&mut flow)?;
    Ok(flow)
}

pub async fn delegate(req: CollabDelegateRequest) -> Result<CollabCommandResult> {
    validate_delegate_request(&req)?;
    let _lock = FlowLock::acquire(&req.flow_id)?;
    let mut flow = crate::collab::store::read_flow(&req.flow_id)?;
    if flow.cwd != req.cwd {
        return Err(Error::Other(format!(
            "flow cwd mismatch: stored={}, request={}",
            flow.cwd, req.cwd
        )));
    }
    ensure_next_step_allowed(&flow)?;

    let allowed_paths = normalize_allowed_paths(&req.cwd, &req.allowed_paths)?;
    if req.write_allowed && allowed_paths.is_empty() {
        return Err(Error::Other(
            "写入步骤必须显式声明允许修改的路径范围".into(),
        ));
    }
    if let Some(enabled) = crate::collab::enabled_providers_from_env() {
        if !enabled.iter().any(|provider| provider == &req.provider) {
            return Err(Error::Other(format!(
                "Agent provider 未启用：{}。请在设置 -> 协同中启用后，新会话再使用。",
                req.provider
            )));
        }
    }

    let step_id = Uuid::new_v4().to_string();
    let run_id = Uuid::new_v4().to_string();
    let command = build_agent_command(&req, &run_id)?;
    let index = flow.steps.len() as u32 + 1;
    let started_at = now_rfc3339();
    let step = CollabStep {
        id: step_id.clone(),
        index,
        provider: req.provider.clone(),
        responsibility_scope: req.responsibility_scope.clone(),
        allowed_paths: allowed_paths.clone(),
        write_allowed: req.write_allowed,
        status: "running".into(),
        input_prompt: req.prompt.clone(),
        started_at: Some(started_at),
        ended_at: None,
        agent_run: None,
        changed_files: Vec::new(),
        validation_results: Vec::new(),
        approval: None,
        failure_reason: None,
    };
    flow.status = "running".into();
    flow.steps.push(step);
    write_flow(&mut flow)?;

    let before = capture_workspace(&req.cwd)?;
    let run_started_at = now_rfc3339();
    let output = run_command(&command.executable, &command.args, &req.cwd).await?;
    let run_ended_at = now_rfc3339();
    let after = capture_workspace(&req.cwd)?;
    let changed_files = diff_snapshots(&before, &after, &allowed_paths);

    let dir = run_dir(&run_id)?;
    let stdout_path = dir.join("stdout.log");
    let stderr_path = dir.join("stderr.log");
    write_text(&stdout_path, &output.stdout)?;
    write_text(&stderr_path, &output.stderr)?;
    let structured_output = read_structured_output(command.output_path.as_deref(), &output.stdout);
    let output_path = command
        .output_path
        .as_ref()
        .filter(|path| path.is_file())
        .map(|path| path.display().to_string());
    let agent_run = AgentRun {
        id: run_id,
        provider: req.provider.clone(),
        command: command.display,
        cwd: req.cwd.clone(),
        permission_mode: command.permission_mode,
        started_at: run_started_at,
        ended_at: run_ended_at,
        exit_code: output.exit_code,
        stdout_path: stdout_path.display().to_string(),
        stderr_path: stderr_path.display().to_string(),
        output_path,
        stdout_preview: preview(&output.stdout),
        stderr_preview: preview(&output.stderr),
        structured_output,
    };

    let mut flow = crate::collab::store::read_flow(&req.flow_id)?;
    let step = flow
        .steps
        .iter_mut()
        .find(|step| step.id == step_id)
        .ok_or_else(|| Error::Other(format!("collaboration step not found: {step_id}")))?;
    step.agent_run = Some(agent_run);
    step.changed_files = changed_files;
    step.ended_at = Some(now_rfc3339());

    let changed_count = step.changed_files.len();
    let outside = step
        .changed_files
        .iter()
        .filter(|change| !change.allowed)
        .map(|change| change.path.clone())
        .collect::<Vec<_>>();
    if output.exit_code != 0 {
        step.status = "failed".into();
        step.failure_reason = Some(format!("Agent CLI exited with {}", output.exit_code));
        flow.status = "failed".into();
    } else if !req.write_allowed && changed_count > 0 {
        step.status = "failed".into();
        step.failure_reason = Some("只读步骤产生了文件变更".into());
        flow.status = "failed".into();
    } else if !outside.is_empty() {
        step.status = "failed".into();
        step.failure_reason = Some(format!("越界修改：{}", outside.join(", ")));
        flow.status = "failed".into();
    } else {
        step.status = "completed".into();
        flow.status = "completed".into();
    }
    write_flow(&mut flow)?;
    Ok(CollabCommandResult { flow, step_id })
}

pub async fn record_approval(req: CollabApprovalRequest) -> Result<CollabFlow> {
    let mut flow = crate::collab::store::read_flow(&req.flow_id)?;
    let step = flow
        .steps
        .iter_mut()
        .find(|step| step.id == req.step_id)
        .ok_or_else(|| Error::Other(format!("collaboration step not found: {}", req.step_id)))?;
    let decision = req.decision.trim();
    let next_status = match decision {
        "approve" | "approved" => "approved",
        "reject" | "rejected" => "rejected",
        "cancel" | "cancelled" => "cancelled",
        other => {
            return Err(Error::Other(format!(
                "invalid approval decision: {other}; expected approve, reject, or cancel"
            )))
        }
    };
    step.status = next_status.into();
    step.approval = Some(ApprovalRecord {
        decision: next_status.into(),
        note: req.note,
        recorded_at: now_rfc3339(),
    });
    flow.status = next_status.into();
    write_flow(&mut flow)?;
    Ok(flow)
}

pub async fn run_verification(req: CollabVerificationRequest) -> Result<CollabCommandResult> {
    let command = req.command.trim();
    if command.is_empty() {
        return Err(Error::Other("verification command is empty".into()));
    }
    let _lock = FlowLock::acquire(&req.flow_id)?;
    let mut flow = crate::collab::store::read_flow(&req.flow_id)?;
    let cwd = req.cwd.clone().unwrap_or_else(|| flow.cwd.clone());
    if !Path::new(&cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let step_id = match req.step_id.as_deref() {
        Some(id) => id.to_string(),
        None => flow
            .steps
            .last()
            .map(|step| step.id.clone())
            .ok_or_else(|| Error::Other("collaboration flow has no steps".into()))?,
    };
    let step = flow
        .steps
        .iter_mut()
        .find(|step| step.id == step_id)
        .ok_or_else(|| Error::Other(format!("collaboration step not found: {step_id}")))?;
    if !matches!(step.status.as_str(), "completed" | "approved") {
        return Err(Error::Other(format!(
            "只有 completed 或 approved 步骤可以验证，当前状态是 {}",
            step.status
        )));
    }

    let run_id = Uuid::new_v4().to_string();
    let started_at = now_rfc3339();
    let output = run_shell_command(command, &cwd).await?;
    let ended_at = now_rfc3339();
    let dir = run_dir(&run_id)?;
    let stdout_path = dir.join("verification-stdout.log");
    let stderr_path = dir.join("verification-stderr.log");
    write_text(&stdout_path, &output.stdout)?;
    write_text(&stderr_path, &output.stderr)?;
    let record = VerificationRecord {
        id: run_id,
        command: command.into(),
        cwd,
        started_at,
        ended_at,
        exit_code: output.exit_code,
        stdout_path: stdout_path.display().to_string(),
        stderr_path: stderr_path.display().to_string(),
        stdout_preview: preview(&output.stdout),
        stderr_preview: preview(&output.stderr),
    };
    step.validation_results.push(record);
    if output.exit_code == 0 {
        step.status = "verified".into();
        flow.status = "verified".into();
    } else {
        step.status = "failed".into();
        step.failure_reason = Some(format!("验证命令退出码：{}", output.exit_code));
        flow.status = "failed".into();
    }
    write_flow(&mut flow)?;
    Ok(CollabCommandResult { flow, step_id })
}

fn validate_delegate_request(req: &CollabDelegateRequest) -> Result<()> {
    if !Path::new(&req.cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {}", req.cwd)));
    }
    if req.provider.trim().is_empty() {
        return Err(Error::Other("provider is required".into()));
    }
    if req.prompt.trim().is_empty() {
        return Err(Error::Other("prompt is required".into()));
    }
    if req.responsibility_scope.trim().is_empty() {
        return Err(Error::Other("responsibilityScope is required".into()));
    }
    Ok(())
}

fn ensure_next_step_allowed(flow: &CollabFlow) -> Result<()> {
    let Some(last) = flow.steps.last() else {
        return Ok(());
    };
    if matches!(last.status.as_str(), "approved" | "verified") {
        return Ok(());
    }
    Err(Error::Other(format!(
        "上一协同步骤 {} 当前状态为 {}，必须先 approved 或 verified 才能启动下一步",
        last.id, last.status
    )))
}

struct BuiltCommand {
    executable: PathBuf,
    args: Vec<String>,
    display: Vec<String>,
    permission_mode: String,
    output_path: Option<PathBuf>,
}

fn build_agent_command(req: &CollabDelegateRequest, run_id: &str) -> Result<BuiltCommand> {
    let executable = executable_for_provider(&req.provider)
        .ok_or_else(|| Error::Other(format!("未找到 provider CLI：{}", req.provider)))?;
    let prompt = build_agent_prompt(req);
    let output_file = run_dir(run_id)?.join("last-message.json");
    let mut display = vec![executable.display().to_string()];
    let mut args = Vec::new();
    let permission_mode;
    let mut output_path = None;

    match req.provider.as_str() {
        "codex" => {
            let schema = ensure_codex_schema()?;
            permission_mode = if req.write_allowed {
                "workspace-write".to_string()
            } else {
                "read-only".to_string()
            };
            args.extend([
                "exec".into(),
                "--cd".into(),
                req.cwd.clone(),
                "--sandbox".into(),
                permission_mode.clone(),
                "--json".into(),
                "--output-last-message".into(),
                output_file.display().to_string(),
                "--output-schema".into(),
                schema.display().to_string(),
                "--skip-git-repo-check".into(),
            ]);
            if let Some(model) = req
                .model
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                args.extend(["--model".into(), model.into()]);
            }
            args.push(prompt);
            output_path = Some(output_file);
        }
        "gemini" => {
            permission_mode = req
                .approval_mode
                .as_deref()
                .map(str::trim)
                .filter(|mode| !mode.is_empty())
                .unwrap_or(if req.write_allowed {
                    "auto_edit"
                } else {
                    "default"
                })
                .to_string();
            if let Some(model) = req
                .model
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                args.extend(["--model".into(), model.into()]);
            }
            args.extend([
                "--output-format".into(),
                "json".into(),
                "--approval-mode".into(),
                permission_mode.clone(),
                prompt,
            ]);
        }
        "opencode" => {
            permission_mode = req
                .approval_mode
                .as_deref()
                .map(str::trim)
                .filter(|mode| !mode.is_empty())
                .unwrap_or("default")
                .to_string();
            args.extend(["run".into(), "--format".into(), "json".into()]);
            if let Some(model) = req
                .model
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                args.extend(["--model".into(), model.into()]);
            }
            if permission_mode == "dangerously-skip-permissions" {
                args.push("--dangerously-skip-permissions".into());
            }
            args.push(prompt);
        }
        "claude" => {
            permission_mode = req
                .approval_mode
                .as_deref()
                .map(str::trim)
                .filter(|mode| !mode.is_empty())
                .unwrap_or(if req.write_allowed {
                    "acceptEdits"
                } else {
                    "plan"
                })
                .to_string();
            args.extend([
                "-p".into(),
                "--output-format".into(),
                "json".into(),
                "--permission-mode".into(),
                permission_mode.clone(),
            ]);
            if let Some(model) = req
                .model
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                args.extend(["--model".into(), model.into()]);
            }
            args.push(prompt);
        }
        other => {
            return Err(Error::Other(format!(
                "unsupported collaboration provider: {other}"
            )))
        }
    }

    display.extend(args.iter().cloned());
    Ok(BuiltCommand {
        executable,
        args,
        display,
        permission_mode,
        output_path,
    })
}

fn build_agent_prompt(req: &CollabDelegateRequest) -> String {
    let allowed = if req.allowed_paths.is_empty() {
        "无".into()
    } else {
        req.allowed_paths.join(", ")
    };
    format!(
        "你是 Claudinal 协同流程中的被委派 Agent。\n\
责任范围：{}\n\
允许写入：{}\n\
允许修改路径：{}\n\n\
要求：只处理责任范围内的任务；如果允许写入，只能修改允许路径内的文件；不要返回假成功；失败必须暴露真实错误。\n\
完成后请输出 JSON，字段包括 summary、changedFiles、verification、risks。\n\n\
用户任务：\n{}",
        req.responsibility_scope,
        if req.write_allowed { "true" } else { "false" },
        allowed,
        req.prompt
    )
}

fn ensure_codex_schema() -> Result<PathBuf> {
    let dir = schemas_dir()?;
    std::fs::create_dir_all(&dir).map_err(Error::from)?;
    let path = dir.join("agent-result.schema.json");
    if path.is_file() {
        return Ok(path);
    }
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "summary": { "type": "string" },
            "changedFiles": {
                "type": "array",
                "items": { "type": "string" }
            },
            "verification": { "type": "string" },
            "risks": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["summary", "changedFiles", "verification", "risks"],
        "additionalProperties": false
    });
    write_text(
        &path,
        &serde_json::to_string_pretty(&schema).map_err(Error::from)?,
    )?;
    Ok(path)
}

struct ProcessOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

async fn run_command(executable: &Path, args: &[String], cwd: &str) -> Result<ProcessOutput> {
    let mut cmd = Command::new(executable);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_tokio_window(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|err| Error::Other(format!("run collaboration agent: {err}")))?;
    Ok(ProcessOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

async fn run_shell_command(command: &str, cwd: &str) -> Result<ProcessOutput> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut cmd = Command::new("sh");
        cmd.arg("-lc").arg(command);
        cmd
    };
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_tokio_window(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|err| Error::Other(format!("run collaboration verification: {err}")))?;
    Ok(ProcessOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

fn read_structured_output(output_path: Option<&Path>, stdout: &str) -> Option<Value> {
    if let Some(path) = output_path {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                return Some(value);
            }
        }
    }
    serde_json::from_str::<Value>(stdout).ok()
}
