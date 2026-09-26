use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, UNIX_EPOCH};

use super::capabilities::{self, Support};
use super::diagnostics::{Diagnostics, RuntimeDiagnostics};
use super::supervisor::{supervise, ProcessTree};
use super::transport::{read_line, write_frame, WriteFailure, MAX_EVENT_BYTES, MAX_INPUT_BYTES};
use dashmap::DashMap;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::BufReader;
use tokio::process::{ChildStdin, Command};
use tokio::sync::{watch, Mutex};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::child_process::hide_tokio_window;
use crate::error::{DeliveryError, Error, Result};
use crate::proc::spawn::{
    claude_lookup_candidates, configured_claude_path, find_claude, save_claude_path,
};

pub struct SpawnOptions {
    pub runtime_id: Option<String>,
    pub fork_session: bool,
    pub resume_session_at: Option<String>,
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub resume_session_id: Option<String>,
    pub env: Option<std::collections::HashMap<String, String>>,
    pub env_remove: Vec<String>,
    pub permission_prompt_tool: Option<String>,
    pub mcp_config: Option<String>,
    pub settings_json: Option<String>,
}

struct Session {
    stdin: Mutex<ChildStdin>,
    available: AtomicBool,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    stop_reason: std::sync::Mutex<Option<String>>,
    submissions: Mutex<std::collections::HashMap<String, std::result::Result<(), DeliveryError>>>,
}

impl Session {
    fn close(&self, reason: &str) {
        self.available.store(false, Ordering::Release);
        if let Ok(mut stored) = self.stop_reason.lock() {
            if stored.is_none() {
                *stored = Some(reason.into());
            }
        }
        let _ = self.stop.send(true);
    }
}

#[derive(Default)]
pub struct Manager {
    sessions: Arc<DashMap<String, Arc<Session>>>,
    claude_help_cache: DashMap<ClaudeHelpCacheKey, String>,
    diagnostics: Arc<Diagnostics>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ClaudeHelpCacheKey {
    path: PathBuf,
    size: Option<u64>,
    modified_ms: Option<u128>,
    version: String,
}

impl Manager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn diagnostics(&self) -> RuntimeDiagnostics {
        self.diagnostics.snapshot()
    }

    pub async fn installations(&self) -> Result<capabilities::CliInstallations> {
        let selected = configured_claude_path()?;
        let mut candidates = tokio::task::spawn_blocking(claude_lookup_candidates)
            .await
            .map_err(|error| Error::Other(error.to_string()))?;
        if let Some(path) = &selected {
            if !candidates.contains(path) {
                candidates.insert(0, path.clone());
            }
        }
        let mut probes = tokio::task::JoinSet::new();
        for (index, path) in candidates
            .into_iter()
            .filter(|path| path.is_file() || Some(path) == selected.as_ref())
            .take(32)
            .enumerate()
        {
            probes.spawn(async move {
                let version = claude_version(&path).await.ok().filter(|version| {
                    capabilities::version_at_least(version, (0, 0, 0)) == Support::Supported
                });
                (
                    index,
                    capabilities::CliInstallation {
                        path: path.display().to_string(),
                        runnable: version.is_some(),
                        version,
                    },
                )
            });
        }
        let mut installations = Vec::new();
        while let Some(result) = probes.join_next().await {
            installations.push(result.map_err(|error| Error::Other(error.to_string()))?);
        }
        installations.sort_by_key(|(index, _)| *index);
        Ok(capabilities::CliInstallations {
            selected_path: selected.map(|path| path.display().to_string()),
            environment_locked: std::env::var_os("CLAUDE_CLI_PATH").is_some(),
            installations: installations
                .into_iter()
                .map(|(_, installation)| installation)
                .collect(),
        })
    }

    pub async fn select_installation(&self, path: Option<String>) -> Result<()> {
        if std::env::var_os("CLAUDE_CLI_PATH").is_some() {
            return Err(Error::Other(
                "CLI 已由 CLAUDE_CLI_PATH 固定，请先修改该环境变量".into(),
            ));
        }
        if let Some(path) = &path {
            let installations = self.installations().await?;
            if !installations
                .installations
                .iter()
                .any(|entry| entry.path == *path && entry.runnable)
            {
                return Err(Error::Other("所选 CLI 不可运行，请重新检测安装项".into()));
            }
        }
        save_claude_path(path.as_deref().map(Path::new))?;
        self.claude_help_cache.clear();
        Ok(())
    }

