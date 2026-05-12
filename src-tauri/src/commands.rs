use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, State};

use crate::api_proxy::{start as start_api_proxy, ProxyConfig};
use crate::child_process::{hide_std_window, hide_tokio_window};
use crate::error::{Error, Result};
use crate::permission_mcp::{
    render_default_mcp_config, PermissionMcpBridge, DEFAULT_PERMISSION_MCP_TOOL,
};
use crate::proc::{Manager, SpawnOptions};
use crate::session::{
    delete_session_jsonl as delete_jsonl_inner, list_project_sessions as list_sessions_inner,
    list_recent_sessions_all as list_all_inner, read_session_sidecar as read_sidecar_inner,
    read_session_transcript as read_transcript_inner, rebuild_session_index as rebuild_index_inner,
    scan_activity_heatmap as scan_heatmap_inner, scan_all_usage_sidecars as scan_usage_inner,
    search_sessions as search_sessions_inner, session_index_diagnostics as index_diagnostics_inner,
    write_session_sidecar as write_sidecar_inner, ActivityCell, GlobalSessionMeta, GlobalUsage,
    SessionIndexDiagnostics, SessionMeta, SessionSearchHit, WatcherState,
};

const MIN_SUPPORTED_CLAUDE_CLI_VERSION: &str = "2.1.123";
const CLAUDE_UPDATE_COMMAND: &str = "claude update";
const CLAUDE_CLI_REFERENCE_URL: &str =
    "https://docs.anthropic.com/en/docs/claude-code/cli-reference";

/// 把字符串内容原子写入磁盘：先写到 `<path>.tmp.<pid>`，再 rename 到目标路径。
/// 这样即使写入过程中崩溃 / 断电，也不会留下半截文件。所有 GUI 直接管理的
/// 用户配置（settings.json / mcp.json / CLAUDE.md / 导出 JSON）都应该走这条。
fn atomic_write_str(path: &std::path::Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(Error::from)?;
        }
    }
    let pid = std::process::id();
    let mut tmp = path.to_path_buf();
    let suffix = match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{ext}.tmp.{pid}"),
        None => format!("tmp.{pid}"),
    };
    tmp.set_extension(suffix);
    std::fs::write(&tmp, contents).map_err(Error::from)?;
    if let Err(err) = std::fs::rename(&tmp, path) {
        // rename 失败时尽力清理临时文件，避免残留
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::from(err));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct ClaudeCliVersionInfo {
    pub path: String,
    pub version: String,
    pub min_supported_version: String,
    pub supported: bool,
    pub update_command: String,
    pub docs_url: String,
}

#[derive(serde::Serialize)]
pub struct AppRuntimeInfo {
    pub executable_path: String,
    pub executable_dir: String,
}

#[tauri::command]
pub fn app_runtime_info() -> Result<AppRuntimeInfo> {
    let exe = std::env::current_exe()
        .map_err(|e| Error::Other(format!("无法定位 Claudinal 可执行文件: {e}")))?;
    let dir = exe
        .parent()
        .ok_or_else(|| Error::Other("无法定位 Claudinal 可执行文件目录".into()))?;
    Ok(AppRuntimeInfo {
        executable_path: exe.display().to_string(),
        executable_dir: dir.display().to_string(),
    })
}

#[tauri::command]
pub async fn detect_claude_cli() -> Result<String> {
    let path = crate::proc::spawn::find_claude()?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn claude_cli_version_info() -> Result<ClaudeCliVersionInfo> {
    use tokio::process::Command as AsyncCommand;
    use tokio::time::{timeout, Duration};

    let path = crate::proc::spawn::find_claude()?;
    let mut cmd = AsyncCommand::new(&path);
    cmd.arg("--version");
    cmd.kill_on_drop(true);
    hide_tokio_window(&mut cmd);

    let output = timeout(Duration::from_secs(5), cmd.output())
        .await
        .map_err(|_| Error::Other("读取 Claude CLI 版本超时".into()))??;
    if !output.status.success() {
        return Err(Error::Other(format!(
            "读取 Claude CLI 版本失败：exit {}，stderr: {}",
            output
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string()),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }

    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| Error::Other("Claude CLI 没有输出版本号".into()))?
        .to_string();
    let supported = version_at_least(&version, MIN_SUPPORTED_CLAUDE_CLI_VERSION)
        .ok_or_else(|| Error::Other(format!("无法解析 Claude CLI 版本号：{version}")))?;

    Ok(ClaudeCliVersionInfo {
        path: path.display().to_string(),
        version,
        min_supported_version: MIN_SUPPORTED_CLAUDE_CLI_VERSION.into(),
        supported,
        update_command: CLAUDE_UPDATE_COMMAND.into(),
        docs_url: CLAUDE_CLI_REFERENCE_URL.into(),
    })
}

#[tauri::command]
pub async fn spawn_session(
    app: AppHandle,
    manager: State<'_, Manager>,
    permission_bridge: State<'_, PermissionMcpBridge>,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    resume_session_id: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    permission_mcp_enabled: Option<bool>,
    permission_prompt_tool: Option<String>,
    mcp_config: Option<String>,
    collab_mcp_enabled: Option<bool>,
    collab_provider_paths: Option<std::collections::HashMap<String, String>>,
    collab_enabled_providers: Option<Vec<String>>,
) -> Result<String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let mut env = env.unwrap_or_default();
    let env_remove = Vec::new();
    let mut use_runtime_claude_settings = false;
    if let Some(proxy_config) = take_proxy_config(&mut env, effort.as_deref()) {
        let local_base_url = start_api_proxy(proxy_config).await?;
        env.insert("ANTHROPIC_BASE_URL".into(), local_base_url);
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), "claudinal-proxy".into());
        env.remove("ANTHROPIC_API_KEY");
        use_runtime_claude_settings = true;
    }
    bridge_socks_proxy_env(&mut env).await?;
    if let Some(model) = model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let is_claude_builtin = model == "default"
            || model == "best"
            || model == "sonnet"
            || model == "opus"
            || model == "haiku"
            || model == "opusplan"
            || model == "sonnet[1m]"
            || model == "opus[1m]"
            || model.starts_with("claude-")
            || model.starts_with("anthropic.");
        if !is_claude_builtin {
            env.entry("ANTHROPIC_CUSTOM_MODEL_OPTION".into())
                .or_insert_with(|| model.to_string());
            env.entry("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".into())
                .or_insert_with(|| model.to_string());
            env.entry("ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION".into())
                .or_insert_with(|| "Third-party API primary model".to_string());
            env.entry("ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES".into())
                .or_insert_with(|| {
                    "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking"
                        .to_string()
                });
        }
    }
    let settings_json = if use_runtime_claude_settings {
        runtime_claude_settings_json(&env)?
    } else {
        None
    };
    let (permission_prompt_tool, permission_mcp_config) = if permission_mcp_enabled.unwrap_or(false)
    {
        env.extend(permission_bridge.env(app.clone()).await?);
        let tool = permission_prompt_tool
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_PERMISSION_MCP_TOOL)
            .to_string();
        let config = render_default_mcp_config(mcp_config.as_deref())?;
        (Some(tool), Some(serde_json::from_str::<Value>(&config)?))
    } else {
        (None, None)
    };
    let mut merged_mcp_config = load_native_mcp_config(&cwd)?;
    if let Some(config) = permission_mcp_config {
        merge_mcp_config(&mut merged_mcp_config, config);
    }
    if collab_mcp_enabled.unwrap_or(false) {
        env.insert("CLAUDINAL_COLLAB_ENABLED".into(), "1".into());
        if let Some(paths) = collab_provider_paths {
            env.insert(
                "CLAUDINAL_COLLAB_PROVIDER_PATHS".into(),
                serde_json::to_string(&paths)?,
            );
        }
        if let Some(providers) = collab_enabled_providers {
            env.insert(
                "CLAUDINAL_COLLAB_ENABLED_PROVIDERS".into(),
                serde_json::to_string(&providers)?,
            );
        }
        merge_mcp_config(
            &mut merged_mcp_config,
            crate::collab::render_default_mcp_config()?,
        );
    }
    let mcp_config = merged_mcp_config
        .and_then(runtime_mcp_config)
        .map(|config| write_runtime_mcp_config_file(&config))
        .transpose()?;
    let opts = SpawnOptions {
        cwd: cwd.into(),
        model,
        effort,
        permission_mode,
        resume_session_id,
        env: if env.is_empty() { None } else { Some(env) },
        env_remove,
        permission_prompt_tool,
        mcp_config,
        settings_json,
    };
    manager.spawn(app, opts).await
}

fn version_at_least(version: &str, min_version: &str) -> Option<bool> {
    let current = parse_semver_prefix(version)?;
    let minimum = parse_semver_prefix(min_version)?;
    Some(current >= minimum)
}

fn parse_semver_prefix(version: &str) -> Option<(u64, u64, u64)> {
    let token = version.split_whitespace().next()?.trim_start_matches('v');
    let mut parts = token.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch_raw = parts.next()?;
    let patch = patch_raw
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    Some((major, minor, patch))
}

fn read_json_file_if_exists(path: &std::path::Path) -> Result<Option<Value>> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(&raw)?;
    Ok(Some(value))
}

fn load_native_mcp_config(cwd: &str) -> Result<Option<Value>> {
    let mut merged = None;
    let global_path = claude_mcp_path("global", None)?;
    if let Some(config) = read_json_file_if_exists(&global_path)? {
        merge_mcp_config(&mut merged, config);
    }
    let project_path = claude_mcp_path("project", Some(cwd))?;
    if let Some(config) = read_json_file_if_exists(&project_path)? {
        merge_mcp_config(&mut merged, config);
    }
    Ok(merged)
}

fn merge_mcp_config(target: &mut Option<Value>, source: Value) {
    if target.is_none() {
        *target = Some(Value::Object(Map::new()));
    }
    let Some(target_value) = target.as_mut() else {
        return;
    };
    if !target_value.is_object() {
        *target_value = Value::Object(Map::new());
    }
    let Some(target_obj) = target_value.as_object_mut() else {
        return;
    };
    let Value::Object(source_obj) = source else {
        return;
    };

    for (key, value) in source_obj {
        if key != "mcpServers" {
            target_obj.insert(key, value);
            continue;
        }
        let Value::Object(source_servers) = value else {
            continue;
        };
        let target_servers = target_obj
            .entry("mcpServers")
            .or_insert_with(|| Value::Object(Map::new()));
        if !target_servers.is_object() {
            *target_servers = Value::Object(Map::new());
        }
        if let Some(target_servers) = target_servers.as_object_mut() {
            for (name, config) in source_servers {
                target_servers.insert(name, config);
            }
        }
    }
}

fn runtime_mcp_config(mut config: Value) -> Option<Value> {
    let servers = config.get_mut("mcpServers")?.as_object_mut()?;
    servers.retain(|_, server| {
        server
            .get("disabled")
            .and_then(Value::as_bool)
            .is_some_and(|disabled| disabled)
            == false
    });
    if servers.is_empty() {
        return None;
    }
    Some(config)
}

fn write_runtime_mcp_config_file(config: &Value) -> Result<String> {
    let dir = std::env::temp_dir().join("claudinal");
    std::fs::create_dir_all(&dir).map_err(Error::from)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| Error::Other(format!("system clock before UNIX_EPOCH: {e}")))?
        .as_millis();
    let path = dir.join(format!("mcp-config-{}-{stamp}.json", std::process::id()));
    let text = serde_json::to_string_pretty(config)?;
    std::fs::write(&path, text).map_err(Error::from)?;
    Ok(path.display().to_string())
}

const RUNTIME_CLAUDE_SETTINGS_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
];

fn runtime_claude_settings_json(
    env: &std::collections::HashMap<String, String>,
) -> Result<Option<String>> {
    let mut runtime_env = std::collections::BTreeMap::new();
    for key in RUNTIME_CLAUDE_SETTINGS_ENV_KEYS {
        let Some(value) = env.get(*key) else {
            continue;
        };
        if value.trim().is_empty() {
            continue;
        }
        runtime_env.insert(*key, value.clone());
    }
    if runtime_env.is_empty() {
        return Ok(None);
    }
    let settings = serde_json::json!({ "env": runtime_env });
    serde_json::to_string(&settings)
        .map(Some)
        .map_err(Error::from)
}

