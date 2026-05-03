use std::path::PathBuf;

use crate::error::{Error, Result};

/// Claudinal 应用根目录。
///
/// - 开发模式：current_exe 通常在 `src-tauri/target/{debug,release}/`，
///   上溯到仓库根，写到 `<repo>/.claudinal/`。
/// - Windows / Linux 打包：写到 `<exe-dir>/.claudinal/`。
/// - macOS .app bundle：跳出 `Foo.app/Contents/MacOS/`，写到 .app 同级目录。
pub fn app_root() -> Result<PathBuf> {
    let exe = std::env::current_exe()
        .map_err(|e| Error::Other(format!("无法定位 Claudinal 可执行文件: {e}")))?;
    let dir = exe
        .parent()
        .ok_or_else(|| Error::Other("可执行文件没有父目录".into()))?
        .to_path_buf();

    let path_str = dir.to_string_lossy().replace('\\', "/");
    if path_str.contains("/target/debug") || path_str.contains("/target/release") {
        let mut p: &std::path::Path = &dir;
        while let Some(parent) = p.parent() {
            if parent.file_name().and_then(|n| n.to_str()) == Some("target") {
                if let Some(grand) = parent.parent().and_then(|p| p.parent()) {
                    return Ok(grand.to_path_buf());
                }
            }
            p = parent;
        }
    }

    #[cfg(target_os = "macos")]
    {
        if dir.ends_with("Contents/MacOS") {
            if let Some(app_sibling) = dir
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
            {
                return Ok(app_sibling.to_path_buf());
            }
        }
    }

    Ok(dir)
}

pub fn claudinal_dir() -> Result<PathBuf> {
    Ok(app_root()?.join(".claudinal"))
}
