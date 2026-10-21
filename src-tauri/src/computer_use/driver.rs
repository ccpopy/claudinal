//! Reviewed CuaDriver stdio adapter. Always starts with an explicit bounded policy.
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use super::{platform, types::AppInfo};
use crate::{
    error::{Error, Result},
    proc::ProcessTree,
};

pub const PINNED_RELEASE: &str = "0.37.0";
const MAX_DRIVER_LINE: usize = 12 * 1024 * 1024;
const REQUEST_DEADLINE: Duration = Duration::from_secs(8);
const MAX_ARCHIVE: usize = 40 * 1024 * 1024;
const MAX_EXECUTABLE: u64 = 180 * 1024 * 1024;
// Rotate well before the manifest's own `expires_after`/`idle_timeout` so a
// long conversation never reaches a driver whose capability has lapsed.
const ROTATE_AFTER: Duration = Duration::from_secs(9 * 60);
const ROTATE_IDLE: Duration = Duration::from_secs(100);
pub const ACTION_TOOLS: &[&str] = &["get_window_state", "scroll", "type_text", "press_key"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evidence {
    pub path: PathBuf,
    pub sha256: String,
    pub version: String,
    pub managed: bool,
    #[serde(default)]
    pub companions: Vec<(PathBuf, String)>,
}

pub fn fingerprint(path: &Path) -> Result<String> {
    let file = std::fs::File::open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() > MAX_EXECUTABLE {
        return Err(Error::Other(
            "Driver must be a bounded local executable file.".into(),
        ));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut reader = file.take(MAX_EXECUTABLE + 1);
    loop {
        let len = reader.read(&mut buffer)?;
        if len == 0 {
            break;
        }
        hash.update(&buffer[..len]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn manifest(apps: &[AppInfo], health: bool) -> Value {
    json!({
        "version": 3,
        "expires_after": "10m",
        "idle_timeout": "2m",
        "allow": { "tools": if health { vec!["check_permissions"] } else { ACTION_TOOLS.to_vec() } },
        "resources": { "desktop": { "display": false, "windows": apps.iter().map(|app| json!({
            "pid": app.pid, "window_id": app.window_id.parse::<u64>().unwrap_or(0)
        })).collect::<Vec<_>>() } }
    })
}

pub struct Driver {
    child: Mutex<Option<Child>>,
    tree: Mutex<Option<ProcessTree>>,
    stdin: Arc<Mutex<ChildStdin>>,
    responses: tokio::sync::Mutex<mpsc::Receiver<std::result::Result<Value, String>>>,
    serial: AtomicU64,
    manifest_path: PathBuf,
    started: Instant,
    last_used: Mutex<Instant>,
}

impl Driver {
    /// Called while the host generation lock is held, so revoke cannot race a spawn.
    pub fn start_in(
        evidence: &Evidence,
        apps: &[AppInfo],
        health: bool,
        data_dir: &Path,
    ) -> Result<Arc<Self>> {
        if fingerprint(&evidence.path)? != evidence.sha256 {
            return Err(Error::Other(
                "The selected driver changed since verification. Select it again.".into(),
            ));
        }
        for (path, expected) in &evidence.companions {
            if fingerprint(path)? != *expected {
                return Err(Error::Other("A selected driver companion changed since verification. Select or install it again.".into()));
            }
        }
        let directory = data_dir.join("manifests");
        std::fs::create_dir_all(&directory)?;
        let manifest_path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
        let mut manifest_file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&manifest_path)?;
        serde_json::to_writer(&mut manifest_file, &manifest(apps, health))?;
        manifest_file.sync_all()?;
        let mut command = Command::new(&evidence.path);
        command
            .arg("mcp")
            .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0")
            .env("DO_NOT_TRACK", "1")
            .env("CUA_DRIVER_PERMISSION_MODE", "bounded")
            .env("CUA_DRIVER_CAPABILITY_MANIFEST_FILE", &manifest_path)
            .env("CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED", "1")
            // Never attach to a service/socket whose capability policy we do not own.
            .env_remove("CUA_DRIVER_SOCKET")
            .env_remove("CUA_DRIVER_AUTH_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::child_process::hide_std_window(&mut command);
        let child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                let _ = std::fs::remove_file(&manifest_path);
                return Err(err.into());
            }
        };
        Self::from_child(child, manifest_path)
    }

    fn from_child(mut child: Child, manifest_path: PathBuf) -> Result<Arc<Self>> {
        let tree = match ProcessTree::attach_std(&child) {
            Ok(tree) => tree,
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&manifest_path);
                return Err(err.into());
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Other("Driver stdin is unavailable.".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Other("Driver stdout is unavailable.".into()))?;
        let (send, receive) = mpsc::channel(8);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let line = read_bounded_line(&mut reader, MAX_DRIVER_LINE);
                let value = match line {
                    Ok(Some(line)) => serde_json::from_slice(&line)
                        .map_err(|_| "Driver returned invalid JSON.".to_string()),
                    Ok(None) => break,
                    Err(_) => {
                        Err("Driver response exceeded its byte budget or its output failed.".into())
                    }
                };
                let failed = value.is_err();
                if send.blocking_send(value).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Arc::new(Self {
            child: Mutex::new(Some(child)),
            tree: Mutex::new(Some(tree)),
            stdin: Arc::new(Mutex::new(stdin)),
            responses: tokio::sync::Mutex::new(receive),
            serial: AtomicU64::new(1),
            manifest_path,
            started: Instant::now(),
            last_used: Mutex::new(Instant::now()),
        }))
    }

    #[cfg(test)]
    pub(super) fn from_test_child(child: Child, manifest_path: PathBuf) -> Result<Arc<Self>> {
        Self::from_child(child, manifest_path)
    }

    pub async fn initialize(&self) -> Result<String> {
        let response = self.request("initialize", json!({"protocolVersion":"2024-11-05", "capabilities":{},
            "clientInfo":{"name":"claudinal-computer-gateway","version":env!("CARGO_PKG_VERSION")}})).await?;
        let version = response
            .pointer("/serverInfo/version")
            .and_then(Value::as_str)
            .filter(|version| !version.is_empty() && version.len() < 128)
            .ok_or_else(|| Error::Other("Driver initialize did not identify its version.".into()))?
            .to_string();
        self.write(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await?;
        let tools = self.request("tools/list", json!({})).await?;
        validate_catalog(&tools)?;
        Ok(version)
    }

    async fn write(&self, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        if bytes.len() > 128 * 1024 {
            return Err(Error::Other(
                "Driver request exceeds its byte budget.".into(),
            ));
        }
        let writer = self.stdin.clone();
        let write = tokio::task::spawn_blocking(move || -> Result<()> {
            let mut stdin = writer
                .lock()
                .map_err(|_| Error::Other("Driver writer failed.".into()))?;
            stdin.write_all(&bytes)?;
            stdin.write_all(b"\n")?;
            stdin.flush()?;
            Ok(())
        });
        match tokio::time::timeout(Duration::from_secs(3), write).await {
            Ok(result) => result.map_err(|error| Error::Other(error.to_string()))?,
            Err(_) => {
                self.kill();
                Err(Error::Other(
                    "Driver stdin write timed out; delivery is uncertain and will not be replayed."
                        .into(),
                ))
            }
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.serial.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let mut responses = self.responses.lock().await;
        tokio::time::timeout(REQUEST_DEADLINE.saturating_sub(started.elapsed()), async {
            for _ in 0..64 {
                let response = responses
                    .recv()
                    .await
                    .ok_or_else(|| {
                        Error::Other("Driver disconnected; the action will not be replayed.".into())
                    })?
                    .map_err(Error::Other)?;
                if response.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if response.get("error").is_some() {
                    return Err(Error::Other(
                        "Driver rejected the request; no automatic replay is permitted.".into(),
                    ));
                }
                return response
                    .get("result")
                    .cloned()
                    .ok_or_else(|| Error::Other("Driver returned no result.".into()));
            }
            Err(Error::Other(
                "Driver exceeded its notification budget.".into(),
            ))
        })
        .await
        .map_err(|_| {
            Error::Other(
                "Driver response timed out; action delivery is uncertain and will not be replayed."
                    .into(),
            )
        })?
    }

    /// True when the bounded manifest is close to lapsing or the process exited.
    pub fn needs_rotation(&self) -> bool {
        let idle = self
            .last_used
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .elapsed();
        let exited = self
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
            .is_none_or(|child| !matches!(child.try_wait(), Ok(None)));
        exited || self.started.elapsed() >= ROTATE_AFTER || idle >= ROTATE_IDLE
    }

    pub async fn call(&self, name: &str, arguments: Value) -> Result<Value> {
        *self.last_used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        let result = self
            .request("tools/call", json!({"name":name,"arguments":arguments}))
            .await;
        *self.last_used.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        let result = result?;
        if !result.is_object()
            || !result.get("content").is_some_and(Value::is_array)
            || result
                .get("isError")
                .is_some_and(|value| !value.is_boolean())
        {
            return Err(Error::Other(
                "Driver returned an invalid MCP tool result. No action will be replayed.".into(),
            ));
        }
        Ok(result)
    }

    /// No await, no end_session dependency. The host revokes first, then kills.
    pub fn kill(&self) {
        self.tree.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(child) = self
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            let _ = child.kill();
        }
    }

    pub fn reap(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_millis(1500);
        loop {
            let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
            let Some(child) = guard.as_mut() else {
                return Ok(());
            };
            if child.try_wait()?.is_some() {
                guard.take();
                return Ok(());
            }
            drop(guard);
            if Instant::now() >= deadline {
                return Err(Error::Other("Driver termination was not confirmed within 1500 ms. Computer access remains disabled.".into()));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        self.kill();
        let _ = std::fs::remove_file(&self.manifest_path);
    }
}

pub fn read_bounded_line(
    reader: &mut impl BufRead,
    limit: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "Incomplete JSON line",
                ))
            };
        }
        let end = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(bytes.len());
        if line.len() + end > limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "JSON line limit",
            ));
        }
        let finished = bytes[end - 1] == b'\n';
        line.extend_from_slice(&bytes[..end]);
        reader.consume(end);
        if finished {
            return Ok(Some(line));
        }
    }
}