fn take_proxy_config(
    env: &mut std::collections::HashMap<String, String>,
    effort: Option<&str>,
) -> Option<ProxyConfig> {
    let target_url = env.remove("CLAUDINAL_PROXY_TARGET_URL")?;
    let api_key = env.remove("CLAUDINAL_PROXY_API_KEY").unwrap_or_default();
    let input_format = env
        .remove("CLAUDINAL_PROXY_INPUT_FORMAT")
        .unwrap_or_else(|| "anthropic".into());
    let auth_field = env
        .remove("CLAUDINAL_PROXY_AUTH_FIELD")
        .unwrap_or_else(|| "ANTHROPIC_AUTH_TOKEN".into());
    let use_full_url = env
        .remove("CLAUDINAL_PROXY_USE_FULL_URL")
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
    let openai_reasoning_effort = env
        .remove("CLAUDINAL_PROXY_OPENAI_REASONING_EFFORT")
        .or_else(|| effort.map(str::to_string))
        .unwrap_or_default();
    let network_proxy_url = session_network_proxy_url(env).unwrap_or_default();
    let network_no_proxy = env
        .get("NO_PROXY")
        .or_else(|| env.get("no_proxy"))
        .cloned()
        .unwrap_or_default();
    let main_model = env.remove("CLAUDINAL_PROXY_MAIN_MODEL").unwrap_or_default();
    let haiku_model = env
        .remove("CLAUDINAL_PROXY_HAIKU_MODEL")
        .unwrap_or_default();
    let sonnet_model = env
        .remove("CLAUDINAL_PROXY_SONNET_MODEL")
        .unwrap_or_default();
    let opus_model = env.remove("CLAUDINAL_PROXY_OPUS_MODEL").unwrap_or_default();
    let available_models = env
        .remove("CLAUDINAL_PROXY_AVAILABLE_MODELS")
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .collect();
    Some(ProxyConfig {
        target_url,
        api_key,
        input_format,
        auth_field,
        use_full_url,
        openai_reasoning_effort,
        network_proxy_url,
        network_no_proxy,
        main_model,
        haiku_model,
        sonnet_model,
        opus_model,
        available_models,
    })
}

fn session_network_proxy_url(env: &std::collections::HashMap<String, String>) -> Option<String> {
    [
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ]
    .iter()
    .filter_map(|key| env.get(*key))
    .map(|value| value.trim())
    .find(|value| !value.is_empty())
    .map(str::to_string)
}

async fn bridge_socks_proxy_env(env: &mut std::collections::HashMap<String, String>) -> Result<()> {
    let proxy_url = [
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ]
    .iter()
    .find_map(|key| env.get(*key).map(String::as_str))
    .filter(|url| crate::network_proxy::is_socks_proxy_url(url))
    .map(str::to_string);

    let Some(proxy_url) = proxy_url else {
        return Ok(());
    };

    let local_proxy = crate::network_proxy::start_http_connect_bridge(&proxy_url).await?;
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        env.insert(key.into(), local_proxy.clone());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResolution {
    session_id: String,
    request_id: String,
    transport: Option<String>,
    response: Value,
}

#[tauri::command]
pub async fn resolve_permission_request(
    manager: State<'_, Manager>,
    permission_bridge: State<'_, PermissionMcpBridge>,
    resolution: PermissionResolution,
) -> Result<()> {
    if resolution.transport.as_deref() == Some("mcp") {
        return permission_bridge
            .resolve(&resolution.request_id, resolution.response)
            .await;
    }
    manager
        .resolve_control_request(
            &resolution.session_id,
            &resolution.request_id,
            resolution.response,
        )
        .await
}

#[tauri::command]
pub async fn send_user_message(
    manager: State<'_, Manager>,
    session_id: String,
    content_blocks: Value,
) -> Result<()> {
    manager.send(&session_id, content_blocks).await
}

#[tauri::command]
pub async fn stop_session(manager: State<'_, Manager>, session_id: String) -> Result<()> {
    manager.stop(&session_id).await
}

#[tauri::command]
pub async fn create_dir(path: String) -> Result<()> {
    let p = std::path::PathBuf::from(&path);
    std::fs::create_dir_all(&p).map_err(Error::from)
}

#[tauri::command]
pub async fn path_exists(path: String) -> Result<bool> {
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
pub async fn default_workspace_root() -> Result<String> {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    Ok(home.join("claude-projects").display().to_string())
}

#[derive(Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntryInfo>> {
    let p = std::path::Path::new(&path);
    if !p.is_dir() {
        return Err(Error::Other(format!("not a directory: {path}")));
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(p)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(DirEntryInfo {
            name,
            path: entry.path().display().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
pub async fn list_project_sessions(cwd: String) -> Result<Vec<SessionMeta>> {
    list_sessions_inner(&cwd)
}

#[tauri::command]
pub async fn list_recent_sessions_all(limit: Option<usize>) -> Result<Vec<GlobalSessionMeta>> {
    list_all_inner(limit.unwrap_or(50))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changed_files: u32,
    pub additions: u32,
    pub deletions: u32,
    pub files: Vec<GitFileChange>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeFileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    pub is_repo: bool,
    pub files: Vec<WorktreeFileDiff>,
    pub patch_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshotStart {
    pub id: String,
    pub cwd: String,
    pub file_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPathResult {
    pub action: String,
    pub path: String,
    pub fallback_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewSnapshotManifest {
    cwd: String,
    files: Vec<ReviewSnapshotFile>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReviewSnapshotFile {
    path: String,
    size: u64,
    modified_ms: u128,
    hash: u64,
    binary: bool,
    baseline_path: Option<String>,
}

struct ReviewCurrentFile {
    size: u64,
    hash: u64,
    binary: bool,
    content: Option<String>,
}

struct ReviewSnapshotChange {
    path: String,
    status: String,
    before: Option<ReviewSnapshotFile>,
    after: Option<ReviewCurrentFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCliStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub authenticated: bool,
    pub user: Option<String>,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub name: String,
    pub current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchList {
    pub is_repo: bool,
    pub current: Option<String>,
    pub branches: Vec<GitBranchInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeInfo {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    pub current: bool,
    pub exists: bool,
    pub changed_files: Option<u32>,
    pub status_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeList {
    pub is_repo: bool,
    pub current_root: Option<String>,
    pub worktrees: Vec<GitWorktreeInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCreateWorktreeRequest {
    pub cwd: String,
    pub path: String,
    pub branch: String,
    pub base: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCreateWorktreeResult {
    pub path: String,
    pub branch: String,
}

fn git_worktree_status_inner(cwd: String) -> Result<GitWorktreeStatus> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    if !command_success(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "rev-parse",
        "--is-inside-work-tree",
    ])) {
        return Ok(GitWorktreeStatus {
            is_repo: false,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            changed_files: 0,
            additions: 0,
            deletions: 0,
            files: vec![],
        });
    }

    let branch = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "branch",
        "--show-current",
    ]))?
    .trim()
    .to_string();
    let branch = if branch.is_empty() {
        command_stdout(std::process::Command::new("git").args([
            "-C",
            &cwd,
            "rev-parse",
            "--short",
            "HEAD",
        ]))
        .ok()
        .map(|s| format!("detached:{}", s.trim()))
    } else {
        Some(branch)
    };

    let upstream = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}",
    ]))
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());

    let (behind, ahead) = if upstream.is_some() {
        command_stdout(std::process::Command::new("git").args([
            "-C",
            &cwd,
            "rev-list",
            "--left-right",
            "--count",
            "@{u}...HEAD",
        ]))
        .ok()
        .and_then(|s| {
            let mut parts = s.split_whitespace();
            let behind = parts.next()?.parse::<u32>().ok()?;
            let ahead = parts.next()?.parse::<u32>().ok()?;
            Some((behind, ahead))
        })
        .unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    let numstat_raw = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "diff",
        "--numstat",
        "HEAD",
        "--",
    ]))
    .unwrap_or_default();
    let numstat = parse_git_numstat(&numstat_raw);
    let status_raw = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "status",
        "--porcelain=v1",
        "-z",
    ]))?;
    let mut files = Vec::new();
    let mut entries = status_raw.split('\0').filter(|s| !s.is_empty()).peekable();
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let status = entry[..2].trim().to_string();
        let path = entry[3..].to_string();
        if status.starts_with('R') || status.starts_with('C') {
            let _ = entries.next();
        }
        let (additions, deletions) = numstat.get(&path).copied().unwrap_or((0, 0));
        files.push(GitFileChange {
            path,
            status,
            additions,
            deletions,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let additions = files.iter().map(|f| f.additions).sum();
    let deletions = files.iter().map(|f| f.deletions).sum();

    Ok(GitWorktreeStatus {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        changed_files: files.len() as u32,
        additions,
        deletions,
        files,
    })
}

#[tauri::command]
pub async fn git_worktree_status(cwd: String) -> Result<GitWorktreeStatus> {
    git_worktree_status_inner(cwd)
}

#[tauri::command]
pub async fn worktree_diff(cwd: String) -> Result<WorktreeDiff> {
    let root = std::path::Path::new(&cwd);
    if !root.is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    if !command_success(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "rev-parse",
        "--is-inside-work-tree",
    ])) {
        return Ok(WorktreeDiff {
            is_repo: false,
            files: vec![],
            patch_error: None,
        });
    }

    let status_raw = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
    ]))?;
    let statuses = parse_git_status_z(&status_raw);

    let patch_raw = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "-c",
        "core.quotePath=false",
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--unified=80",
        "HEAD",
        "--",
    ]))?;
    let numstat_raw = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "-c",
        "core.quotePath=false",
        "diff",
        "--numstat",
        "HEAD",
        "--",
    ]))?;
    let numstat = parse_git_numstat(&numstat_raw);

    let mut files = parse_git_patch(&patch_raw);
    let mut index = std::collections::HashMap::new();
    for (idx, file) in files.iter().enumerate() {
        index.insert(file.path.clone(), idx);
    }

    for status in statuses {
        if let Some(idx) = index.get(&status.path).copied() {
            let file = &mut files[idx];
            file.status = status.status;
            file.old_path = status.old_path.or_else(|| file.old_path.clone());
            if let Some((additions, deletions)) = numstat.get(&file.path).copied() {
                file.additions = additions;
                file.deletions = deletions;
            }
            continue;
        }

        if status.status == "??" {
            if let Some(file) = untracked_file_diff(root, &status.path) {
                index.insert(file.path.clone(), files.len());
                files.push(file);
            }
        }
    }

    for file in &mut files {
        if let Some((additions, deletions)) = numstat.get(&file.path).copied() {
            file.additions = additions;
            file.deletions = deletions;
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(WorktreeDiff {
        is_repo: true,
        files,
        patch_error: None,
    })
}

#[tauri::command]
pub async fn review_snapshot_start(cwd: String) -> Result<ReviewSnapshotStart> {
    let root = std::path::PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = review_snapshot_dir(&id)?;
    std::fs::create_dir_all(dir.join("files")).map_err(Error::from)?;
    let mut records = Vec::new();
    scan_review_baseline(&root, &root, &dir, &mut records)?;
    records.sort_by(|a, b| a.path.cmp(&b.path));
    let manifest = ReviewSnapshotManifest {
        cwd: root.display().to_string(),
        files: records,
    };
    let manifest_text = serde_json::to_string_pretty(&manifest)?;
    atomic_write_str(&dir.join("manifest.json"), &manifest_text)?;
    Ok(ReviewSnapshotStart {
        id,
        cwd: manifest.cwd,
        file_count: manifest.files.len(),
    })
}

#[tauri::command]
pub async fn review_snapshot_finish(id: String) -> Result<WorktreeDiff> {
    let dir = review_snapshot_dir(&id)?;
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(Error::Other(format!("review snapshot not found: {id}")));
    }
    let raw = std::fs::read_to_string(&manifest_path).map_err(Error::from)?;
    let manifest: ReviewSnapshotManifest = serde_json::from_str(&raw)?;
    let root = std::path::PathBuf::from(&manifest.cwd);
    if !root.is_dir() {
        return Err(Error::Other(format!(
            "snapshot cwd no longer exists: {}",
            manifest.cwd
        )));
    }

    let mut current = std::collections::HashMap::new();
    scan_review_current(&root, &root, &mut current)?;
    let changes = classify_review_snapshot_changes(manifest.files, current);
    let (files, mut patch_error) = review_snapshot_changes_to_diff(&dir, &changes);
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        record_patch_error(
            &mut patch_error,
            format!("清理审查快照临时目录失败: {}: {e}", dir.display()),
        );
    }
    Ok(WorktreeDiff {
        is_repo: false,
        files,
        patch_error,
    })
}

fn review_snapshot_root() -> std::path::PathBuf {
    std::env::temp_dir().join("claudinal-review-snapshots")
}

fn review_snapshot_dir(id: &str) -> Result<std::path::PathBuf> {
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        return Err(Error::Other(format!("invalid review snapshot id: {id}")));
    }
    Ok(review_snapshot_root().join(id))
}

fn scan_review_baseline(
    root: &std::path::Path,
    dir: &std::path::Path,
    snapshot_dir: &std::path::Path,
    records: &mut Vec<ReviewSnapshotFile>,
) -> Result<()> {
    if same_path(root, dir) {
        if let Some(paths) = review_git_candidate_paths(root)? {
            for path in paths {
                scan_review_baseline_file(root, &path, snapshot_dir, records)?;
            }
            return Ok(());
        }
    }
    for entry in std::fs::read_dir(dir).map_err(Error::from)? {
        let entry = entry.map_err(Error::from)?;
        let path = entry.path();
        let file_name = entry.file_name();
        if should_skip_review_path(&file_name.to_string_lossy()) {
            continue;
        }
        let meta = entry.metadata().map_err(Error::from)?;
        if meta.is_dir() {
            scan_review_baseline(root, &path, snapshot_dir, records)?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        scan_review_baseline_file(root, &path, snapshot_dir, records)?;
    }
    Ok(())
}

fn scan_review_baseline_file(
    root: &std::path::Path,
    path: &std::path::Path,
    snapshot_dir: &std::path::Path,
    records: &mut Vec<ReviewSnapshotFile>,
) -> Result<()> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(Error::from(err)),
    };
    if !meta.is_file() {
        return Ok(());
    }
    let rel = review_rel_path(root, path)?;
    let bytes = std::fs::read(path).map_err(Error::from)?;
    let binary = review_is_binary(&bytes);
    let hash = review_hash(&bytes);
    let baseline_path = if binary {
        None
    } else {
        let rel_baseline = format!("files/{}.txt", records.len());
        let target = snapshot_dir.join(&rel_baseline);
        std::fs::write(&target, &bytes).map_err(Error::from)?;
        Some(rel_baseline)
    };
    records.push(ReviewSnapshotFile {
        path: rel,
        size: meta.len(),
        modified_ms: review_modified_ms(&meta)?,
        hash,
        binary,
        baseline_path,
    });
    Ok(())
}

