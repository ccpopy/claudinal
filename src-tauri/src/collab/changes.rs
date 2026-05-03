use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::collab::store::FileChangeRecord;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub kind: String,
    pub len: u64,
    pub modified_ms: Option<u128>,
    pub hash: String,
}

pub type WorkspaceSnapshot = BTreeMap<String, FileFingerprint>;

pub fn capture_workspace(cwd: &str) -> Result<WorkspaceSnapshot> {
    let root = std::fs::canonicalize(cwd).map_err(Error::from)?;
    if !root.is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let mut out = BTreeMap::new();
    visit(&root, &root, &mut out)?;
    Ok(out)
}

pub fn diff_snapshots(
    before: &WorkspaceSnapshot,
    after: &WorkspaceSnapshot,
    allowed_paths: &[String],
) -> Vec<FileChangeRecord> {
    let mut keys = BTreeSet::new();
    keys.extend(before.keys().cloned());
    keys.extend(after.keys().cloned());

    let mut out = Vec::new();
    for path in keys {
        let change_type = match (before.get(&path), after.get(&path)) {
            (None, Some(_)) => "added",
            (Some(_), None) => "deleted",
            (Some(a), Some(b)) if a != b => "modified",
            _ => continue,
        };
        out.push(FileChangeRecord {
            allowed: path_allowed(&path, allowed_paths),
            path,
            change_type: change_type.into(),
        });
    }
    out
}

pub fn normalize_allowed_paths(cwd: &str, raw_paths: &[String]) -> Result<Vec<String>> {
    let root = std::fs::canonicalize(cwd).map_err(Error::from)?;
    if !root.is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    let root = normalize_path(&root);
    let mut out = Vec::new();
    for raw in raw_paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let candidate = if Path::new(trimmed).is_absolute() {
            PathBuf::from(trimmed)
        } else {
            root.join(trimmed)
        };
        let normalized = normalize_path(&candidate);
        if !is_inside_or_equal(&normalized, &root) {
            return Err(Error::Other(format!(
                "allowed path is outside workspace: {trimmed}"
            )));
        }
        let rel = normalized
            .strip_prefix(&root)
            .map_err(|_| Error::Other(format!("allowed path is outside workspace: {trimmed}")))?;
        let rel = rel_to_slash(rel);
        out.push(if rel.is_empty() { ".".into() } else { rel });
    }
    out.sort();
    out.dedup();
    Ok(out)
}

fn visit(root: &Path, dir: &Path, out: &mut WorkspaceSnapshot) -> Result<()> {
    for entry in std::fs::read_dir(dir).map_err(Error::from)? {
        let entry = entry.map_err(Error::from)?;
        let path = entry.path();
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let meta = std::fs::symlink_metadata(&path).map_err(Error::from)?;
        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&path).map_err(Error::from)?;
            out.insert(
                rel_to_slash(
                    path.strip_prefix(root)
                        .map_err(|_| Error::Other("failed to build relative path".into()))?,
                ),
                FileFingerprint {
                    kind: "symlink".into(),
                    len: 0,
                    modified_ms: modified_ms(&meta),
                    hash: hash_bytes(target.to_string_lossy().as_bytes()),
                },
            );
            continue;
        }
        if meta.is_dir() {
            visit(root, &path, out)?;
            continue;
        }
        if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| Error::Other("failed to build relative path".into()))?;
            out.insert(
                rel_to_slash(rel),
                FileFingerprint {
                    kind: "file".into(),
                    len: meta.len(),
                    modified_ms: modified_ms(&meta),
                    hash: hash_file(&path)?,
                },
            );
        }
    }
    Ok(())
}

fn path_allowed(path: &str, allowed_paths: &[String]) -> bool {
    allowed_paths.iter().any(|allowed| {
        allowed == "."
            || path == allowed
            || path
                .strip_prefix(allowed)
                .is_some_and(|tail| tail.starts_with('/'))
    })
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<u128> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn hash_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(Error::from)?;
    let mut hasher = Fnv64::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buf).map_err(Error::from)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:016x}", hasher.finish()))
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Fnv64::new();
    hasher.update(bytes);
    format!("{:016x}", hasher.finish())
}

struct Fnv64(u64);

impl Fnv64 {
    fn new() -> Self {
        Self(0xcbf29ce484222325)
    }

    fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    fn finish(self) -> u64 {
        self.0
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn is_inside_or_equal(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn rel_to_slash(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}
