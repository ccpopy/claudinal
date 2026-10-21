use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, UNIX_EPOCH};

use super::capabilities::{self, Support};
use super::control::{unsupported_response, ControlReceipts, ReplyWaiters};
use super::diagnostics::{Diagnostics, RuntimeDiagnostics};
use super::metadata_probe;
use super::runtime_controls::{self, Activity, Preview};
use super::supervisor::{supervise_with_close, ProcessTree};
use super::transport::{read_line, write_frame, WriteFailure, MAX_EVENT_BYTES, MAX_INPUT_BYTES};
use dashmap::{DashMap, DashSet};
use serde_json::{json, Map, Value};
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

#[derive(Default)]
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
    /// JSON contents, never a path. The manager owns the sole runtime MCP file.
    pub mcp_config: Option<String>,
    pub computer_use_enabled: bool,
    pub settings_json: Option<String>,
    pub file_checkpointing: Option<bool>,
    pub forward_subagent_text: Option<bool>,
    pub prompt_suggestions: Option<bool>,
    pub ultracode: Option<bool>,
    pub fast_mode: Option<bool>,
    pub enable_workflows: Option<bool>,
    pub model_settings: Option<Value>,
}

struct Session {
    desktop: Arc<RuntimeDesktop>,
    capabilities: capabilities::CliCapabilities,
    stdin: Mutex<ChildStdin>,
    available: AtomicBool,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    stop_reason: std::sync::Mutex<Option<String>>,
    submissions: Mutex<std::collections::HashMap<String, std::result::Result<(), DeliveryError>>>,
    control_responses: Mutex<ControlReceipts>,
    replies: Arc<ReplyWaiters>,
    mutation_gate: Mutex<()>,
    activity: std::sync::Mutex<Activity>,
    checkpoints_enabled: bool,
}

impl Session {
    fn close(&self, reason: &str) {
        self.desktop.revoke(reason);
        self.available.store(false, Ordering::Release);
        self.replies.close("CLI 会话已停止，控制请求已取消");
        if let Ok(mut stored) = self.stop_reason.lock() {
            if stored.is_none() {
                *stored = Some(reason.into());
            }
        }
        let _ = self.stop.send(true);
    }
}

struct CloseSessionOnDrop {
    session: Arc<Session>,
    reason: &'static str,
}

impl Drop for CloseSessionOnDrop {
    fn drop(&mut self) {
        self.session.close(self.reason);
    }
}

#[derive(Default)]
pub struct Manager {
    sessions: Arc<DashMap<String, Arc<Session>>>,
    pending_launches: DashMap<String, Arc<PendingLaunch>>,
    // Runtime IDs are one-use within this app process. Old readers/cleanup must
    // never share an authorization identity with a later launch.
    runtime_ids: DashSet<String>,
    cancelled_launch_ids: DashSet<String>,
    claude_help_cache: DashMap<ClaudeHelpCacheKey, String>,
    metadata_cache: metadata_probe::Cache,
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

    fn reserve_runtime_id(&self, runtime: &str) -> Result<()> {
        Uuid::parse_str(runtime).map_err(|_| Error::Other("invalid runtime id".into()))?;
        if !self.runtime_ids.insert(runtime.into()) {
            return Err(Error::Other("runtime id has already been used".into()));
        }
        // This is an authorization retirement ledger, so identities cannot be
        // evicted and later reused. Bound it with a fail-closed process limit.
        if self.runtime_ids.len() > 65_536 {
            self.runtime_ids.remove(runtime);
            return Err(Error::Other(
                "runtime identity limit reached; restart the app".into(),
            ));
        }
        Ok(())
    }