fn scan_review_current(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut std::collections::HashMap<String, ReviewCurrentFile>,
) -> Result<()> {
    if same_path(root, dir) {
        if let Some(paths) = review_git_candidate_paths(root)? {
            for path in paths {
                scan_review_current_file(root, &path, out)?;
            }
            return Ok(());
        }
    }
    for entry in std::fs::read_dir(dir).map_err(Error::from)? {
        let entry = entry.map_err(Error::from)?;
        let path = entry.path();
        let file_name = entry.file_name();
        if should_skip_review_path(&file_name.to_string_lossy()) {
            continue;
        }
        let meta = entry.metadata().map_err(Error::from)?;
        if meta.is_dir() {
            scan_review_current(root, &path, out)?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        scan_review_current_file(root, &path, out)?;
    }
    Ok(())
}

fn scan_review_current_file(
    root: &std::path::Path,
    path: &std::path::Path,
    out: &mut std::collections::HashMap<String, ReviewCurrentFile>,
) -> Result<()> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(Error::from(err)),
    };
    if !meta.is_file() {
        return Ok(());
    }
    let bytes = std::fs::read(path).map_err(Error::from)?;
    let binary = review_is_binary(&bytes);
    let content = if binary {
        None
    } else {
        Some(String::from_utf8(bytes.clone()).map_err(|e| {
            Error::Other(format!(
                "current file utf-8 decode failed: {}: {e}",
                path.display()
            ))
        })?)
    };
    out.insert(
        review_rel_path(root, path)?,
        ReviewCurrentFile {
            size: meta.len(),
            hash: review_hash(&bytes),
            binary,
            content,
        },
    );
    Ok(())
}

fn review_git_candidate_paths(root: &std::path::Path) -> Result<Option<Vec<std::path::PathBuf>>> {
    if which::which("git").is_err() {
        return Ok(None);
    }
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args(["ls-files", "-co", "--exclude-standard", "-z", "--", "."])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_std_window(&mut cmd);
    let output = cmd.output().map_err(Error::from)?;
    if !output.status.success() {
        return Ok(None);
    }

    let mut paths = Vec::new();
    for raw in output.stdout.split(|byte| *byte == 0) {
        if raw.is_empty() {
            continue;
        }
        let rel = std::path::PathBuf::from(String::from_utf8_lossy(raw).to_string());
        if !review_is_safe_relative_path(&rel) {
            continue;
        }
        if rel.components().any(|component| {
            component
                .as_os_str()
                .to_str()
                .is_some_and(should_skip_review_path)
        }) {
            continue;
        }
        paths.push(root.join(rel));
    }
    Ok(Some(paths))
}

fn review_is_safe_relative_path(path: &std::path::Path) -> bool {
    path.components().all(|component| {
        matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    })
}

fn classify_review_snapshot_changes(
    before: Vec<ReviewSnapshotFile>,
    mut after: std::collections::HashMap<String, ReviewCurrentFile>,
) -> Vec<ReviewSnapshotChange> {
    let mut changes = Vec::new();
    for file in before {
        match after.remove(&file.path) {
            Some(current) => {
                if file.hash != current.hash || file.size != current.size {
                    changes.push(ReviewSnapshotChange {
                        path: file.path.clone(),
                        status: "M".into(),
                        before: Some(file),
                        after: Some(current),
                    });
                }
            }
            None => changes.push(ReviewSnapshotChange {
                path: file.path.clone(),
                status: "D".into(),
                before: Some(file),
                after: None,
            }),
        }
    }
    for (path, current) in after {
        changes.push(ReviewSnapshotChange {
            path,
            status: "A".into(),
            before: None,
            after: Some(current),
        });
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    changes
}

fn review_snapshot_changes_to_diff(
    snapshot_dir: &std::path::Path,
    changes: &[ReviewSnapshotChange],
) -> (Vec<WorktreeFileDiff>, Option<String>) {
    if changes.is_empty() {
        return (Vec::new(), None);
    }

    let git_available = which::which("git").is_ok();
    let mut patch_error = if git_available {
        None
    } else {
        Some("未找到 git，无法为无仓库本地文件生成 no-index patch。".to_string())
    };
    let empty = snapshot_dir.join("empty");
    let can_use_git_diff = if git_available {
        match std::fs::write(&empty, b"") {
            Ok(()) => true,
            Err(e) => {
                record_patch_error(
                    &mut patch_error,
                    format!("创建 no-index 空文件失败: {}: {e}", empty.display()),
                );
                false
            }
        }
    } else {
        false
    };

    let mut files = Vec::new();
    for change in changes {
        let binary = change.before.as_ref().is_some_and(|f| f.binary)
            || change.after.as_ref().is_some_and(|f| f.binary);
        if binary || !can_use_git_diff {
            push_review_fallback_file_diff(
                &mut files,
                &mut patch_error,
                snapshot_dir,
                change,
                binary,
            );
            continue;
        }

        let (old_path, new_path, current_tmp) =
            match review_no_index_paths(snapshot_dir, change, &empty) {
                Ok(paths) => paths,
                Err(e) => {
                    record_patch_error(&mut patch_error, e);
                    push_review_fallback_file_diff(
                        &mut files,
                        &mut patch_error,
                        snapshot_dir,
                        change,
                        false,
                    );
                    continue;
                }
            };
        match command_git_no_index_diff(&old_path, &new_path) {
            Ok(raw) => {
                let mut parsed = parse_git_patch(&raw);
                if let Some(mut file) = parsed.pop() {
                    file.path = change.path.clone();
                    file.old_path = None;
                    file.status = change.status.clone();
                    files.push(file);
                } else {
                    record_patch_error(
                        &mut patch_error,
                        format!("git diff --no-index 未返回可解析 patch: {}", change.path),
                    );
                    push_review_fallback_file_diff(
                        &mut files,
                        &mut patch_error,
                        snapshot_dir,
                        change,
                        false,
                    );
                }
            }
            Err(e) => {
                record_patch_error(&mut patch_error, e);
                push_review_fallback_file_diff(
                    &mut files,
                    &mut patch_error,
                    snapshot_dir,
                    change,
                    false,
                );
            }
        }
        if let Some(path) = current_tmp {
            if let Err(e) = std::fs::remove_file(&path) {
                record_patch_error(
                    &mut patch_error,
                    format!(
                        "清理 no-index 当前文件临时副本失败: {}: {e}",
                        path.display()
                    ),
                );
            }
        }
    }
    (files, patch_error)
}

fn record_patch_error(slot: &mut Option<String>, message: String) {
    if slot.is_none() {
        *slot = Some(message);
    }
}

fn review_no_index_paths(
    snapshot_dir: &std::path::Path,
    change: &ReviewSnapshotChange,
    empty: &std::path::Path,
) -> std::result::Result<
    (
        std::path::PathBuf,
        std::path::PathBuf,
        Option<std::path::PathBuf>,
    ),
    String,
> {
    let old_path = change
        .before
        .as_ref()
        .and_then(|before| before.baseline_path.as_ref())
        .map(|rel| snapshot_dir.join(rel))
        .unwrap_or_else(|| empty.to_path_buf());

    let new_path = if let Some(after) = change.after.as_ref() {
        let content = after.content.as_ref().ok_or_else(|| {
            format!(
                "当前文件没有可生成 no-index patch 的文本内容: {}",
                change.path
            )
        })?;
        let tmp = snapshot_dir
            .join("files")
            .join(format!("current-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, content.as_bytes())
            .map_err(|e| format!("写入 no-index 当前文件临时副本失败: {}: {e}", tmp.display()))?;
        return Ok((old_path, tmp.clone(), Some(tmp)));
    } else {
        empty.to_path_buf()
    };
    Ok((old_path, new_path, None))
}

fn push_review_fallback_file_diff(
    files: &mut Vec<WorktreeFileDiff>,
    patch_error: &mut Option<String>,
    snapshot_dir: &std::path::Path,
    change: &ReviewSnapshotChange,
    binary: bool,
) {
    match review_fallback_file_diff(snapshot_dir, change, binary) {
        Ok(file) => files.push(file),
        Err(e) => {
            record_patch_error(patch_error, e);
            files.push(review_file_list_only_diff(change, binary));
        }
    }
}

fn review_file_list_only_diff(change: &ReviewSnapshotChange, binary: bool) -> WorktreeFileDiff {
    WorktreeFileDiff {
        path: change.path.clone(),
        old_path: None,
        status: change.status.clone(),
        additions: 0,
        deletions: 0,
        binary,
        hunks: Vec::new(),
    }
}

fn review_fallback_file_diff(
    snapshot_dir: &std::path::Path,
    change: &ReviewSnapshotChange,
    binary: bool,
) -> std::result::Result<WorktreeFileDiff, String> {
    let (additions, deletions, hunks) = if binary {
        (0, 0, Vec::new())
    } else {
        review_full_file_hunks(snapshot_dir, change)?
    };
    Ok(WorktreeFileDiff {
        path: change.path.clone(),
        old_path: None,
        status: change.status.clone(),
        additions,
        deletions,
        binary,
        hunks,
    })
}

fn review_full_file_hunks(
    snapshot_dir: &std::path::Path,
    change: &ReviewSnapshotChange,
) -> std::result::Result<(u32, u32, Vec<DiffHunk>), String> {
    match (&change.before, &change.after) {
        (None, Some(after)) => {
            let Some(content) = after.content.as_ref() else {
                return Ok((0, 0, Vec::new()));
            };
            let lines = text_lines(content);
            let additions = lines.len() as u32;
            let hunks = if additions == 0 {
                Vec::new()
            } else {
                vec![DiffHunk {
                    old_start: 0,
                    old_lines: 0,
                    new_start: 1,
                    new_lines: additions,
                    lines: lines.into_iter().map(|line| format!("+{line}")).collect(),
                }]
            };
            Ok((additions, 0, hunks))
        }
        (Some(before), None) => {
            let Some(baseline) = before.baseline_path.as_ref() else {
                return Ok((0, 0, Vec::new()));
            };
            let path = snapshot_dir.join(baseline);
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("读取审查基线文本失败: {}: {e}", path.display()))?;
            let lines = text_lines(&content);
            let deletions = lines.len() as u32;
            let hunks = if deletions == 0 {
                Vec::new()
            } else {
                vec![DiffHunk {
                    old_start: 1,
                    old_lines: deletions,
                    new_start: 0,
                    new_lines: 0,
                    lines: lines.into_iter().map(|line| format!("-{line}")).collect(),
                }]
            };
            Ok((0, deletions, hunks))
        }
        (Some(before), Some(after)) => {
            let Some(baseline) = before.baseline_path.as_ref() else {
                return Ok((0, 0, Vec::new()));
            };
            let Some(after_content) = after.content.as_ref() else {
                return Ok((0, 0, Vec::new()));
            };
            let baseline_path = snapshot_dir.join(baseline);
            let before_content = std::fs::read_to_string(&baseline_path)
                .map_err(|e| format!("读取审查基线文本失败: {}: {e}", baseline_path.display()))?;
            let before_lines = text_lines(&before_content);
            let after_lines = text_lines(after_content);
            let deletions = before_lines.len() as u32;
            let additions = after_lines.len() as u32;
            let lines = before_lines
                .into_iter()
                .map(|line| format!("-{line}"))
                .chain(after_lines.into_iter().map(|line| format!("+{line}")))
                .collect::<Vec<_>>();
            let hunks = if lines.is_empty() {
                Vec::new()
            } else {
                vec![DiffHunk {
                    old_start: 1,
                    old_lines: deletions,
                    new_start: 1,
                    new_lines: additions,
                    lines,
                }]
            };
            Ok((additions, deletions, hunks))
        }
        (None, None) => Ok((0, 0, Vec::new())),
    }
}

fn command_git_no_index_diff(
    old_path: &std::path::Path,
    new_path: &std::path::Path,
) -> std::result::Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args([
        "diff",
        "--no-index",
        "--patch",
        "--no-color",
        "--unified=80",
    ]);
    cmd.arg(old_path);
    cmd.arg(new_path);
    hide_std_window(&mut cmd);
    let out = cmd.output().map_err(|e| e.to_string())?;
    let code = out.status.code().unwrap_or(2);
    if code == 0 || code == 1 {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn review_rel_path(root: &std::path::Path, path: &std::path::Path) -> Result<String> {
    let rel = path
        .strip_prefix(root)
        .map_err(|e| Error::Other(format!("path outside review root: {}: {e}", path.display())))?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn review_modified_ms(meta: &std::fs::Metadata) -> Result<u128> {
    let modified = meta.modified().map_err(Error::from)?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| {
            Error::Other(format!(
                "file modified time is before unix epoch and cannot be snapshotted: {e}"
            ))
        })?;
    Ok(duration.as_millis())
}

fn review_hash(bytes: &[u8]) -> u64 {
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(bytes);
    hasher.finish()
}

fn review_is_binary(bytes: &[u8]) -> bool {
    bytes.iter().any(|b| *b == 0) || std::str::from_utf8(bytes).is_err()
}

fn should_skip_review_path(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "dist" | "target" | ".cache" | ".next" | "coverage" | "release"
    )
}

#[tauri::command]
pub async fn git_branch_list(cwd: String) -> Result<GitBranchList> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    if !command_success(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "rev-parse",
        "--is-inside-work-tree",
    ])) {
        return Ok(GitBranchList {
            is_repo: false,
            current: None,
            branches: vec![],
        });
    }
    let current = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "branch",
        "--show-current",
    ]))
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());
    let raw = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
    ]))?;
    let mut branches = raw
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| GitBranchInfo {
            name: name.to_string(),
            current: current.as_deref() == Some(name),
        })
        .collect::<Vec<_>>();
    branches.sort_by(|a, b| match (a.current, b.current) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(GitBranchList {
        is_repo: true,
        current,
        branches,
    })
}

