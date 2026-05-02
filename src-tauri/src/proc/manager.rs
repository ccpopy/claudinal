use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use dashmap::DashMap;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

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
}

impl Manager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn spawn(&self, app: AppHandle, opts: SpawnOptions) -> Result<String> {
        let claude = find_claude()?;
        let session_id = Uuid::new_v4().to_string();
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

        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

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

#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;

    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .status();
}

#[cfg(not(windows))]
fn kill_process_tree(_pid: u32) {}
