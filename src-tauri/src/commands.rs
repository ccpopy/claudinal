use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::proc::{Manager, SpawnOptions};
use crate::session::{
    delete_session_jsonl as delete_jsonl_inner,
    list_project_sessions as list_sessions_inner,
    read_session_sidecar as read_sidecar_inner,
    read_session_transcript as read_transcript_inner,
    write_session_sidecar as write_sidecar_inner,
    SessionMeta, WatcherState,
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
    fork_session_id: Option<String>,
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
        fork_session_id,
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
pub async fn delete_session_jsonl(cwd: String, session_id: String) -> Result<()> {
    delete_jsonl_inner(&cwd, &session_id)
}

#[tauri::command]
pub async fn read_session_sidecar(
    cwd: String,
    session_id: String,
) -> Result<Option<Value>> {
    read_sidecar_inner(&cwd, &session_id)
}

#[tauri::command]
pub async fn write_session_sidecar(
    cwd: String,
    session_id: String,
    data: Value,
) -> Result<()> {
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
    let skip_dirs = ["node_modules", ".git", "target", "dist", ".next", ".venv", "venv"];
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
pub async fn watch_sessions(
    app: AppHandle,
    watcher: State<'_, WatcherState>,
    cwd: String,
) -> Result<()> {
    watcher.watch(app, cwd)
}

#[tauri::command]
pub async fn unwatch_sessions(
    watcher: State<'_, WatcherState>,
    cwd: String,
) -> Result<()> {
    watcher.unwatch(&cwd);
    Ok(())
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
