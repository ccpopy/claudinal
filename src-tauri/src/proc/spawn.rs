use std::path::PathBuf;

use crate::error::{Error, Result};

pub fn find_claude() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("CLAUDE_CLI_PATH") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
    }
    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "windows")]
        let native = home.join(".local").join("bin").join("claude.exe");
        #[cfg(not(target_os = "windows"))]
        let native = home.join(".local").join("bin").join("claude");
        if native.is_file() {
            return Ok(native);
        }
    }
    #[cfg(target_os = "windows")]
    {
        for candidate in windows_npm_claude_candidates() {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    which::which("claude").map_err(Error::from)
}

#[cfg(target_os = "windows")]
fn windows_npm_claude_candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(data_dir) = dirs::data_dir() {
        roots.push(data_dir.join("npm"));
    }
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(program_files) = std::env::var(key) {
            roots.push(PathBuf::from(program_files).join("nodejs"));
        }
    }

    roots
        .into_iter()
        .flat_map(|root| {
            [
                root.join("claude.cmd"),
                root.join("claude.exe"),
                root.join("claude.ps1"),
            ]
        })
        .collect()
}