    fn cancel_pending_launch(&self, runtime: &str, reason: &str) {
        // Frontend preparation (proxy/permission bridge) precedes Manager::spawn.
        // Tombstone even a not-yet-seen valid UUID so a stop during those awaits
        // cannot be followed by registration. Share the bounded identity ledger.
        // Recheck the ledger after reservation even on AlreadyUsed: a concurrent
        // spawn may have reserved between cancellation's lookup and publication.
        let _ = self.reserve_runtime_id(runtime);
        if self.runtime_ids.contains(runtime) {
            self.cancelled_launch_ids.insert(runtime.into());
        }
        if let Some(launch) = self.pending_launches.get(runtime) {
            launch.cancellation.cancel();
            launch.desktop.revoke(reason);
        }
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
        self.metadata_cache.clear().await;
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

    pub async fn capabilities(
        &self,
        session_id: Option<&str>,
    ) -> Result<capabilities::CliCapabilities> {
        self.refresh_capabilities(session_id, false).await
    }

    pub async fn refresh_capabilities(
        &self,
        session_id: Option<&str>,
        refresh: bool,
    ) -> Result<capabilities::CliCapabilities> {
        if let Some(id) = session_id {
            return self
                .sessions
                .get(id)
                .map(|session| session.capabilities.clone())
                .ok_or_else(|| Error::Other("会话已结束".into()));
        }
        let (claude, version) = resolve_claude().await?;
        let help = claude_help_cached(&claude, &version, &self.claude_help_cache)
            .await
            .unwrap_or_default();
        let mut caps = capabilities::detect(&claude, version, &help);
        if refresh {
            self.metadata_cache.refresh(&caps.fingerprint).await;
        }
        self.metadata_cache
            .get(&claude, &caps.fingerprint)
            .await
            .apply(&mut caps);
        Ok(caps)
    }

    async fn detect_capabilities(
        &self,
        claude: &Path,
        version: String,
        help: &str,
    ) -> capabilities::CliCapabilities {
        let mut caps = capabilities::detect(claude, version, help);
        self.metadata_cache
            .get(claude, &caps.fingerprint)
            .await
            .apply(&mut caps);
        caps
    }

    pub async fn spawn(&self, app: AppHandle, mut opts: SpawnOptions) -> Result<String> {
        let runtime = opts
            .runtime_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        self.reserve_runtime_id(&runtime)?;
        opts.runtime_id = Some(runtime.clone());
        let launch = Arc::new(PendingLaunch {
            desktop: Arc::new(RuntimeDesktop {
                app: app.clone(),
                runtime_id: runtime.clone(),
            }),
            cancellation: LaunchCancellation::default(),
        });
        self.pending_launches
            .insert(runtime.clone(), launch.clone());
        let _pending = PendingLaunchGuard {
            manager: self,
            runtime_id: runtime.clone(),
        };
        // Covers a stop racing the reservation -> pending-map insertion gap.
        if self.cancelled_launch_ids.contains(&runtime) {
            launch.cancellation.cancel();
            launch.desktop.revoke("launch_cancelled");
        }
        self.diagnostics
            .record(&runtime, "launch_requested", None, None);
        let result = self.spawn_inner(app.clone(), opts, launch).await;
        if let Err(error) = &result {
            crate::computer_use::revoke_runtime(&app, &runtime, "launch_failed");
            let code = match error {
                Error::Io(error) => error.raw_os_error(),
                _ => None,
            };
            self.diagnostics
                .record(&runtime, "launch_failed", None, code);
        }
        result
    }

    async fn spawn_inner(
        &self,
        app: AppHandle,
        mut opts: SpawnOptions,
        launch: Arc<PendingLaunch>,
    ) -> Result<String> {
        let desktop = launch.desktop.clone();
        launch.cancellation.ensure_active()?;
        let (claude, version) = resolve_claude().await?;
        launch.cancellation.ensure_active()?;
        self.diagnostics.installation(
            opts.runtime_id.as_deref().unwrap_or_default(),
            &claude,
            &version,
        );
        // Missing help entries are unknown, not evidence that core streaming is unsupported.
        let help = claude_help_cached(&claude, &version, &self.claude_help_cache)
            .await
            .unwrap_or_default();
        let caps = self
            .detect_capabilities(&claude, version.clone(), &help)
            .await;
        launch.cancellation.ensure_active()?;
        configure_session_settings_for_capabilities(&mut opts, &caps)?;
        let checkpoints_enabled = opts.file_checkpointing.unwrap_or(true)
            && caps.file_checkpoints == Support::Supported
            && caps.user_message_replay == Support::Supported;
        if opts.file_checkpointing == Some(true) && !checkpoints_enabled {
            return Err(Error::Other(
                "当前 CLI 的文件检查点及用户 UUID 回放能力尚未确认".into(),
            ));
        }
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
        let mut mcp_config = parse_runtime_mcp_config(opts.mcp_config.as_deref())?;
        // This application-owned server is applied last. Project/global config
        // cannot replace its executable, token, or disabled state.
        #[cfg(windows)]
        if let Some(managed) = crate::computer_use::runtime_mcp_config(
            &app,
            &session_id,
            &opts.cwd,
            opts.computer_use_enabled,
        )
        .await?
        {
            merge_managed_mcp_config(&mut mcp_config, managed)?;
        }
        // Stop can arrive while registration awaits. It must never be followed
        // by a new helper spawn, even if the broker registered after that stop.
        launch.cancellation.ensure_active()?;
        #[cfg(not(windows))]
        let _ = opts.computer_use_enabled;
        let runtime_mcp_file = mcp_config
            .map(|config| RuntimeSettings::mcp(&session_id, &config))
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
        } else if checkpoints_enabled {
            cmd.arg("--replay-user-messages");
        }
        if opts.forward_subagent_text.unwrap_or(true)
            && caps.subagent_text_forwarding == Support::Supported
        {
            cmd.arg("--forward-subagent-text");
        } else if opts.forward_subagent_text == Some(true) {
            return Err(Error::Other("当前 CLI 未确认支持子代理文本转发".into()));
        }
        if caps.prompt_suggestions == Support::Supported {
            cmd.arg("--prompt-suggestions")
                .arg(if opts.prompt_suggestions.unwrap_or(false) {
                    "true"
                } else {
                    "false"
                });
        } else if opts.prompt_suggestions == Some(true) {
            return Err(Error::Other("当前 CLI 未确认支持输入建议".into()));
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
        append_runtime_mcp_arg(&mut cmd, runtime_mcp_file.as_ref());
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
        cmd.env(
            "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
            if checkpoints_enabled { "true" } else { "false" },
        );

        cmd.current_dir(&opts.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        hide_tokio_window(&mut cmd);

        launch.cancellation.ensure_active()?;
        let mut child = cmd.spawn()?;
        let tree = match ProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(error) => {
                desktop.revoke("process_supervision_failed");
                let _ = child.kill().await;
                return Err(Error::from(error));
            }
        };
        if let Err(error) = launch.cancellation.ensure_active() {
            desktop.revoke("launch_cancelled");
            drop(tree);
            let _ = child.kill().await;
            return Err(error);
        }
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            desktop.revoke("process_pipes_missing");
            drop(tree);
            let _ = child.kill().await;
            return Err(Error::Other("CLI process pipe missing".into()));
        };

        let event_topic = format!("claude://session/{}/event", session_id);
        let error_topic = format!("claude://session/{}/error", session_id);

        let (stop_tx, stop_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(false);
        let session = Arc::new(Session {
            desktop,
            capabilities: caps,
            stdin: Mutex::new(stdin),
            available: AtomicBool::new(true),
            stop: stop_tx,
            done: done_rx,
            stop_reason: std::sync::Mutex::new(None),
            submissions: Mutex::new(std::collections::HashMap::new()),
            control_responses: Mutex::new(ControlReceipts::default()),
            replies: Arc::new(ReplyWaiters::default()),
            mutation_gate: Mutex::new(()),
            activity: std::sync::Mutex::new(Activity::default()),
            checkpoints_enabled,
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
                // Also covers reader panic/cancellation: transport loss cannot
                // leave desktop authority live while the CLI is still running.
                let _close = CloseSessionOnDrop {
                    session: session.clone(),
                    reason: "stdout_closed",
                };
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
                                    if runtime_event_revokes_desktop(&value) {
                                        session.desktop.revoke("turn_error");
                                    }
                                    let mut controls = session.control_responses.lock().await;
                                    match controls.should_forward_permission(&value) {
                                        Ok(false) => continue,
                                        Ok(true) => {}
                                        Err(_) => {
                                            diagnostics.record(
                                                &sid,
                                                "malformed_permission_request",
                                                None,
                                                None,
                                            );
                                            let _ = app.emit(&topic, json!({"type":"stderr","line":"CLI 权限请求缺少有效 request_id，会话已停止。"}));
                                            session.close("malformed_permission_request");
                                            break;
                                        }
                                    }
                                    if value.get("type").and_then(Value::as_str)
                                        == Some("control_cancel_request")
                                    {
                                        if let Some(id) =
                                            value.get("request_id").and_then(Value::as_str)
                                        {
                                            controls.cancel_permission(id);
                                        }
                                    }
                                    let permission_cancel =
                                        if let Ok(mut activity) = session.activity.lock() {
                                            let permission_cancel =
                                                value.get("type").and_then(Value::as_str)
                                                    == Some("control_cancel_request")
                                                    && value
                                                        .get("request_id")
                                                        .and_then(Value::as_str)
                                                        .is_some_and(|id| {
                                                            activity.permissions.contains(id)
                                                        });
                                            activity.observe(&value);
                                            permission_cancel
                                        } else {
                                            false
                                        };
                                    drop(controls);
                                    if session.replies.consume(&value) && !permission_cancel {
                                        continue;
                                    }
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
                                            let Some(response) = unsupported_response(&value)
                                            else {
                                                let _ = app.emit(&topic, json!({"type":"stderr", "line":"CLI 控制请求缺少有效 request_id，无法回复；会话已停止。"}));
                                                session.close("malformed_control_request");
                                                break;
                                            };
                                            let id =
                                                value["request_id"].as_str().unwrap_or_default();
                                            if session.control_responses.lock().await.insert(id) {
                                                let body = format!("{}\n", response);
                                                let replied = match tokio::time::timeout(
                                                    Duration::from_secs(2),
                                                    session.stdin.lock(),
                                                )
                                                .await
                                                {
                                                    Ok(mut stdin) => write_frame(
                                                        &mut *stdin,
                                                        body.as_bytes(),
                                                        Duration::from_secs(2),
                                                    )
                                                    .await
                                                    .is_ok(),
                                                    Err(_) => false,
                                                };
                                                if !replied {
                                                    session
                                                        .close("unsupported_control_reply_failed");
                                                    break;
                                                }
                                                let _ = app.emit(&topic, json!({"type":"stderr", "line":"CLI 控制扩展暂不支持，已回复明确错误；会话继续运行。"}));
                                            }
                                            continue;
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
                                            diagnostics.record(
                                                &sid,
                                                "permission_emit_failed",
                                                None,
                                                None,
                                            );
                                            session.close("permission_emit_failed");
                                            break;
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
        let supervision = supervise_with_close(child, stop_rx, tree, {
            let session = session.clone();
            move || session.close("process_exit")
        });
        tokio::spawn(async move {
            let _close = CloseSessionOnDrop {
                session: session.clone(),
                reason: "process_supervision_closed",
            };
            let status = supervision.await;
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
            session.replies.close("CLI 进程已退出，控制请求未完成");
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
        if let Err(error) = launch.cancellation.ensure_active() {
            // A concurrent stop may have seen only the pending launch. Publish
            // the close to the now-supervised session before returning.
            if let Some(session) = self.sessions.get(&session_id) {
                session.close("launch_cancelled");
            }
            return Err(error);
        }
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
            "uuid": Uuid::new_v4().to_string(),
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
        if request_id.is_empty()
            || request_id.len() > 256
            || request_id.chars().any(char::is_control)
        {
            return Err(Error::Other("控制请求 ID 无效".into()));
        }
        let session = self
            .sessions
            .get(session_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| Error::Other("会话进程已结束".into()))?;
        let payload = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response
            }
        });
        let result = self.write_json_line(session_id, payload).await;
        if result.is_ok() {
            if let Ok(mut activity) = session.activity.lock() {
                activity.permissions.remove(request_id);
            }
        }
        // The writer closes the runtime on an uncertain/failed frame. A
        // cancelled or unknown permission is rejected before writing and must
        // not terminate an otherwise healthy process.
        result
    }

    /// 软中断当前回合：向会话 stdin 写一行 interrupt control_request（等价 TUI Esc）。
    /// CLI 进程与会话保活，被中断回合仍会产出 result 事件；
    /// 与 resolve_control_request 同向（GUI → CLI stdin），强杀路径见 stop。
    pub async fn interrupt(&self, session_id: &str) -> Result<()> {
        self.cancel_pending_launch(session_id, "interrupt_requested");
        let payload = json!({
            "type": "control_request",
            "request_id": Uuid::new_v4().to_string(),
            "request": { "subtype": "interrupt" }
        });
        let session = self.sessions.get(session_id).map(|entry| entry.clone());
        let Some(session) = session else {
            return Ok(());
        };
        session.desktop.revoke("interrupt_requested");
        // Never wait behind a blocked input frame. The supervisor can close the
        // process independently; inserting control bytes into that frame is unsafe.
        let result = if let Ok(mut stdin) = session.stdin.try_lock() {
            let body = format!("{}\n", serde_json::to_string(&payload)?);
            Some(write_frame(&mut *stdin, body.as_bytes(), Duration::from_secs(1)).await)
        } else {
            None
        };
        match result {
            Some(Ok(())) => Ok(()),
            _ => self.stop(session_id).await,
        }
    }

    fn control_session(&self, session_id: &str, native_contract: bool) -> Result<Arc<Session>> {
        let session = self
            .sessions
            .get(session_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| Error::Other("会话进程已结束".into()))?;
        if native_contract {
            runtime_controls::supported(&session.capabilities.resolved_version)?;
        }
        if !session.available.load(Ordering::Acquire) {
            return Err(Error::Other("会话连接已关闭".into()));
        }
        Ok(session)
    }

    async fn request_control(session: &Arc<Session>, request: Value) -> Result<Value> {
        if !session.available.load(Ordering::Acquire) {
            return Err(Error::Other("会话连接已关闭".into()));
        }
        let pending = session.replies.register().map_err(Error::Other)?;
        let request_id = pending.id.clone();
        let mutation = request.get("subtype").and_then(Value::as_str)
            == Some("apply_flag_settings")
            || (request.get("subtype").and_then(Value::as_str) == Some("rewind_files")
                && request.get("dry_run").and_then(Value::as_bool) == Some(false));
        let body = format!(
            "{}\n",
            json!({"type":"control_request", "request_id":request_id, "request":request})
        );
        if body.len() > 1024 * 1024 {
            return Err(Error::Other("CLI 控制请求超过大小限制".into()));
        }
        {
            let mut stdin = tokio::time::timeout(Duration::from_secs(2), session.stdin.lock())
                .await
                .map_err(|_| Error::Other("CLI 输入通道繁忙，控制请求尚未写入".into()))?;
            if !session.available.load(Ordering::Acquire) {
                return Err(Error::Other("会话连接已关闭".into()));
            }
            if mutation {
                Self::ensure_idle(session)?;
            }
            if write_frame(&mut *stdin, body.as_bytes(), Duration::from_secs(2))
                .await
                .is_err()
            {
                session.close("control_write_unknown");
                return Err(Error::Other(
                    "控制请求写入结果未确认，会话已停止；未自动重试".into(),
                ));
            }
        }
        match pending.receive(Duration::from_secs(10)).await {
            Ok(reply) => Ok(reply),
            Err(error) => {
                if mutation {
                    session.close("control_mutation_unconfirmed");
                    return Err(Error::Other(format!("{error}；运行实例已停止，未自动重试")));
                }
                if error.starts_with("CLI 控制请求超时") {
                    if let Ok(mut stdin) = session.stdin.try_lock() {
                        let cancel = format!(
                            "{}\n",
                            json!({"type":"control_cancel_request", "request_id":request_id})
                        );
                        if write_frame(&mut *stdin, cancel.as_bytes(), Duration::from_secs(1))
                            .await
                            .is_err()
                        {
                            session.close("control_cancel_write_failed");
                        }
                    }
                }
                Err(Error::Other(error))
            }
        }
    }

    fn ensure_idle(session: &Session) -> Result<()> {
        let activity = session
            .activity
            .lock()
            .map_err(|_| Error::Other("runtime activity lock poisoned".into()))?;
        if !activity.idle() {
            return Err(Error::Other(
                "请等待本轮、后台任务和权限请求结束后再操作".into(),
            ));
        }
        Ok(())
    }

    pub async fn runtime_settings(&self, session_id: &str) -> Result<Value> {
        let session = self.control_session(session_id, false)?;
        let raw = Self::request_control(&session, json!({"subtype":"get_settings"})).await?;
        runtime_controls::validate_settings_reply(&raw)?;
        let activity = session
            .activity
            .lock()
            .map_err(|_| Error::Other("runtime activity lock poisoned".into()))?;
        Ok(runtime_controls::settings_reply(&raw, &activity))
    }

    pub async fn apply_runtime_settings(
        &self,
        session_id: &str,
        mut settings: Value,
    ) -> Result<Value> {
        let session = self.control_session(session_id, false)?;
        runtime_controls::validate_settings_for_capabilities(&settings, &session.capabilities)?;
        let _guard = session
            .mutation_gate
            .try_lock()
            .map_err(|_| Error::Other("已有文件或配置操作正在执行".into()))?;
        Self::ensure_idle(&session)?;
        if let Some(patch) = settings
            .get("modelSettings")
            .and_then(Value::as_object)
            .cloned()
        {
            let raw = Self::request_control(&session, json!({"subtype":"get_settings"})).await?;
            runtime_controls::validate_settings_reply(&raw)?;
            let mut models = raw
                .pointer("/effective/modelSettings")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (model, preferences) in patch {
                let existing = models.entry(model).or_insert_with(|| json!({}));
                let existing = existing
                    .as_object_mut()
                    .ok_or_else(|| Error::Other("现有模型设置无法安全合并".into()))?;
                existing.extend(preferences.as_object().unwrap().clone());
            }
            settings["modelSettings"] = Value::Object(models);
        }
        let fast_changed = settings.get("fastMode").is_some();
        Self::request_control(
            &session,
            json!({"subtype":"apply_flag_settings", "settings":settings}),
        )
        .await?;
        if let Ok(mut activity) = session.activity.lock() {
            activity.epoch = activity.epoch.saturating_add(1);
            activity.preview = None;
            if fast_changed {
                activity.fast_state = None;
                activity.fast_reason = Some("pending".into());
            }
        }
        let raw = match Self::request_control(&session, json!({"subtype":"get_settings"})).await {
            Ok(raw) if runtime_controls::validate_settings_reply(&raw).is_ok() => raw,
            _ => {
                session.close("control_apply_verification_failed");
                return Err(Error::Other(
                    "配置已提交但权威回读失败，会话已停止；未自动重试配置更改".into(),
                ));
            }
        };
        if fast_changed {
            // initialize returns an actual current-state snapshot. It is not a
            // model request, and an absent state leaves honest pending status.
            if let Ok(metadata) =
                Self::request_control(&session, json!({"subtype":"initialize"})).await
            {
                if let Ok(mut activity) = session.activity.lock() {
                    activity.observe_fast(&metadata);
                }
            }
        }
        let activity = session.activity.lock().map_err(|_| {
            session.close("control_apply_verification_failed");
            Error::Other("配置已提交但运行状态无法确认，会话已停止".into())
        })?;
        Ok(runtime_controls::settings_reply(&raw, &activity))
    }

    pub async fn context_usage(&self, session_id: &str) -> Result<Value> {
        let session = self.control_session(session_id, true)?;
        let raw = Self::request_control(
            &session,
            json!({"subtype":"get_context_usage", "detail":"summary"}),
        )
        .await?;
        Ok(runtime_controls::context_reply(&raw))
    }

    pub async fn preview_rewind(&self, session_id: &str, message_id: String) -> Result<Value> {
        Uuid::parse_str(&message_id).map_err(|_| Error::Other("invalid checkpoint UUID".into()))?;
        let session = self.control_session(session_id, true)?;
        if !session.checkpoints_enabled {
            return Err(Error::Other(
                "此运行实例未启用文件检查点，不能补造历史检查点".into(),
            ));
        }
        let _guard = session
            .mutation_gate
            .try_lock()
            .map_err(|_| Error::Other("已有文件或配置操作正在执行".into()))?;
        Self::ensure_idle(&session)?;
        let raw = Self::request_control(
            &session,
            json!({"subtype":"rewind_files", "user_message_id":message_id, "dry_run":true}),
        )
        .await?;
        let mut result = runtime_controls::rewind_reply(&raw)?;
        if result["canRewind"] == true {
            let preview_id = Uuid::new_v4().to_string();
            let mut activity = session
                .activity
                .lock()
                .map_err(|_| Error::Other("runtime activity lock poisoned".into()))?;
            let epoch = activity.epoch;
            activity.preview = Some(Preview {
                id: preview_id.clone(),
                message_id,
                epoch,
                created: std::time::Instant::now(),
                result: result.clone(),
            });
            result["previewId"] = json!(preview_id);
        } else {
            if let Ok(mut activity) = session.activity.lock() {
                activity.preview = None;
            }
        }
        Ok(result)
    }

    pub async fn rewind_files(
        &self,
        session_id: &str,
        message_id: String,
        preview_id: String,
    ) -> Result<Value> {
        Uuid::parse_str(&message_id).map_err(|_| Error::Other("invalid checkpoint UUID".into()))?;
        let session = self.control_session(session_id, true)?;
        if !session.checkpoints_enabled {
            return Err(Error::Other("此运行实例未启用文件检查点".into()));
        }
        let _guard = session
            .mutation_gate
            .try_lock()
            .map_err(|_| Error::Other("已有文件或配置操作正在执行".into()))?;
        Self::ensure_idle(&session)?;
        let preview = {
            let mut activity = session
                .activity
                .lock()
                .map_err(|_| Error::Other("runtime activity lock poisoned".into()))?;
            if !activity.preview_matches(&preview_id, &message_id) {
                return Err(Error::Other(
                    "回退预览已过期或运行回合已变化，请重新预览".into(),
                ));
            }
            activity.preview.take().unwrap()
        };
        let raw = Self::request_control(
            &session,
            json!({"subtype":"rewind_files", "user_message_id":message_id, "dry_run":true}),
        )
        .await?;
        let current = runtime_controls::rewind_reply(&raw)?;
        if current["canRewind"] != true || current != preview.result {
            return Err(Error::Other(
                "CLI 回退范围已变化或无法回退，请重新预览确认".into(),
            ));
        }
        let raw = Self::request_control(
            &session,
            json!({"subtype":"rewind_files", "user_message_id":message_id, "dry_run":false}),
        )
        .await?;
        runtime_controls::rewind_reply(&raw)
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
        let authored_input = payloads
            .iter()
            .any(|payload| payload.get("type").and_then(Value::as_str) == Some("user"));
        let permission_reply_id = payloads.iter().find_map(|payload| {
            (payload.get("type").and_then(Value::as_str) == Some("control_response"))
                .then(|| {
                    payload
                        .pointer("/response/request_id")
                        .and_then(Value::as_str)
                })
                .flatten()
                .map(str::to_string)
        });
        let input_ids: Vec<String> = payloads
            .iter()
            .filter(|payload| payload.get("type").and_then(Value::as_str) == Some("user"))
            .map(|payload| {
                payload
                    .get("uuid")
                    .and_then(Value::as_str)
                    .filter(|id| Uuid::parse_str(id).is_ok())
                    .map(str::to_string)
                    .ok_or_else(|| {
                        fail(
                            "not_sent",
                            "invalid_input_id",
                            "输入缺少有效 UUID，尚未发送".into(),
                            None,
                        )
                    })
            })
            .collect::<Result<_>>()?;
        let _mutation_guard = if authored_input {
            Some(
                tokio::time::timeout(Duration::from_secs(10), session.mutation_gate.lock())
                    .await
                    .map_err(|_| {
                        fail(
                            "not_sent",
                            "mutation_busy",
                            "文件回退或配置更改尚未完成，输入尚未发送".into(),
                            None,
                        )
                    })?,
            )
        } else {
            None
        };
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
        // Hold the same receipt gate used by inbound cancellation until the
        // frame is written. Never authorize a cancelled/unknown request, even
        // if a GUI callback was already queued before stdin became available.
        let mut permission_guard = if permission_reply_id.is_some() {
            Some(session.control_responses.lock().await)
        } else {
            None
        };
        if let (Some(receipts), Some(id)) = (&mut permission_guard, &permission_reply_id) {
            if !receipts.claim_permission_reply(id).map_err(Error::Other)? {
                return Ok(());
            }
        }
        self.diagnostics
            .record(session_id, "write_started", Some(body.len()), None);
        if authored_input {
            let mut activity = session.activity.lock().map_err(|_| {
                fail(
                    "not_sent",
                    "activity_unavailable",
                    "无法确认运行状态，输入尚未发送".into(),
                    None,
                )
            })?;
            activity.begin_inputs(&input_ids).map_err(|_| {
                fail(
                    "not_sent",
                    "pending_input_limit",
                    "未完成输入已达到上限，输入尚未发送".into(),
                    None,
                )
            })?;
        }
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
        self.cancel_pending_launch(session_id, "stop_requested");
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

    /// Application shutdown cannot await individual IPC cleanup.
    pub fn shutdown(&self) {
        for launch in self.pending_launches.iter() {
            launch.cancellation.cancel();
            launch.desktop.revoke("application_shutdown");
        }
        for session in self.sessions.iter() {
            session.close("application_shutdown");
        }
    }
}

#[derive(Default)]
struct LaunchCancellation(AtomicBool);

impl LaunchCancellation {
    fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn ensure_active(&self) -> Result<()> {
        if self.0.load(Ordering::Acquire) {
            Err(Error::Other("runtime launch was cancelled".into()))
        } else {
            Ok(())
        }
    }
}

struct PendingLaunch {
    desktop: Arc<RuntimeDesktop>,
    cancellation: LaunchCancellation,
}

struct PendingLaunchGuard<'a> {
    manager: &'a Manager,
    runtime_id: String,
}

impl Drop for PendingLaunchGuard<'_> {
    fn drop(&mut self) {
        self.manager.pending_launches.remove(&self.runtime_id);
    }
}

struct RuntimeDesktop {
    app: AppHandle,
    runtime_id: String,
}

impl RuntimeDesktop {
    fn revoke(&self, reason: &str) {
        crate::computer_use::revoke_runtime(&self.app, &self.runtime_id, reason);
    }
}

impl Drop for RuntimeDesktop {
    fn drop(&mut self) {
        self.revoke("runtime_retired");
    }
}

struct RuntimeSettings {
    path: PathBuf,
    session_id: String,
}

impl RuntimeSettings {
    fn mcp(session_id: &str, config: &Value) -> Result<Self> {
        let contents = serde_json::to_string(config)?;
        let path = write_runtime_claude_settings_file(&format!("mcp-{session_id}"), &contents)?;
        Ok(Self {
            path,
            session_id: session_id.into(),
        })
    }
}

fn parse_runtime_mcp_config(contents: Option<&str>) -> Result<Option<Value>> {
    let Some(contents) = contents else {
        return Ok(None);
    };
    let config: Value = serde_json::from_str(contents)?;
    if !config.is_object() || !config.get("mcpServers").is_some_and(Value::is_object) {
        return Err(Error::Other(
            "runtime MCP config must contain an mcpServers object".into(),
        ));
    }
    Ok(Some(config))
}

fn merge_managed_mcp_config(target: &mut Option<Value>, managed: Value) -> Result<()> {
    let servers = managed
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            Error::Other("managed MCP config must contain an mcpServers object".into())
        })?;
    let target = target.get_or_insert_with(|| json!({"mcpServers": {}}));
    let target_servers = target
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            Error::Other("runtime MCP config must contain an mcpServers object".into())
        })?;
    target_servers.extend(servers.clone());
    Ok(())
}