    /// 解析当前 Claude CLI `--effort` 支持的档位（复用 `--help` 缓存）。
    /// 失败或解析不到时返回空 Vec，由调用方回退内置清单。
    pub async fn effort_levels(&self) -> Result<Vec<String>> {
        let (claude, version) = resolve_claude().await?;
        let help = claude_help_cached(&claude, &version, &self.claude_help_cache).await?;
        let mut levels = parse_effort_levels(&help);
        if capabilities::version_at_least(&version, (2, 1, 203)) == Support::Supported
            && !levels.iter().any(|level| level == "ultracode")
        {
            levels.push("ultracode".into());
        }
        Ok(levels)
    }

    pub async fn capabilities(&self) -> Result<capabilities::CliCapabilities> {
        let (claude, version) = resolve_claude().await?;
        let help = claude_help_cached(&claude, &version, &self.claude_help_cache)
            .await
            .unwrap_or_default();
        Ok(capabilities::detect(&claude, version, &help))
    }

    pub async fn spawn(&self, app: AppHandle, mut opts: SpawnOptions) -> Result<String> {
        let runtime = opts
            .runtime_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        Uuid::parse_str(&runtime).map_err(|_| Error::Other("invalid runtime id".into()))?;
        opts.runtime_id = Some(runtime.clone());
        self.diagnostics
            .record(&runtime, "launch_requested", None, None);
        let result = self.spawn_inner(app, opts).await;
        if let Err(error) = &result {
            let code = match error {
                Error::Io(error) => error.raw_os_error(),
                _ => None,
            };
            self.diagnostics
                .record(&runtime, "launch_failed", None, code);
        }
        result
    }

