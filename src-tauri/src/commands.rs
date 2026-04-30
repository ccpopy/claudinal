use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

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
    let (permission_prompt_tool, mcp_config) = if permission_mcp_enabled.unwrap_or(false) {
        env.extend(permission_bridge.env(app.clone()).await?);
        let tool = permission_prompt_tool
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_PERMISSION_MCP_TOOL)
            .to_string();
        let config = render_default_mcp_config(mcp_config.as_deref())?;
        (Some(tool), Some(config))
    } else {
        (None, None)
    };
    let opts = SpawnOptions {
        cwd: cwd.into(),
        model,
        effort,
        permission_mode,
        resume_session_id,
        env: if env.is_empty() { None } else { Some(env) },
        permission_prompt_tool,
        mcp_config,
    };
    manager.spawn(app, opts).await
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