#[tauri::command]
pub async fn git_checkout_branch(cwd: String, branch: String, create: Option<bool>) -> Result<()> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let branch = branch.trim();
    validate_git_branch_name(branch)?;
    let mut cmd = std::process::Command::new("git");
    cmd.args(["-C", &cwd, "switch"]);
    if create.unwrap_or(false) {
        cmd.arg("-c");
    }
    cmd.arg(branch);
    command_stdout(&mut cmd).map(|_| ())
}

#[tauri::command]
pub async fn git_worktree_list(cwd: String) -> Result<GitWorktreeList> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    if !command_success(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "rev-parse",
        "--is-inside-work-tree",
    ])) {
        return Ok(GitWorktreeList {
            is_repo: false,
            current_root: None,
            worktrees: vec![],
        });
    }

    let current_root = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "rev-parse",
        "--show-toplevel",
    ]))?
    .trim()
    .to_string();
    let raw = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "worktree",
        "list",
        "--porcelain",
    ]))?;
    let mut worktrees = parse_git_worktree_porcelain(&raw, &current_root);

    for worktree in &mut worktrees {
        if !worktree.exists || worktree.bare {
            continue;
        }
        match git_worktree_status_inner(worktree.path.clone()) {
            Ok(status) => worktree.changed_files = Some(status.changed_files),
            Err(err) => worktree.status_error = Some(err.to_string()),
        }
    }

    Ok(GitWorktreeList {
        is_repo: true,
        current_root: Some(current_root),
        worktrees,
    })
}

#[tauri::command]
pub async fn git_suggest_worktree_path(cwd: String, branch: String) -> Result<String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let current_root = git_root(&cwd)?;
    validate_git_branch_name(branch.trim())?;
    let repo = std::path::Path::new(&current_root)
        .file_name()
        .and_then(|name| name.to_str())
        .map(sanitize_path_component)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "repo".into());
    let token = sanitize_path_component(branch.trim());
    let home =
        dirs::home_dir().ok_or_else(|| Error::Other("cannot resolve home directory".into()))?;
    Ok(home
        .join(".codex")
        .join("worktrees")
        .join(token)
        .join(repo)
        .display()
        .to_string())
}

#[tauri::command]
pub async fn git_create_worktree(req: GitCreateWorktreeRequest) -> Result<GitCreateWorktreeResult> {
    if !std::path::Path::new(&req.cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {}", req.cwd)));
    }
    let _current_root = git_root(&req.cwd)?;
    let branch = req.branch.trim();
    validate_git_branch_name(branch)?;
    let base = req
        .base
        .as_deref()
        .map(str::trim)
        .filter(|base| !base.is_empty())
        .unwrap_or("HEAD");
    validate_git_ref_arg(base, "base ref")?;
    let target = clean_path_arg(&req.path, "worktree path")?;
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(Error::from)?;
        }
    }

    let mut cmd = std::process::Command::new("git");
    cmd.args(["-C", &req.cwd, "worktree", "add", "-b", branch, "--"])
        .arg(&target)
        .arg(base);
    command_stdout(&mut cmd).map(|_| GitCreateWorktreeResult {
        path: target.display().to_string(),
        branch: branch.to_string(),
    })
}

#[tauri::command]
pub async fn git_remove_worktree(cwd: String, path: String) -> Result<()> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let target = clean_path_arg(&path, "worktree path")?;
    let current_root = command_stdout(std::process::Command::new("git").args([
        "-C",
        &cwd,
        "rev-parse",
        "--show-toplevel",
    ]))?
    .trim()
    .to_string();
    if same_path(&target, std::path::Path::new(&current_root)) {
        return Err(Error::Other("cannot remove the current worktree".into()));
    }

    let mut cmd = std::process::Command::new("git");
    cmd.args(["-C", &cwd, "worktree", "remove", "--"])
        .arg(&target);
    command_stdout(&mut cmd).map(|_| ())
}

#[tauri::command]
pub async fn normalize_proxy_url_for_http_client(proxy_url: String) -> Result<String> {
    let proxy_url = proxy_url.trim();
    if proxy_url.is_empty() {
        return Err(Error::Other("proxy url required".into()));
    }
    reqwest::Url::parse(proxy_url).map_err(|e| Error::Other(format!("invalid proxy url: {e}")))?;
    if crate::network_proxy::is_socks_proxy_url(proxy_url) {
        return crate::network_proxy::start_http_connect_bridge(proxy_url).await;
    }
    Ok(proxy_url.to_string())
}

#[tauri::command]
pub async fn github_cli_status(
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<GithubCliStatus> {
    use tokio::process::Command as AsyncCommand;
    use tokio::time::{timeout, Duration};

    let path = match which::which("gh") {
        Ok(path) => path,
        Err(_) => {
            return Ok(GithubCliStatus {
                installed: false,
                path: None,
                version: None,
                authenticated: false,
                user: None,
                message: "未找到 gh CLI".into(),
            })
        }
    };

    // 前端传来的 GUI 代理 env（HTTP_PROXY 等）。socks5 url gh (Go) 不识别，
    // 沿用 spawn_session 同款 bridge_socks_proxy_env 桥接成本地 HTTP CONNECT 代理。
    let mut env = env.unwrap_or_default();
    bridge_socks_proxy_env(&mut env).await?;

    // `gh --version` 是本地查询；`gh auth status` 会向 github.com 验证 token，
    // 离线 / 网络差时会卡很久。两者并行 + 各自加超时，并通过 kill_on_drop 保证
    // 超时后子进程不会留下来。
    let version_path = path.clone();
    let version_env = env.clone();
    let version_fut = async move {
        let mut cmd = AsyncCommand::new(&version_path);
        cmd.arg("--version");
        for (k, v) in &version_env {
            cmd.env(k, v);
        }
        cmd.kill_on_drop(true);
        hide_tokio_window(&mut cmd);
        cmd.output().await.ok()
    };
    let auth_path = path.clone();
    let auth_env = env;
    let auth_fut = async move {
        let mut cmd = AsyncCommand::new(&auth_path);
        cmd.args(["auth", "status"]);
        for (k, v) in &auth_env {
            cmd.env(k, v);
        }
        cmd.kill_on_drop(true);
        hide_tokio_window(&mut cmd);
        cmd.output().await.ok()
    };

    let (version_res, auth_res) = tokio::join!(
        timeout(Duration::from_secs(3), version_fut),
        timeout(Duration::from_secs(6), auth_fut),
    );

    let version = version_res.ok().flatten().and_then(|out| {
        if out.status.success() {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .map(str::to_string)
        } else {
            None
        }
    });

    let auth_timed_out = auth_res.is_err();
    let auth = auth_res.ok().flatten();
    let authenticated = auth.as_ref().is_some_and(|out| out.status.success());
    let auth_text = auth
        .map(|out| {
            let mut s = String::from_utf8_lossy(&out.stdout).to_string();
            s.push_str(&String::from_utf8_lossy(&out.stderr));
            s
        })
        .unwrap_or_default();
    let user = auth_text
        .lines()
        .find_map(|line| line.split(" account ").nth(1))
        .map(|tail| {
            tail.split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches(|c| c == '(' || c == ')' || c == ',')
                .to_string()
        })
        .filter(|s| !s.is_empty());

    let message = if authenticated {
        "GitHub CLI 已认证".into()
    } else if auth_timed_out {
        "认证检测超时".into()
    } else {
        "GitHub CLI 未通过身份验证，请在终端运行 gh auth login".into()
    };

    Ok(GithubCliStatus {
        installed: true,
        path: Some(path.display().to_string()),
        version,
        authenticated,
        user,
        message,
    })
}

fn command_stdout(cmd: &mut std::process::Command) -> Result<String> {
    hide_std_window(cmd);
    let out = cmd.output().map_err(Error::from)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(Error::Other(stderr.trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn command_success(cmd: &mut std::process::Command) -> bool {
    hide_std_window(cmd);
    cmd.output().is_ok_and(|out| out.status.success())
}

fn git_root(cwd: &str) -> Result<String> {
    let inside = command_stdout(std::process::Command::new("git").args([
        "-C",
        cwd,
        "rev-parse",
        "--is-inside-work-tree",
    ]))?;
    if inside.trim() != "true" {
        return Err(Error::Other("current project is not a Git worktree".into()));
    }
    Ok(command_stdout(std::process::Command::new("git").args([
        "-C",
        cwd,
        "rev-parse",
        "--show-toplevel",
    ]))?
    .trim()
    .to_string())
}

fn validate_git_branch_name(branch: &str) -> Result<()> {
    if branch.is_empty()
        || branch.contains('\0')
        || branch.starts_with('-')
        || branch.contains("..")
        || branch.contains('~')
        || branch.contains('^')
        || branch.contains(':')
        || branch.contains('?')
        || branch.contains('*')
        || branch.contains('[')
        || branch.ends_with('/')
        || branch.ends_with(".lock")
    {
        return Err(Error::Other(format!("invalid branch name: {branch}")));
    }
    Ok(())
}

fn validate_git_ref_arg(value: &str, label: &str) -> Result<()> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(Error::Other(format!("{label} required")));
    }
    Ok(())
}

fn sanitize_path_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.chars() {
        let next = if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            last_dash = false;
            Some(ch.to_ascii_lowercase())
        } else if last_dash {
            None
        } else {
            last_dash = true;
            Some('-')
        };
        if let Some(ch) = next {
            out.push(ch);
        }
    }
    let trimmed = out.trim_matches('-').trim_matches('.').to_string();
    if trimmed.is_empty() {
        "worktree".into()
    } else {
        trimmed
    }
}

fn clean_path_arg(path: &str, label: &str) -> Result<std::path::PathBuf> {
    let path = path.trim();
    if path.is_empty() || path.contains('\0') {
        return Err(Error::Other(format!("{label} required")));
    }
    Ok(std::path::PathBuf::from(path))
}

fn path_key(path: &std::path::Path) -> String {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn same_path(left: &std::path::Path, right: &std::path::Path) -> bool {
    path_key(left) == path_key(right)
}

fn parse_git_worktree_porcelain(raw: &str, current_root: &str) -> Vec<GitWorktreeInfo> {
    let mut out = Vec::new();
    let mut current: Option<GitWorktreeInfo> = None;
    let current_root = std::path::Path::new(current_root);

    for line in raw.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(worktree) = current.take() {
                out.push(worktree);
            }
            let path = path.to_string();
            let path_ref = std::path::Path::new(&path);
            current = Some(GitWorktreeInfo {
                current: same_path(path_ref, current_root),
                exists: path_ref.is_dir(),
                path,
                head: None,
                branch: None,
                detached: false,
                bare: false,
                locked: None,
                prunable: None,
                changed_files: None,
                status_error: None,
            });
            continue;
        }

        let Some(worktree) = current.as_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            worktree.head = Some(head.to_string());
        } else if let Some(branch) = line.strip_prefix("branch ") {
            worktree.branch = Some(
                branch
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch)
                    .to_string(),
            );
        } else if line == "detached" {
            worktree.detached = true;
        } else if line == "bare" {
            worktree.bare = true;
        } else if line == "locked" {
            worktree.locked = Some(String::new());
        } else if let Some(reason) = line.strip_prefix("locked ") {
            worktree.locked = Some(reason.to_string());
        } else if line == "prunable" {
            worktree.prunable = Some(String::new());
        } else if let Some(reason) = line.strip_prefix("prunable ") {
            worktree.prunable = Some(reason.to_string());
        }
    }

    if let Some(worktree) = current {
        out.push(worktree);
    }
    out
}

fn parse_git_numstat(raw: &str) -> std::collections::HashMap<String, (u32, u32)> {
    let mut out = std::collections::HashMap::new();
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let additions = parts
            .next()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        let deletions = parts
            .next()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        let Some(path) = parts.next() else {
            continue;
        };
        out.insert(path.to_string(), (additions, deletions));
    }
    out
}

struct GitStatusEntry {
    path: String,
    old_path: Option<String>,
    status: String,
}