    async fn spawn_inner(&self, app: AppHandle, opts: SpawnOptions) -> Result<String> {
        let (claude, version) = resolve_claude().await?;
        self.diagnostics.installation(
            opts.runtime_id.as_deref().unwrap_or_default(),
            &claude,
            &version,
        );
        // Missing help entries are unknown, not evidence that core streaming is unsupported.
        let help = claude_help_cached(&claude, &version, &self.claude_help_cache)
            .await
            .unwrap_or_default();
        if opts.effort.as_deref() == Some("ultracode")
            && capabilities::version_at_least(&version, (2, 1, 203)) != Support::Supported
        {
            return Err(Error::Other(
                "当前 CLI 尚未确认支持原生 ultracode，请选择其他思考强度".into(),
            ));
        }
        if opts.fork_session
            && capabilities::detect(&claude, version.clone(), &help).fork_session
                != Support::Supported
        {
            return Err(Error::Other(
                "当前 CLI 的历史分支能力尚未确认，原会话已保留".into(),
            ));
        }
        let session_id = opts
            .runtime_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        Uuid::parse_str(&session_id).map_err(|_| Error::Other("invalid runtime id".into()))?;
        if self.sessions.contains_key(&session_id) {
            return Err(Error::Other("runtime already exists".into()));
        }
        let runtime_settings_file = opts
            .settings_json
            .as_deref()
            .map(str::trim)
            .filter(|settings| !settings.is_empty())
            .map(|settings| {
                write_runtime_claude_settings_file(&session_id, settings).map(|path| {
                    RuntimeSettings {
                        path,
                        session_id: session_id.clone(),
                    }
                })
            })
            .transpose()?;
        // JSON goes through a protected file so Windows npm shims never reparse quotes.
        let runtime_mcp_file = opts
            .mcp_config
            .as_deref()
            .map(|config| {
                write_runtime_claude_settings_file(&format!("mcp-{session_id}"), config).map(
                    |path| RuntimeSettings {
                        path,
                        session_id: session_id.clone(),
                    },
                )
            })
            .transpose()?;
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
            .arg("--verbose");
        if capabilities::from_help("--include-hook-events", &help) == Support::Supported {
            cmd.arg("--include-hook-events");
        }
        if capabilities::from_help("--replay-user-messages", &help) == Support::Supported {
            cmd.arg("--replay-user-messages");
        }

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
        if opts.fork_session {
            cmd.arg("--fork-session");
        }
        if let Some(uuid) = &opts.resume_session_at {
            cmd.arg("--resume-session-at").arg(uuid);
        }
        if let Some(config) = &runtime_mcp_file {
            cmd.arg("--mcp-config").arg(&config.path);
        }
        if let Some(settings_file) = &runtime_settings_file {
            cmd.arg("--settings").arg(&settings_file.path);
        }
        let permission_prompt_tool = opts
            .permission_prompt_tool
            .as_deref()
            .map(str::trim)
            .filter(|tool| !tool.is_empty())
            .unwrap_or("stdio");
        cmd.arg("--permission-prompt-tool")
            .arg(permission_prompt_tool);

        let arguments = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let mut cmd = crate::commands::claude_runtime_command(&claude, &arguments)?;
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }
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
        let tree = match ProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.kill().await;
                return Err(Error::from(error));
            }
        };
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

        let (stop_tx, stop_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(false);
        let session = Arc::new(Session {
            stdin: Mutex::new(stdin),
            available: AtomicBool::new(true),
            stop: stop_tx,
            done: done_rx,
            stop_reason: std::sync::Mutex::new(None),
            submissions: Mutex::new(std::collections::HashMap::new()),
        });
        self.sessions.insert(session_id.clone(), session.clone());
        self.diagnostics.record(&session_id, "spawned", None, None);

        // Readers run independently. The supervisor owns Child, so stop never waits for its mutex.
        let stdout_task = {
            let app = app.clone();
            let topic = event_topic.clone();
            let sid = session_id.clone();
            let cwd = opts.cwd.display().to_string();
            let session = session.clone();
            let diagnostics = self.diagnostics.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut malformed = 0;
                loop {
                    match read_line(&mut reader, MAX_EVENT_BYTES).await {
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
                                    let stage = match (event_type, subtype) {
                                        ("system", "init") => Some("initialized"),
                                        ("user", _) => Some("user_acknowledged"),
                                        ("result", _) => Some("result_received"),
                                        ("control_request", _) => Some("control_requested"),
                                        _ => None,
                                    };
                                    if let Some(stage) = stage {
                                        diagnostics.record(&sid, stage, None, None);
                                    }
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
                                        if value.pointer("/request/subtype").and_then(Value::as_str)
                                            != Some("can_use_tool")
                                        {
                                            diagnostics.record(
                                                &sid,
                                                "unknown_control_request",
                                                None,
                                                None,
                                            );
                                            let _ = app.emit(&topic, json!({"type":"stderr", "line":"CLI 发出了未识别的控制请求，会话已停止；未授予权限。"}));
                                            session.close("unknown_control_request");
                                            break;
                                        }
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
                                    diagnostics.record(
                                        &sid,
                                        "invalid_json",
                                        Some(trimmed.len()),
                                        None,
                                    );
                                    warn!(session = %sid, bytes = trimmed.len(), "non-json line: {e}");
                                    malformed += 1;
                                    if malformed <= 3 {
                                        let _ = app.emit(&topic, json!({ "type": "stderr", "line": "CLI 输出了无效的 JSON 行，内容未写入日志。" }));
                                    }
                                    if malformed >= 10 {
                                        session.close("invalid_json_output");
                                        break;
                                    }
                                }
                            }
                        }
                        Ok(None) => {
                            diagnostics.record(&sid, "stdout_closed", None, None);
                            info!(session = %sid, "stdout closed");
                            break;
                        }
                        Err(e) => {
                            diagnostics.record(&sid, "stdout_read_failed", None, e.raw_os_error());
                            error!(session = %sid, "stdout read error: {e}");
                            let _ =
                                app.emit(&topic, json!({"type":"stderr", "line":e.to_string()}));
                            break;
                        }
                    }
                }
                // EOF makes the transport unusable even if a child forgot to exit.
                session.close("stdout_closed");
            })
        };

        let stderr_task = {
            let app = app.clone();
            let topic = error_topic.clone();
            let sid = session_id.clone();
            let session = session.clone();
            let diagnostics = self.diagnostics.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut emitted_bytes = 0;
                loop {
                    match read_line(&mut reader, 64 * 1024).await {
                        Ok(Some(line)) => {
                            diagnostics.record(&sid, "stderr_received", Some(line.len()), None);
                            warn!(session = %sid, bytes = line.len(), "stderr received");
                            if emitted_bytes < 256 * 1024 {
                                emitted_bytes += line.len();
                                let _ = app.emit(&topic, line);
                                if emitted_bytes >= 256 * 1024 {
                                    let _ = app.emit(
                                        &topic,
                                        "诊断输出已达到显示上限，后续 stderr 继续排空。",
                                    );
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(error) => {
                            diagnostics.record(
                                &sid,
                                "stderr_read_failed",
                                None,
                                error.raw_os_error(),
                            );
                            let _ = app.emit(&topic, format!("CLI stderr 读取失败：{error}"));
                            session.close("stderr_read_failed");
                            break;
                        }
                    }
                }
            })
        };
        let sessions = self.sessions.clone();
        let sid = session_id.clone();
        let diagnostics = self.diagnostics.clone();
        tokio::spawn(async move {
            let status = supervise(child, stop_rx, tree).await;
            diagnostics.record(
                &sid,
                "process_exited",
                None,
                status.as_ref().ok().and_then(|status| status.code()),
            );
            session.available.store(false, Ordering::Release);
            sessions.remove(&sid);
            // Drain final output before publishing exit, preserving result-before-exit ordering.
            let mut stdout_task = stdout_task;
            let mut stderr_task = stderr_task;
            if tokio::time::timeout(Duration::from_secs(2), async {
                let _ = (&mut stdout_task).await;
                let _ = (&mut stderr_task).await;
            })
            .await
            .is_err()
            {
                stdout_task.abort();
                stderr_task.abort();
            }
            drop(runtime_settings_file);
            drop(runtime_mcp_file);
            let _ = app.emit(
                &format!("claude://session/{sid}/lifecycle"),
                json!({
                    "runtimeId": sid, "state":"exited",
                    "exitCode":status.as_ref().ok().and_then(|s| s.code()),
                    "reason":status.err().map(|e| e.to_string()).or_else(|| session.stop_reason.lock().ok().and_then(|reason| reason.clone())).unwrap_or_else(|| "process_exit".into())
                }),
            );
            let _ = done_tx.send(true);
        });
        Ok(session_id)
    }

    pub async fn send(
        &self,
        session_id: &str,
        content_blocks: Value,
        client_message_id: Option<String>,
    ) -> Result<()> {
        let id = client_message_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        Uuid::parse_str(&id).map_err(|_| Error::Other("invalid client message id".into()))?;
        let session = self
            .sessions
            .get(session_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| {
                Error::Delivery(DeliveryError {
                    code: "runtime_closed".into(),
                    phase: "write".into(),
                    runtime_id: session_id.into(),
                    delivery_certainty: "not_sent".into(),
                    os_error_code: None,
                    message: "会话已结束，尚未发送".into(),
                })
            })?;
        let mut submissions =
            tokio::time::timeout(Duration::from_secs(10), session.submissions.lock())
                .await
                .map_err(|_| Error::Other("提交队列繁忙，当前输入尚未发送".into()))?;
        if let Some(result) = submissions.get(&id) {
            return result.clone().map_err(Error::Delivery);
        }
        if submissions.len() >= 10000 {
            return Err(Error::Other(
                "runtime submission limit reached; start a new runtime".into(),
            ));
        }
        let payload = json!({
            "type": "user",
            "uuid": id,
            "message": {
                "role": "user",
                "content": content_blocks
            }
        });
        let result = self.write_json_lines(session_id, vec![payload]).await;
        match &result {
            Ok(()) => {
                submissions.insert(id, Ok(()));
            }
            Err(Error::Delivery(error)) => {
                submissions.insert(id, Err(error.clone()));
            }
            _ => {}
        }
        result
    }

    pub async fn send_skill_invocation(
        &self,
        session_id: &str,
        command_text: String,
    ) -> Result<()> {
        let command_payload = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": command_text
            }
        });
        self.write_json_lines(session_id, vec![command_payload])
            .await
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

    /// 软中断当前回合：向会话 stdin 写一行 interrupt control_request（等价 TUI Esc）。
    /// CLI 进程与会话保活，被中断回合仍会产出 result 事件；
    /// 与 resolve_control_request 同向（GUI → CLI stdin），强杀路径见 stop。
    pub async fn interrupt(&self, session_id: &str) -> Result<()> {
        let payload = json!({
            "type": "control_request",
            "request_id": Uuid::new_v4().to_string(),
            "request": { "subtype": "interrupt" }
        });
        self.write_json_line(session_id, payload).await
    }

    async fn write_json_line(&self, session_id: &str, payload: Value) -> Result<()> {
        self.write_json_lines(session_id, vec![payload]).await
    }

    async fn write_json_lines(&self, session_id: &str, payloads: Vec<Value>) -> Result<()> {
        let fail = |certainty: &str, code: &str, message: String, os_error_code| {
            self.diagnostics
                .record(session_id, "submission_failed", None, os_error_code);
            Error::Delivery(DeliveryError {
                code: code.into(),
                phase: "write".into(),
                runtime_id: session_id.into(),
                delivery_certainty: certainty.into(),
                os_error_code,
                message,
            })
        };
        let session = self
            .sessions
            .get(session_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| {
                fail(
                    "not_sent",
                    "runtime_closed",
                    "会话进程已结束，输入尚未发送".into(),
                    None,
                )
            })?;
        let mut body = String::new();
        for payload in payloads {
            body.push_str(&serde_json::to_string(&payload)?);
            body.push('\n');
            if body.len() > MAX_INPUT_BYTES {
                return Err(fail(
                    "not_sent",
                    "payload_limit",
                    "输入总量超过 32 MB，请减少附件".into(),
                    None,
                ));
            }
        }
        let mut stdin = tokio::time::timeout(Duration::from_secs(10), session.stdin.lock())
            .await
            .map_err(|_| {
                fail(
                    "not_sent",
                    "write_busy",
                    "发送队列繁忙，输入尚未发送".into(),
                    None,
                )
            })?;
        if !session.available.load(Ordering::Acquire) {
            return Err(fail(
                "not_sent",
                "runtime_closed",
                "会话连接已结束，输入尚未发送".into(),
                None,
            ));
        }
        self.diagnostics
            .record(session_id, "write_started", Some(body.len()), None);
        let result = write_frame(&mut *stdin, body.as_bytes(), Duration::from_secs(15)).await;
        match result {
            Ok(()) => {
                self.diagnostics
                    .record(session_id, "write_completed", Some(body.len()), None);
                Ok(())
            }
            Err(error) => {
                session.close("write_failed");
                let (stage, os_error) = match error {
                    WriteFailure::Io(error) => ("write_failed", error.raw_os_error()),
                    WriteFailure::TimedOut => ("write_timeout", None),
                };
                self.diagnostics.record(session_id, stage, None, os_error);
                Err(fail(
                    "unknown",
                    "write_failed",
                    "连接在提交期间中断，无法确认是否接收；请先检查会话记录".into(),
                    os_error,
                ))
            }
        }
    }

    pub async fn stop(&self, session_id: &str) -> Result<()> {
        self.diagnostics
            .record(session_id, "stop_requested", None, None);
        let session = self.sessions.get(session_id).map(|entry| entry.clone());
        if let Some(session) = session {
            session.close("stop_requested");
            let mut done = session.done.clone();
            tokio::time::timeout(Duration::from_secs(5), done.wait_for(|done| *done))
                .await
                .map_err(|_| Error::Other("等待 CLI 退出超时".into()))?
                .map_err(|_| Error::Other("CLI 监管任务异常结束".into()))?;
        }
        Ok(())
    }
}

