use std::path::PathBuf;

use crate::error::{Error, Result};

pub fn find_claude() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("CLAUDE_CLI_PATH") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
    }
    which::which("claude").map_err(Error::from)
}
