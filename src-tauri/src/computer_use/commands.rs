use super::{
    platform,
    types::{AppInfo, PermissionRequest, Status},
    ComputerUse, Core,
};
use crate::error::{Error, Result};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn computer_use_status(computer: State<'_, ComputerUse>, runtime_id: Option<String>) -> Status {
    computer.0.status(runtime_id.as_deref())
}

pub(crate) fn set_foreground_keys(core: &Arc<Core>, enabled: bool) -> Result<Status> {
    let cleanup = {
        let mut state = core.lock();
        std::fs::create_dir_all(&core.data_dir)?;
        crate::fs_atomic::atomic_write_str(
            &core.data_dir.join("foreground-keys.json"),
            if enabled { "true" } else { "false" },
        )?;
        state.foreground_keys = enabled;
        // Disabling also cancels a worker that already captured the old setting.
        // A later enable can never resurrect that runtime generation.
        let owner = state.owner.clone();
        if !enabled {
            owner.and_then(|id| state.revoke(&id, "user_take_back", false))
        } else {
            None
        }
    };
    core.schedule_cleanup(cleanup);
    core.emit(None);
    Ok(core.status(None))
}

#[tauri::command]
pub fn computer_use_set_foreground_keys(
    computer: State<'_, ComputerUse>,
    enabled: bool,
) -> Result<Status> {
    if !cfg!(windows) {
        return Err(Error::Other(
            "Foreground shortcuts are available on Windows only.".into(),
        ));
    }
    set_foreground_keys(&computer.0, enabled)
}

#[tauri::command]
pub async fn computer_use_install_driver(computer: State<'_, ComputerUse>) -> Result<Status> {
    computer.0.replace_driver(None).await
}

#[tauri::command]
pub async fn computer_use_set_driver_path(
    computer: State<'_, ComputerUse>,
    path: String,
) -> Result<Status> {
    computer.0.replace_driver(Some(path)).await
}

#[tauri::command]
pub async fn computer_use_list_apps(
    computer: State<'_, ComputerUse>,
    runtime_id: String,
) -> Result<Vec<AppInfo>> {
    computer.0.list_apps(&runtime_id).await
}

pub(crate) fn set_enabled(core: &Arc<Core>, runtime_id: &str, enabled: bool) -> Result<Status> {
    if !enabled {
        core.lock().runtime(runtime_id)?;
        core.revoke(runtime_id, "user_disabled");
    } else {
        if core.broker_port == 0 {
            return Err(Error::Other(
                "The local computer gateway is unavailable. Restart the app to retry.".into(),
            ));
        }
        let mut state = core.lock();
        if state.driver_status.state != "ready" {
            return Err(Error::Other(
                "Install or verify CuaDriver before enabling computer access.".into(),
            ));
        }
        if state.cleanup.state != "idle" {
            return Err(Error::Other("Computer cleanup has not completed.".into()));
        }
        state.runtime(runtime_id)?;
        let runtime = state.runtimes.get_mut(runtime_id).unwrap();
        if !runtime.enabled {
            runtime.generation += 1;
            runtime.enabled = true;
            runtime.state = "enabled".into();
            runtime.reason = None;
            runtime.revocations.send_replace(runtime.generation);
            runtime.pending.clear();
            runtime.answered.clear();
            runtime.responding.clear();
            runtime.grants.clear();
            runtime.captures.clear();
        }
    }
    core.emit(Some(runtime_id));
    Ok(core.status(Some(runtime_id)))
}

#[tauri::command]
pub fn computer_use_set_enabled(
    computer: State<'_, ComputerUse>,
    runtime_id: String,
    enabled: bool,
) -> Result<Status> {
    set_enabled(&computer.0, &runtime_id, enabled)
}

#[tauri::command]
pub async fn computer_use_request_app(
    computer: State<'_, ComputerUse>,
    runtime_id: String,
    app_id: String,
) -> Result<PermissionRequest> {
    computer.0.request_app(&runtime_id, &app_id).await
}

