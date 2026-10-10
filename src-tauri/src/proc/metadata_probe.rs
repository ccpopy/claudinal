//! Isolated syntax evidence only. No account configuration or model input is read.
use super::capabilities::{CliCapabilities, Support};
use super::runtime_controls;
use super::supervisor::{supervise, ProcessTree};
use super::transport::{read_line, write_frame};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::sync::{watch, Mutex, OnceCell};

const DEADLINE: Duration = Duration::from_secs(8);
const LINE_LIMIT: usize = 256 * 1024;
const OUTPUT_LIMIT: usize = 1024 * 1024;
const FRAME_LIMIT: usize = 64;

#[derive(Clone, Debug)]
pub struct Evidence {
    pub control: Support,
    pub ultra: Support,
    pub fast: Support,
    pub reason: &'static str,
}
impl Evidence {
    fn unknown(reason: &'static str) -> Self {
        Self {
            control: Support::Unknown,
            ultra: Support::Unknown,
            fast: Support::Unknown,
            reason,
        }
    }
    pub fn apply(&self, caps: &mut CliCapabilities) {
        caps.runtime_settings_control = self.control;
        caps.independent_ultracode = self.ultra;
        caps.headless_fast_mode = self.fast;
        caps.settings_probe_evidence = "metadata";
        caps.settings_probe_reason = self.reason;
        caps.evidence.insert("runtimeSettingsControl", "isolated get_settings shape and apply_flag_settings acknowledgement; no account qualification");
        caps.evidence.insert("independentUltracode", "isolated independent requested/applied fields and flag acknowledgement; availability is not certification");
        caps.evidence.insert("headlessFastMode", "isolated Fast metadata and flag acknowledgement; account/upstream eligibility unverified");
        caps.certification =
            "isolated syntax metadata only; account and model-request eligibility unverified";
    }
}

