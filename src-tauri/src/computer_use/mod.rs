//! App-owned computer-use authority. Model tool permission never grants this gate.
mod broker;
mod commands;
mod driver;
mod mcp;
mod platform;
mod state;
mod types;
mod window_executor;

#[cfg(test)]
mod acceptance_tests {
    //! Central gateway acceptance. Ordinary tests never capture or inject input.
    //! The ignored Windows test requires explicit fixture/driver paths and controls
    //! only the disposable child it starts; it never selects an existing user app.

    use std::{
        path::{Path, PathBuf},
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    use serde_json::{json, Value};
    use tokio::{io::BufReader, net::TcpStream};

    use super::{broker, commands, state::State, Core};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "claudinal-computer-acceptance-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            // This directory was created exclusively by this test. No global app
            // data paths or environment overrides are involved.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn core(directory: &Path) -> Arc<Core> {
        core_with_worker(directory, None)
    }

    fn core_with_worker(directory: &Path, worker_executable: Option<PathBuf>) -> Arc<Core> {
        Arc::new(Core {
            app: None,
            state: Mutex::new(State::default()),
            action: Arc::new(tokio::sync::Mutex::new(())),
            broker_port: 1,
            data_dir: directory.to_path_buf(),
            worker_executable,
        })
    }

    /// Keep synchronous revocation/child kill on the panic path as well.
    struct AuthorityGuard(Arc<Core>);

    impl Drop for AuthorityGuard {
        fn drop(&mut self) {
            let ids = self.0.lock().runtimes.keys().cloned().collect::<Vec<_>>();
            for id in ids {
                let cleanup = self.0.lock().revoke(&id, "acceptance_finished", true);
                if let Some(cleanup) = cleanup {
                    let _ = super::state::run_cleanup(cleanup);
                }
            }
        }
    }

    async fn wait_for(mut predicate: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !predicate() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("bounded acceptance condition did not settle");
    }

    #[tokio::test]
    async fn central_gateway_defaults_off_and_does_not_publish_capabilities() {
        let directory = TestDirectory::new();
        let core = core(&directory.0);
        let _guard = AuthorityGuard(core.clone());
        let token = core.lock().register("owner", "fixture", false).unwrap();
        core.lock().register("rival", "fixture", false).unwrap();

        let status = broker::dispatch(core.clone(), "owner", "computer_status", json!({}))
            .await
            .unwrap();
        assert_eq!(status["structuredContent"]["runtime"]["enabled"], false);
        assert_eq!(status["structuredContent"]["runtime"]["state"], "disabled");
        assert_eq!(status["structuredContent"]["controller"], Value::Null);
        assert!(!serde_json::to_string(&status).unwrap().contains(&token));
        assert!(
            broker::dispatch(core.clone(), "owner", "computer_list_apps", json!({}))
                .await
                .is_err()
        );
        for name in ["computer_observe", "computer_click", "computer_type"] {
            assert!(
                broker::dispatch(core.clone(), "owner", name, json!({"appId":"unapproved"}))
                    .await
                    .is_err()
            );
        }
        for (name, args) in [
            ("shell", json!({"command":"ignored"})),
            ("computer_status", json!({"scope":"desktop"})),
            ("computer_status", json!({"delivery_mode":"foreground"})),
        ] {
            assert!(broker::dispatch(core.clone(), "owner", name, args)
                .await
                .is_err());
        }
        assert!(
            broker::dispatch(core.clone(), "unknown", "computer_status", json!({}))
                .await
                .is_err()
        );
        assert!(commands::set_enabled(&core, "owner", true).is_err());
        assert!(core.lock().driver.is_none());
        assert!(!directory.0.join("manifests").exists());
    }

    #[tokio::test]
    async fn authenticated_broker_binds_runtime_and_eof_revokes_the_generation() {
        let directory = TestDirectory::new();
        let core = core(&directory.0);
        let _guard = AuthorityGuard(core.clone());
        let token = core.lock().register("owner", "fixture", false).unwrap();
        let rival_token = core.lock().register("rival", "fixture", false).unwrap();
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(broker::serve(core.clone(), listener));

        // Another runtime's otherwise valid token is not authorization for owner.
        let mut rejected = TcpStream::connect(address).await.unwrap();
        broker::write_json(
            &mut rejected,
            &json!({"runtimeId":"owner","token":rival_token}),
        )
        .await
        .unwrap();
        assert!(tokio::time::timeout(
            Duration::from_secs(2),
            broker::read_json(&mut BufReader::new(rejected), 4096)
        )
        .await
        .unwrap()
        .unwrap()
        .is_none());
        assert!(core.lock().runtime("owner").unwrap().connection.is_none());

        let stream = TcpStream::connect(address).await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut read = BufReader::new(read);
        broker::write_json(&mut write, &json!({"runtimeId":"owner","token":token}))
            .await
            .unwrap();
        assert_eq!(
            broker::read_json(&mut read, 4096).await.unwrap().unwrap()["ok"],
            true
        );
        broker::write_json(
            &mut write,
            &json!({"name":"computer_status","arguments":{}}),
        )
        .await
        .unwrap();
        let status = broker::read_json(&mut read, broker::MAX_RESPONSE)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status["structuredContent"]["runtime"]["runtimeId"], "owner");
        let generation = core.lock().runtime("owner").unwrap().generation;

