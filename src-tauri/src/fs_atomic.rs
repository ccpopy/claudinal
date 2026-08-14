use std::path::Path;

use crate::error::{Error, Result};

/// Write a complete file through a unique sibling and atomically replace the target.
/// The UUID is required even inside one process: independent async callers can overlap.
pub(crate) fn atomic_write_str(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(Error::from)?;
        }
    }
    let pid = std::process::id();
    let nonce = uuid::Uuid::new_v4();
    let mut tmp = path.to_path_buf();
    let suffix = match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) => format!("{extension}.tmp.{pid}.{nonce}"),
        None => format!("tmp.{pid}.{nonce}"),
    };
    tmp.set_extension(suffix);
    std::fs::write(&tmp, contents).map_err(Error::from)?;
    if let Err(error) = atomic_replace_file(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::from(error));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

#[cfg(target_os = "windows")]
fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from_wide = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let to_wide = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
