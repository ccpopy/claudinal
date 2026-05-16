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
    which::which("claude").map_err(Error::from)
}