fn parse_git_status_z(raw: &str) -> Vec<GitStatusEntry> {
    let mut out = Vec::new();
    let mut entries = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let status = entry[..2].trim().to_string();
        let path = entry[3..].replace('\\', "/");
        let old_path = if status.starts_with('R') || status.starts_with('C') {
            entries.next().map(|s| s.replace('\\', "/"))
        } else {
            None
        };
        out.push(GitStatusEntry {
            path,
            old_path,
            status,
        });
    }
    out
}

fn parse_git_patch(raw: &str) -> Vec<WorktreeFileDiff> {
    let mut files = Vec::new();
    let mut current: Option<WorktreeFileDiff> = None;
    let mut current_hunk: Option<DiffHunk> = None;

    for line in raw.lines() {
        if line.starts_with("diff --git ") {
            push_hunk(&mut current, &mut current_hunk);
            push_file(&mut files, current.take());
            let (old_path, path) = parse_diff_git_header(line);
            current = Some(WorktreeFileDiff {
                path: path.unwrap_or_default(),
                old_path,
                status: "M".into(),
                additions: 0,
                deletions: 0,
                binary: false,
                hunks: Vec::new(),
            });
            continue;
        }

        let Some(file) = current.as_mut() else {
            continue;
        };

        if let Some(path) = line.strip_prefix("--- ") {
            file.old_path = parse_diff_marker_path(path);
            continue;
        }
        if let Some(path) = line.strip_prefix("+++ ") {
            if let Some(path) = parse_diff_marker_path(path) {
                file.path = path;
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("rename from ") {
            file.old_path = Some(path.replace('\\', "/"));
            file.status = "R".into();
            continue;
        }
        if let Some(path) = line.strip_prefix("rename to ") {
            file.path = path.replace('\\', "/");
            file.status = "R".into();
            continue;
        }
        if line == "new file mode" || line.starts_with("new file mode ") {
            file.status = "A".into();
            continue;
        }
        if line == "deleted file mode" || line.starts_with("deleted file mode ") {
            file.status = "D".into();
            continue;
        }
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            file.binary = true;
            continue;
        }
        if line.starts_with("@@ ") {
            push_hunk(&mut current, &mut current_hunk);
            current_hunk = parse_unified_hunk_header(line);
            continue;
        }
        if let Some(hunk) = current_hunk.as_mut() {
            if line.starts_with('+') {
                file.additions += 1;
            } else if line.starts_with('-') {
                file.deletions += 1;
            }
            hunk.lines.push(line.to_string());
        }
    }

    push_hunk(&mut current, &mut current_hunk);
    push_file(&mut files, current);
    files
}

fn push_hunk(file: &mut Option<WorktreeFileDiff>, hunk: &mut Option<DiffHunk>) {
    let Some(hunk) = hunk.take() else {
        return;
    };
    if let Some(file) = file.as_mut() {
        file.hunks.push(hunk);
    }
}

fn push_file(files: &mut Vec<WorktreeFileDiff>, file: Option<WorktreeFileDiff>) {
    let Some(mut file) = file else {
        return;
    };
    if file.path.is_empty() {
        if let Some(old_path) = file.old_path.clone() {
            file.path = old_path;
        }
    }
    if !file.path.is_empty() {
        files.push(file);
    }
}

fn parse_diff_git_header(line: &str) -> (Option<String>, Option<String>) {
    let Some(rest) = line.strip_prefix("diff --git ") else {
        return (None, None);
    };
    let Some(rest) = rest.strip_prefix("a/") else {
        return (None, None);
    };
    let Some(idx) = rest.find(" b/") else {
        return (None, None);
    };
    let old_path = rest[..idx].replace('\\', "/");
    let new_path = rest[idx + 3..].replace('\\', "/");
    (Some(old_path), Some(new_path))
}

fn parse_diff_marker_path(raw: &str) -> Option<String> {
    let path = raw.trim().split('\t').next().unwrap_or("").trim();
    if path == "/dev/null" || path.is_empty() {
        return None;
    }
    let path = path
        .strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path);
    Some(path.replace('\\', "/"))
}

fn parse_unified_hunk_header(line: &str) -> Option<DiffHunk> {
    let header = line.strip_prefix("@@ ")?;
    let end = header.find(" @@")?;
    let mut parts = header[..end].split_whitespace();
    let old = parse_hunk_range(parts.next()?, '-')?;
    let new = parse_hunk_range(parts.next()?, '+')?;
    Some(DiffHunk {
        old_start: old.0,
        old_lines: old.1,
        new_start: new.0,
        new_lines: new.1,
        lines: Vec::new(),
    })
}

fn parse_hunk_range(token: &str, prefix: char) -> Option<(u32, u32)> {
    let raw = token.strip_prefix(prefix)?;
    let mut parts = raw.splitn(2, ',');
    let start = parts.next()?.parse::<u32>().ok()?;
    let lines = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(1);
    Some((start, lines))
}

fn untracked_file_diff(root: &std::path::Path, rel: &str) -> Option<WorktreeFileDiff> {
    let path = safe_workspace_child(root, rel)?;
    if !path.is_file() {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    if bytes.iter().any(|b| *b == 0) {
        return Some(WorktreeFileDiff {
            path: rel.replace('\\', "/"),
            old_path: None,
            status: "??".into(),
            additions: 0,
            deletions: 0,
            binary: true,
            hunks: Vec::new(),
        });
    }
    let content = String::from_utf8(bytes).ok()?;
    let mut lines = text_lines(&content)
        .into_iter()
        .map(|line| format!("+{line}"))
        .collect::<Vec<_>>();
    let additions = lines.len() as u32;
    let hunks = if additions == 0 {
        Vec::new()
    } else {
        vec![DiffHunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: additions,
            lines: std::mem::take(&mut lines),
        }]
    };
    Some(WorktreeFileDiff {
        path: rel.replace('\\', "/"),
        old_path: None,
        status: "??".into(),
        additions,
        deletions: 0,
        binary: false,
        hunks,
    })
}

fn safe_workspace_child(root: &std::path::Path, rel: &str) -> Option<std::path::PathBuf> {
    let rel_path = std::path::Path::new(rel);
    if rel_path.is_absolute() {
        return None;
    }
    for component in rel_path.components() {
        match component {
            std::path::Component::Normal(_) => {}
            _ => return None,
        }
    }
    Some(root.join(rel_path))
}

