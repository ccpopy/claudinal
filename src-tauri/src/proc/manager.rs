use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use dashmap::DashMap;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::child_process::{hide_std_window, hide_tokio_window};
use crate::error::{Error, Result};
use crate::proc::spawn::find_claude;

pub struct SpawnOptions {
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub resume_session_id: Option<String>,
    pub env: Option<std::collections::HashMap<String, String>>,
    pub env_remove: Vec<String>,
    pub permission_prompt_tool: Option<String>,
    pub mcp_config: Option<String>,
}

struct Session {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
}

#[derive(Default)]
pub struct Manager {
    sessions: DashMap<String, Arc<Session>>,
    claude_help_cache: DashMap<ClaudeHelpCacheKey, String>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ClaudeHelpCacheKey {
    path: PathBuf,
    size: Option<u64>,
    modified_ms: Option<u128>,
}

impl Manager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn spawn(&self, app: AppHandle, opts: SpawnOptions) -> Result<String> {
        let claude = find_claude()?;
        ensure_required_claude_flags(&claude, &opts, &self.claude_help_cache).await?;
        let session_id = Uuid::new_v4().to_string();
        let collab_enabled = opts
            .env
            .as_ref()
            .and_then(|env| env.get("CLAUDINAL_COLLAB_ENABLED"))
            .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
        info!(claude = %claude.display(), session = %session_id, cwd = %opts.cwd.display(), "spawning claude");

        let mut cmd = Command::new(&claude);
        cmd.arg("-p")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--include-hook-events")
            .arg("--verbose");

        if let Some(model) = &opts.model {
            cmd.arg("--model").arg(model);
        }
        if let Some(effort) = &opts.effort {
            cmd.arg("--effort").arg(effort);
        }
        if let Some(pm) = &opts.permission_mode {
            cmd.arg("--permission-mode").arg(pm);
        }
        if let Some(rid) = &opts.resume_session_id {
            cmd.arg("--resume").arg(rid);
        }
        if let Some(config) = &opts.mcp_config {
            cmd.arg("--mcp-config").arg(config);
        }
        let permission_prompt_tool = opts
            .permission_prompt_tool
            .as_deref()
            .map(str::trim)
            .filter(|tool| !tool.is_empty())
            .unwrap_or("stdio");
        cmd.arg("--permission-prompt-tool")
            .arg(permission_prompt_tool);

        if let Some(env) = &opts.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
        cmd.env("CLAUDINAL_RUNTIME_SESSION_ID", &session_id);
        cmd.env("CLAUDINAL_RUNTIME_CWD", opts.cwd.display().to_string());
        for key in &opts.env_remove {
            cmd.env_remove(key);
        }

        cmd.current_dir(&opts.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        hide_tokio_window(&mut cmd);

        let mut child = cmd.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Other("stdin pipe missing".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Other("stdout pipe missing".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::Other("stderr pipe missing".into()))?;

        let event_topic = format!("claude://session/{}/event", session_id);
        let error_topic = format!("claude://session/{}/error", session_id);

        // stdout reader
        {
            let app = app.clone();
            let topic = event_topic.clone();
            let sid = session_id.clone();
            let cwd = opts.cwd.display().to_string();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                loop {
                    match reader.next_line().await {
                        Ok(Some(line)) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            match serde_json::from_str::<Value>(trimmed) {
                                Ok(value) => {
                                    let event_type = value
                                        .get("type")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown");
                                    let subtype =
                                        value.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                                    let uuid =
                                        value.get("uuid").and_then(|v| v.as_str()).unwrap_or("");
                                    debug!(
                                        session = %sid,
                                        event_type,
                                        subtype,
                                        uuid,
                                        "stdout event"
                                    );
                                    if collab_enabled && event_type == "system" && subtype == "init"
                                    {
                                        if let Some(claude_session_id) =
                                            value.get("session_id").and_then(Value::as_str)
                                        {
                                            if let Err(e) =
                                                crate::collab::store::record_runtime_session(
                                                    &sid,
                                                    claude_session_id,
                                                )
                                            {
                                                warn!(
                                                    session = %sid,
                                                    claude_session = %claude_session_id,
                                                    "record collaboration session mapping failed: {e}"
                                                );
                                            }
                                        }
                                    }
                                    if value
                                        .get("type")
                                        .and_then(Value::as_str)
                                        .is_some_and(|t| t == "control_request")
                                    {
                                        let mut payload = value.clone();
                                        if let Some(obj) = payload.as_object_mut() {
                                            obj.insert("session_id".into(), json!(sid.clone()));
                                            obj.insert("cwd".into(), json!(cwd.clone()));
                                        }
                                        if let Err(e) =
                                            app.emit("claudinal://permission/request", payload)
                                        {
                                            error!(
                                                session = %sid,
                                                "permission request emit failed: {e}"
                                            );
                                        }
                                        continue;
                                    }
                                    if let Err(e) = app.emit(&topic, value) {
                                        error!(session = %sid, "emit failed: {e}");
                                    }
                                }
                                Err(e) => {
                                    warn!(session = %sid, "non-json line: {e}, raw: {trimmed}");
                                    let _ =
                                        app.emit(&topic, json!({ "type": "raw", "line": trimmed }));
                                }
                            }
                        }
                        Ok(None) => {
                            info!(session = %sid, "stdout closed");
                            break;
                        }
                        Err(e) => {
                            error!(session = %sid, "stdout read error: {e}");
                            break;
                        }
                    }
                }
            });
        }

