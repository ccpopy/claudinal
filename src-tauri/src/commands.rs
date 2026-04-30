use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, State};

use crate::api_proxy::{start as start_api_proxy, ProxyConfig};
use crate::error::{Error, Result};
use crate::permission_mcp::{
    render_default_mcp_config, PermissionMcpBridge, DEFAULT_PERMISSION_MCP_TOOL,
};
use crate::proc::{Manager, SpawnOptions};
use crate::session::{
    delete_session_jsonl as delete_jsonl_inner, list_project_sessions as list_sessions_inner,
    read_session_sidecar as read_sidecar_inner, read_session_transcript as read_transcript_inner,
    scan_activity_heatmap as scan_heatmap_inner, scan_all_usage_sidecars as scan_usage_inner,
    write_session_sidecar as write_sidecar_inner, ActivityCell, GlobalUsage, SessionMeta,
    WatcherState,
};

#[tauri::command]
pub async fn detect_claude_cli() -> Result<String> {
    let path = crate::proc::spawn::find_claude()?;
    Ok(path.display().to_string())
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
) -> Result<String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let mut env = env.unwrap_or_default();
    let env_remove = Vec::new();
    if let Some(proxy_config) = take_proxy_config(&mut env) {
        let local_base_url = start_api_proxy(proxy_config).await?;
        env.insert("ANTHROPIC_BASE_URL".into(), local_base_url);
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), "claudinal-proxy".into());
        env.remove("ANTHROPIC_API_KEY");
    }
    if let Some(model) = model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let is_claude_builtin = model == "default"
            || model == "best"
            || model == "sonnet"
            || model == "opus"
            || model == "haiku"
            || model == "opusplan"
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
    };
    manager.spawn(app, opts).await
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

fn take_proxy_config(env: &mut std::collections::HashMap<String, String>) -> Option<ProxyConfig> {
    let target_url = env.remove("CLAUDINAL_PROXY_TARGET_URL")?;
    let api_key = env.remove("CLAUDINAL_PROXY_API_KEY").unwrap_or_default();
    let auth_field = env
        .remove("CLAUDINAL_PROXY_AUTH_FIELD")
        .unwrap_or_else(|| "ANTHROPIC_AUTH_TOKEN".into());
    let use_full_url = env
        .remove("CLAUDINAL_PROXY_USE_FULL_URL")
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
    let main_model = env.remove("CLAUDINAL_PROXY_MAIN_MODEL").unwrap_or_default();
    let haiku_model = env
        .remove("CLAUDINAL_PROXY_HAIKU_MODEL")
        .unwrap_or_default();
    let sonnet_model = env
        .remove("CLAUDINAL_PROXY_SONNET_MODEL")
        .unwrap_or_default();
    let opus_model = env.remove("CLAUDINAL_PROXY_OPUS_MODEL").unwrap_or_default();
    Some(ProxyConfig {
        target_url,
        api_key,
        auth_field,
        use_full_url,
        main_model,
        haiku_model,
        sonnet_model,
        opus_model,
    })
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
pub async fn read_session_transcript(cwd: String, session_id: String) -> Result<Vec<Value>> {
    read_transcript_inner(&cwd, &session_id)
}

#[tauri::command]
pub async fn delete_session_jsonl(cwd: String, session_id: String) -> Result<()> {
    delete_jsonl_inner(&cwd, &session_id)
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

#[tauri::command]
pub async fn claude_mcp_path_for(scope: String, cwd: Option<String>) -> Result<String> {
    let p = claude_mcp_path(&scope, cwd.as_deref())?;
    Ok(p.display().to_string())
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

#[tauri::command]
pub async fn write_claude_mcp_config(
    scope: String,
    cwd: Option<String>,
    data: Value,
) -> Result<()> {
    let path = claude_mcp_path(&scope, cwd.as_deref())?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(Error::from)?;
        }
    }
    let text = serde_json::to_string_pretty(&data)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(Error::from)?;
    std::fs::rename(&tmp, &path).map_err(Error::from)?;
    Ok(())
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
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(Error::from)?;
        }
    }
    let text = serde_json::to_string_pretty(&data)?;
    std::fs::write(&path, text).map_err(Error::from)?;
    Ok(())
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
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(Error::from)?;
        }
    }
    std::fs::write(&path, contents).map_err(Error::from)?;
    Ok(())
}

/// 读 ~/.claude/.credentials.json 中的 claudeAiOauth.accessToken。
/// macOS 上 CLI 把凭据存在 Keychain（"Claude Code-credentials"），
/// 当前实现仅覆盖 Linux/Windows；macOS 留 P4。
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
    let token = read_oauth_access_token()?
        .ok_or_else(|| Error::Other("OAuth 未登录：未找到 ~/.claude/.credentials.json".into()))?;
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

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<()> {
    let p = std::path::PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(Error::from)?;
        }
    }
    std::fs::write(&p, contents).map_err(Error::from)?;
    Ok(())
}

fn provider_models_url(
    request_url: &str,
    input_format: &str,
    use_full_url: bool,
) -> Result<String> {
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
    if !url.to_lowercase().ends_with("/models") {
        if input_format == "anthropic" && !url.to_lowercase().ends_with("/v1") {
            url.push_str("/v1");
        }
        url.push_str("/models");
    }
    Ok(url)
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

#[tauri::command]
pub async fn fetch_provider_models(
    request_url: String,
    api_key: String,
    auth_field: String,
    input_format: String,
    use_full_url: bool,
) -> Result<Vec<String>> {
    let url = provider_models_url(&request_url, &input_format, use_full_url)?;
    let token = api_key.trim();
    if token.is_empty() {
        return Err(Error::Other("apiKey required".into()));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| Error::Other(format!("http client: {e}")))?;
    let mut req = client
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", "Claudinal/0.1");
    if auth_field == "ANTHROPIC_API_KEY" && input_format != "openai-chat-completions" {
        req = req
            .header("x-api-key", token)
            .header("anthropic-version", "2023-06-01");
    } else {
        let bearer = token.strip_prefix("Bearer ").unwrap_or(token);
        req = req.bearer_auth(bearer);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| Error::Other(format!("models request: {e}")))?;
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("models parse: {e}")))?;
    if !status.is_success() {
        return Err(Error::Other(format!(
            "models http {}: {}",
            status,
            serde_json::to_string(&body).unwrap_or_default()
        )));
    }
    let models = extract_provider_models(&body);
    if models.is_empty() {
        return Err(Error::Other("响应中未找到模型 ID".into()));
    }
    Ok(models)
}

#[tauri::command]
pub async fn open_path(path: String) -> Result<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(Error::Other(format!("path not found: {path}")));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&p)
            .spawn()
            .map_err(Error::from)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(Error::from)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(Error::from)?;
    }
    Ok(())
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
        .map_err(|e| Error::Other(format!("invalid proxy url: {e}")))?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(timeout)
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| Error::Other(format!("http client: {e}")))?;
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
            let ok = status.is_success() || status.is_redirection() || status.as_u16() == 401;
            Ok(ProxyTestResult {
                ok,
                status: Some(status.as_u16()),
                latency_ms: latency,
                message: if ok {
                    format!("连接成功 · HTTP {}", status.as_u16())
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
                message: format!("失败：{e}"),
            })
        }
    }
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
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(Error::from)?;
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