fn text_lines(content: &str) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines = content.split('\n').collect::<Vec<_>>();
    if content.ends_with('\n') {
        let _ = lines.pop();
    }
    lines
        .into_iter()
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_claude_settings_contains_only_cli_env_overrides() {
        let mut env = std::collections::HashMap::new();
        env.insert("ANTHROPIC_BASE_URL".into(), "http://127.0.0.1:1234".into());
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), "claudinal-proxy".into());
        env.insert("CLAUDINAL_PROXY_API_KEY".into(), "sk-secret".into());
        env.insert("HTTP_PROXY".into(), "http://proxy.local:8080".into());
        env.insert("ANTHROPIC_MODEL".into(), "provider-main".into());

        let raw = runtime_claude_settings_json(&env)
            .expect("settings json")
            .expect("settings present");
        let value: Value = serde_json::from_str(&raw).expect("valid json");
        let env = value
            .get("env")
            .and_then(Value::as_object)
            .expect("env object");

        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str),
            Some("http://127.0.0.1:1234")
        );
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str),
            Some("claudinal-proxy")
        );
        assert_eq!(
            env.get("ANTHROPIC_MODEL").and_then(Value::as_str),
            Some("provider-main")
        );
        assert!(env.get("CLAUDINAL_PROXY_API_KEY").is_none());
        assert!(env.get("HTTP_PROXY").is_none());
    }

    #[test]
    fn runtime_claude_settings_skips_empty_env_values() {
        let mut env = std::collections::HashMap::new();
        env.insert("ANTHROPIC_BASE_URL".into(), "   ".into());

        let raw = runtime_claude_settings_json(&env).expect("settings json");
        assert!(raw.is_none());
    }

    #[test]
    fn parse_git_patch_extracts_file_hunks() {
        let raw = "\
diff --git a/src/main.rs b/src/main.rs
index 1111111..2222222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
-    println!(\"old\");
+    println!(\"new\");
+    println!(\"extra\");
 }
";

        let files = parse_git_patch(raw);
        assert_eq!(files.len(), 1);
        let file = &files[0];
        assert_eq!(file.path, "src/main.rs");
        assert_eq!(file.additions, 2);
        assert_eq!(file.deletions, 1);
        assert_eq!(file.hunks.len(), 1);
        assert_eq!(file.hunks[0].old_start, 1);
        assert_eq!(file.hunks[0].new_start, 1);
        assert_eq!(file.hunks[0].lines.len(), 5);
    }

    #[test]
    fn parse_git_status_z_keeps_rename_source() {
        let raw = "R  new name.rs\0old name.rs\0?? notes.txt\0";
        let entries = parse_git_status_z(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].status, "R");
        assert_eq!(entries[0].path, "new name.rs");
        assert_eq!(entries[0].old_path.as_deref(), Some("old name.rs"));
        assert_eq!(entries[1].status, "??");
        assert_eq!(entries[1].path, "notes.txt");
    }

    #[test]
    fn review_snapshot_classifies_non_git_local_changes() {
        let before = vec![ReviewSnapshotFile {
            path: "src/a.txt".into(),
            size: 3,
            modified_ms: 1,
            hash: 1,
            binary: false,
            baseline_path: Some("files/0.txt".into()),
        }];
        let mut after = std::collections::HashMap::new();
        after.insert(
            "src/a.txt".into(),
            ReviewCurrentFile {
                size: 4,
                hash: 2,
                binary: false,
                content: Some("new\n".into()),
            },
        );
        after.insert(
            "src/b.txt".into(),
            ReviewCurrentFile {
                size: 1,
                hash: 3,
                binary: false,
                content: Some("b".into()),
            },
        );

        let changes = classify_review_snapshot_changes(before, after);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "src/a.txt");
        assert_eq!(changes[0].status, "M");
        assert_eq!(changes[1].path, "src/b.txt");
        assert_eq!(changes[1].status, "A");
    }

    #[test]
    fn git_no_index_diff_generates_patch_when_git_exists() {
        if which::which("git").is_err() {
            return;
        }
        let dir =
            std::env::temp_dir().join(format!("claudinal-no-index-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let old_path = dir.join("old.txt");
        let new_path = dir.join("new.txt");
        std::fs::write(&old_path, "old\n").unwrap();
        std::fs::write(&new_path, "new\n").unwrap();

        let patch = command_git_no_index_diff(&old_path, &new_path).unwrap();
        let files = parse_git_patch(&patch);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].additions, 1);
        assert_eq!(files[0].deletions, 1);
    }

    #[test]
    fn parse_git_worktree_porcelain_reads_branch_and_detached_entries() {
        let raw = "\
worktree F:/project/claudecli
HEAD c5d0f681ac1930a867a6ba3549551ebe0c91e980
branch refs/heads/main

worktree C:/Users/me/.codex/worktrees/34b8/claudecli
HEAD 49ec5009538b3e8f5a9f39e046f1f0c0aaedfeb7
branch refs/heads/codex/review-fixes-deps

worktree C:/Users/me/.gemini/worktrees/45b8/claudecli
HEAD a6d190fcb36d0933bc0737b6d516352eb9461cea
detached
prunable gitdir file points to non-existent location
";
        let entries = parse_git_worktree_porcelain(raw, "F:/project/claudecli");

        assert_eq!(entries.len(), 3);
        assert!(entries[0].current);
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(
            entries[1].branch.as_deref(),
            Some("codex/review-fixes-deps")
        );
        assert!(entries[2].detached);
        assert_eq!(
            entries[2].prunable.as_deref(),
            Some("gitdir file points to non-existent location")
        );
    }

    #[test]
    fn provider_models_urls_builds_anthropic_path_candidates() {
        let urls = provider_models_urls("https://api.example.com/anthropic", "anthropic", false)
            .expect("models url");
        assert_eq!(
            urls,
            vec![
                "https://api.example.com/anthropic/models".to_string(),
                "https://api.example.com/v1/models".to_string(),
                "https://api.example.com/anthropic/v1/models".to_string()
            ]
        );
    }

    #[test]
    fn provider_models_urls_builds_official_anthropic_models_endpoint() {
        let urls = provider_models_urls("https://api.example.com", "anthropic", false)
            .expect("models url");
        assert_eq!(urls, vec!["https://api.example.com/v1/models".to_string()]);
    }

    #[test]
    fn provider_models_urls_strips_full_messages_endpoint() {
        let urls = provider_models_urls(
            "https://api.example.com/anthropic/v1/messages",
            "anthropic",
            true,
        )
        .expect("models url");
        assert_eq!(
            urls,
            vec!["https://api.example.com/anthropic/v1/models".to_string()]
        );
    }

    #[test]
    fn extract_provider_models_reads_anthropic_models_response() {
        let body = serde_json::json!({
            "data": [
                {
                    "created_at": "2026-03-18T02:00:00Z",
                    "display_name": "MiniMax-M2.7",
                    "id": "MiniMax-M2.7",
                    "type": "model"
                },
                {
                    "created_at": "2026-02-13T02:00:00Z",
                    "display_name": "MiniMax-M2.5",
                    "id": "MiniMax-M2.5",
                    "type": "model"
                }
            ],
            "first_id": "MiniMax-M2.7",
            "has_more": false,
            "last_id": "MiniMax-M2.5"
        });

        assert_eq!(
            extract_provider_models(&body),
            vec!["MiniMax-M2.7".to_string(), "MiniMax-M2.5".to_string()]
        );
    }

    #[test]
    fn extract_provider_models_reads_openai_models_response() {
        let body = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "gpt-5.1", "object": "model" },
                { "id": "gpt-5.1", "object": "model" },
                { "id": "gpt-5.1-mini", "object": "model" }
            ]
        });

        assert_eq!(
            extract_provider_models(&body),
            vec!["gpt-5.1".to_string(), "gpt-5.1-mini".to_string()]
        );
    }

    #[test]
    fn merge_mcp_config_overrides_global_servers_with_project_entries() {
        let global = serde_json::json!({
            "mcpServers": {
                "shared": { "command": "global-shared" },
                "global-only": { "command": "global" }
            }
        });
        let project = serde_json::json!({
            "mcpServers": {
                "shared": { "command": "project-shared" },
                "project-only": { "command": "project" }
            }
        });

        let mut merged: Option<Value> = None;
        merge_mcp_config(&mut merged, global);
        merge_mcp_config(&mut merged, project);

        let servers = merged
            .as_ref()
            .and_then(|v| v.get("mcpServers"))
            .and_then(|v| v.as_object())
            .expect("merged mcpServers should be an object");
        assert_eq!(
            servers
                .get("shared")
                .and_then(|v| v.get("command"))
                .and_then(Value::as_str),
            Some("project-shared")
        );
        assert!(servers.contains_key("global-only"));
        assert!(servers.contains_key("project-only"));
        assert_eq!(servers.len(), 3);
    }

    #[test]
    fn merge_mcp_config_keeps_top_level_keys_and_replaces_disabled_entries() {
        let mut merged: Option<Value> = None;
        // 第一份配置带额外顶层 key（如 mcpRequiresApproval），merge 时保留
        merge_mcp_config(
            &mut merged,
            serde_json::json!({
                "mcpRequiresApproval": true,
                "mcpServers": {
                    "fs": { "command": "fs", "disabled": true }
                }
            }),
        );
        // 第二份重新 enable fs server
        merge_mcp_config(
            &mut merged,
            serde_json::json!({
                "mcpServers": {
                    "fs": { "command": "fs", "disabled": false }
                }
            }),
        );

        let value = merged.expect("merged value");
        assert_eq!(value.get("mcpRequiresApproval"), Some(&Value::Bool(true)));
        let fs = value
            .pointer("/mcpServers/fs")
            .expect("fs server should remain");
        assert_eq!(fs.get("disabled"), Some(&Value::Bool(false)));
    }

    #[test]
    fn merge_mcp_config_ignores_non_object_sources() {
        let mut merged: Option<Value> = None;
        merge_mcp_config(&mut merged, Value::Array(vec![Value::Bool(true)]));
        // 非 object 输入不应破坏 target，target 应该被初始化为空 object
        let value = merged.expect("merged should be initialized");
        assert!(value.is_object());
        assert!(value.as_object().unwrap().is_empty());
    }

    #[test]
    fn runtime_mcp_config_strips_disabled_servers() {
        let config = serde_json::json!({
            "mcpServers": {
                "alpha": { "command": "alpha" },
                "beta":  { "command": "beta", "disabled": true },
                "gamma": { "command": "gamma", "disabled": false }
            }
        });
        let runtime = runtime_mcp_config(config).expect("runtime config");
        let servers = runtime
            .get("mcpServers")
            .and_then(Value::as_object)
            .expect("mcpServers");
        assert_eq!(servers.len(), 2);
        assert!(servers.contains_key("alpha"));
        assert!(servers.contains_key("gamma"));
        assert!(!servers.contains_key("beta"));
    }

    #[test]
    fn runtime_mcp_config_returns_none_when_all_servers_disabled() {
        let config = serde_json::json!({
            "mcpServers": {
                "alpha": { "command": "alpha", "disabled": true }
            }
        });
        assert!(runtime_mcp_config(config).is_none());
    }

    #[test]
    fn runtime_mcp_config_returns_none_when_mcp_servers_missing() {
        let config = serde_json::json!({ "other": "value" });
        assert!(runtime_mcp_config(config).is_none());
    }

    #[test]
    fn mcp_config_from_value_extracts_only_mcp_servers_subtree() {
        let raw = serde_json::json!({
            "mcpServers": { "fs": { "command": "fs" } },
            "ignored": "field"
        });
        let extracted = mcp_config_from_value(&raw).expect("should extract");
        let obj = extracted.as_object().expect("object");
        assert_eq!(obj.len(), 1);
        assert!(obj.contains_key("mcpServers"));
        assert!(extracted.pointer("/mcpServers/fs").is_some());
    }

    #[test]
    fn mcp_config_from_value_returns_none_when_servers_field_missing_or_invalid() {
        assert!(mcp_config_from_value(&serde_json::json!({})).is_none());
        assert!(
            mcp_config_from_value(&serde_json::json!({ "mcpServers": "not an object" })).is_none()
        );
    }

    #[test]
    fn mcp_project_config_from_claude_json_matches_normalized_paths() {
        let claude_json = serde_json::json!({
            "projects": {
                "F:/project/claudecli": {
                    "mcpServers": { "fs": { "command": "fs" } }
                }
            }
        });
        // 路径用 Windows 反斜杠传入，归一化后能命中 forward-slash key
        let cfg = mcp_project_config_from_claude_json(&claude_json, "F:\\project\\claudecli")
            .expect("project config");
        assert!(cfg.pointer("/mcpServers/fs").is_some());
    }

    #[test]
    fn mcp_project_config_from_claude_json_falls_back_to_case_insensitive_match() {
        let claude_json = serde_json::json!({
            "projects": {
                "f:/Project/claudecli": {
                    "mcpServers": { "fs": { "command": "fs" } }
                }
            }
        });
        // 直查 key 不匹配（大小写不同），但 normalize 后应能匹配
        let cfg = mcp_project_config_from_claude_json(&claude_json, "F:/project/claudecli/")
            .expect("case-insensitive match");
        assert!(cfg.pointer("/mcpServers/fs").is_some());
    }

    #[test]
    fn mcp_project_config_from_claude_json_returns_none_when_missing() {
        let claude_json = serde_json::json!({
            "projects": {
                "F:/other/path": { "mcpServers": {} }
            }
        });
        assert!(
            mcp_project_config_from_claude_json(&claude_json, "F:/project/claudecli").is_none()
        );
    }

    #[test]
    fn normalize_claude_project_key_unifies_separators_and_trailing_slash() {
        assert_eq!(
            normalize_claude_project_key("F:\\project\\claudecli\\"),
            "F:/project/claudecli"
        );
        assert_eq!(
            normalize_claude_project_key("/Users/me/repo"),
            "/Users/me/repo"
        );
    }

    #[test]
    fn claude_project_key_for_write_reuses_existing_key_variant() {
        let claude_json = serde_json::json!({
            "projects": {
                "F:\\project\\claudecli": { "mcpServers": {} }
            }
        });
        // 已有 key 用反斜杠形式存在，写入时应该复用同一个 key（避免重复 entry）
        assert_eq!(
            claude_project_key_for_write(&claude_json, "F:/project/claudecli"),
            "F:\\project\\claudecli"
        );
    }

    #[test]
    fn claude_project_key_for_write_creates_normalized_key_when_absent() {
        let claude_json = serde_json::json!({ "projects": {} });
        assert_eq!(
            claude_project_key_for_write(&claude_json, "F:\\project\\claudecli\\"),
            "F:/project/claudecli"
        );
    }
}

#[tauri::command]
pub async fn read_session_transcript(cwd: String, session_id: String) -> Result<Vec<Value>> {
    read_transcript_inner(&cwd, &session_id)
}

#[tauri::command]
pub async fn delete_session_jsonl(cwd: String, session_id: String) -> Result<()> {
    delete_jsonl_inner(&cwd, &session_id)?;
    crate::collab::store::delete_flows_for_session(&cwd, &session_id)?;
    Ok(())
}

#[tauri::command]
pub async fn read_session_sidecar(cwd: String, session_id: String) -> Result<Option<Value>> {
    read_sidecar_inner(&cwd, &session_id)
}

#[tauri::command]
pub async fn write_session_sidecar(cwd: String, session_id: String, data: Value) -> Result<()> {
    write_sidecar_inner(&cwd, &session_id, data)
}

#[derive(Serialize)]
pub struct FileMatch {
    pub path: String,
    pub rel: String,
    pub is_dir: bool,
}

/// 在 cwd 下做浅扫（最多 500 项），按 prefix 模糊匹配文件名 / 相对路径。
/// 跳过 .git / node_modules / target / dist 等。供 @ 文件补全使用。
#[tauri::command]
pub async fn list_files(cwd: String, prefix: String) -> Result<Vec<FileMatch>> {
    let root = std::path::Path::new(&cwd);
    if !root.is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let pat = prefix.trim().to_lowercase();
    let mut out: Vec<FileMatch> = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    const MAX_DEPTH: usize = 4;
    const MAX_RESULTS: usize = 500;
    let skip_dirs = [
        "node_modules",
        ".git",
        "target",
        "dist",
        ".next",
        ".venv",
        "venv",
    ];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= MAX_RESULTS {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && depth > 0 {
                continue;
            }
            let path = entry.path();
            let is_dir = path.is_dir();
            if is_dir && skip_dirs.iter().any(|s| s == &name.as_str()) {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if pat.is_empty() || rel.to_lowercase().contains(&pat) {
                out.push(FileMatch {
                    path: path.display().to_string(),
                    rel,
                    is_dir,
                });
                if out.len() >= MAX_RESULTS {
                    break;
                }
            }
            if is_dir && depth + 1 < MAX_DEPTH {
                stack.push((path, depth + 1));
            }
        }
    }
    // 文件优先 + 路径短优先
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (false, true) => std::cmp::Ordering::Less,
        (true, false) => std::cmp::Ordering::Greater,
        _ => a.rel.len().cmp(&b.rel.len()),
    });
    Ok(out)
}

#[tauri::command]
pub async fn scan_global_usage() -> Result<GlobalUsage> {
    scan_usage_inner()
}

#[tauri::command]
pub async fn scan_activity_heatmap(days: u32) -> Result<Vec<ActivityCell>> {
    scan_heatmap_inner(days)
}

#[tauri::command]
pub async fn search_sessions(query: String, limit: Option<usize>) -> Result<Vec<SessionSearchHit>> {
    search_sessions_inner(&query, limit.unwrap_or(50))
}

#[tauri::command]
pub async fn session_index_diagnostics() -> Result<SessionIndexDiagnostics> {
    index_diagnostics_inner()
}

#[tauri::command]
pub async fn rebuild_session_index() -> Result<()> {
    rebuild_index_inner()
}

#[tauri::command]
pub async fn watch_sessions(
    app: AppHandle,
    watcher: State<'_, WatcherState>,
    cwd: String,
) -> Result<()> {
    watcher.watch(app, cwd)
}

#[tauri::command]
pub async fn unwatch_sessions(watcher: State<'_, WatcherState>, cwd: String) -> Result<()> {
    watcher.unwatch(&cwd);
    Ok(())
}

fn claude_settings_path(scope: &str, cwd: Option<&str>) -> Result<std::path::PathBuf> {
    match scope {
        "global" => {
            let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
            Ok(home.join(".claude").join("settings.json"))
        }
        "project" => {
            let cwd = cwd.ok_or_else(|| Error::Other("cwd required for project scope".into()))?;
            Ok(std::path::PathBuf::from(cwd)
                .join(".claude")
                .join("settings.json"))
        }
        "project-local" => {
            let cwd =
                cwd.ok_or_else(|| Error::Other("cwd required for project-local scope".into()))?;
            Ok(std::path::PathBuf::from(cwd)
                .join(".claude")
                .join("settings.local.json"))
        }
        _ => Err(Error::Other(format!("invalid scope: {scope}"))),
    }
}

fn claude_mcp_path(scope: &str, cwd: Option<&str>) -> Result<std::path::PathBuf> {
    match scope {
        "global" => {
            let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
            Ok(home.join(".claude").join("mcp.json"))
        }
        "project" => {
            let cwd = cwd.ok_or_else(|| Error::Other("cwd required for project scope".into()))?;
            Ok(std::path::PathBuf::from(cwd).join(".mcp.json"))
        }
        _ => Err(Error::Other(format!("invalid mcp scope: {scope}"))),
    }
}

fn claude_json_path() -> Result<std::path::PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
    Ok(home.join(".claude.json"))
}

#[tauri::command]
pub async fn claude_mcp_path_for(scope: String, cwd: Option<String>) -> Result<String> {
    let p = claude_mcp_path(&scope, cwd.as_deref())?;
    Ok(p.display().to_string())
}

#[derive(Serialize)]
pub struct ClaudeJsonMcpConfigs {
    pub path: String,
    pub global: Option<Value>,
    pub project: Option<Value>,
}

