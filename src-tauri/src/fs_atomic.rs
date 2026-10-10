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

    // Rust canonicalization supplies an absolute verbatim Windows path, including UNC.
    // Only resolve the destination parent: resolving the file itself would follow a symlink.
    let from = std::fs::canonicalize(from)?;
    let to = windows_destination_path(to)?;
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

#[cfg(target_os = "windows")]
fn windows_destination_path(path: &Path) -> std::io::Result<std::path::PathBuf> {
    let filename = path.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "atomic target has no filename",
        )
    })?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    Ok(std::fs::canonicalize(parent)?.join(filename))
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{atomic_write_str, windows_destination_path};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            Self::new_in(&std::env::temp_dir())
        }

        fn new_in(parent: &Path) -> Self {
            let root = parent.join(format!("claudinal-atomic-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn assert_only_target(parent: &Path, target: &Path) {
        let entries = std::fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(entries, vec![target.to_path_buf()]);
    }

    #[test]
    fn atomic_write_replaces_target_when_unique_temporary_path_exceeds_max_path() {
        let fixture = TestDir::new();
        let short = fixture.0.join("short.claudinal.json");
        atomic_write_str(&short, "short-path-control").unwrap();
        assert_eq!(
            std::fs::read_to_string(&short).unwrap(),
            "short-path-control"
        );

        let mut parent = fixture.0.join("nested");
        while parent.as_os_str().encode_wide().count() < 190 {
            parent.push("long-path-segment");
        }
        let extension = ".claudinal.json";
        let filename_length = 255usize
            .checked_sub(parent.as_os_str().encode_wide().count() + 1 + extension.len())
            .expect("the controlled 255-unit fixture needs a shorter temporary directory");
        let target = parent.join(format!("{}{}", "x".repeat(filename_length), extension));
        assert_eq!(target.as_os_str().encode_wide().count(), 255);
        let temporary_length = 255 + 5 + std::process::id().to_string().len() + 1 + 36;
        assert!(temporary_length > 260);
        eprintln!(
            "atomic long-path fixture: target=255 UTF-16 units, temporary={temporary_length}"
        );

        let first = "{\"composer\":{\"model\":\"sonnet\"},\"note\":\"中文\"}";
        atomic_write_str(&target, first)
            .expect("long temporary path must support initial creation");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), first);
        assert_only_target(&parent, &target);

        let replacement = format!(
            "{{\"result\":\"{}\",\"note\":\"保留完整内容\"}}",
            "a".repeat(32768)
        );
        atomic_write_str(&target, &replacement)
            .expect("long temporary path must atomically replace an existing target");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), replacement);
        assert_only_target(&parent, &target);
    }

    #[test]
    fn atomic_write_accepts_relative_and_existing_verbatim_paths() {
        // Keep the process cwd unchanged: parallel tests must not observe a test cwd.
        let cwd = std::env::current_dir().unwrap();
        let fixture = TestDir::new_in(&cwd);
        let target = fixture.0.join("relative.claudinal.json");
        let relative = target.strip_prefix(&cwd).unwrap();
        atomic_write_str(relative, "relative-create").unwrap();
        atomic_write_str(relative, "relative-replacement").unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "relative-replacement"
        );
        assert_only_target(&fixture.0, &target);

        let verbatim = std::fs::canonicalize(&fixture.0)
            .unwrap()
            .join("relative.claudinal.json");
        assert!(verbatim.as_os_str().to_string_lossy().starts_with(r"\\?\"));
        atomic_write_str(&verbatim, "verbatim-replacement 中文").unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "verbatim-replacement 中文"
        );
        assert_eq!(windows_destination_path(&verbatim).unwrap(), verbatim);
        assert_only_target(&fixture.0, &target);
    }

    #[test]
    fn failed_replace_preserves_destination_and_removes_unique_temporary_file() {
        let fixture = TestDir::new();
        let target = fixture.0.join("occupied.claudinal.json");
        std::fs::create_dir(&target).unwrap();
        let preserved = target.join("preserved.txt");
        std::fs::write(&preserved, "untouched destination").unwrap();

        assert!(atomic_write_str(&target, "must not replace a directory").is_err());
        assert_eq!(
            std::fs::read_to_string(&preserved).unwrap(),
            "untouched destination"
        );
        assert_only_target(&fixture.0, &target);
    }
}