        drop(write);
        drop(read);
        wait_for(|| core.lock().runtime("owner").unwrap().generation > generation).await;
        let status = core.status(Some("owner"));
        let runtime = status.runtime.unwrap();
        assert_eq!(runtime.state, "revoked");
        assert!(!runtime.enabled);
        assert_eq!(runtime.reason.as_deref(), Some("gateway_disconnected"));
        assert!(broker::dispatch(
            core.clone(),
            "owner",
            "computer_observe",
            json!({"appId":"unapproved"})
        )
        .await
        .is_err());
        assert_eq!(core.lock().runtime("rival").unwrap().generation, 1);
        server.abort();
    }

    #[cfg(windows)]
    #[test]
    fn native_desktop_lease_excludes_independent_handles_and_releases_on_drop() {
        let directory = TestDirectory::new();
        let first = super::platform::desktop_lock_in(&directory.0).unwrap();
        assert!(super::platform::desktop_lock_in(&directory.0).is_err());
        drop(first);
        let second = super::platform::desktop_lock_in(&directory.0).unwrap();
        assert!(super::platform::desktop_lock_in(&directory.0).is_err());
        drop(second);
        assert!(super::platform::desktop_lock_in(&directory.0).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn native_lease_child() {
        let Some(directory) = std::env::var_os("CLAUDINAL_ACCEPTANCE_LEASE_CHILD") else {
            return;
        };
        let directory = PathBuf::from(directory);
        assert!(directory.is_absolute());
        assert!(directory
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("claudinal-computer-acceptance-"));
        let _lease = super::platform::desktop_lock_in(&directory).unwrap();
        std::fs::write(directory.join("lease-child-ready"), b"ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(windows)]
    #[test]
    fn native_desktop_lease_is_cross_process_and_released_after_owner_death() {
        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let directory = TestDirectory::new();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "computer_use::acceptance_tests::native_lease_child",
                "--test-threads=1",
            ])
            .env("CLAUDINAL_ACCEPTANCE_LEASE_CHILD", &directory.0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::child_process::hide_std_window(&mut command);
        let mut child = OwnedChild(command.spawn().unwrap());
        let ready = directory.0.join("lease-child-ready");
        let deadline = Instant::now() + Duration::from_secs(3);
        while !ready.exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "lease child exited before acquiring its lock"
            );
            assert!(
                Instant::now() < deadline,
                "lease child did not become ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(super::platform::desktop_lock_in(&directory.0).is_err());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(super::platform::desktop_lock_in(&directory.0).is_ok());
    }

    #[cfg(windows)]
    mod windows_fixture {
        use super::super::{driver, platform, types::AppInfo};
        use super::*;
        use base64::Engine;
        use std::process::{Child, Command, Stdio};
        use windows_sys::Win32::{
            Foundation::{HWND, POINT, RECT},
            UI::WindowsAndMessaging::*,
        };

        struct Fixture {
            child: Child,
            state_path: PathBuf,
            executable: PathBuf,
        }

        impl Fixture {
            async fn start(executable: PathBuf, state_path: PathBuf) -> Self {
                assert_eq!(executable.file_name().unwrap(), "AcceptanceWindow.exe");
                let child = Command::new(&executable)
                    .arg(&state_path)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("start the disposable, explicitly selected fixture");
                let fixture = Self {
                    child,
                    state_path,
                    executable,
                };
                wait_for(|| fixture.snapshot().is_some()).await;
                assert_eq!(
                    fixture.snapshot().unwrap()["pid"].as_u64(),
                    Some(fixture.child.id() as u64)
                );
                fixture
            }

            fn snapshot(&self) -> Option<Value> {
                serde_json::from_slice(&std::fs::read(&self.state_path).ok()?).ok()
            }

            async fn snapshot_when(&self, predicate: impl Fn(&Value) -> bool) -> Value {
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        if let Some(snapshot) = self.snapshot() {
                            if predicate(&snapshot) {
                                return snapshot;
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("bounded fixture receipt did not settle")
            }

            fn app(&self) -> AppInfo {
                let snapshot = self.snapshot().unwrap();
                let window_id = snapshot["windowId"].as_str().unwrap();
                let app = platform::apps()
                    .unwrap()
                    .into_iter()
                    .find(|app| app.pid == self.child.id() && app.window_id == window_id)
                    .expect("the fixture HWND must belong to its exact child PID");
                assert!(Path::new(&app.path)
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&self.executable.to_string_lossy()));
                assert_eq!(app.title, "Claudinal computer-use acceptance fixture");
                platform::revalidate(&app).unwrap();
                app
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                // Child::kill targets only the process handle returned by our spawn.
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }

        struct Occluder(Child);

        impl Drop for Occluder {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        async fn cover_fixture(fixture: &Fixture, app: &AppInfo, directory: &Path) -> Occluder {
            let state_path = directory.join("occluder-state.json");
            let child = Command::new(&fixture.executable)
                .args(["--occluder", &app.pid.to_string(), &app.window_id])
                .arg(&state_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let occluder = Occluder(child);
            let read_state = || {
                std::fs::read(&state_path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            };
            wait_for(|| read_state().is_some()).await;
            let state = read_state().unwrap();
            assert_eq!(state["pid"].as_u64(), Some(occluder.0.id() as u64));
            let cover = state["windowId"]
                .as_str()
                .unwrap()
                .parse::<usize>()
                .unwrap() as HWND;
            unsafe {
                let previous = SetThreadDpiAwarenessContext(-4);
                let root = app.window_id.parse::<usize>().unwrap() as HWND;
                let mut bounds: RECT = std::mem::zeroed();
                assert_ne!(GetWindowRect(root, &mut bounds), 0);
                let center = POINT {
                    x: (bounds.left + bounds.right) / 2,
                    y: (bounds.top + bounds.bottom) / 2,
                };
                let front = GetAncestor(WindowFromPoint(center), GA_ROOT);
                if previous != 0 {
                    SetThreadDpiAwarenessContext(previous);
                }
                assert_eq!(
                    front, cover,
                    "the separately owned occluder must cover the fixture center"
                );
            }
            occluder
        }

        #[link(name = "user32")]
        extern "system" {
            fn SetThreadDpiAwarenessContext(value: isize) -> isize;
        }

        /// The host worker returns full-window geometry. Ground only against
        /// that receipt, without DWM cropping or assumed titlebar/DPI offsets.
        fn control_point(app: &AppInfo, image: &Value, child_id: &str) -> (f64, f64) {
            unsafe {
                let previous = SetThreadDpiAwarenessContext(-4); // per-monitor aware v2
                let hwnd = app.window_id.parse::<usize>().unwrap() as HWND;
                let child = child_id.parse::<usize>().unwrap() as HWND;
                let mut pid = 0;
                GetWindowThreadProcessId(child, &mut pid);
                assert_eq!(pid, app.pid);
                assert_ne!(IsChild(hwnd, child), 0);
                let mut bounds: RECT = std::mem::zeroed();
                assert_ne!(GetWindowRect(child, &mut bounds), 0);
                if previous != 0 {
                    SetThreadDpiAwarenessContext(previous);
                }
                let frame = &image["window_bounds"];
                let width = frame["width"].as_f64().unwrap();
                let height = frame["height"].as_f64().unwrap();
                assert!(width > 0.0 && height > 0.0);
                let x = ((bounds.left + bounds.right) as f64 / 2.0 - frame["x"].as_f64().unwrap())
                    * image["screenshot_width"].as_f64().unwrap()
                    / width;
                let y = ((bounds.top + bounds.bottom) as f64 / 2.0 - frame["y"].as_f64().unwrap())
                    * image["screenshot_height"].as_f64().unwrap()
                    / height;
                (x, y)
            }
        }

        fn check_png(result: &Value) -> Value {
            assert_ne!(
                result.get("isError").and_then(Value::as_bool),
                Some(true),
                "capture failed: {}",
                bounded_result(result)
            );
            let content = result["content"].as_array().unwrap();
            let images = content
                .iter()
                .filter(|part| part["type"] == "image")
                .collect::<Vec<_>>();
            assert_eq!(images.len(), 1);
            assert_eq!(images[0]["mimeType"], "image/png");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(images[0]["data"].as_str().unwrap())
                .unwrap();
            assert!(bytes.len() > 24);
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
            assert_eq!(&bytes[12..16], b"IHDR");
            let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
            assert!((100..=1372).contains(&width));
            assert!((100..=1372).contains(&height));
            let data = &result["structuredContent"];
            assert_eq!(data["screenshot_width"].as_u64(), Some(width as u64));
            assert_eq!(data["screenshot_height"].as_u64(), Some(height as u64));
            assert!(!data["capture_id"].as_str().unwrap().is_empty());
            json!({"width":width,"height":height,"pngBytes":bytes.len(),"mimeType":"image/png"})
        }

        fn fixture_pixel_counts(result: &Value) -> Value {
            check_png(result);
            let part = result["content"]
                .as_array()
                .unwrap()
                .iter()
                .find(|part| part["type"] == "image")
                .unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(part["data"].as_str().unwrap())
                .unwrap();
            let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
            decoder
                .set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
            let mut reader = decoder.read_info().unwrap();
            let mut pixels = vec![0; reader.output_buffer_size()];
            let frame = reader.next_frame(&mut pixels).unwrap();
            let channels = match frame.color_type {
                png::ColorType::Rgb => 3,
                png::ColorType::Rgba => 4,
                other => panic!("window worker returned an unsupported color format: {other:?}"),
            };
            let mut signature = 0usize;
            let mut occluder = 0usize;
            for pixel in pixels[..frame.buffer_size()].chunks_exact(channels) {
                if pixel[..3] == [33, 106, 188] {
                    signature += 1;
                }
                if pixel[..3] == [218, 22, 197] {
                    occluder += 1;
                }
            }
            json!({"fixtureBluePixels":signature,"occluderMagentaPixels":occluder})
        }

        async fn verify_occluded_capture(
            core: &Arc<Core>,
            fixture: &Fixture,
            app: &AppInfo,
            directory: &Path,
        ) -> Value {
            let baseline = observe(core, app).await;
            let baseline_pixels = fixture_pixel_counts(&baseline);
            assert!(
                baseline_pixels["fixtureBluePixels"].as_u64().unwrap() > 1000,
                "baseline must contain the fixture's actual blue signature"
            );
            assert_eq!(baseline_pixels["occluderMagentaPixels"], 0);
            let cover = cover_fixture(fixture, app, directory).await;
            let observed = broker::dispatch(
                core.clone(),
                "owner",
                "computer_observe",
                json!({"appId":app.app_id,"includeTree":false}),
            )
            .await;
            let evidence = match observed {
                Ok(result) if result.get("isError").and_then(Value::as_bool) != Some(true) => {
                    let pixels = fixture_pixel_counts(&result);
                    assert!(pixels["fixtureBluePixels"].as_u64().unwrap() > 1000,
                        "occluded window capture must contain the fixture signature, never a blank success");
                    assert_eq!(pixels["occluderMagentaPixels"], 0,
                        "window-only capture must exclude every pixel of the separately owned covering window");
                    json!({"state":"isolated","baseline":baseline_pixels,"covered":pixels})
                }
                result => {
                    let reason = match result {
                        Ok(value) => bounded_result(&value).to_string(),
                        Err(error) => error.to_string(),
                    };
                    let lower = reason.to_ascii_lowercase();
                    assert!(
                        lower.contains("capture") || lower.contains("printwindow"),
                        "only an explicit window-capture refusal is an accepted limit: {reason}"
                    );
                    json!({"state":"captureRefused","reason":reason.chars().take(2000).collect::<String>(),"baseline":baseline_pixels})
                }
            };
            drop(cover);
            if !core.status(Some("owner")).runtime.unwrap().enabled {
                wait_for(|| core.status(None).cleanup.state == "idle").await;
                commands::set_enabled(core, "owner", true).unwrap();
                approve(core, "owner", app).await;
            }
            evidence
        }

        fn bounded_result(result: &Value) -> Value {
            // Evidence must never print raw screenshots or capability tokens.
            json!({
                "isError":result.get("isError").cloned().unwrap_or(json!(false)),
                "structuredContent":result.get("structuredContent"),
                "text":result["content"].as_array().into_iter().flatten()
                    .filter(|part| part["type"] == "text")
                    .filter_map(|part| part["text"].as_str())
                    .map(|text| text.chars().take(1000).collect::<String>()).collect::<Vec<_>>()
            })
        }

        async fn observe(core: &Arc<Core>, app: &AppInfo) -> Value {
            broker::dispatch(
                core.clone(),
                "owner",
                "computer_observe",
                json!({"appId":app.app_id,"includeTree":false}),
            )
            .await
            .unwrap()
        }

        fn check_action_result(name: &str, result: &Value) {
            let summary = bounded_result(result);
            println!("{name}: {summary}");
            if result.get("isError").and_then(Value::as_bool) == Some(true) {
                assert_eq!(
                    result["structuredContent"]["driverReported"]["code"], "background_unavailable",
                    "only an explicit background-delivery refusal is an accepted limitation: {summary}"
                );
            }
        }

        async fn approve(core: &Arc<Core>, runtime: &str, app: &AppInfo) {
            let request = core.request_app(runtime, &app.app_id).await.unwrap();
            commands::respond(core, runtime, &request.request_id, true)
                .await
                .unwrap();
        }

        fn install_evidence(core: &Arc<Core>, evidence: &driver::Evidence) {
            let mut state = core.lock();
            state.evidence = Some(evidence.clone());
            state.driver_status.state = "ready".into();
            state.driver_status.path = Some(evidence.path.to_string_lossy().into_owned());
            state.driver_status.version = Some(evidence.version.clone());
        }

        async fn verify_held_input_cleanup(
            core: &Arc<Core>,
            fixture: &Fixture,
            app: &AppInfo,
        ) -> Value {
            let child = fixture.snapshot().unwrap()["inputWindowId"]
                .as_str()
                .unwrap()
                .to_string();
            let mut rounds = Vec::new();
            for (index, mode) in ["plain", "alt"].into_iter().enumerate() {
                if index > 0 {
                    commands::set_enabled(core, "owner", true).unwrap();
                    approve(core, "owner", app).await;
                }
                let keys = if mode == "plain" {
                    vec![0x41, 0x0D]
                } else {
                    vec![0x12, 0x42]
                };
                let mouse = mode == "plain";
                let approved = {
                    let state = core.lock();
                    let generation = state.enabled("owner").unwrap().generation;
                    state.authorize("owner", generation, &app.app_id).unwrap()
                };
                let targets = platform::input_targets(&approved).unwrap();
                assert!(targets.contains(&child.parse::<usize>().unwrap()));
                {
                    let mut state = core.lock();
                    let generation = state.enabled("owner").unwrap().generation;
                    state.authorize("owner", generation, &app.app_id).unwrap();
                    assert!(state.driver.is_none());
                    assert!(state.worker.is_none());
                    state.held = Some(super::super::state::HeldInput {
                        app: approved,
                        targets,
                        keys,
                        mouse,
                    });
                }
                let mut command = Command::new(&fixture.executable);
                command
                    .args(["--hold", &app.pid.to_string(), &app.window_id, &child, mode])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                crate::child_process::hide_std_window(&mut command);
                let helper = command.spawn().unwrap();
                let helper_pid = helper.id();
                let pending = if mode == "plain" {
                    let manifest = core.data_dir.join(format!("fixture-held-{mode}.json"));
                    std::fs::write(&manifest, b"{}").unwrap();
                    let executor = driver::Driver::from_test_child(helper, manifest).unwrap();
                    core.lock().driver = Some(executor.clone());
                    tokio::spawn(async move { executor.call("fixture_hold", json!({})).await })
                } else {
                    let worker =
                        super::super::window_executor::Worker::from_test_child(helper).unwrap();
                    core.lock().worker = Some(worker.clone());
                    tokio::spawn(async move { worker.receive().await })
                };
                let expected = if mode == "plain" {
                    vec![format!("{child}:65"), format!("{child}:13")]
                } else {
                    vec![format!("{child}:18"), format!("{child}:66")]
                };
                let before = fixture
                    .snapshot_when(|state| {
                        expected
                            .iter()
                            .all(|key| state["heldKeys"].as_array().unwrap().contains(&json!(key)))
                            && (!mouse
                                || state["heldMouse"]
                                    .as_array()
                                    .unwrap()
                                    .contains(&json!(format!("{child}:left"))))
                    })
                    .await;
                assert!(
                    !pending.is_finished(),
                    "fake input work must still be in flight at revoke"
                );
                let stopped = Instant::now();
                core.revoke("owner", "user_take_back");
                assert!(!core.status(Some("owner")).runtime.unwrap().enabled);
                let reply = tokio::time::timeout(Duration::from_secs(2), pending)
                    .await
                    .expect("revoke must close the fake executor's pending response")
                    .unwrap();
                assert!(
                    reply.is_err(),
                    "a killed pending action cannot return success"
                );
                wait_for(|| core.status(None).cleanup.state == "idle").await;
                let after = fixture
                    .snapshot_when(|state| {
                        state["heldKeys"].as_array().unwrap().is_empty()
                            && state["heldMouse"].as_array().unwrap().is_empty()
                    })
                    .await;
                let events = after["inputEvents"].as_array().unwrap();
                if mode == "plain" {
                    assert!(events.contains(&json!(format!("{child}:WM_KEYUP:65"))));
                    assert!(events.contains(&json!(format!("{child}:WM_KEYUP:13"))));
                    assert!(events.iter().any(|event| event.as_str().is_some_and(
                        |event| event.starts_with(&format!("{child}:WM_LEFTBUTTONUP:"))
                    )));
                } else {
                    for key in [18, 66] {
                        assert!(events.contains(&json!(format!("{child}:WM_SYSKEYUP:{key}"))));
                    }
                }
                let elapsed_ms = stopped.elapsed().as_millis();
                assert!(
                    elapsed_ms < 2000,
                    "held input cleanup exceeded its deadline"
                );
                rounds.push(json!({
                    "mode":mode,"executor":if mode == "plain" {"driverAdapter"} else {"windowWorker"},"helperPid":helper_pid,"targetChildWindowId":child,
                    "heldKeysBefore":before["heldKeys"],"heldMouseBefore":before["heldMouse"],
                    "heldKeysAfter":after["heldKeys"],"heldMouseAfter":after["heldMouse"],
                    "cleanupMs":elapsed_ms,"pendingActionRejected":true,
                    "releaseEvents":events.iter().filter(|event| event.as_str().is_some_and(|event| event.starts_with(&format!("{child}:WM_")) && event.contains("UP:"))).collect::<Vec<_>>()
                }));
            }
            json!({"rounds":rounds,"scope":"only the exact disposable fixture child; no global input"})
        }

        /// Run only after the human-facing fixture notification. All paths must be
        /// absolute; no model, account, existing application or global settings.
        #[tokio::test]
        #[ignore = "opt-in actual capture/input on a disposable AcceptanceWindow.exe child"]
        async fn real_windows_driver_through_central_gateway() {
            let driver_path = PathBuf::from(
                std::env::var_os("CLAUDINAL_COMPUTER_ACCEPTANCE_DRIVER")
                    .expect("explicit pinned CuaDriver path required"),
            )
            .canonicalize()
            .unwrap();
            if cfg!(target_arch = "x86_64") {
                assert_eq!(
                    driver::fingerprint(&driver_path).unwrap(),
                    "30b14e435defbd440f53ffbd1761b0c888182a519db0c15c4678977bd7c9481e",
                    "real acceptance requires the reviewed pinned driver bytes"
                );
            }
            let fixture_path = PathBuf::from(
                std::env::var_os("CLAUDINAL_COMPUTER_ACCEPTANCE_FIXTURE")
                    .expect("explicit disposable fixture path required"),
            )
            .canonicalize()
            .unwrap();
            let app_path = PathBuf::from(
                std::env::var_os("CLAUDINAL_COMPUTER_ACCEPTANCE_APP").expect(
                    "explicit built product executable required for the window-only worker",
                ),
            )
            .canonicalize()
            .unwrap();
            assert!(app_path.is_file());
            let report_path =
                std::env::var_os("CLAUDINAL_COMPUTER_ACCEPTANCE_REPORT").map(PathBuf::from);
            if let Some(path) = report_path.as_ref() {
                assert!(path.is_absolute());
            }
            let directory = TestDirectory::new();
            let mut fixture =
                Fixture::start(fixture_path, directory.0.join("fixture-state.json")).await;
            let app = fixture.app();
            let core = super::core_with_worker(&directory.0, Some(app_path));
            let _guard = AuthorityGuard(core.clone());
            let evidence = driver::probe_in(driver_path, false, &directory.0)
                .await
                .unwrap();
            install_evidence(&core, &evidence);
            for id in ["owner", "rival"] {
                core.lock()
                    .register(id, "disposable acceptance fixture", false)
                    .unwrap();
                commands::set_enabled(&core, id, true).unwrap();
            }

            let denied = core.request_app("owner", &app.app_id).await.unwrap();
            commands::respond(&core, "owner", &denied.request_id, false)
                .await
                .unwrap();
            assert!(broker::dispatch(
                core.clone(),
                "owner",
                "computer_observe",
                json!({"appId":app.app_id})
            )
            .await
            .is_err());
            approve(&core, "owner", &app).await;
            let rival_request = core.request_app("rival", &app.app_id).await.unwrap();
            assert!(
                commands::respond(&core, "rival", &rival_request.request_id, true)
                    .await
                    .is_err()
            );
            assert!(broker::dispatch(
                core.clone(),
                "rival",
                "computer_observe",
                json!({"appId":app.app_id})
            )
            .await
            .is_err());

            // A second authority instance must observe the same native lease lock.
            let other = super::core(&directory.0);
            let _other_guard = AuthorityGuard(other.clone());
            install_evidence(&other, &evidence);
            other
                .lock()
                .register("independent", "fixture", false)
                .unwrap();
            commands::set_enabled(&other, "independent", true).unwrap();
            let request = other.request_app("independent", &app.app_id).await.unwrap();
            assert!(
                commands::respond(&other, "independent", &request.request_id, true)
                    .await
                    .is_err()
            );

            let capture_isolation =
                verify_occluded_capture(&core, &fixture, &app, &directory.0).await;
            let image = observe(&core, &app).await;
            let png = check_png(&image);
            println!("fixture PNG: {png}");
            let capture = image["structuredContent"]["capture_id"]
                .as_str()
                .unwrap()
                .to_string();
            let (x, y) = control_point(
                &app,
                &image["structuredContent"],
                fixture.snapshot().unwrap()["buttonWindowId"]
                    .as_str()
                    .unwrap(),
            );
            assert!(broker::dispatch(
                core.clone(),
                "owner",
                "computer_click",
                json!({"appId":app.app_id,"captureId":"foreign-capture","x":x,"y":y})
            )
            .await
            .is_err());
            assert!(broker::dispatch(
                core.clone(),
                "owner",
                "computer_click",
                json!({"appId":app.app_id,"captureId":capture,"x":1372,"y":y})
            )
            .await
            .is_err());
            let click = broker::dispatch(
                core.clone(),
                "owner",
                "computer_click",
                json!({"appId":app.app_id,"captureId":capture,"x":x,"y":y}),
            )
            .await
            .unwrap();
            check_action_result("button click", &click);
            if click.get("isError").and_then(Value::as_bool) != Some(true) {
                wait_for(|| {
                    fixture
                        .snapshot()
                        .is_some_and(|state| state["clicks"].as_u64() == Some(1))
                })
                .await;
            }
            assert!(broker::dispatch(
                core.clone(),
                "owner",
                "computer_click",
                json!({"appId":app.app_id,"captureId":capture,"x":x,"y":y})
            )
            .await
            .is_err());

            // Right and double clicks reach only the same approved button.
            let button_window = fixture.snapshot().unwrap()["buttonWindowId"]
                .as_str()
                .unwrap()
                .to_string();
            let image = observe(&core, &app).await;
            let (x, y) = control_point(&app, &image["structuredContent"], &button_window);
            let right = broker::dispatch(
                core.clone(),
                "owner",
                "computer_click",
                json!({"appId":app.app_id,"captureId":image["structuredContent"]["capture_id"],
                    "x":x,"y":y,"button":"right"}),
            )
            .await
            .unwrap();
            check_action_result("right click", &right);
            if right.get("isError").and_then(Value::as_bool) != Some(true) {
                let up = format!("{button_window}:WM_RIGHTBUTTONUP:");
                wait_for(|| {
                    fixture.snapshot().is_some_and(|state| {
                        state["inputEvents"].as_array().is_some_and(|events| {
                            events
                                .iter()
                                .any(|event| event.as_str().is_some_and(|e| e.starts_with(&up)))
                        })
                    })
                })
                .await;
                assert_eq!(fixture.snapshot().unwrap()["clicks"].as_u64(), Some(1));
            }
            let image = observe(&core, &app).await;
            let (x, y) = control_point(&app, &image["structuredContent"], &button_window);
            let double = broker::dispatch(
                core.clone(),
                "owner",
                "computer_click",
                json!({"appId":app.app_id,"captureId":image["structuredContent"]["capture_id"],
                    "x":x,"y":y,"clickCount":2}),
            )
            .await
            .unwrap();
            check_action_result("double click", &double);
            if double.get("isError").and_then(Value::as_bool) != Some(true) {
                wait_for(|| {
                    fixture
                        .snapshot()
                        .is_some_and(|state| state["clicks"].as_u64().is_some_and(|n| n >= 2))
                })
                .await;
            }

            let image = observe(&core, &app).await;
            check_png(&image);
            let (x, y) = control_point(
                &app,
                &image["structuredContent"],
                fixture.snapshot().unwrap()["inputWindowId"]
                    .as_str()
                    .unwrap(),
            );
            let focus = broker::dispatch(core.clone(), "owner", "computer_click", json!({"appId":app.app_id,"captureId":image["structuredContent"]["capture_id"],"x":x,"y":y})).await.unwrap();
            check_action_result("textbox click", &focus);
            check_png(&observe(&core, &app).await);
            let marker = "Claudinal fixture acceptance 123";
            let typed = broker::dispatch(
                core.clone(),
                "owner",
                "computer_type",
                json!({"appId":app.app_id,"text":marker}),
            )
            .await
            .unwrap();
            check_action_result("type", &typed);
            if typed.get("isError").and_then(Value::as_bool) != Some(true) {
                wait_for(|| {
                    fixture
                        .snapshot()
                        .is_some_and(|state| state["text"].as_str() == Some(marker))
                })
                .await;
            }
            check_png(&observe(&core, &app).await);
            let keys_before = fixture.snapshot().unwrap()["keys"].as_u64().unwrap();
            let key = broker::dispatch(
                core.clone(),
                "owner",
                "computer_key",
                json!({"appId":app.app_id,"key":"home"}),
            )
            .await
            .unwrap();
            check_action_result("key", &key);
            if key.get("isError").and_then(Value::as_bool) != Some(true) {
                wait_for(|| {
                    fixture.snapshot().is_some_and(|state| {
                        state["keys"]
                            .as_u64()
                            .is_some_and(|count| count > keys_before)
                    })
                })
                .await;
            }
            check_png(&observe(&core, &app).await);
            let scroll_before = fixture.snapshot().unwrap()["scrollOffsetY"]
                .as_u64()
                .unwrap();
            let scroll_messages_before = fixture.snapshot().unwrap()["scrollMessages"]
                .as_u64()
                .unwrap();
            let scroll = broker::dispatch(
                core.clone(),
                "owner",
                "computer_scroll",
                json!({"appId":app.app_id,"direction":"down","amount":1}),
            )
            .await
            .unwrap();
            check_action_result("scroll", &scroll);
            if scroll.get("isError").and_then(Value::as_bool) != Some(true) {
                wait_for(|| {
                    fixture.snapshot().is_some_and(|state| {
                        state["scrollOffsetY"]
                            .as_u64()
                            .is_some_and(|offset| offset > scroll_before)
                            && state["scrollMessages"]
                                .as_u64()
                                .is_some_and(|count| count > scroll_messages_before)
                            && state["inputEvents"]
                                .as_array()
                                .unwrap()
                                .contains(&json!(format!("{}:WM_VSCROLL:1", app.window_id)))
                    })
                })
                .await;
            }
            let fixture_effects = fixture.snapshot().unwrap();

            let stop = Instant::now();
            core.revoke("owner", "user_take_back");
            assert!(!core.status(Some("owner")).runtime.unwrap().enabled);
            assert!(broker::dispatch(
                core.clone(),
                "owner",
                "computer_click",
                json!({"appId":app.app_id,"captureId":capture,"x":x,"y":y})
            )
            .await
            .is_err());
            wait_for(|| core.status(None).cleanup.state == "idle").await;
            let stop_ms = stop.elapsed().as_millis();
            assert!(
                stop_ms < 2000,
                "idle driver revoke exceeded the cleanup bound"
            );

            commands::set_enabled(&core, "owner", true).unwrap();
            let stale = core.request_app("owner", &app.app_id).await.unwrap();
            core.revoke("owner", "interrupt_requested");
            wait_for(|| core.status(None).cleanup.state == "idle").await;
            commands::set_enabled(&core, "owner", true).unwrap();
            assert!(commands::respond(&core, "owner", &stale.request_id, true)
                .await
                .is_err());
            approve(&core, "owner", &app).await;
            assert!(broker::dispatch(
                core.clone(),
                "owner",
                "computer_click",
                json!({"appId":app.app_id,"captureId":capture,"x":x,"y":y})
            )
            .await
            .is_err());
            let held_input_cleanup = verify_held_input_cleanup(&core, &fixture, &app).await;
            commands::set_enabled(&core, "owner", true).unwrap();
            approve(&core, "owner", &app).await;
            let witnessed = {
                let state = core.lock();
                let generation = state.enabled("owner").unwrap().generation;
                state.authorize("owner", generation, &app.app_id).unwrap()
            };
            assert!(witnessed.window_witness.is_some());
            let before_lifetime_change = fixture.snapshot().unwrap();
            platform::remove_window_witness(&witnessed);
            assert!(platform::revalidate(&witnessed).is_err());
            assert!(broker::dispatch(
                core.clone(),
                "owner",
                "computer_observe",
                json!({"appId":app.app_id})
            )
            .await
            .is_err());
            // Only the dead grant is dropped; the conversation's access stays on.
            let runtime = core.status(Some("owner")).runtime.unwrap();
            assert!(runtime.enabled);
            assert!(runtime
                .apps
                .iter()
                .all(|granted| granted.app_id != app.app_id));
            let after_lifetime_change = fixture.snapshot().unwrap();
            for field in [
                "text",
                "clicks",
                "keys",
                "wheels",
                "scrollMessages",
                "scrollOffsetY",
            ] {
                assert_eq!(before_lifetime_change[field], after_lifetime_change[field]);
            }
            commands::set_enabled(&core, "owner", true).unwrap();
            approve(&core, "owner", &app).await;
            fixture.child.kill().unwrap();
            fixture.child.wait().unwrap();
            assert!(platform::revalidate(&app).is_err());
            assert!(broker::dispatch(
                core.clone(),
                "owner",
                "computer_observe",
                json!({"appId":app.app_id})
            )
            .await
            .is_err());

            wait_for(|| core.status(None).cleanup.state == "idle").await;

            let report = json!({
                "driverVersion":evidence.version,"driverSha256":evidence.sha256,
                "fixturePid":app.pid,"fixtureWindowId":app.window_id,"png":png,
                "buttonClick":bounded_result(&click),"focusClick":bounded_result(&focus),
                "type":bounded_result(&typed),"key":bounded_result(&key),"scroll":bounded_result(&scroll),
                "fixtureEffects":fixture_effects,"idleDriverRevokeMs":stop_ms,
                "heldInputCleanup":held_input_cleanup,
                "occludedCaptureIsolation":capture_isolation,
                "guardsPassed":["deny","rival runtime","independent authority lease","foreign capture","out of bounds","single-use capture","revoke","stale permission","stale capture","window lifetime witness","fixture process exit"],
                "limits":["Only this disposable WinForms window was exercised.","Idle real-driver revoke plus a fake executor holding ordinary/Alt keys and left mouse on the fixture child; no claim about arbitrary driver internals.","No foreground fallback, model call, provider/account request or permanent settings change."]
            });
            if let Some(path) = report_path {
                std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
            }
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
        }
    }
}

pub use commands::*;
pub use mcp::run_mcp_stdio;
pub use window_executor::run_stdio as run_window_worker;

use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};
use tauri::{Emitter, Manager};

use crate::error::{Error, Result};
use state::{Cleanup, State};
use types::{AppInfo, PermissionRequest, Status};

pub const SERVER_NAME: &str = "claudinal-computer";

#[derive(Clone)]
pub struct ComputerUse(pub(crate) Arc<Core>);

pub(crate) struct Core {
    app: Option<tauri::AppHandle>,
    pub(crate) state: Mutex<State>,
    pub(crate) action: Arc<tokio::sync::Mutex<()>>,
    broker_port: u16,
    data_dir: std::path::PathBuf,
    pub(crate) worker_executable: Option<std::path::PathBuf>,
}

impl Core {
    pub(crate) fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
    pub(crate) fn status(&self, id: Option<&str>) -> Status {
        self.lock().status(id)
    }
    pub(crate) fn emit(&self, id: Option<&str>) {
        let status = self.status(id);
        if let Some(app) = self.app.as_ref() {
            let _ = app.emit("computer-use://status", &status);
        }
    }
    pub(crate) fn emit_request(&self, request: &PermissionRequest) {
        if let Some(app) = self.app.as_ref() {
            let _ = app.emit("computer-use://permission-request", request);
        }
    }
    pub(crate) fn schedule_cleanup(self: &Arc<Self>, work: Option<Cleanup>) {
        let Some(work) = work else {
            return;
        };
        let core = self.clone();
        let serial = work.serial;
        // Authority and process termination were already revoked synchronously.
        std::thread::spawn(move || {
            let result = state::run_cleanup(work);
            {
                let mut state = core.lock();
                if state.cleanup_serial != serial {
                    return;
                }
                state.cleanup = match result {
                    Ok(()) => types::CleanupStatus::default(),
                    Err(error) => types::CleanupStatus {
                        state: "failed".into(),
                        reason: Some(error.to_string()),
                    },
                };
            }
            core.emit(None);
        });
    }
    pub(crate) fn revoke(self: &Arc<Self>, id: &str, reason: &str) {
        let work = self.lock().revoke(id, reason, state::is_retirement(reason));
        self.emit(Some(id));
        self.schedule_cleanup(work);
    }
    /// A late action may revoke only the generation which admitted it. Keep the
    /// comparison and authority barrier under one lock so recovery cannot enter
    /// between them and lose its newly approved grants.
    pub(crate) fn revoke_if_generation(
        self: &Arc<Self>,
        id: &str,
        generation: u64,
        reason: &str,
    ) -> bool {
        let work = {
            let mut state = self.lock();
            if !state
                .runtimes
                .get(id)
                .is_some_and(|runtime| runtime.generation == generation)
            {
                return false;
            }
            state.revoke(id, reason, state::is_retirement(reason))
        };
        self.emit(Some(id));
        self.schedule_cleanup(work);
        true
    }
    pub(crate) async fn request_app(
        self: &Arc<Self>,
        id: &str,
        app_id: &str,
    ) -> Result<PermissionRequest> {
        let generation = self.lock().enabled(id)?.generation;
        let catalog = tokio::task::spawn_blocking(platform::apps)
            .await
            .map_err(|error| Error::Other(error.to_string()))??;
        let app = catalog
            .into_iter()
            .find(|app| app.app_id == app_id)
            .ok_or_else(|| {
                Error::Other(
                    "The selected app window no longer exists. Refresh the app list.".into(),
                )
            })?;
        let request = self.lock().request(id, app, generation)?;
        self.emit(Some(id));
        self.emit_request(&request);
        Ok(request)
    }
    pub(crate) async fn list_apps(&self, id: &str) -> Result<Vec<AppInfo>> {
        let generation = self.lock().enabled(id)?.generation;
        let apps = tokio::task::spawn_blocking(platform::apps)
            .await
            .map_err(|error| Error::Other(error.to_string()))??;
        if self.lock().enabled(id)?.generation != generation {
            return Err(Error::Other("App discovery was cancelled.".into()));
        }
        Ok(apps)
    }
    pub(crate) async fn replace_driver(self: &Arc<Self>, path: Option<String>) -> Result<Status> {
        let (generation, cleanup) = {
            let mut state = self.lock();
            if state.driver_status.state == "checking" {
                return Err(Error::Other(
                    "Driver verification is already running.".into(),
                ));
            }
            let ids = state.runtimes.keys().cloned().collect::<Vec<_>>();
            let mut cleanup = None;
            for id in ids {
                cleanup = state.revoke(&id, "driver_failed", false).or(cleanup);
            }
            state.evidence = None;
            state.evidence_generation += 1;
            state.driver_status.state = "checking".into();
            state.driver_status.reason = None;
            (state.evidence_generation, cleanup)
        };
        self.emit(None);
        self.schedule_cleanup(cleanup);
        let result = if let Some(path) = path {
            driver::probe(path.into(), false).await
        } else {
            driver::install().await
        };
        let status = {
            let mut state = self.lock();
            if state.evidence_generation != generation {
                return Err(Error::Other("Driver verification was superseded.".into()));
            }
            match result {
                Ok(evidence) => {
                    // Selection only: runtime tokens and app grants are never persisted.
                    let saved = serde_json::to_string(&evidence)
                        .map_err(Error::from)
                        .and_then(|json| {
                            crate::fs_atomic::atomic_write_str(
                                &self.data_dir.join("driver-selection.json"),
                                &json,
                            )
                        });
                    match saved {
                        Ok(()) => {
                            state.driver_status = types::DriverStatus {
                                supported: cfg!(windows),
                                platform: std::env::consts::OS.into(),
                                state: "ready".into(),
                                path: Some(evidence.path.to_string_lossy().into_owned()),
                                version: Some(evidence.version.clone()),
                                managed: evidence.managed,
                                reason: None,
                            };
                            state.evidence = Some(evidence);
                        }
                        Err(error) => {
                            state.driver_status.state = "error".into();
                            state.driver_status.reason =
                                Some(format!("Driver selection could not be saved: {error}"));
                        }
                    }
                }
                Err(error) => {
                    state.driver_status.state = "error".into();
                    state.driver_status.reason = Some(error.to_string());
                }
            }
            state.status(None)
        };
        if let Some(app) = self.app.as_ref() {
            let _ = app.emit("computer-use://status", &status);
        }
        Ok(status)
    }
}

pub fn init(app: tauri::AppHandle) -> Result<()> {
    let mut initial = State::default();
    let directory = platform::data_dir();
    let listener = if cfg!(windows) && directory.is_ok() {
        std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).and_then(|listener| {
            listener.set_nonblocking(true)?;
            Ok(listener)
        })
    } else {
        Err(std::io::Error::other("Computer control is unavailable on this platform or local app data cannot be resolved."))
    };
    let port = listener
        .as_ref()
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|address| address.port())
        .unwrap_or(0);
    if cfg!(windows) && port == 0 {
        initial.driver_status.state = "error".into();
        initial.driver_status.reason = Some(
            "The local computer gateway could not start. Ordinary conversations remain available."
                .into(),
        );
    }
    let core = Arc::new(Core {
        app: Some(app.clone()),
        state: Mutex::new(initial),
        action: Arc::new(tokio::sync::Mutex::new(())),
        broker_port: port,
        data_dir: directory.unwrap_or_default(),
        worker_executable: None,
    });
    app.manage(ComputerUse(core.clone()));
    if let Ok(listener) = listener {
        let server_core = core.clone();
        tauri::async_runtime::spawn(async move {
            broker::serve(server_core, listener).await;
        });
    }
    if cfg!(windows) && port != 0 {
        // Revalidate persisted selection against its recorded bytes and actual protocol.
        tauri::async_runtime::spawn(async move {
            let selected = platform::data_dir()
                .ok()
                .and_then(|dir| std::fs::read(dir.join("driver-selection.json")).ok())
                .and_then(|bytes| serde_json::from_slice::<driver::Evidence>(&bytes).ok());
            let Some(selected) = selected else {
                return;
            };
            let generation = {
                let mut state = core.lock();
                state.driver_status.state = "checking".into();
                state.evidence_generation += 1;
                state.evidence_generation
            };
            core.emit(None);
            let result =
                if driver::fingerprint(&selected.path).ok().as_deref() == Some(&selected.sha256) {
                    driver::probe(selected.path, selected.managed).await
                } else {
                    Err(Error::Other(
                        "The saved driver changed. Select or install the driver again.".into(),
                    ))
                };
            {
                let mut state = core.lock();
                if state.evidence_generation != generation {
                    return;
                }
                match result {
                    Ok(evidence) => {
                        state.driver_status = types::DriverStatus {
                            supported: true,
                            platform: "windows".into(),
                            state: "ready".into(),
                            path: Some(evidence.path.to_string_lossy().into_owned()),
                            version: Some(evidence.version.clone()),
                            managed: evidence.managed,
                            reason: None,
                        };
                        state.evidence = Some(evidence);
                    }
                    Err(error) => {
                        state.driver_status.state = "error".into();
                        state.driver_status.reason = Some(error.to_string());
                    }
                }
            }
            core.emit(None);
        });
    }
    Ok(())
}

pub async fn runtime_mcp_config(
    app: &tauri::AppHandle,
    runtime_id: &str,
    cwd: &Path,
    enabled: bool,
) -> Result<Option<Value>> {
    if !cfg!(windows) {
        return Ok(None);
    }
    let core = &app.state::<ComputerUse>().0;
    if core.broker_port == 0 {
        return if enabled {
            Err(Error::Other(
                "The local computer gateway is unavailable.".into(),
            ))
        } else {
            Ok(None)
        };
    }
    let token = core
        .lock()
        .register(runtime_id, &cwd.to_string_lossy(), enabled)?;
    core.emit(Some(runtime_id));
    Ok(Some(
        json!({"mcpServers": { SERVER_NAME: { "type":"stdio", "command": std::env::current_exe()?.to_string_lossy(), "args":["--computer-use-mcp-server"],
        "env": { "CLAUDINAL_COMPUTER_BROKER_PORT": core.broker_port.to_string(), "CLAUDINAL_COMPUTER_RUNTIME_ID": runtime_id, "CLAUDINAL_COMPUTER_TOKEN": token } } } }),
    ))
}

pub fn revoke_runtime(app: &tauri::AppHandle, runtime_id: &str, reason: &str) {
    if let Some(core) = app.try_state::<ComputerUse>() {
        core.0.revoke(runtime_id, reason);
    }
}

pub fn revoke_all(app: &tauri::AppHandle, reason: &str) {
    if let Some(core) = app.try_state::<ComputerUse>() {
        let ids = core.0.lock().runtimes.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            core.0.revoke(&id, reason);
        }
        if reason == "application_shutdown" {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1700);
            while core.0.lock().cleanup.state == "stopping" && std::time::Instant::now() < deadline
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
}