#[tauri::command]
pub async fn read_claude_json_mcp_configs(cwd: Option<String>) -> Result<ClaudeJsonMcpConfigs> {
    let path = claude_json_path()?;
    if !path.is_file() {
        return Ok(ClaudeJsonMcpConfigs {
            path: path.display().to_string(),
            global: None,
            project: None,
        });
    }

    let raw = std::fs::read_to_string(&path)?;
    let value: Value = serde_json::from_str(&raw)?;
    let global = mcp_config_from_value(&value);
    let project = cwd
        .as_deref()
        .and_then(|cwd| mcp_project_config_from_claude_json(&value, cwd));

    Ok(ClaudeJsonMcpConfigs {
        path: path.display().to_string(),
        global,
        project,
    })
}

#[tauri::command]
pub async fn write_claude_json_mcp_config(
    scope: String,
    cwd: Option<String>,
    data: Value,
) -> Result<()> {
    let path = claude_json_path()?;
    let mut value = if path.is_file() {
        let raw = std::fs::read_to_string(&path)?;
        serde_json::from_str(&raw)?
    } else {
        Value::Object(Map::new())
    };

    if !value.is_object() {
        return Err(Error::Other(format!(
            "{} must contain a JSON object",
            path.display()
        )));
    }

    let mcp_servers = data
        .get("mcpServers")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !mcp_servers.is_object() {
        return Err(Error::Other("mcpServers must be a JSON object".into()));
    }

    match scope.as_str() {
        "global" => {
            value
                .as_object_mut()
                .ok_or_else(|| Error::Other("claude json root must be an object".into()))?
                .insert("mcpServers".into(), mcp_servers);
        }
        "project" => {
            let cwd = cwd.ok_or_else(|| Error::Other("cwd required for project scope".into()))?;
            let target_key = claude_project_key_for_write(&value, &cwd);
            let obj = value
                .as_object_mut()
                .ok_or_else(|| Error::Other("claude json root must be an object".into()))?;
            let projects = obj
                .entry("projects")
                .or_insert_with(|| Value::Object(Map::new()));
            if !projects.is_object() {
                return Err(Error::Other(
                    "claude json projects field must be a JSON object".into(),
                ));
            }
            let project = projects
                .as_object_mut()
                .ok_or_else(|| Error::Other("claude json projects must be an object".into()))?
                .entry(target_key)
                .or_insert_with(|| Value::Object(Map::new()));
            if !project.is_object() {
                return Err(Error::Other(
                    "claude json project entry must be a JSON object".into(),
                ));
            }
            project
                .as_object_mut()
                .ok_or_else(|| Error::Other("claude json project entry must be an object".into()))?
                .insert("mcpServers".into(), mcp_servers);
        }
        _ => {
            return Err(Error::Other(format!(
                "invalid claude json mcp scope: {scope}"
            )))
        }
    }

    let text = serde_json::to_string_pretty(&value)?;
    atomic_write_str(&path, &text)?;
    Ok(())
}

#[tauri::command]
pub async fn read_claude_mcp_config(scope: String, cwd: Option<String>) -> Result<Option<Value>> {
    let path = claude_mcp_path(&scope, cwd.as_deref())?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    let v: Value = serde_json::from_str(&raw)?;
    Ok(Some(v))
}

fn mcp_config_from_value(value: &Value) -> Option<Value> {
    let servers = value.get("mcpServers")?;
    if !servers.is_object() {
        return None;
    }
    let mut obj = Map::new();
    obj.insert("mcpServers".into(), servers.clone());
    Some(Value::Object(obj))
}

fn mcp_project_config_from_claude_json(value: &Value, cwd: &str) -> Option<Value> {
    let projects = value.get("projects")?.as_object()?;
    let candidates = claude_project_key_candidates(cwd);
    for candidate in &candidates {
        if let Some(project) = projects.get(candidate) {
            return mcp_config_from_value(project);
        }
    }

    let normalized = normalize_claude_project_key(cwd);
    projects
        .iter()
        .find(|(key, _)| normalize_claude_project_key(key).eq_ignore_ascii_case(&normalized))
        .and_then(|(_, project)| mcp_config_from_value(project))
}

fn claude_project_key_candidates(cwd: &str) -> Vec<String> {
    let mut out = Vec::new();
    push_unique_project_key(&mut out, cwd);
    if let Ok(canonical) = std::fs::canonicalize(cwd) {
        push_unique_project_key(&mut out, &canonical.display().to_string());
    }
    out
}

fn push_unique_project_key(out: &mut Vec<String>, path: &str) {
    let normalized = normalize_claude_project_key(path);
    if !normalized.is_empty() && !out.iter().any(|item| item == &normalized) {
        out.push(normalized);
    }
}

fn normalize_claude_project_key(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn claude_project_key_for_write(value: &Value, cwd: &str) -> String {
    if let Some(projects) = value.get("projects").and_then(Value::as_object) {
        for candidate in claude_project_key_candidates(cwd) {
            if projects.contains_key(&candidate) {
                return candidate;
            }
        }
        let normalized = normalize_claude_project_key(cwd);
        if let Some((key, _)) = projects
            .iter()
            .find(|(key, _)| normalize_claude_project_key(key).eq_ignore_ascii_case(&normalized))
        {
            return key.clone();
        }
    }
    normalize_claude_project_key(cwd)
}

#[tauri::command]
pub async fn write_claude_mcp_config(
    scope: String,
    cwd: Option<String>,
    data: Value,
) -> Result<()> {
    let path = claude_mcp_path(&scope, cwd.as_deref())?;
    let text = serde_json::to_string_pretty(&data)?;
    atomic_write_str(&path, &text)
}

#[tauri::command]
pub async fn claude_settings_path_for(scope: String, cwd: Option<String>) -> Result<String> {
    let p = claude_settings_path(&scope, cwd.as_deref())?;
    Ok(p.display().to_string())
}

#[tauri::command]
pub async fn read_claude_settings(scope: String, cwd: Option<String>) -> Result<Option<Value>> {
    let path = claude_settings_path(&scope, cwd.as_deref())?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    let v: Value = serde_json::from_str(&raw)?;
    Ok(Some(v))
}

#[tauri::command]
pub async fn write_claude_settings(scope: String, cwd: Option<String>, data: Value) -> Result<()> {
    let path = claude_settings_path(&scope, cwd.as_deref())?;
    let text = serde_json::to_string_pretty(&data)?;
    atomic_write_str(&path, &text)
}

/// CLAUDE.md 三 scope 路径解析。
/// - global → `~/.claude/CLAUDE.md`
/// - project → `<cwd>/CLAUDE.md`
/// - project-local → `<cwd>/.claude/CLAUDE.local.md`
fn claude_md_path(scope: &str, cwd: Option<&str>) -> Result<std::path::PathBuf> {
    match scope {
        "global" => {
            let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
            Ok(home.join(".claude").join("CLAUDE.md"))
        }
        "project" => {
            let cwd = cwd.ok_or_else(|| Error::Other("cwd required for project scope".into()))?;
            Ok(std::path::PathBuf::from(cwd).join("CLAUDE.md"))
        }
        "project-local" => {
            let cwd =
                cwd.ok_or_else(|| Error::Other("cwd required for project-local scope".into()))?;
            Ok(std::path::PathBuf::from(cwd)
                .join(".claude")
                .join("CLAUDE.local.md"))
        }
        _ => Err(Error::Other(format!("invalid scope: {scope}"))),
    }
}

#[tauri::command]
pub async fn claude_md_path_for(scope: String, cwd: Option<String>) -> Result<String> {
    let p = claude_md_path(&scope, cwd.as_deref())?;
    Ok(p.display().to_string())
}

#[tauri::command]
pub async fn read_claude_md(scope: String, cwd: Option<String>) -> Result<String> {
    let path = claude_md_path(&scope, cwd.as_deref())?;
    if !path.is_file() {
        return Ok(String::new());
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(raw)
}

#[tauri::command]
pub async fn write_claude_md(scope: String, cwd: Option<String>, contents: String) -> Result<()> {
    let path = claude_md_path(&scope, cwd.as_deref())?;
    atomic_write_str(&path, &contents)
}

/// 读 ~/.claude/.credentials.json 中的 claudeAiOauth.accessToken。
/// macOS 上 CLI 把凭据存在系统钥匙串（item 名 "Claude Code-credentials"），
/// 文件可能根本不存在；这里只读文件、不访问系统钥匙串，由调用方决定如何提示用户。
fn read_oauth_access_token() -> Result<Option<String>> {
    let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
    let path = home.join(".claude").join(".credentials.json");
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    let v: Value = serde_json::from_str(&raw)?;
    let token = v
        .pointer("/claudeAiOauth/accessToken")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Ok(token)
}

#[cfg(target_os = "macos")]
const MACOS_OAUTH_KEYCHAIN_HINT: &str = "macOS 上的 OAuth token 存在系统钥匙串（\"Claude Code-credentials\"），桌面端不会读取。可在终端运行 `claude auth status` 查看登录态，或在「第三方 API」页配置 ANTHROPIC_API_KEY 查看用量。";

#[tauri::command]
pub async fn read_claude_oauth_token() -> Result<Option<String>> {
    read_oauth_access_token()
}

/// `anthropic-beta` 头当前默认值（抓包社区共识，非官方公开文档）。
/// Anthropic 升级 beta 时此处会失效；可通过环境变量 `ANTHROPIC_OAUTH_BETA` 临时覆盖。
const DEFAULT_OAUTH_BETA: &str = "oauth-2025-04-20";

/// 调用 Anthropic 的 OAuth usage 端点；返回 JSON 透传给前端。
/// 端点：GET https://api.anthropic.com/api/oauth/usage
/// 头：Authorization: Bearer <token> + anthropic-beta: <ANTHROPIC_OAUTH_BETA or default>
#[tauri::command]
pub async fn fetch_oauth_usage() -> Result<Value> {
    let token = match read_oauth_access_token()? {
        Some(token) => token,
        None => {
            #[cfg(target_os = "macos")]
            {
                return Err(Error::Other(MACOS_OAUTH_KEYCHAIN_HINT.into()));
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Err(Error::Other(
                    "OAuth 未登录：未找到 ~/.claude/.credentials.json".into(),
                ));
            }
        }
    };
    let beta =
        std::env::var("ANTHROPIC_OAUTH_BETA").unwrap_or_else(|_| DEFAULT_OAUTH_BETA.to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| Error::Other(format!("http client: {e}")))?;
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", beta)
        .header("Content-Type", "application/json")
        .header("User-Agent", "Claudinal/0.1")
        .send()
        .await
        .map_err(|e| Error::Other(format!("usage request: {e}")))?;
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("usage parse: {e}")))?;
    if !status.is_success() {
        return Err(Error::Other(format!(
            "usage http {}: {}",
            status,
            serde_json::to_string(&body).unwrap_or_default()
        )));
    }
    Ok(body)
}

/// 把任意文本写入用户在系统对话框中显式选择的路径。当前唯一使用方是
/// 设置页的「导出配置」流程（`ConfigExportDialog`）：路径由 `dialog.save()`
/// 返回，文件由用户主动选择，这里不做额外的路径白名单。原子写避免半截文件。
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<()> {
    let p = std::path::PathBuf::from(&path);
    atomic_write_str(&p, &contents)
}

fn push_unique_url(urls: &mut Vec<String>, url: String) {
    if !urls.iter().any(|seen| seen == &url) {
        urls.push(url);
    }
}

fn url_origin(url: &str) -> Option<&str> {
    let scheme_end = url.find("://")?;
    let authority_start = scheme_end + 3;
    let path_start = url[authority_start..]
        .find('/')
        .map(|idx| authority_start + idx)
        .unwrap_or(url.len());
    Some(&url[..path_start])
}

fn provider_models_urls(
    request_url: &str,
    input_format: &str,
    use_full_url: bool,
) -> Result<Vec<String>> {
    let mut url = request_url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Err(Error::Other("requestUrl required".into()));
    }
    if use_full_url {
        let lower = url.to_lowercase();
        for suffix in ["/chat/completions", "/messages"] {
            if lower.ends_with(suffix) {
                let keep = url.len() - suffix.len();
                url.truncate(keep);
                break;
            }
        }
    }
    if url.to_lowercase().ends_with("/models") {
        return Ok(vec![url]);
    }

    let lower = url.to_lowercase();
    let mut urls = Vec::new();
    if input_format == "anthropic" {
        if lower.ends_with("/v1") {
            push_unique_url(&mut urls, format!("{url}/models"));
        } else if lower.ends_with("/anthropic") {
            push_unique_url(&mut urls, format!("{url}/models"));
            if let Some(origin) = url_origin(&url) {
                push_unique_url(&mut urls, format!("{origin}/v1/models"));
            }
            push_unique_url(&mut urls, format!("{url}/v1/models"));
        } else {
            push_unique_url(&mut urls, format!("{url}/v1/models"));
        }
    } else {
        push_unique_url(&mut urls, format!("{url}/models"));
    }
    Ok(urls)
}

fn collect_model_ids(value: &Value, out: &mut Vec<String>) {
    if let Some(s) = value.as_str() {
        if !s.trim().is_empty() {
            out.push(s.trim().to_string());
        }
        return;
    }
    if let Some(obj) = value.as_object() {
        for key in ["id", "name", "model"] {
            if let Some(s) = obj.get(key).and_then(|x| x.as_str()) {
                if !s.trim().is_empty() {
                    out.push(s.trim().to_string());
                    return;
                }
            }
        }
    }
}