#[derive(Default)]
pub struct Cache {
    entries: Mutex<VecDeque<(String, Instant, Arc<OnceCell<Evidence>>)>>,
}
impl Cache {
    pub async fn clear(&self) {
        self.entries
            .lock()
            .await
            .retain(|(_, _, cell)| cell.get().is_none());
    }
    pub async fn refresh(&self, fingerprint: &str) {
        self.entries.lock().await.retain(|(key, _, cell)| {
            key != fingerprint
                || !cell
                    .get()
                    .is_some_and(|evidence| evidence.reason != "confirmed")
        });
    }
    pub async fn get(&self, path: &Path, fingerprint: &str) -> Evidence {
        self.get_with(fingerprint, || probe(path)).await
    }
    async fn get_with<F, Fut>(&self, fingerprint: &str, initialize: F) -> Evidence
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Evidence>,
    {
        let cell = {
            let mut entries = self.entries.lock().await;
            entries.retain(|(_, created, cell)| {
                !cell.get().is_some_and(|evidence| {
                    evidence.reason != "confirmed" && created.elapsed() > Duration::from_secs(3)
                })
            });
            if let Some((_, _, cell)) = entries.iter().find(|(key, _, _)| key == fingerprint) {
                cell.clone()
            } else {
                let cell = Arc::new(OnceCell::new());
                // Keep in-flight entries so concurrent callers remain single-flight.
                if entries.len() >= 16 {
                    if let Some(index) =
                        entries.iter().position(|(_, _, cell)| cell.get().is_some())
                    {
                        entries.remove(index);
                    } else {
                        return Evidence::unknown("limit_exceeded");
                    }
                }
                entries.push_back((fingerprint.into(), Instant::now(), cell.clone()));
                cell
            }
        };
        cell.get_or_init(initialize).await.clone()
    }
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> std::io::Result<Self> {
        let root =
            std::env::temp_dir().join(format!("claudinal-metadata-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        let scratch = Self(root);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&scratch.0, std::fs::Permissions::from_mode(0o700))?;
        }
        for folder in [
            "config",
            "storage",
            "profile",
            "appdata",
            "localappdata",
            "temp",
        ] {
            std::fs::create_dir(scratch.0.join(folder))?;
        }
        std::fs::write(
            scratch.0.join("settings.json"),
            br#"{"disableAllHooks":true,"hooks":{},"ultracode":false,"fastMode":false}"#,
        )?;
        std::fs::write(scratch.0.join("mcp.json"), br#"{"mcpServers":{}}"#)?;
        Ok(scratch)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn command(path: &Path, scratch: &Scratch) -> crate::error::Result<tokio::process::Command> {
    // --bare suppresses OS keychain reads as well as plugin synchronization and
    // hooks. An older CLI rejecting this safety flag remains unknown.
    let mut args: Vec<String> = [
        "-p",
        "--bare",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    args.push(scratch.0.join("mcp.json").display().to_string());
    args.extend([
        "--settings".into(),
        scratch.0.join("settings.json").display().to_string(),
    ]);
    args.extend(
        [
            "--tools",
            "",
            "--disable-slash-commands",
            "--no-chrome",
            "--no-session-persistence",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    let mut cmd = crate::commands::claude_runtime_command(path, &args)?;
    cmd.env_clear();
    for key in ["PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    for (key, folder) in [
        ("CLAUDE_CONFIG_DIR", "config"),
        ("CLAUDE_SECURESTORAGE_CONFIG_DIR", "storage"),
        ("HOME", "profile"),
        ("USERPROFILE", "profile"),
        ("APPDATA", "appdata"),
        ("LOCALAPPDATA", "localappdata"),
        ("TEMP", "temp"),
        ("TMP", "temp"),
    ] {
        cmd.env(key, scratch.0.join(folder));
    }
    cmd.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    crate::child_process::hide_tokio_window(&mut cmd);
    cmd.current_dir(&scratch.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Ok(cmd)
}

struct Reader<R> {
    stream: R,
    bytes: Arc<AtomicUsize>,
    frames: usize,
}
impl<R: tokio::io::AsyncBufRead + Unpin> Reader<R> {
    async fn reply(&mut self, id: &str) -> Result<Value, &'static str> {
        loop {
            let line = read_line(&mut self.stream, LINE_LIMIT)
                .await
                .map_err(|_| "limit_exceeded")?
                .ok_or("invalid_response")?;
            let bytes = self
                .bytes
                .fetch_add(line.len(), Ordering::Relaxed)
                .saturating_add(line.len());
            self.frames += 1;
            if bytes > OUTPUT_LIMIT || self.frames > FRAME_LIMIT {
                return Err("limit_exceeded");
            }
            if line.trim().is_empty() {
                continue;
            }
            #[cfg(test)]
            if line.trim() == "running 1 test" {
                continue;
            }
            let frame: Value = serde_json::from_str(&line).map_err(|_| "invalid_response")?;
            if frame.get("type").and_then(Value::as_str) != Some("control_response") {
                continue;
            }
            let response = frame.get("response").ok_or("invalid_response")?;
            if response.get("request_id").and_then(Value::as_str) != Some(id) {
                continue;
            }
            match response.get("subtype").and_then(Value::as_str) {
                Some("success") => {
                    // apply_flag_settings uses a bare success ACK. Payload shape
                    // is separately required for initialize/get_settings.
                    return match response.get("response") {
                        None => Ok(json!({})),
                        Some(value) if value.is_object() => Ok(value.clone()),
                        _ => Err("invalid_response"),
                    };
                }
                Some("error") => {
                    #[cfg(test)]
                    eprintln!(
                        "metadata control refused at {id}; unsupported-subtype={}",
                        response.get("error").and_then(Value::as_str).is_some_and(
                            |error| error.starts_with("Unsupported control request subtype:")
                        )
                    );
                    return Err(
                        if response
                            .get("error")
                            .and_then(Value::as_str)
                            .is_some_and(|error| {
                                error.starts_with("Unsupported control request subtype:")
                            })
                        {
                            "unsupported"
                        } else {
                            "invalid_response"
                        },
                    );
                }
                _ => return Err("invalid_response"),
            }
        }
    }
}

struct StopOnDrop(watch::Sender<bool>);
impl Drop for StopOnDrop {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}
async fn request<R: tokio::io::AsyncBufRead + Unpin>(
    stdin: &mut tokio::process::ChildStdin,
    reader: &mut Reader<R>,
    id: &str,
    request: Value,
) -> Result<Value, &'static str> {
    let body = format!(
        "{}\n",
        json!({"type":"control_request","request_id":id,"request":request})
    );
    write_frame(stdin, body.as_bytes(), Duration::from_secs(1))
        .await
        .map_err(|_| "invalid_response")?;
    let result = reader.reply(id).await;
    #[cfg(test)]
    if result.is_err() {
        eprintln!("metadata probe step {id}: {:?}", result.as_ref().err());
    }
    result
}

pub async fn probe(path: &Path) -> Evidence {
    let Ok(scratch) = Scratch::new() else {
        return Evidence::unknown("launch_failed");
    };
    let Ok(cmd) = command(path, &scratch) else {
        return Evidence::unknown("launch_failed");
    };
    execute(cmd, scratch, DEADLINE).await
}

async fn execute(
    mut cmd: tokio::process::Command,
    scratch: Scratch,
    deadline: Duration,
) -> Evidence {
    let Ok(mut child) = cmd.spawn() else {
        return Evidence::unknown("launch_failed");
    };
    let tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(_) => {
            let _ = child.kill().await;
            return Evidence::unknown("launch_failed");
        }
    };
    let (Some(mut stdin), Some(stdout), Some(mut stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        drop(tree);
        let _ = child.kill().await;
        return Evidence::unknown("launch_failed");
    };
    let (stop_tx, stop_rx) = watch::channel(false);
    let _stop_on_drop = StopOnDrop(stop_tx.clone());
    let owner = tokio::spawn(async move {
        let result = supervise(child, stop_rx, tree).await;
        drop(scratch);
        result
    });
    let stderr_stop = stop_tx.clone();
    let bytes = Arc::new(AtomicUsize::new(0));
    let stderr_bytes = bytes.clone();
    let stderr_task = tokio::spawn(async move {
        let mut buf = [0; 8192];
        loop {
            let count = stderr
                .read(&mut buf)
                .await
                .map_err(|_| "invalid_response")?;
            if count == 0 {
                return Ok::<_, &'static str>(());
            }
            let total = stderr_bytes
                .fetch_add(count, Ordering::Relaxed)
                .saturating_add(count);
            if total > OUTPUT_LIMIT {
                let _ = stderr_stop.send(true);
                return Err("limit_exceeded");
            }
        }
    });
    let mut reader = Reader {
        stream: BufReader::new(stdout),
        bytes,
        frames: 0,
    };
    let mut evidence = Evidence::unknown("invalid_response");
    let exchange = async {
        let init = request(
            &mut stdin,
            &mut reader,
            "metadata-init",
            json!({"subtype":"initialize"}),
        )
        .await?;
        if init
            .pointer("/account/tokenSource")
            .and_then(Value::as_str)
            .is_some_and(|source| source != "none")
        {
            #[cfg(test)]
            eprintln!("metadata probe unexpectedly found tokenSource; discarded");
            return Err("invalid_response");
        }
        let settings = request(
            &mut stdin,
            &mut reader,
            "metadata-settings",
            json!({"subtype":"get_settings"}),
        )
        .await?;
        runtime_controls::validate_settings_reply(&settings).map_err(|_| { #[cfg(test)] eprintln!("metadata settings shape invalid: effective-object={}, applied-object={}, model-present={}, effort-present={}", settings.get("effective").is_some_and(Value::is_object), settings.get("applied").is_some_and(Value::is_object), settings.pointer("/applied/model").is_some(), settings.pointer("/applied/effort").is_some()); "invalid_response" })?;
        request(
            &mut stdin,
            &mut reader,
            "metadata-apply",
            json!({"subtype":"apply_flag_settings","settings":{}}),
        )
        .await?;
        evidence = Evidence {
            control: Support::Supported,
            ultra: Support::Unknown,
            fast: Support::Unknown,
            reason: "confirmed",
        };
        // A false availability value still proves the independent field contract.
        if ["ultracode", "ultracodeRequested", "ultracodeAvailable"]
            .iter()
            .all(|key| settings["applied"].get(*key).is_some_and(Value::is_boolean))
        {
            evidence.ultra = match request(
                &mut stdin,
                &mut reader,
                "metadata-ultra",
                json!({"subtype":"apply_flag_settings","settings":{"ultracode":false}}),
            )
            .await
            {
                Ok(_) => Support::Supported,
                Err("unsupported") => Support::Unsupported,
                Err(reason) => {
                    evidence.reason = reason;
                    Support::Unknown
                }
            };
        }
        if settings
            .pointer("/effective/fastMode")
            .is_some_and(Value::is_boolean)
            && init
                .get("fast_mode_state")
                .and_then(Value::as_str)
                .is_some_and(|state| matches!(state, "on" | "off" | "cooldown"))
        {
            evidence.fast = match request(
                &mut stdin,
                &mut reader,
                "metadata-fast",
                json!({"subtype":"apply_flag_settings","settings":{"fastMode":false}}),
            )
            .await
            {
                Ok(_) => Support::Supported,
                Err("unsupported") => Support::Unsupported,
                Err(reason) => {
                    evidence.reason = reason;
                    Support::Unknown
                }
            };
        }
        Ok::<_, &'static str>(())
    };
    let result = tokio::time::timeout(deadline, exchange)
        .await
        .unwrap_or(Err("timeout"));
    // Closing the supervisor's stop channel also terminates it if this future is cancelled.
    drop(stdin);
    let _ = stop_tx.send(true);
    let _ = owner.await;
    let stderr_result = stderr_task.await;
    if matches!(stderr_result, Ok(Err("limit_exceeded"))) {
        return Evidence::unknown("limit_exceeded");
    }
    match result {
        Ok(()) => evidence,
        Err(reason) if evidence.control == Support::Supported => {
            evidence.reason = reason;
            evidence
        }
        Err("unsupported") => Evidence {
            control: Support::Unsupported,
            ultra: Support::Unknown,
            fast: Support::Unknown,
            reason: "unsupported",
        },
        Err(reason) => Evidence::unknown(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};

    // This executable simulates only control frames; it cannot issue model IO.
    #[test]
    fn fake_metadata_child() {
        let Ok(mode) = std::env::var("CLAUDINAL_METADATA_FAKE") else {
            return;
        };
        std::fs::write("child.pid", std::process::id().to_string()).unwrap();
        if mode == "hang" {
            std::thread::sleep(Duration::from_secs(20));
            std::process::exit(0);
        }
        if mode == "line" {
            println!("{}", "x".repeat(LINE_LIMIT + 1));
            std::thread::sleep(Duration::from_secs(20));
            std::process::exit(0);
        }
        if mode == "stderr" {
            eprint!("{}", "x".repeat(OUTPUT_LIMIT + 1));
            std::io::stderr().flush().unwrap();
            std::thread::sleep(Duration::from_secs(20));
            std::process::exit(0);
        }
        if mode == "frames" {
            for _ in 0..FRAME_LIMIT + 1 {
                println!("{{\"type\":\"system\"}}");
            }
            std::thread::sleep(Duration::from_secs(20));
            std::process::exit(0);
        }
        if mode == "aggregate" {
            for _ in 0..16 {
                println!("{}", json!({"type":"system", "padding":"x".repeat(80_000)}));
            }
            std::thread::sleep(Duration::from_secs(20));
            std::process::exit(0);
        }
        for line in std::io::stdin().lock().lines() {
            let frame: Value = serde_json::from_str(&line.unwrap()).unwrap();
            assert_eq!(frame["type"], "control_request");
            let subtype = frame["request"]["subtype"].as_str().unwrap();
            assert!(matches!(
                subtype,
                "initialize" | "get_settings" | "apply_flag_settings"
            ));
            let id = &frame["request_id"];
            if mode == "ultra_refused" && id == "metadata-ultra" {
                println!(
                    "{}",
                    json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Organization policy denied setting"}})
                );
                std::io::stdout().flush().unwrap();
                continue;
            }
            if mode == "unsupported" || mode == "policy" {
                let error = if mode == "unsupported" {
                    "Unsupported control request subtype: get_settings"
                } else {
                    "Organization policy denied control"
                };
                println!(
                    "{}",
                    json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":error}})
                );
            } else {
                let payload = match subtype {
                    "initialize" => {
                        json!({"fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","account":{"tokenSource":"none"}})
                    }
                    "get_settings" if mode == "malformed" => json!({"effective":{}}),
                    "get_settings" if mode == "missing" => {
                        json!({"effective":{},"applied":{"model":"opus","effort":"low"}})
                    }
                    "get_settings" => {
                        json!({"effective":{"fastMode":false},"applied":{"model":"opus","effort":"low","ultracode":false,"ultracodeRequested":false,"ultracodeAvailable":false}})
                    }
                    _ => json!({}),
                };
                if subtype == "apply_flag_settings" {
                    println!(
                        "{}",
                        json!({"type":"control_response","response":{"subtype":"success","request_id":id}})
                    );
                } else {
                    println!(
                        "{}",
                        json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":payload}})
                    );
                }
            }
            std::io::stdout().flush().unwrap();
        }
        std::process::exit(0);
    }

    fn fake_command(mode: &str, scratch: &Scratch) -> tokio::process::Command {
        let root = scratch.0.clone();
        let mut cmd = tokio::process::Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "proc::metadata_probe::tests::fake_metadata_child",
            "--nocapture",
        ])
        .env("CLAUDINAL_METADATA_FAKE", mode)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }
        crate::child_process::hide_tokio_window(&mut cmd);
        cmd
    }

    async fn fake(mode: &str) -> (Evidence, PathBuf) {
        let scratch = Scratch::new().unwrap();
        let root = scratch.0.clone();
        let cmd = fake_command(mode, &scratch);
        (
            execute(cmd, scratch, Duration::from_millis(600)).await,
            root,
        )
    }

    #[tokio::test]
    async fn protocol_evidence_overrides_older_future_and_unknown_version_hints() {
        let (evidence, scratch) = fake("success").await;
        assert!(!scratch.exists());
        assert_eq!(evidence.control, Support::Supported);
        assert_eq!(evidence.ultra, Support::Supported);
        assert_eq!(evidence.fast, Support::Supported);
        for version in ["2.1.196", "2.1.203", "9.0.0", "unknown"] {
            let mut caps =
                super::super::capabilities::detect(Path::new("claude"), version.into(), "");
            evidence.apply(&mut caps);
            assert_eq!(caps.runtime_settings_control, Support::Supported);
            assert_eq!(caps.independent_ultracode, Support::Supported);
            assert_eq!(caps.headless_fast_mode, Support::Supported);
            assert!(caps.certification.contains("unverified"));
        }
        let (missing, _) = fake("missing").await;
        assert_eq!(missing.control, Support::Supported);
        assert_eq!(missing.ultra, Support::Unknown);
        assert_eq!(missing.fast, Support::Unknown);
        let (partial, _) = fake("ultra_refused").await;
        assert_eq!(partial.control, Support::Supported);
        assert_eq!(partial.ultra, Support::Unknown);
        assert_eq!(partial.fast, Support::Supported);
    }

    #[tokio::test]
    async fn refusal_timeout_and_limits_are_honest_and_reap_scratch() {
        for (mode, reason, control) in [
            ("unsupported", "unsupported", Support::Unsupported),
            ("policy", "invalid_response", Support::Unknown),
            ("malformed", "invalid_response", Support::Unknown),
            ("hang", "timeout", Support::Unknown),
            ("line", "limit_exceeded", Support::Unknown),
            ("stderr", "limit_exceeded", Support::Unknown),
            ("frames", "limit_exceeded", Support::Unknown),
            ("aggregate", "limit_exceeded", Support::Unknown),
        ] {
            let (evidence, scratch) = fake(mode).await;
            assert_eq!(evidence.reason, reason, "{mode}");
            assert_eq!(evidence.control, control, "{mode}");
            assert!(!scratch.exists(), "{mode}");
        }
    }

    #[tokio::test]
    async fn cache_is_single_flight_changes_identity_and_clears() {
        let cache = Cache::default();
        let launches = AtomicUsize::new(0);
        let init = || async {
            launches.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(10)).await;
            Evidence::unknown("timeout")
        };
        let _ = tokio::join!(cache.get_with("first", init), cache.get_with("first", init));
        assert_eq!(launches.load(Ordering::Relaxed), 1);
        cache.get_with("changed", init).await;
        assert_eq!(launches.load(Ordering::Relaxed), 2);
        cache.clear().await;
        cache.get_with("changed", init).await;
        assert_eq!(launches.load(Ordering::Relaxed), 3);
        cache.refresh("changed").await;
        cache.get_with("changed", init).await;
        assert_eq!(launches.load(Ordering::Relaxed), 4);
    }

    #[tokio::test]
    async fn cancellation_reaps_child_before_scratch_cleanup() {
        let scratch = Scratch::new().unwrap();
        let root = scratch.0.clone();
        let cmd = fake_command("hang", &scratch);
        let handle = tokio::spawn(execute(cmd, scratch, DEADLINE));
        tokio::time::timeout(Duration::from_secs(2), async {
            while !root.join("child.pid").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let pid: u32 = std::fs::read_to_string(root.join("child.pid"))
            .unwrap()
            .parse()
            .unwrap();
        handle.abort();
        assert!(handle.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), async {
            while root.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if !process.is_null() {
                let mut code = 0;
                assert_ne!(GetExitCodeProcess(process, &mut code), 0);
                CloseHandle(process);
                assert_ne!(code, 259);
            }
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
        }
    }

    #[tokio::test]
    async fn selection_clear_keeps_inflight_single_flight() {
        let cache = Cache::default();
        let launches = AtomicUsize::new(0);
        let init = || async {
            launches.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(30)).await;
            Evidence::unknown("timeout")
        };
        let clear_then_request = async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            cache.clear().await;
            cache.get_with("same", init).await
        };
        let _ = tokio::join!(cache.get_with("same", init), clear_then_request);
        assert_eq!(launches.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    #[ignore = "opt-in installed CLI metadata-only acceptance; no user/model prompt"]
    async fn installed_cli_metadata_probe() {
        let path = std::env::var("CLAUDINAL_ACCEPTANCE_CLI").expect("set exact selected CLI path");
        let evidence = probe(Path::new(&path)).await;
        println!("isolated metadata: control={:?}, independent_ultra={:?}, headless_fast={:?}, reason={}; no account or model inference certification", evidence.control, evidence.ultra, evidence.fast, evidence.reason);
        assert_eq!(evidence.control, Support::Supported);
        assert_eq!(evidence.ultra, Support::Supported);
        assert_eq!(evidence.fast, Support::Supported);
    }
}