fn validate_catalog(catalog: &Value) -> Result<()> {
    let tools = catalog
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Other("Driver tools/list is invalid.".into()))?;
    for name in ACTION_TOOLS.iter().copied().chain(["check_permissions"]) {
        let tool = tools
            .iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
            .ok_or_else(|| {
                Error::Other(format!("Driver does not expose the required {name} tool."))
            })?;
        let properties = tool
            .pointer("/inputSchema/properties")
            .and_then(Value::as_object)
            .ok_or_else(|| Error::Other(format!("Driver {name} schema is unsupported.")))?;
        let required_fields: &[&str] = match name {
            "get_window_state" => &[
                "pid",
                "window_id",
                "include_accessibility_tree",
                "include_screenshot",
                "max_image_dimension",
            ],
            "click" => &["pid", "window_id", "capture_id", "x", "y", "delivery_mode"],
            "scroll" => &["pid", "window_id", "direction", "delivery_mode"],
            "type_text" => &["pid", "window_id", "text", "delivery_mode"],
            "press_key" => &["pid", "window_id", "key", "modifiers", "delivery_mode"],
            _ => &[],
        };
        if required_fields
            .iter()
            .any(|field| !properties.contains_key(*field))
        {
            return Err(Error::Other(format!(
                "Driver {name} targeting schema is incompatible."
            )));
        }
    }
    Ok(())
}