fn extract_provider_models(body: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(arr) = body.get("data").and_then(|x| x.as_array()) {
        for item in arr {
            collect_model_ids(item, &mut out);
        }
    }
    if let Some(arr) = body.get("models").and_then(|x| x.as_array()) {
        for item in arr {
            collect_model_ids(item, &mut out);
        }
    }
    if let Some(arr) = body.as_array() {
        for item in arr {
            collect_model_ids(item, &mut out);
        }
    }
    let mut unique = Vec::new();
    for id in out {
        if !unique.iter().any(|seen| seen == &id) {
            unique.push(id);
        }
    }
    unique
}

fn response_body_preview(bytes: &[u8]) -> String {
    const MAX_CHARS: usize = 1000;
    let text = String::from_utf8_lossy(bytes);
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = normalized.chars().take(MAX_CHARS).collect::<String>();
    if normalized.chars().count() > MAX_CHARS {
        preview.push_str("...");
    }
    if preview.is_empty() {
        format!("<{} bytes non-utf8 body>", bytes.len())
    } else {
        preview
    }
}

#[tauri::command]
pub async fn fetch_provider_models(
    request_url: String,
    api_key: String,
    auth_field: String,
    input_format: String,
    use_full_url: bool,
    proxy_url: Option<String>,
) -> Result<Vec<String>> {
    let urls = provider_models_urls(&request_url, &input_format, use_full_url)?;
    let token = api_key.trim();
    if token.is_empty() {
        return Err(Error::Other("apiKey required".into()));
    }
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20));
    if let Some(proxy_url) = proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
    {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|e| Error::Other(format!("invalid proxy url: {}", error_chain(&e))))?;
        builder = builder.proxy(proxy);
    }
    let client = builder
        .build()
        .map_err(|e| Error::Other(format!("http client: {e}")))?;
    let mut errors = Vec::new();
    for url in urls {
        match fetch_provider_models_from_url(&client, &url, token, &auth_field, &input_format).await
        {
            Ok(models) => return Ok(models),
            Err(err) => errors.push(err),
        }
    }
    Err(Error::Other(format!(
        "所有模型列表端点均失败: {}",
        errors.join(" | ")
    )))
}

async fn fetch_provider_models_from_url(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    auth_field: &str,
    input_format: &str,
) -> std::result::Result<Vec<String>, String> {
    let mut req = client
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", "Claudinal/0.1");
    if input_format == "anthropic" {
        req = req.header("anthropic-version", "2023-06-01");
    }
    if auth_field == "ANTHROPIC_API_KEY" && input_format != "openai-chat-completions" {
        req = req.header("x-api-key", token);
    } else {
        let bearer = token.strip_prefix("Bearer ").unwrap_or(token);
        req = req.bearer_auth(bearer);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("GET {url}: models request: {e}"))?;
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("GET {url}: models response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "GET {url}: models http {}: {}",
            status,
            response_body_preview(&bytes)
        ));
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|e| {
        format!(
            "GET {url}: models parse: {e}; body: {}",
            response_body_preview(&bytes)
        )
    })?;
    let models = extract_provider_models(&body);
    if models.is_empty() {
        return Err(format!(
            "GET {url}: 响应中未找到模型 ID: {}",
            response_body_preview(&bytes)
        ));
    }
    Ok(models)
}

#[tauri::command]
pub async fn open_path(path: String) -> Result<OpenPathResult> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(Error::Other(format!("path not found: {path}")));
    }
    let fallback = if p.is_file() {
        p.parent().map(std::path::Path::to_path_buf)
    } else {
        None
    };
    let open_target = |target: &std::path::Path| -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            if target.is_dir() {
                let mut cmd = std::process::Command::new("explorer");
                cmd.arg(target);
                hide_std_window(&mut cmd);
                cmd.spawn().map_err(Error::from)?;
            } else {
                let mut cmd = std::process::Command::new("cmd");
                cmd.args(["/c", "start", ""]);
                cmd.arg(target);
                hide_std_window(&mut cmd);
                cmd.spawn().map_err(Error::from)?;
            }
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(target)
                .spawn()
                .map_err(Error::from)?;
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
                .arg(target)
                .spawn()
                .map_err(Error::from)?;
        }
        Ok(())
    };

    match open_target(&p) {
        Ok(()) => Ok(OpenPathResult {
            action: "opened".into(),
            path,
            fallback_path: None,
        }),
        Err(err) => {
            let Some(parent) = fallback else {
                return Err(err);
            };
            open_target(&parent)?;
            Ok(OpenPathResult {
                action: "revealed_parent".into(),
                path,
                fallback_path: Some(parent.display().to_string()),
            })
        }
    }
}

#[derive(Serialize)]
pub struct ProjectActionResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[tauri::command]
pub async fn run_project_action(cwd: String, command: String) -> Result<ProjectActionResult> {
    let command = command.trim();
    if command.is_empty() {
        return Err(Error::Other("project action command is empty".into()));
    }
    let root = std::path::Path::new(&cwd);
    if !root.is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-lc").arg(command);
        cmd
    };

    cmd.current_dir(root)
        .env("CLAUDINAL_WORKTREE_PATH", &cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_tokio_window(&mut cmd);

    let output = cmd
        .output()
        .await
        .map_err(|e| Error::Other(format!("run project action: {e}")))?;
    Ok(ProjectActionResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Playwright 浏览器二进制存放目录（含 chromium/firefox/webkit 子目录）。
/// 标准路径见 https://playwright.dev/docs/browsers#managing-browser-binaries：
/// - Windows: `%USERPROFILE%\AppData\Local\ms-playwright`
/// - macOS:   `~/Library/Caches/ms-playwright`
/// - Linux:   `~/.cache/ms-playwright`
/// 用户可通过 `PLAYWRIGHT_BROWSERS_PATH` 覆盖；返回路径不保证存在。
fn playwright_browsers_default_path() -> Result<std::path::PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
    #[cfg(target_os = "windows")]
    {
        Ok(home.join("AppData").join("Local").join("ms-playwright"))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(home.join("Library").join("Caches").join("ms-playwright"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Ok(home.join(".cache").join("ms-playwright"))
    }
}

#[derive(Serialize)]
pub struct PlaywrightInstallState {
    pub root_path: String,
    pub root_exists: bool,
    pub env_override: Option<String>,
    pub chromium: bool,
    pub firefox: bool,
    pub webkit: bool,
}

fn dir_has_prefix(root: &std::path::Path, prefix: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(prefix) {
            return true;
        }
    }
    false
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestRequest {
    pub url: String,
    pub target: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct ProxyTestResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub latency_ms: u64,
    pub message: String,
}

/// 通过指定 proxy_url 直连一次目标 URL，返回耗时与 HTTP 状态。
/// proxy_url 形如 `http://user:pass@host:7890` / `socks5h://host:1080`。
/// target 留空走 https://api.anthropic.com（HEAD 请求，不消耗配额）。
#[tauri::command]
pub async fn test_proxy_connection(req: ProxyTestRequest) -> Result<ProxyTestResult> {
    let target = req
        .target
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("https://api.anthropic.com")
        .to_string();
    let timeout = std::time::Duration::from_millis(req.timeout_ms.unwrap_or(8_000));
    let proxy = reqwest::Proxy::all(&req.url)
        .map_err(|e| Error::Other(format!("invalid proxy url: {}", error_chain(&e))))?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(timeout)
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| Error::Other(format!("http client: {}", error_chain(&e))))?;
    let start = std::time::Instant::now();
    match client
        .head(&target)
        .header("User-Agent", "Claudinal/0.1 proxy-test")
        .send()
        .await
    {
        Ok(resp) => {
            let latency = start.elapsed().as_millis() as u64;
            let status = resp.status();
            let ok = status.is_success()
                || status.is_redirection()
                || matches!(status.as_u16(), 401 | 403 | 404 | 405);
            Ok(ProxyTestResult {
                ok,
                status: Some(status.as_u16()),
                latency_ms: latency,
                message: if ok {
                    if status.is_success() || status.is_redirection() {
                        format!("连接成功 · HTTP {}", status.as_u16())
                    } else {
                        format!("连接成功，目标返回 HTTP {}", status.as_u16())
                    }
                } else {
                    format!("代理可达，但目标返回 HTTP {}", status.as_u16())
                },
            })
        }
        Err(e) => {
            let latency = start.elapsed().as_millis() as u64;
            Ok(ProxyTestResult {
                ok: false,
                status: None,
                latency_ms: latency,
                message: format!("失败：{}", error_chain(&e)),
            })
        }
    }
}

fn error_chain(err: &dyn std::error::Error) -> String {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(err) = source {
        let detail = err.to_string();
        if !detail.is_empty() && !message.contains(&detail) {
            message.push_str(": ");
            message.push_str(&detail);
        }
        source = err.source();
    }
    message
}

#[tauri::command]
pub async fn detect_playwright_install() -> Result<PlaywrightInstallState> {
    let env_override = std::env::var("PLAYWRIGHT_BROWSERS_PATH").ok();
    let root = if let Some(path) = env_override.as_deref().filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(path)
    } else {
        playwright_browsers_default_path()?
    };
    let root_exists = root.is_dir();
    let (chromium, firefox, webkit) = if root_exists {
        (
            dir_has_prefix(&root, "chromium"),
            dir_has_prefix(&root, "firefox"),
            dir_has_prefix(&root, "webkit"),
        )
    } else {
        (false, false, false)
    };
    Ok(PlaywrightInstallState {
        root_path: root.display().to_string(),
        root_exists,
        env_override,
        chromium,
        firefox,
        webkit,
    })
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<()> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(Error::Other(format!("invalid url: {url}")));
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "start", "", &url]);
        hide_std_window(&mut cmd);
        cmd.spawn().map_err(Error::from)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(Error::from)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(Error::from)?;
    }
    Ok(())
}

/// 探测系统钥匙串是否可用。Linux 无 secret-service / DE 时返回 false，前端用来切降级。
#[tauri::command]
pub async fn keychain_available() -> bool {
    crate::keychain::is_available()
}

/// 写入 / 覆盖密钥；secret 为空字符串视作删除。
#[tauri::command]
pub async fn keychain_set(account: String, secret: String) -> Result<()> {
    crate::keychain::set(&account, &secret)
}

/// 读取密钥；不存在返回 None。
#[tauri::command]
pub async fn keychain_get(account: String) -> Result<Option<String>> {
    crate::keychain::get(&account)
}

/// 删除密钥；不存在视作成功（幂等）。
#[tauri::command]
pub async fn keychain_delete(account: String) -> Result<()> {
    crate::keychain::delete(&account)
}

#[tauri::command]
pub async fn auth_status() -> Result<crate::auth::AuthStatus> {
    crate::auth::auth_status().await
}

#[tauri::command]
pub async fn auth_logout() -> Result<String> {
    crate::auth::auth_logout().await
}

#[tauri::command]
pub async fn auth_start_login(
    login: State<'_, crate::auth::AuthLoginState>,
    use_console: Option<bool>,
) -> Result<()> {
    login.start_hidden(use_console.unwrap_or(false)).await
}

#[tauri::command]
pub async fn auth_cancel_login(login: State<'_, crate::auth::AuthLoginState>) -> Result<()> {
    login.cancel().await
}

#[tauri::command]
pub async fn auth_open_login_terminal(use_console: Option<bool>) -> Result<()> {
    crate::auth::open_login_terminal(use_console.unwrap_or(false))
}

#[tauri::command]
pub async fn collab_detect_providers(
    overrides: Option<Vec<crate::collab::providers::ProviderPathOverride>>,
) -> Result<Vec<crate::collab::CollabProviderStatus>> {
    crate::collab::detect_providers(overrides).await
}

#[tauri::command]
pub async fn collab_detect_provider(
    provider: String,
    overrides: Option<Vec<crate::collab::providers::ProviderPathOverride>>,
) -> Result<crate::collab::CollabProviderStatus> {
    crate::collab::detect_provider_by_id(provider, overrides).await
}

#[tauri::command]
pub async fn collab_list_flows(cwd: Option<String>) -> Result<Vec<crate::collab::CollabFlow>> {
    crate::collab::store::list_flows(cwd.as_deref())
}

#[tauri::command]
pub async fn collab_read_flow(flow_id: String) -> Result<crate::collab::CollabFlow> {
    crate::collab::store::read_flow(&flow_id)
}

#[tauri::command]
pub async fn collab_start_flow(
    req: crate::collab::CollabStartFlowRequest,
) -> Result<crate::collab::CollabFlow> {
    crate::collab::start_flow(req).await
}

#[tauri::command]
pub async fn collab_delegate(
    req: crate::collab::CollabDelegateRequest,
) -> Result<crate::collab::CollabCommandResult> {
    crate::collab::delegate(req).await
}

#[tauri::command]
pub async fn collab_record_approval(
    req: crate::collab::CollabApprovalRequest,
) -> Result<crate::collab::CollabFlow> {
    crate::collab::record_approval(req).await
}

#[tauri::command]
pub async fn collab_run_verification(
    req: crate::collab::CollabVerificationRequest,
) -> Result<crate::collab::CollabCommandResult> {
    crate::collab::run_verification(req).await
}