pub(crate) async fn respond(
    core: &Arc<Core>,
    runtime_id: &str,
    request_id: &str,
    allow: bool,
) -> Result<Status> {
    // Reserve the desktop before touching the allowed HWND. A denied rival,
    // including a second host instance, must not replace the owner's witness.
    let mut provisional_lease: Option<std::fs::File> = None;
    struct PreparedWindow {
        app: AppInfo,
        committed: bool,
    }
    impl Drop for PreparedWindow {
        fn drop(&mut self) {
            if !self.committed {
                platform::remove_window_witness(&self.app);
            }
        }
    }
    let mut prepared: Option<PreparedWindow> = None;
    let mut request = {
        let state = core.lock();
        let runtime = state.enabled(runtime_id)?;
        if runtime.answered.get(request_id) == Some(&allow) {
            drop(state);
            return Ok(core.status(Some(runtime_id)));
        }
        if allow {
            if state.cleanup.state != "idle" || state.driver_status.state != "ready" {
                return Err(Error::Other(
                    "Computer driver or previous cleanup is not ready.".into(),
                ));
            }
            if state
                .owner
                .as_deref()
                .is_some_and(|owner| owner != runtime_id)
            {
                return Err(Error::Other(
                    "Another conversation controls the computer. Take back control first.".into(),
                ));
            }
            if state.owner.is_none() {
                provisional_lease = Some(platform::desktop_lock_in(&core.data_dir)?);
            }
        }
        runtime.pending.get(request_id).cloned()
    };
    struct ResponseClaim {
        core: std::sync::Weak<Core>,
        runtime_id: String,
        request_id: String,
        generation: u64,
    }
    impl Drop for ResponseClaim {
        fn drop(&mut self) {
            if let Some(core) = self.core.upgrade() {
                let mut state = core.lock();
                if let Some(runtime) = state.runtimes.get_mut(&self.runtime_id) {
                    if runtime.generation == self.generation {
                        runtime.responding.remove(&self.request_id);
                    }
                }
            }
        }
    }
    let generation = request
        .as_ref()
        .ok_or_else(|| Error::Other("App permission request was cancelled.".into()))?
        .generation;
    {
        let mut state = core.lock();
        let runtime = state
            .runtimes
            .get_mut(runtime_id)
            .ok_or_else(|| Error::Other("Captured runtime retired.".into()))?;
        if !runtime.live
            || !runtime.enabled
            || runtime.generation != generation
            || !runtime.pending.contains_key(request_id)
        {
            return Err(Error::Other("App permission request was cancelled.".into()));
        }
        if !runtime.responding.insert(request_id.into()) {
            return Err(Error::Other(
                "This app permission response is already in progress.".into(),
            ));
        }
    }
    let _claim = ResponseClaim {
        core: Arc::downgrade(core),
        runtime_id: runtime_id.into(),
        request_id: request_id.into(),
        generation,
    };
    if allow {
        if let Some(request) = request.as_mut() {
            let mut app = request.app.clone();
            app.window_witness = None;
            let window = tokio::task::spawn_blocking(move || {
                platform::bind_window(app).map(|app| PreparedWindow {
                    app,
                    committed: false,
                })
            })
            .await
            .map_err(|error| Error::Other(error.to_string()))??;
            request.app = window.app.clone();
            prepared = Some(window);
        }
    }
    // A bounded manifest is immutable inside the driver. Adding a second app
    // retires that driver before starting a new manifest with the approved union.
    let restart = {
        let mut state = core.lock();
        if allow {
            let request = request
                .as_ref()
                .ok_or_else(|| Error::Other("App permission request was cancelled.".into()))?;
            let runtime = state.enabled(runtime_id)?;
            if runtime.generation != request.generation || !runtime.pending.contains_key(request_id)
            {
                return Err(Error::Other("App permission request was cancelled.".into()));
            }
            state
                .runtimes
                .get_mut(runtime_id)
                .unwrap()
                .pending
                .get_mut(request_id)
                .unwrap()
                .app = request.app.clone();
        }
        if allow
            && (state.driver.is_some() || state.worker.is_some())
            && state.owner.as_deref() == Some(runtime_id)
        {
            let request = request
                .as_ref()
                .ok_or_else(|| Error::Other("App permission request was cancelled.".into()))?;
            let runtime = state.enabled(runtime_id)?;
            if runtime.generation != request.generation || !runtime.pending.contains_key(request_id)
            {
                return Err(Error::Other("App permission request was cancelled.".into()));
            }
            if state.cleanup.state != "idle" {
                return Err(Error::Other("Computer cleanup is still pending.".into()));
            }
            let lease = state
                .lease
                .as_ref()
                .map(std::fs::File::try_clone)
                .transpose()?;
            state.cleanup_serial += 1;
            let serial = state.cleanup_serial;
            state.cleanup = super::types::CleanupStatus {
                state: "stopping".into(),
                reason: Some("Updating approved app scope.".into()),
            };
            let driver = state.driver.take();
            if let Some(driver) = driver.as_ref() {
                driver.kill();
            }
            let worker = state.worker.take();
            if let Some(worker) = worker.as_ref() {
                worker.kill();
            }
            let held = state.held.take();
            let runtime = state.runtimes.get_mut(runtime_id).unwrap();
            runtime.generation += 1;
            runtime.revocations.send_replace(runtime.generation);
            runtime.pending.clear();
            runtime.answered.clear();
            runtime.responding.clear();
            runtime.captures.clear();
            runtime.state = "granted".into();
            Some((
                super::state::Cleanup {
                    serial,
                    driver,
                    worker,
                    lease,
                    held,
                    windows: Vec::new(),
                },
                runtime.generation,
                request.app.clone(),
            ))
        } else {
            None
        }
    };
    if let Some((work, generation, app)) = restart {
        let serial = work.serial;
        core.emit(Some(runtime_id));
        let result = tokio::task::spawn_blocking(move || super::state::run_cleanup(work))
            .await
            .map_err(|error| Error::Other(error.to_string()))?;
        {
            let mut state = core.lock();
            if state.cleanup_serial != serial
                || state.enabled(runtime_id)?.generation != generation
                || state.owner.as_deref() != Some(runtime_id)
            {
                return Err(Error::Other(
                    "App approval was cancelled while the previous driver stopped.".into(),
                ));
            }
            match result {
                Ok(()) => {
                    state.cleanup = super::types::CleanupStatus::default();
                    let runtime = state.runtimes.get_mut(runtime_id).unwrap();
                    runtime.grants.insert(app.app_id.clone(), app);
                    runtime.answered.insert(request_id.into(), true);
                    runtime.state = "granted".into();
                }
                Err(error) => {
                    state.cleanup = super::types::CleanupStatus {
                        state: "failed".into(),
                        reason: Some(error.to_string()),
                    };
                    drop(state);
                    core.revoke(runtime_id, "driver_failed");
                    return Err(error);
                }
            }
        }
        core.emit(Some(runtime_id));
        if let Some(prepared) = prepared.as_mut() {
            prepared.committed = true;
        }
        return Ok(core.status(Some(runtime_id)));
    }
    core.lock().respond(runtime_id, request_id, allow, || {
        provisional_lease
            .take()
            .ok_or_else(|| Error::Other("Desktop lease reservation was cancelled.".into()))
    })?;
    if let Some(prepared) = prepared.as_mut() {
        prepared.committed = true;
    }
    core.emit(Some(runtime_id));
    Ok(core.status(Some(runtime_id)))
}