pub async fn probe(path: PathBuf, managed: bool) -> Result<Evidence> {
    probe_in(path, managed, &platform::data_dir()?).await
}

pub async fn probe_in(path: PathBuf, managed: bool, data_dir: &Path) -> Result<Evidence> {
    if !cfg!(windows) {
        return Err(Error::Other(
            "CuaDriver computer control is only supported on Windows.".into(),
        ));
    }
    let path = std::fs::canonicalize(path)?;
    if path
        .extension()
        .and_then(|part| part.to_str())
        .is_none_or(|part| !part.eq_ignore_ascii_case("exe"))
    {
        return Err(Error::Other(
            "Select a local Windows CuaDriver .exe file.".into(),
        ));
    }
    let hash_path = path.clone();
    let sha256 = tokio::task::spawn_blocking(move || fingerprint(&hash_path))
        .await
        .map_err(|e| Error::Other(e.to_string()))??;
    let mut companions = Vec::new();
    if let Some(parent) = path.parent() {
        for name in [
            "cua-driver-uia.exe",
            "cua-cursor-theme.exe",
            "cua_driver_sdk.dll",
            "cua_driver_node_runtime.node",
        ] {
            let companion = parent.join(name);
            if companion.exists() {
                companions.push((companion.clone(), fingerprint(&companion)?));
            }
        }
    }
    let mut evidence = Evidence {
        path,
        sha256,
        managed,
        version: String::new(),
        companions,
    };
    let start_evidence = evidence.clone();
    let start_directory = data_dir.to_path_buf();
    let driver = tokio::task::spawn_blocking(move || {
        Driver::start_in(&start_evidence, &[], true, &start_directory)
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))??;
    let result = async {
        let version = driver.initialize().await?;
        let health = driver.call("check_permissions", json!({})).await?;
        if health
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(Error::Other(
                "Driver permission metadata probe failed.".into(),
            ));
        }
        Ok(version)
    }
    .await;
    driver.kill();
    let reap_driver = driver.clone();
    tokio::task::spawn_blocking(move || reap_driver.reap())
        .await
        .map_err(|e| Error::Other(e.to_string()))??;
    evidence.version = result?;
    Ok(evidence)
}

