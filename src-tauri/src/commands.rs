use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::proc::{Manager, SpawnOptions};
use crate::session::{
    list_project_sessions as list_sessions_inner,
    read_session_transcript as read_transcript_inner,
    SessionMeta,
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
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    resume_session_id: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let opts = SpawnOptions {
        cwd: cwd.into(),
        model,
        effort,
        permission_mode,
        resume_session_id,
        env,
    };
    manager.spawn(app, opts).await
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
pub async fn read_session_transcript(
    cwd: String,
    session_id: String,
) -> Result<Vec<Value>> {
    read_transcript_inner(&cwd, &session_id)
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