        // stderr reader
        {
            let app = app.clone();
            let topic = error_topic.clone();
            let sid = session_id.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    warn!(session = %sid, "stderr: {line}");
                    let _ = app.emit(&topic, line);
                }
            });
        }

        let session = Arc::new(Session {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
        });
        self.sessions.insert(session_id.clone(), session);
        Ok(session_id)
    }

    pub async fn send(&self, session_id: &str, content_blocks: Value) -> Result<()> {
        let payload = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": content_blocks
            }
        });
        self.write_json_line(session_id, payload).await
    }

    pub async fn resolve_control_request(
        &self,
        session_id: &str,
        request_id: &str,
        response: Value,
    ) -> Result<()> {
        let payload = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response
            }
        });
        self.write_json_line(session_id, payload).await
    }

    async fn write_json_line(&self, session_id: &str, payload: Value) -> Result<()> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| Error::SessionNotFound(session_id.to_string()))?
            .clone();
        let mut line = serde_json::to_string(&payload)?;
        debug!(session = %session_id, "stdin <- {} bytes", line.len());
        line.push('\n');
        let mut stdin = session.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn stop(&self, session_id: &str) -> Result<()> {
        if let Some((_, session)) = self.sessions.remove(session_id) {
            let mut child = session.child.lock().await;
            if let Some(pid) = child.id() {
                kill_process_tree(pid);
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
            info!(session = %session_id, "stopped");
        }
        Ok(())
    }
}

async fn ensure_required_claude_flags(
    claude: &Path,
    opts: &SpawnOptions,
    help_cache: &DashMap<ClaudeHelpCacheKey, String>,
) -> Result<()> {
    let cache_key = claude_help_cache_key(claude);
    let help = match help_cache.get(&cache_key) {
        Some(cached) => cached.clone(),
        None => {
            let loaded = claude_help(claude).await?;
            help_cache.insert(cache_key, loaded.clone());
            loaded
        }
    };
    // --permission-prompt-tool 在 Claude CLI 2.1.x 起从 --help 输出里移除，
    // 但参数本身仍在用（已实测 2.1.126 直传可正常工作），所以不再做 help 文本检查。
    let mut required = vec![
        "--input-format",
        "--output-format",
        "--include-partial-messages",
        "--include-hook-events",
        "--permission-mode",
    ];
    if opts.model.as_deref().is_some_and(|v| !v.trim().is_empty()) {
        required.push("--model");
    }
    if opts.effort.as_deref().is_some_and(|v| !v.trim().is_empty()) {
        required.push("--effort");
    }
    if opts
        .resume_session_id
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty())
    {
        required.push("--resume");
    }
    if opts
        .mcp_config
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty())
    {
        required.push("--mcp-config");
    }

    let missing: Vec<&str> = required
        .into_iter()
        .filter(|flag| !help.contains(flag))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }

    let version = claude_version(claude)
        .await
        .unwrap_or_else(|err| format!("unknown ({err})"));
    Err(Error::Other(format!(
        "当前 Claude CLI 不支持桌面端所需参数：{}。检测到的 Claude CLI：{}，版本：{}。请升级 Claude CLI 后重试（可运行 `claude update` 或重新安装 Claude Code）。",
        missing.join(", "),
        claude.display(),
        version.trim()
    )))
}

fn claude_help_cache_key(claude: &Path) -> ClaudeHelpCacheKey {
    let meta = std::fs::metadata(claude).ok();
    let size = meta.as_ref().map(std::fs::Metadata::len);
    let modified_ms = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    ClaudeHelpCacheKey {
        path: claude.to_path_buf(),
        size,
        modified_ms,
    }
}

async fn claude_help(claude: &Path) -> Result<String> {
    let mut cmd = Command::new(claude);
    cmd.arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_tokio_window(&mut cmd);

    let output = tokio::time::timeout(Duration::from_secs(5), cmd.output())
        .await
        .map_err(|_| Error::Other("读取 Claude CLI 参数帮助超时".into()))??;
    if !output.status.success() {
        return Err(Error::Other(format!(
            "读取 Claude CLI 参数帮助失败：exit {}，stderr: {}",
            output
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string()),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }

    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.stderr.is_empty() {
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    Ok(text)
}

async fn claude_version(claude: &Path) -> Result<String> {
    let mut cmd = Command::new(claude);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_tokio_window(&mut cmd);

    let output = tokio::time::timeout(Duration::from_secs(5), cmd.output())
        .await
        .map_err(|_| Error::Other("读取 Claude CLI 版本超时".into()))??;
    if !output.status.success() {
        return Err(Error::Other(format!(
            "读取 Claude CLI 版本失败：exit {}",
            output
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string())
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_std_window(&mut cmd);
    let _ = cmd.status();
}

#[cfg(not(windows))]
fn kill_process_tree(_pid: u32) {}