pub async fn install() -> Result<Evidence> {
    let (architecture, checksum) = if cfg!(all(windows, target_arch = "x86_64")) {
        (
            "x86_64",
            "40481b55073f1225b0010235b30217bd640ef1f323e982aec0a5f6131d3e4a99",
        )
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        (
            "arm64",
            "0fce682b251775e25fd76bf29ff856f7f5ab5aae5759d6b76a40f8312a194a5a",
        )
    } else {
        return Err(Error::Other(
            "No managed Windows driver is available for this architecture.".into(),
        ));
    };
    let asset = format!("cua-driver-rs-{PINNED_RELEASE}-windows-{architecture}-binary.zip");
    let url = format!(
        "https://github.com/trycua/cua/releases/download/cua-driver-rs-v{PINNED_RELEASE}/{asset}"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| Error::Other(e.to_string()))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| Error::Other(e.to_string()))?
        .error_for_status()
        .map_err(|e| Error::Other(e.to_string()))?;
    if response
        .content_length()
        .is_some_and(|len| len > MAX_ARCHIVE as u64)
    {
        return Err(Error::Other(
            "Driver archive exceeds its size budget.".into(),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| Error::Other(e.to_string()))?
    {
        if bytes.len() + chunk.len() > MAX_ARCHIVE {
            return Err(Error::Other(
                "Driver archive exceeds its size budget.".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if format!("{:x}", Sha256::digest(&bytes)) != checksum {
        return Err(Error::Other(
            "Pinned driver archive checksum mismatch. Installation cancelled.".into(),
        ));
    }
    let bundle = format!("cua-driver-{PINNED_RELEASE}-{architecture}");
    let root = platform::install_root()?;
    // Extract beside the final directory, then swap it in, so a failed or
    // interrupted install never leaves a half-written driver at the final path.
    let staging = root.join(format!(".{bundle}-{}", uuid::Uuid::new_v4().simple()));
    let final_directory = root.join(&bundle);
    let directory = staging.clone();
    let extracted = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
            .map_err(|e| Error::Other(e.to_string()))?;
        std::fs::create_dir_all(&directory)?;
        if archive.len() > 64 {
            return Err(Error::Other(
                "Driver bundle contains too many entries.".into(),
            ));
        }
        let mut executable = None;
        let mut total = 0u64;
        let mut paths = std::collections::HashSet::new();
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|e| Error::Other(e.to_string()))?;
            let relative = entry
                .enclosed_name()
                .ok_or_else(|| Error::Other("Driver archive contains an unsafe path.".into()))?;
            if !paths.insert(relative.clone())
                || entry
                    .unix_mode()
                    .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(Error::Other(
                    "Driver archive contains a duplicate path or symlink.".into(),
                ));
            }
            let target = directory.join(&relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&target)?;
                continue;
            }
            total = total
                .checked_add(entry.size())
                .ok_or_else(|| Error::Other("Driver archive size overflow.".into()))?;
            if entry.size() > MAX_EXECUTABLE || total > 300 * 1024 * 1024 {
                return Err(Error::Other(
                    "Driver bundle exceeds its extracted size budget.".into(),
                ));
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?;
            let written = std::io::copy(&mut entry.by_ref().take(MAX_EXECUTABLE + 1), &mut output)?;
            if written > MAX_EXECUTABLE {
                return Err(Error::Other(
                    "Driver bundle entry exceeded its declared bound.".into(),
                ));
            }
            output.sync_all()?;
            if relative.file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .eq_ignore_ascii_case("cua-driver.exe")
            }) {
                if executable.is_some() {
                    return Err(Error::Other(
                        "Driver archive contains multiple executables with the driver name.".into(),
                    ));
                }
                executable = Some(target);
            }
        }
        std::fs::write(
            directory.join("LICENSE-CuaDriver.txt"),
            include_str!("LICENSE-CuaDriver.txt"),
        )?;
        executable.ok_or_else(|| {
            Error::Other("Pinned driver archive did not contain the driver executable.".into())
        })
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))?;
    let extracted = match extracted {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let path = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
        let relative = extracted
            .strip_prefix(&staging)
            .map_err(|_| Error::Other("Driver bundle layout is invalid.".into()))?
            .to_path_buf();
        // A locked previous copy (still exiting) keeps the staged copy in place.
        if final_directory.exists() && std::fs::remove_dir_all(&final_directory).is_err() {
            return Ok(extracted);
        }
        match std::fs::rename(&staging, &final_directory) {
            Ok(()) => Ok(final_directory.join(relative)),
            Err(_) => Ok(extracted),
        }
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))??;
    probe(path, true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifests_are_deny_default_and_exact_window_scoped() {
        let manifest = manifest(&[], true);
        assert_eq!(manifest["resources"]["desktop"]["display"], false);
        assert_eq!(manifest["resources"]["desktop"]["windows"], json!([]));
        assert_eq!(manifest["allow"]["tools"], json!(["check_permissions"]));
        assert!(manifest.get("expires_after").is_some());
        assert!(manifest.get("idle_timeout").is_some());
        let action = super::manifest(&[], false);
        assert!(!action["allow"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "click"));
    }
    #[test]
    fn bounded_reader_rejects_oversized_and_partial_output() {
        assert!(read_bounded_line(&mut &b"123456\n"[..], 4).is_err());
        assert!(read_bounded_line(&mut &b"{}"[..], 4).is_err());
        assert_eq!(
            read_bounded_line(&mut &b"{}\n"[..], 4).unwrap(),
            Some(b"{}\n".to_vec())
        );
    }

    #[cfg(windows)]
    fn fake_driver(directory: &Path, read_request: bool) -> Arc<Driver> {
        Driver::from_test_child(
            fake_child(directory, read_request),
            directory.join("manifest.json"),
        )
        .unwrap()
    }

    #[cfg(windows)]
    fn fake_child(directory: &Path, read_request: bool) -> Child {
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let script = if read_request {
            "$null=[Console]::In.ReadLine(); [IO.File]::WriteAllText($env:CLAUDINAL_FAKE_MARKER,'admitted'); Start-Sleep -Seconds 30; [IO.File]::WriteAllText($env:CLAUDINAL_FAKE_LATE,'replayed')"
        } else {
            "[IO.File]::WriteAllText($env:CLAUDINAL_FAKE_MARKER,'nonreading'); Start-Sleep -Seconds 30; [IO.File]::WriteAllText($env:CLAUDINAL_FAKE_LATE,'replayed')"
        };
        let mut command = Command::new(shell);
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ])
            .env("CLAUDINAL_FAKE_MARKER", directory.join("admitted"))
            .env("CLAUDINAL_FAKE_LATE", directory.join("late"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::child_process::hide_std_window(&mut command);
        command.spawn().unwrap()
    }

    #[cfg(windows)]
    async fn admitted(directory: &Path) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !directory.join("admitted").is_file() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn rotation_child() {
        let Some(directory) = std::env::var_os("CLAUDINAL_ROTATION_TEST_CHILD") else {
            return;
        };
        let directory = PathBuf::from(directory);
        assert!(directory.is_absolute());
        assert!(directory
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("claudinal-driver-renewal-"));
        std::fs::write(directory.join("admitted"), b"ready").unwrap();
        std::thread::sleep(Duration::from_secs(30));
        std::fs::write(directory.join("late"), b"replayed").unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn expired_driver_is_reaped_without_revoking_approved_windows() {
        use super::super::{broker, state::State, types::Tier, Core};
        struct PendingChild(Option<Child>);
        impl Drop for PendingChild {
            fn drop(&mut self) {
                if let Some(child) = self.0.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        let directory =
            std::env::temp_dir().join(format!("claudinal-driver-renewal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        // This test exercises process lifetime only, so it does not consume the
        // harness stdout as MCP frames. Reuse the test binary rather than tying
        // readiness to a cold PowerShell/.NET startup on parallel CI runners.
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "computer_use::driver::tests::rotation_child",
                "--test-threads=1",
            ])
            .env("CLAUDINAL_ROTATION_TEST_CHILD", &directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::child_process::hide_std_window(&mut command);
        let mut pending = PendingChild(Some(command.spawn().unwrap()));
        // Wait before attaching the MCP reader: its strict frame parser closes
        // harness stdout, which must not interrupt the child's startup banner.
        // The guard still kills/reaps the child if the readiness assertion fails.
        admitted(&directory).await;
        let mut driver =
            Driver::from_test_child(pending.0.take().unwrap(), directory.join("manifest.json"))
                .unwrap();
        assert!(!driver.needs_rotation());
        let now = Instant::now();
        Arc::get_mut(&mut driver).unwrap().started = now - ROTATE_AFTER;
        assert!(driver.needs_rotation());
        Arc::get_mut(&mut driver).unwrap().started = now;
        *driver.last_used.lock().unwrap() = now - ROTATE_IDLE;
        assert!(driver.needs_rotation());

        let app = AppInfo {
            window_witness: None,
            app_id: "approved-fixture".into(),
            name: "fixture".into(),
            path: "C:\\fixture.exe".into(),
            pid: 1,
            window_id: "2".into(),
            title: "fixture".into(),
            tier: Tier::Full,
        };
        let mut state = State::default();
        state.register("owner", "fixture", true).unwrap();
        state.owner = Some("owner".into());
        state
            .runtimes
            .get_mut("owner")
            .unwrap()
            .grants
            .insert(app.app_id.clone(), app.clone());
        state.driver = Some(driver.clone());
        let core = Core {
            app: None,
            state: Mutex::new(state),
            action: Arc::new(tokio::sync::Mutex::new(())),
            broker_port: 1,
            data_dir: directory.clone(),
            worker_executable: None,
        };
        let started = Instant::now();
        assert!(
            broker::reuse_or_retire_driver(&core, "owner", 1, &app.app_id)
                .unwrap()
                .is_none()
        );
        assert!(started.elapsed() < Duration::from_millis(1800));
        assert!(
            driver.child.lock().unwrap().is_none(),
            "exit must be confirmed before removing the state receipt"
        );
        assert!(core.lock().driver.is_none());
        assert!(core.lock().authorize("owner", 1, &app.app_id).is_ok());
        assert!(!directory.join("late").exists());
        drop(driver);
        std::fs::remove_file(directory.join("admitted")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn revoke_kills_hung_owned_driver_before_cleanup_and_never_replays() {
        use super::super::{
            state::State,
            types::{AppInfo, Tier},
        };
        let directory =
            std::env::temp_dir().join(format!("claudinal-driver-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let driver = fake_driver(&directory, true);
        let worker_directory = directory.join("window-worker");
        std::fs::create_dir(&worker_directory).unwrap();
        let worker = super::super::window_executor::Worker::from_test_child(fake_child(
            &worker_directory,
            false,
        ))
        .unwrap();
        let pending_worker = worker.clone();
        let worker_reply = tokio::spawn(async move { pending_worker.receive().await });
        let request_driver = driver.clone();
        let pending = tokio::spawn(async move {
            request_driver
                .request("tools/call", json!({"name":"fixture_action"}))
                .await
        });
        admitted(&directory).await;
        admitted(&worker_directory).await;
        let mut state = State::default();
        state.driver_status.state = "ready".into();
        state.register("captured", "fixture", true).unwrap();
        let app = AppInfo {
            window_witness: None,
            app_id: "fake:window:lifetime".into(),
            name: "fake".into(),
            path: "C:\\fixture.exe".into(),
            pid: 1,
            window_id: "1".into(),
            title: "fake".into(),
            tier: Tier::Full,
        };
        let request = state.request("captured", app.clone(), 1).unwrap();
        state
            .respond("captured", &request.request_id, true, || {
                Ok(std::fs::File::create(directory.join("lease"))?)
            })
            .unwrap();
        state.driver = Some(driver.clone());
        state.worker = Some(worker.clone());
        let started = Instant::now();
        let cleanup = state
            .revoke("captured", "interrupt_requested", false)
            .unwrap();
        assert!(state.authorize("captured", 1, &app.app_id).is_err());
        assert!(state.runtimes["captured"].pending.is_empty());
        tokio::task::spawn_blocking(move || super::super::state::run_cleanup(cleanup))
            .await
            .unwrap()
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(1800));
        assert!(tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(!directory.join("late").exists());
        assert!(tokio::time::timeout(Duration::from_secs(1), worker_reply)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(!worker_directory.join("late").exists());
        drop(worker);
        std::fs::remove_file(worker_directory.join("admitted")).unwrap();
        std::fs::remove_dir(worker_directory).unwrap();
        drop(driver);
        std::fs::remove_file(directory.join("admitted")).unwrap();
        std::fs::remove_file(directory.join("lease")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn nonreading_driver_write_has_deadline_and_is_hard_killed() {
        let directory =
            std::env::temp_dir().join(format!("claudinal-driver-write-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let driver = fake_driver(&directory, false);
        admitted(&directory).await;
        let started = Instant::now();
        let result = driver
            .request("tools/call", json!({"text":"x".repeat(100_000)}))
            .await;
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(result.unwrap_err().to_string().contains("write timed out"));
        let reaper = driver.clone();
        tokio::task::spawn_blocking(move || reaper.reap())
            .await
            .unwrap()
            .unwrap();
        assert!(!directory.join("late").exists());
        drop(driver);
        std::fs::remove_file(directory.join("admitted")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