fn append_runtime_mcp_arg(command: &mut Command, file: Option<&RuntimeSettings>) {
    if let Some(file) = file {
        // Protected JSON file; npm shims must never reparse the contents.
        command.arg("--mcp-config").arg(&file.path);
    }
}

fn runtime_event_revokes_desktop(event: &Value) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("error") => true,
        Some("result") => event.get("is_error").and_then(Value::as_bool) == Some(true),
        Some("assistant") => event.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true),
        _ => false,
    }
}

#[cfg(test)]
fn configure_session_settings(opts: &mut SpawnOptions, version: &str) -> Result<()> {
    let caps = capabilities::detect(Path::new("claude"), version.into(), "");
    configure_session_settings_for_capabilities(opts, &caps)
}

fn configure_session_settings_for_capabilities(
    opts: &mut SpawnOptions,
    caps: &capabilities::CliCapabilities,
) -> Result<()> {
    let mut settings: Value = opts
        .settings_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let object = settings
        .as_object_mut()
        .ok_or_else(|| Error::Other("runtime settings must be an object".into()))?;
    // This process option is set after env_remove and never delegated to the
    // settings.env layer, which Claude can apply after child-process startup.
    if let Some(env) = object.get_mut("env").and_then(Value::as_object_mut) {
        env.remove("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING");
    }
    let mut patch = Map::new();
    if let Some(ultracode) = opts.ultracode {
        patch.insert("ultracode".into(), json!(ultracode));
    }
    if let Some(fast) = opts.fast_mode {
        patch.insert("fastMode".into(), json!(fast));
    }
    if let Some(workflows) = opts.enable_workflows {
        patch.insert("enableWorkflows".into(), json!(workflows));
    }
    if let Some(models) = &opts.model_settings {
        patch.insert("modelSettings".into(), models.clone());
    }
    runtime_controls::validate_settings_for_capabilities(&Value::Object(patch.clone()), caps)?;
    for (key, value) in patch {
        if key == "modelSettings" {
            let existing = object
                .entry(key)
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| Error::Other("modelSettings must be object".into()))?;
            for (model, preferences) in value.as_object().unwrap() {
                let model = existing
                    .entry(model.clone())
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or_else(|| Error::Other("model preferences must be object".into()))?;
                model.extend(preferences.as_object().unwrap().clone());
            }
        } else {
            if object.get(&key).is_some_and(|existing| existing != &value) {
                return Err(Error::Other(format!(
                    "runtime settings {key} conflicts with explicit session selection"
                )));
            }
            object.insert(key, value);
        }
    }
    if caps.headless_fast_mode == Support::Supported {
        object.entry("fastMode").or_insert(json!(false));
    }
    if opts.ultracode.is_some() && opts.effort.as_deref() == Some("ultracode") {
        return Err(Error::Other(
            "legacy ultracode effort must be migrated to independent flag and xhigh effort".into(),
        ));
    }
    opts.settings_json = (!object.is_empty())
        .then(|| serde_json::to_string(&settings))
        .transpose()?;
    Ok(())
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
        append_runtime_mcp_arg, cleanup_runtime_settings_file, configure_session_settings,
        merge_managed_mcp_config, parse_effort_levels, parse_runtime_mcp_config,
        runtime_event_revokes_desktop, write_runtime_claude_settings_file, LaunchCancellation,
        Manager, RuntimeSettings, SpawnOptions,
    };
    use serde_json::json;

    #[test]
    fn startup_settings_keep_independent_ultra_model_prefs_and_manual_fields() {
        let mut options = SpawnOptions {
            effort:Some("low".into()), ultracode:Some(true), fast_mode:Some(false), enable_workflows:Some(true),
            model_settings:Some(json!({"claude-opus-5-5":{"effortLevel":"low","autoCompactWindow":"auto"}})),
            settings_json:Some(json!({"hooks":{},"env":{"CUSTOM":"kept"},"modelSettings":{"claude-opus-5-5":{"maxEffortLevel":"max"},"other":{"effortLevel":"medium"}}}).to_string()),
            ..SpawnOptions::default()
        };
        configure_session_settings(&mut options, "2.1.296").unwrap();
        let settings: serde_json::Value =
            serde_json::from_str(options.settings_json.as_deref().unwrap()).unwrap();
        assert_eq!(settings["ultracode"], true);
        assert_eq!(settings["fastMode"], false);
        assert_eq!(settings["enableWorkflows"], true);
        assert_eq!(settings["env"]["CUSTOM"], "kept");
        assert_eq!(
            settings["modelSettings"]["claude-opus-5-5"]["maxEffortLevel"],
            "max"
        );
        assert_eq!(settings["modelSettings"]["other"]["effortLevel"], "medium");
        assert_eq!(options.effort.as_deref(), Some("low"));
    }

    #[test]
    fn observed_settings_support_overrides_older_version_without_changing_effort() {
        let mut caps =
            super::capabilities::detect(std::path::Path::new("claude"), "2.1.196".into(), "");
        caps.runtime_settings_control = super::Support::Supported;
        caps.independent_ultracode = super::Support::Supported;
        caps.headless_fast_mode = super::Support::Supported;
        let mut options = SpawnOptions {
            effort: Some("low".into()),
            ultracode: Some(true),
            fast_mode: Some(true),
            enable_workflows: Some(true),
            ..SpawnOptions::default()
        };
        super::configure_session_settings_for_capabilities(&mut options, &caps).unwrap();
        let settings: serde_json::Value =
            serde_json::from_str(options.settings_json.as_deref().unwrap()).unwrap();
        assert_eq!(settings["enableWorkflows"], true);
        assert_eq!(settings["ultracode"], true);
        assert_eq!(settings["fastMode"], true);
        assert_eq!(options.effort.as_deref(), Some("low"));
    }

    #[test]
    fn fast_defaults_off_and_explicit_manual_conflicts_fail_without_launching() {
        let mut options = SpawnOptions::default();
        configure_session_settings(&mut options, "2.1.296").unwrap();
        assert_eq!(
            options.settings_json.as_deref(),
            Some("{\"fastMode\":false}")
        );
        let mut old = SpawnOptions::default();
        configure_session_settings(&mut old, "2.1.204").unwrap();
        assert!(old.settings_json.is_none());
        let mut manual = SpawnOptions {
            settings_json: Some("{\"fastMode\":true}".into()),
            ..SpawnOptions::default()
        };
        configure_session_settings(&mut manual, "2.1.296").unwrap();
        assert_eq!(manual.settings_json.as_deref(), Some("{\"fastMode\":true}"));
        manual.fast_mode = Some(false);
        assert!(configure_session_settings(&mut manual, "2.1.296").is_err());
        let mut legacy = SpawnOptions {
            effort: Some("ultracode".into()),
            ultracode: Some(true),
            ..SpawnOptions::default()
        };
        assert!(configure_session_settings(&mut legacy, "2.1.296").is_err());
    }

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

    #[test]
    fn runtime_ids_cannot_be_reused_after_failure_or_retirement() {
        let manager = Manager::new();
        let runtime = uuid::Uuid::new_v4().to_string();
        manager.reserve_runtime_id(&runtime).unwrap();
        // This identity stays reserved even while there is no live session.
        assert!(manager.sessions.is_empty());
        assert!(manager.reserve_runtime_id(&runtime).is_err());
        assert!(manager.reserve_runtime_id("not-a-uuid").is_err());
        manager
            .reserve_runtime_id(&uuid::Uuid::new_v4().to_string())
            .unwrap();
    }

    #[test]
    fn pending_launch_cancellation_is_terminal_and_isolated() {
        let old = LaunchCancellation::default();
        let current = LaunchCancellation::default();
        old.ensure_active().unwrap();
        old.cancel();
        old.cancel();
        assert!(old.ensure_active().is_err());
        current.ensure_active().unwrap();
        assert!(old.ensure_active().is_err());
    }

    #[test]
    fn stop_before_manager_spawn_tombstones_the_captured_runtime_only() {
        let manager = Manager::new();
        let stopped = uuid::Uuid::new_v4().to_string();
        let next = uuid::Uuid::new_v4().to_string();
        manager.cancel_pending_launch(&stopped, "interrupt_requested");
        assert!(manager.cancelled_launch_ids.contains(&stopped));
        assert!(manager.reserve_runtime_id(&stopped).is_err());
        manager.reserve_runtime_id(&next).unwrap();
        assert!(!manager.cancelled_launch_ids.contains(&next));
        manager.cancel_pending_launch("invalid", "stop_requested");
        assert!(!manager.cancelled_launch_ids.contains("invalid"));
    }

    #[test]
    fn stop_between_reservation_and_pending_publication_is_terminal() {
        let manager = Manager::new();
        let runtime = uuid::Uuid::new_v4().to_string();
        manager.reserve_runtime_id(&runtime).unwrap();
        assert!(manager.pending_launches.is_empty());
        manager.cancel_pending_launch(&runtime, "stop_requested");
        assert!(manager.cancelled_launch_ids.contains(&runtime));
        assert!(manager.reserve_runtime_id(&runtime).is_err());
    }

    #[test]
    fn mcp_boundary_rejects_paths_and_non_object_json() {
        for raw in [
            r#"C:\\temp\\mcp-config.json"#,
            r#""C:\\temp\\mcp-config.json""#,
            "[]",
            "{}",
            r#"{"mcpServers":[]}"#,
        ] {
            assert!(
                parse_runtime_mcp_config(Some(raw)).is_err(),
                "accepted {raw}"
            );
        }
        assert!(parse_runtime_mcp_config(None).unwrap().is_none());
        assert!(parse_runtime_mcp_config(Some(r#"{"mcpServers":{}}"#))
            .unwrap()
            .is_some());
    }

    #[test]
    fn managed_mcp_gateway_overrides_project_values_last() {
        let mut config = Some(json!({"mcpServers": {
            "managed": {"command":"project.exe", "disabled":true},
            "project": {"command":"project-helper"}
        }, "other":"preserved"}));
        merge_managed_mcp_config(&mut config, json!({"mcpServers": {
            "managed": {"command":"app.exe", "args":["--computer-use-mcp-server"], "env":{"TOKEN":"runtime-bound"}}
        }})).unwrap();
        let config = config.unwrap();
        assert_eq!(config["mcpServers"]["managed"]["command"], "app.exe");
        assert!(config["mcpServers"]["managed"].get("disabled").is_none());
        assert_eq!(config["mcpServers"]["project"]["command"], "project-helper");
        assert_eq!(config["other"], "preserved");
    }

    #[test]
    fn turn_errors_revoke_desktop_without_treating_diagnostics_as_exit() {
        assert!(runtime_event_revokes_desktop(
            &json!({"type":"result", "is_error":true})
        ));
        assert!(runtime_event_revokes_desktop(
            &json!({"type":"error", "error":"failed"})
        ));
        assert!(runtime_event_revokes_desktop(
            &json!({"type":"assistant", "isApiErrorMessage":true})
        ));
        for event in [
            json!({"type":"result", "is_error":false}),
            json!({"type":"stderr", "line":"warning"}),
            json!({"type":"user", "message":{"content":[{"type":"tool_result", "is_error":true}]}}),
        ] {
            assert!(!runtime_event_revokes_desktop(&event));
        }
    }

    #[tokio::test]
    async fn fake_cli_reads_real_mcp_config_json_and_file_lives_until_process_exit() {
        use std::process::Stdio;
        use tokio::io::{AsyncWriteExt, BufReader};
        use tokio::process::Command;

        let runtime = format!("test-{}", uuid::Uuid::new_v4());
        let config = json!({"mcpServers":{"gateway":{"command":"fake-driver", "args":["quoted space", "中文"]}}});
        let serialized =
            crate::commands::serialize_runtime_mcp_config(Some(json!({"mcpServers": {
                "gateway": config["mcpServers"]["gateway"],
                "disabled": {"command":"must-not-launch", "disabled":true}
            }})))
            .unwrap();
        let parsed = parse_runtime_mcp_config(serialized.as_deref())
            .unwrap()
            .unwrap();
        let file = RuntimeSettings::mcp(&runtime, &parsed).unwrap();
        let path = file.path.clone();
        // App-owned metadata fixture: only arguments and JSON, no helper/model/desktop.
        #[cfg(windows)]
        let (extension, fixture) = (
            "cmd",
            "@echo off\r\nif not \"%~1\"==\"--mcp-config\" exit /b 21\r\nif not \"%~3\"==\"\" exit /b 22\r\ntype \"%~2\"\r\necho(\r\nset /p \"fixtureReply=\"\r\n",
        );
        #[cfg(not(windows))]
        let (extension, fixture) = ("sh", "test \"$#\" -eq 2 && test \"$1\" = '--mcp-config' || exit 21\ncat \"$2\"\nprintf '\\n'\nread reply\n");
        let script = std::env::temp_dir().join(format!("claudinal-fake-mcp-{runtime}.{extension}"));
        std::fs::write(&script, fixture).unwrap();
        let script_guard = RuntimeSettings {
            path: script.clone(),
            session_id: runtime.clone(),
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new(&script);
            append_runtime_mcp_arg(&mut command, Some(&file));
            let arguments = command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            crate::commands::claude_runtime_command(&script, &arguments).unwrap()
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.arg(&script);
            command
        };
        #[cfg(not(windows))]
        append_runtime_mcp_arg(&mut command, Some(&file));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        crate::child_process::hide_tokio_window(&mut command);
        let mut child = command.spawn().unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let raw = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            super::super::transport::read_line(&mut reader, 16 * 1024),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        let actual: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(actual, config);
        assert!(path.is_file(), "config disappeared while CLI was alive");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"done\n")
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert!(path.is_file());
        drop(file);
        assert!(!path.exists());
        drop(script_guard);
        assert!(!script.exists());
    }

    #[tokio::test]
    async fn mcp_file_is_removed_when_spawn_fails() {
        let runtime = format!("test-{}", uuid::Uuid::new_v4());
        let path;
        let result = {
            let file = RuntimeSettings::mcp(&runtime, &json!({"mcpServers":{}})).unwrap();
            path = file.path.clone();
            let mut command = tokio::process::Command::new(
                std::env::temp_dir().join(format!("missing-cli-{runtime}")),
            );
            append_runtime_mcp_arg(&mut command, Some(&file));
            command.spawn()
        };
        assert!(result.is_err());
        assert!(!path.exists());
    }
}