#[tauri::command]
pub async fn computer_use_respond(
    computer: State<'_, ComputerUse>,
    runtime_id: String,
    request_id: String,
    allow: bool,
) -> Result<Status> {
    respond(&computer.0, &runtime_id, &request_id, allow).await
}

#[tauri::command]
pub fn computer_use_revoke_app(
    computer: State<'_, ComputerUse>,
    runtime_id: String,
    app_id: String,
) -> Result<Status> {
    let app = computer.0.lock().revoke_app(&runtime_id, &app_id)?;
    platform::remove_window_witness(&app);
    computer.0.emit(Some(&runtime_id));
    Ok(computer.0.status(Some(&runtime_id)))
}

#[tauri::command]
pub fn computer_use_take_back(
    computer: State<'_, ComputerUse>,
    runtime_id: Option<String>,
) -> Status {
    take_back(&computer.0, runtime_id.as_deref())
}

pub(crate) fn take_back(core: &Arc<Core>, runtime_id: Option<&str>) -> Status {
    if let Some(id) = runtime_id {
        core.revoke(id, "user_take_back");
    } else {
        let ids = core.lock().runtimes.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            core.revoke(&id, "user_take_back");
        }
    }
    core.status(runtime_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn core() -> Arc<Core> {
        let mut state = super::super::state::State::default();
        state.driver_status.state = "ready".into();
        state.register("a", "fixture-a", true).unwrap();
        state.register("b", "fixture-b", true).unwrap();
        Arc::new(Core {
            app: None,
            state: std::sync::Mutex::new(state),
            action: Arc::new(tokio::sync::Mutex::new(())),
            broker_port: 1,
            data_dir: std::env::temp_dir(),
            worker_executable: None,
        })
    }
    fn app() -> AppInfo {
        AppInfo {
            window_witness: None,
            app_id: "fixture".into(),
            name: "fixture".into(),
            path: "C:\\fixture.exe".into(),
            pid: 1,
            window_id: "2".into(),
            title: "fixture".into(),
            tier: super::super::types::Tier::Full,
        }
    }
    #[test]
    fn global_take_back_cancels_unowned_pending_requests() {
        let core = core();
        let request = core.lock().request("b", app(), 1).unwrap();
        take_back(&core, None);
        let mut state = core.lock();
        assert!(state.runtimes["b"].pending.is_empty());
        assert!(!state.runtimes["b"].enabled);
        assert!(state
            .respond("b", &request.request_id, true, || Ok(std::fs::File::open(
                std::env::current_exe()?
            )?))
            .is_err());
    }
    #[test]
    fn foreground_preference_defaults_off_persists_and_revokes_on_disable() {
        let mut core = core();
        let directory = std::env::temp_dir().join(format!(
            "claudinal-foreground-setting-{}",
            uuid::Uuid::new_v4()
        ));
        Arc::get_mut(&mut core).unwrap().data_dir = directory.clone();
        assert!(!core.status(None).foreground_keys);
        assert!(set_foreground_keys(&core, true).unwrap().foreground_keys);
        assert_eq!(
            std::fs::read_to_string(directory.join("foreground-keys.json")).unwrap(),
            "true"
        );
        {
            let mut state = core.lock();
            state.owner = Some("a".into());
            state
                .runtimes
                .get_mut("a")
                .unwrap()
                .grants
                .insert("fixture".into(), app());
        }
        let generation = core.lock().runtimes["a"].generation;
        assert!(!set_foreground_keys(&core, false).unwrap().foreground_keys);
        let state = core.lock();
        assert!(state.authorize("a", generation, "fixture").is_err());
        assert!(state.runtimes["a"].grants.is_empty());
        assert!(state.runtimes["a"].generation > generation);
        assert_eq!(
            std::fs::read_to_string(directory.join("foreground-keys.json")).unwrap(),
            "false"
        );
        drop(state);
        let _ = std::fs::remove_dir_all(directory);
    }
    #[test]
    fn global_take_back_revokes_owner_and_other_pending_consent() {
        let core = core();
        let a = core.lock().request("a", app(), 1).unwrap();
        let b = core.lock().request("b", app(), 1).unwrap();
        core.lock()
            .respond("a", &a.request_id, true, || {
                Ok(std::fs::File::open(std::env::current_exe()?)?)
            })
            .unwrap();
        let previous = core.status(Some("a"));
        let stopped = take_back(&core, None);
        assert!(stopped.revision > previous.revision);
        assert!(stopped.controller.is_none());
        let mut state = core.lock();
        assert!(!state.runtimes["a"].enabled);
        assert!(!state.runtimes["b"].enabled);
        assert!(state
            .respond("b", &b.request_id, true, || Ok(std::fs::File::open(
                std::env::current_exe()?
            )?))
            .is_err());
    }
}