struct RuntimeSettings {
    path: PathBuf,
    session_id: String,
}
impl Drop for RuntimeSettings {
    fn drop(&mut self) {
        cleanup_runtime_settings_file(&self.session_id, &self.path);
    }
}

fn write_runtime_claude_settings_file(session_id: &str, settings_json: &str) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join("claudinal");
    std::fs::create_dir_all(&dir).map_err(Error::from)?;
    let path = dir.join(format!(
        "claude-settings-{}-{session_id}.json",
        std::process::id()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(&path).map_err(Error::from)?;
    if let Err(error) = std::io::Write::write_all(&mut file, settings_json.as_bytes()) {
        drop(file);
        cleanup_runtime_settings_file(session_id, &path);
        return Err(Error::from(error));
    }
    Ok(path)
}

fn cleanup_runtime_settings_file(session_id: &str, path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => debug!(
            session = %session_id,
            path = %path.display(),
            "removed runtime Claude settings file"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => warn!(
            session = %session_id,
            path = %path.display(),
            "remove runtime Claude settings file failed: {error}"
        ),
    }
}

/// 复用 `--help` 缓存读取 Claude CLI 帮助文本（按二进制指纹缓存）。
async fn resolve_claude() -> Result<(PathBuf, String)> {
    // An explicitly pinned installation must never silently fall back to another binary.
    if configured_claude_path()?.is_some() {
        let path = find_claude()?;
        let version = claude_version(&path).await?;
        return Ok((path, version));
    }
    let candidates = tokio::task::spawn_blocking(claude_lookup_candidates)
        .await
        .map_err(|e| Error::Other(e.to_string()))?;
    let mut last_error = None;
    for path in candidates.into_iter().filter(|path| path.is_file()) {
        match claude_version(&path).await {
            Ok(version)
                if capabilities::version_at_least(&version, (0, 0, 0)) == Support::Supported =>
            {
                return Ok((path, version))
            }
            Ok(_) => last_error = Some(Error::Other("无法解析 Claude CLI 版本".into())),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or(Error::CliNotFound))
}

async fn claude_help_cached(
    claude: &Path,
    version: &str,
    help_cache: &DashMap<ClaudeHelpCacheKey, String>,
) -> Result<String> {
    let cache_key = claude_help_cache_key(claude, version);
    if let Some(cached) = help_cache.get(&cache_key) {
        return Ok(cached.clone());
    }
    let loaded = claude_help(claude).await?;
    help_cache.insert(cache_key, loaded.clone());
    Ok(loaded)
}

/// 从 `claude --help` 文本解析 `--effort` 接受的档位列表。
/// 形如 `--effort <level> ... (low, medium, high, xhigh, max)`，提取括号内逗号分隔值。
/// 解析不到时返回空 Vec（调用方回退内置清单）。
fn parse_effort_levels(help: &str) -> Vec<String> {
    let Some(start) = help.find("--effort") else {
        return Vec::new();
    };
    let after = &help[start + "--effort".len()..];
    // 截到下一个选项行（换行 + 缩进 + '-'），避免吃到后续 flag 的括号
    let block = match after.find("\n  -") {
        Some(i) => &after[..i],
        None => after,
    };
    let Some(open) = block.find('(') else {
        return Vec::new();
    };
    let Some(rel_close) = block[open + 1..].find(')') else {
        return Vec::new();
    };
    block[open + 1..open + 1 + rel_close]
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .collect()
}

fn claude_help_cache_key(claude: &Path, version: &str) -> ClaudeHelpCacheKey {
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
        version: version.to_owned(),
    }
}

async fn claude_help(claude: &Path) -> Result<String> {
    let mut cmd = crate::commands::claude_runtime_command(claude, &["--help".into()])?;
    cmd.stdin(Stdio::null())
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
    let mut cmd = crate::commands::claude_runtime_command(claude, &["--version".into()])?;
    cmd.stdin(Stdio::null())
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

#[cfg(test)]
mod tests {
    use super::{
        cleanup_runtime_settings_file, parse_effort_levels, write_runtime_claude_settings_file,
    };

    #[test]
    fn parse_standard_multiline_help() {
        // --effort 描述跨行（终端换行），括号列表在续行
        let help = "  --effort <level>     Effort level for the current session\n                       (low, medium, high, xhigh, max)\n  --exclude-foo         Next option\n";
        assert_eq!(
            parse_effort_levels(help).join(","),
            "low,medium,high,xhigh,max"
        );
    }

    #[test]
    fn parse_trims_and_lowercases() {
        let help = "--effort <level>  Effort ( Low ,  MEDIUM , high )\n  --next\n";
        assert_eq!(parse_effort_levels(help).join(","), "low,medium,high");
    }

    #[test]
    fn parse_includes_unknown_new_level() {
        // CLI 新增档位时应自动包含，无需改代码
        let help =
            "  --effort <level>  Effort level (low, medium, high, xhigh, max, turbo)\n  --foo\n";
        assert_eq!(
            parse_effort_levels(help).join(","),
            "low,medium,high,xhigh,max,turbo"
        );
    }

    #[test]
    fn parse_missing_parens_is_empty() {
        let help = "  --effort <level>  Effort level for the current session\n  --foo\n";
        assert!(parse_effort_levels(help).is_empty());
    }

    #[test]
    fn parse_no_effort_flag_is_empty() {
        let help = "  --model <name>  Model selection\n  --foo <bar>  Baz (a, b)\n";
        assert!(parse_effort_levels(help).is_empty());
    }

    #[test]
    fn runtime_claude_settings_file_contains_json_for_settings_path_mode() {
        let session_id = format!("test-{}", uuid::Uuid::new_v4());
        let path = write_runtime_claude_settings_file(
            &session_id,
            r#"{"env":{"ANTHROPIC_MODEL":"provider-main"}}"#,
        )
        .expect("write settings file");

        let raw = std::fs::read_to_string(&path).expect("read settings file");
        assert_eq!(raw, r#"{"env":{"ANTHROPIC_MODEL":"provider-main"}}"#);

        cleanup_runtime_settings_file(&session_id, &path);
        assert!(!path.exists());
    }

    #[test]
    fn runtime_claude_settings_file_cleanup_tolerates_missing_file() {
        let session_id = format!("test-{}", uuid::Uuid::new_v4());
        let path = std::env::temp_dir()
            .join("claudinal")
            .join(format!("missing-{session_id}.json"));

        cleanup_runtime_settings_file(&session_id, &path);
        assert!(!path.exists());
    }
}
