use std::{
    collections::{HashMap, HashSet},
    fs::File,
    sync::Arc,
    time::Instant,
};

use super::{
    driver::{Driver, Evidence},
    platform,
    types::*,
};
use crate::error::{Error, Result};

pub struct Runtime {
    pub id: String,
    pub cwd: String,
    pub token: String,
    pub live: bool,
    pub enabled: bool,
    pub generation: u64,
    pub state: String,
    pub reason: Option<String>,
    pub grants: HashMap<String, AppInfo>,
    pub pending: HashMap<String, PermissionRequest>,
    pub answered: HashMap<String, bool>,
    pub responding: HashSet<String>,
    pub connection: Option<String>,
    pub captures: HashMap<String, Capture>,
    pub revocations: tokio::sync::watch::Sender<u64>,
}

pub struct Capture {
    pub id: String,
    pub width: f64,
    pub height: f64,
    pub created: Instant,
    pub consumed: bool,
    pub geometry: Option<serde_json::Value>,
}

impl Runtime {
    pub fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            runtime_id: self.id.clone(),
            cwd: self.cwd.clone(),
            enabled: self.enabled,
            generation: self.generation,
            state: self.state.clone(),
            apps: self.grants.values().cloned().collect(),
            pending_requests: self.pending.values().cloned().collect(),
            reason: self.reason.clone(),
        }
    }
}

pub struct HeldInput {
    pub app: AppInfo,
    pub targets: Vec<usize>,
    pub keys: Vec<u16>,
    pub mouse: bool,
}

pub struct Cleanup {
    pub serial: u64,
    pub driver: Option<Arc<Driver>>,
    pub(super) worker: Option<Arc<super::window_executor::Worker>>,
    pub lease: Option<File>,
    pub held: Option<HeldInput>,
    pub windows: Vec<AppInfo>,
}

pub struct State {
    pub revision: u64,
    pub runtimes: HashMap<String, Runtime>,
    pub driver_status: DriverStatus,
    pub evidence: Option<Evidence>,
    pub evidence_generation: u64,
    pub owner: Option<String>,
    pub lease: Option<File>,
    pub driver: Option<Arc<Driver>>,
    pub(super) worker: Option<Arc<super::window_executor::Worker>>,
    pub held: Option<HeldInput>,
    pub cleanup: CleanupStatus,
    pub cleanup_serial: u64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            revision: 0,
            runtimes: HashMap::new(),
            driver_status: DriverStatus::default(),
            evidence: None,
            evidence_generation: 0,
            owner: None,
            lease: None,
            driver: None,
            worker: None,
            held: None,
            cleanup: CleanupStatus::default(),
            cleanup_serial: 0,
        }
    }
}

impl State {
    pub fn status(&mut self, runtime_id: Option<&str>) -> Status {
        self.revision += 1;
        let runtime = runtime_id
            .and_then(|id| self.runtimes.get(id))
            .map(|runtime| {
                let mut status = runtime.status();
                if self.owner.as_deref() == Some(runtime.id.as_str()) && self.held.is_some() {
                    status.state = "active".into();
                }
                status
            });
        Status {
            revision: self.revision,
            driver: self.driver_status.clone(),
            runtime,
            controller: self
                .owner
                .as_ref()
                .and_then(|id| self.runtimes.get(id))
                .map(|runtime| Controller {
                    runtime_id: runtime.id.clone(),
                    cwd: runtime.cwd.clone(),
                }),
            cleanup: self.cleanup.clone(),
        }
    }

    pub fn register(&mut self, id: &str, cwd: &str, enabled: bool) -> Result<String> {
        if self.runtimes.contains_key(id) {
            return Err(Error::Other(
                "Runtime computer registration is single use.".into(),
            ));
        }
        // Two independent v4 UUIDs provide 244 random bits; never exposed in status.
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.runtimes.insert(
            id.into(),
            Runtime {
                id: id.into(),
                cwd: cwd.into(),
                token: token.clone(),
                live: true,
                enabled,
                generation: 1,
                state: if enabled { "enabled" } else { "disabled" }.into(),
                reason: None,
                grants: HashMap::new(),
                pending: HashMap::new(),
                answered: HashMap::new(),
                responding: HashSet::new(),
                connection: None,
                captures: HashMap::new(),
                revocations: tokio::sync::watch::channel(1).0,
            },
        );
        Ok(token)
    }

    pub fn runtime(&self, id: &str) -> Result<&Runtime> {
        self.runtimes
            .get(id)
            .filter(|runtime| runtime.live)
            .ok_or_else(|| {
                Error::Other(
                    "The captured runtime has retired. Start a new conversation run.".into(),
                )
            })
    }

    pub fn enabled(&self, id: &str) -> Result<&Runtime> {
        let runtime = self.runtime(id)?;
        if !runtime.enabled {
            return Err(Error::Other(
                "Computer access is disabled. Enable it in this conversation first.".into(),
            ));
        }
        Ok(runtime)
    }

    pub fn authenticate(&self, id: &str, token: &str) -> Result<()> {
        let runtime = self.runtime(id)?;
        // Fixed-length, constant-time comparison keeps the capability out of diagnostics.
        if token.len() != runtime.token.len()
            || token
                .as_bytes()
                .iter()
                .zip(runtime.token.as_bytes())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                != 0
        {
            return Err(Error::Other("Invalid computer gateway capability.".into()));
        }
        Ok(())
    }

    pub fn request(
        &mut self,
        id: &str,
        app: AppInfo,
        generation: u64,
    ) -> Result<PermissionRequest> {
        let runtime = self.enabled(id)?;
        if runtime.generation != generation {
            return Err(Error::Other("Computer request was cancelled.".into()));
        }
        if runtime.grants.contains_key(&app.app_id) {
            return Err(Error::Other(
                "This exact app window is already approved.".into(),
            ));
        }
        if let Some(existing) = runtime
            .pending
            .values()
            .find(|request| request.app.app_id == app.app_id)
        {
            return Ok(existing.clone());
        }
        if runtime.pending.len() >= 16 {
            return Err(Error::Other(
                "Computer permission request limit reached.".into(),
            ));
        }
        let request = PermissionRequest {
            runtime_id: id.into(),
            request_id: uuid::Uuid::new_v4().to_string(),
            generation,
            tier: app.tier,
            app,
            reason: "Allow this exact app window for this conversation only.".into(),
        };
        let runtime = self.runtimes.get_mut(id).unwrap();
        runtime
            .pending
            .insert(request.request_id.clone(), request.clone());
        runtime.state = "requested".into();
        Ok(request)
    }

    pub fn respond(
        &mut self,
        id: &str,
        request_id: &str,
        allow: bool,
        lease: impl FnOnce() -> Result<File>,
    ) -> Result<()> {
        let runtime = self.enabled(id)?;
        if runtime.answered.get(request_id) == Some(&allow) {
            return Ok(());
        }
        let request = runtime.pending.get(request_id).filter(|request| request.generation == runtime.generation)
            .cloned().ok_or_else(|| Error::Other("This app permission request was cancelled or belongs to an older runtime generation.".into()))?;
        if allow {
            if self.cleanup.state != "idle" {
                return Err(Error::Other(
                    "Previous computer input cleanup has not completed.".into(),
                ));
            }
            if self.driver_status.state != "ready" {
                return Err(Error::Other(
                    "Verify or install the driver before approving apps.".into(),
                ));
            }
            if self.owner.as_deref().is_some_and(|owner| owner != id) {
                return Err(Error::Other(
                    "Another conversation controls the computer. Take back control first.".into(),
                ));
            }
            if self.driver.is_some() {
                return Err(Error::Other("Take back control before changing the approved app list, then enable and approve the desired windows.".into()));
            }
            if self.owner.is_none() {
                self.lease = Some(lease()?);
                self.owner = Some(id.into());
            }
        }
        let runtime = self.runtimes.get_mut(id).unwrap();
        runtime.pending.remove(request_id);
        if runtime.answered.len() >= 64 {
            runtime.answered.clear();
            runtime.responding.clear();
        }
        runtime.answered.insert(request_id.into(), allow);
        if allow {
            runtime
                .grants
                .insert(request.app.app_id.clone(), request.app);
        }
        runtime.state = if runtime.grants.is_empty() {
            "enabled"
        } else {
            "granted"
        }
        .into();
        Ok(())
    }

    /// The authority barrier is entirely synchronous and runs before cleanup.
    pub fn revoke(&mut self, id: &str, reason: &str, retire: bool) -> Option<Cleanup> {
        let windows = self
            .runtimes
            .get(id)
            .map(|runtime| runtime.grants.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        if let Some(runtime) = self.runtimes.get_mut(id) {
            runtime.enabled = false;
            runtime.generation += 1;
            runtime.revocations.send_replace(runtime.generation);
            runtime.state = "revoked".into();
            runtime.reason = Some(reason.into());
            runtime.grants.clear();
            runtime.pending.clear();
            runtime.answered.clear();
            runtime.captures.clear();
            if retire {
                runtime.live = false;
                runtime.token.clear();
                runtime.connection = None;
            }
        }
        if self.owner.as_deref() != Some(id) {
            for app in &windows {
                platform::remove_window_witness(app);
            }
            return None;
        }
        self.owner = None;
        self.cleanup_serial += 1;
        self.cleanup = CleanupStatus {
            state: "stopping".into(),
            reason: Some(reason.into()),
        };
        let driver = self.driver.take();
        if let Some(driver) = driver.as_ref() {
            driver.kill();
        }
        let worker = self.worker.take();
        if let Some(worker) = worker.as_ref() {
            worker.kill();
        }
        Some(Cleanup {
            serial: self.cleanup_serial,
            driver,
            worker,
            lease: self.lease.take(),
            held: self.held.take(),
            windows,
        })
    }

    /// Withdraw one app without touching other grants. Every action re-checks
    /// grants under this lock, so the next call for this app is refused.
    pub fn revoke_app(&mut self, id: &str, app_id: &str) -> Result<AppInfo> {
        self.runtime(id)?;
        if self
            .held
            .as_ref()
            .is_some_and(|held| held.app.app_id == app_id)
        {
            return Err(Error::Other(
                "An action is in progress in this app. Take back control to stop it now.".into(),
            ));
        }
        let runtime = self.runtimes.get_mut(id).unwrap();
        let app = runtime
            .grants
            .remove(app_id)
            .ok_or_else(|| Error::Other("This app is not approved for the conversation.".into()))?;
        runtime.captures.remove(app_id);
        if runtime.enabled {
            runtime.state = if runtime.grants.is_empty() {
                "enabled"
            } else {
                "granted"
            }
            .into();
        }
        Ok(app)
    }

    pub fn authorize(&self, id: &str, generation: u64, app_id: &str) -> Result<AppInfo> {
        let runtime = self.enabled(id)?;
        if runtime.generation != generation
            || self.owner.as_deref() != Some(id)
            || self.cleanup.state != "idle"
        {
            return Err(Error::Other(
                "Computer control was revoked or belongs to another conversation.".into(),
            ));
        }
        runtime
            .grants
            .get(app_id)
            .cloned()
            .ok_or_else(|| Error::Other("This exact app window has not been approved.".into()))
    }
}

pub fn is_retirement(reason: &str) -> bool {
    !matches!(
        reason,
        "interrupt_requested"
            | "interrupt"
            | "turn_error"
            | "user_disabled"
            | "user_take_back"
            | "gateway_disconnected"
            | "driver_failed"
    )
}

pub fn run_cleanup(work: Cleanup) -> Result<()> {
    let result = std::thread::scope(|scope| {
        let driver = scope.spawn(|| {
            work.driver
                .as_ref()
                .map(|driver| driver.reap())
                .unwrap_or(Ok(()))
        });
        let worker = scope.spawn(|| {
            work.worker
                .as_ref()
                .map(|worker| worker.reap())
                .unwrap_or(Ok(()))
        });
        let driver = driver
            .join()
            .unwrap_or_else(|_| Err(Error::Other("Driver reaper failed.".into())));
        let worker = worker
            .join()
            .unwrap_or_else(|_| Err(Error::Other("Window worker reaper failed.".into())));
        driver.and(worker)
    });
    let release = work
        .held
        .as_ref()
        .map(|held| {
            platform::release_background_input(&held.app, &held.targets, &held.keys, held.mouse)
        })
        .unwrap_or(Ok(()));
    for app in &work.windows {
        platform::remove_window_witness(app);
    }
    // Retain the cross-instance lease until both driver termination and release.
    // On failure the host stays fail-closed; its file lock lives until shutdown.
    match result.and(release) {
        Ok(()) => {
            drop(work.lease);
            Ok(())
        }
        Err(error) => {
            if let Some(lease) = work.lease {
                std::mem::forget(lease);
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app() -> AppInfo {
        AppInfo {
            window_witness: None,
            app_id: "1:2:3".into(),
            name: "fixture".into(),
            path: "C:\\fixture.exe".into(),
            pid: 1,
            window_id: "2".into(),
            title: "fixture".into(),
            tier: Tier::Full,
        }
    }
    fn fake_lease() -> Result<File> {
        Ok(std::fs::File::open(std::env::current_exe()?)?)
    }
    fn state() -> State {
        let mut state = State::default();
        state.driver_status.state = "ready".into();
        state.register("a", "cwd-a", false).unwrap();
        state.register("b", "cwd-b", true).unwrap();
        state
    }
    fn enable(state: &mut State, id: &str) {
        let runtime = state.runtimes.get_mut(id).unwrap();
        runtime.enabled = true;
        runtime.generation += 1;
    }
    #[test]
    fn default_off_token_binding_and_cancelled_request_cannot_grant() {
        let mut state = state();
        assert!(state.enabled("a").is_err());
        assert!(state.authenticate("a", &state.runtimes["b"].token).is_err());
        enable(&mut state, "a");
        let request = state.request("a", app(), 2).unwrap();
        state.revoke("a", "interrupt_requested", false);
        enable(&mut state, "a");
        assert!(state
            .respond("a", &request.request_id, true, fake_lease)
            .is_err());
        assert!(state.owner.is_none());
    }
    #[test]
    fn lease_is_exclusive_and_stale_retirement_cannot_revoke_new_owner() {
        let mut state = state();
        enable(&mut state, "a");
        let request = state.request("a", app(), 2).unwrap();
        state
            .respond("a", &request.request_id, true, fake_lease)
            .unwrap();
        let request_b = state.request("b", app(), 1).unwrap();
        assert!(state
            .respond("b", &request_b.request_id, true, fake_lease)
            .is_err());
        let work = state.revoke("a", "runtime_retired", true).unwrap();
        assert!(state.authorize("a", 2, "1:2:3").is_err());
        assert!(state
            .respond("b", &request_b.request_id, true, fake_lease)
            .is_err());
        run_cleanup(work).unwrap();
        state.cleanup = CleanupStatus::default();
        state
            .respond("b", &request_b.request_id, true, fake_lease)
            .unwrap();
        assert!(state.revoke("a", "runtime_retired", true).is_none());
        assert_eq!(state.owner.as_deref(), Some("b"));
    }
    #[test]
    fn revoking_one_app_keeps_other_grants_and_blocks_only_that_app() {
        let mut state = state();
        let mut other = app();
        other.app_id = "9:8:7".into();
        let first = state.request("b", app(), 1).unwrap();
        state
            .respond("b", &first.request_id, true, fake_lease)
            .unwrap();
        let second = state.request("b", other.clone(), 1).unwrap();
        state
            .respond("b", &second.request_id, true, fake_lease)
            .unwrap();
        state.revoke_app("b", "1:2:3").unwrap();
        assert!(state.authorize("b", 1, "1:2:3").is_err());
        assert!(state.authorize("b", 1, &other.app_id).is_ok());
        assert_eq!(state.runtimes["b"].state, "granted");
        assert!(state.revoke_app("b", "1:2:3").is_err());
        state.revoke_app("b", &other.app_id).unwrap();
        assert_eq!(state.runtimes["b"].state, "enabled");
        assert_eq!(state.owner.as_deref(), Some("b"));
    }
    #[test]
    fn denial_and_duplicate_decisions_are_terminal() {
        let mut state = state();
        let request = state.request("b", app(), 1).unwrap();
        state
            .respond("b", &request.request_id, false, fake_lease)
            .unwrap();
        state
            .respond("b", &request.request_id, false, fake_lease)
            .unwrap();
        assert!(state
            .respond("b", &request.request_id, true, fake_lease)
            .is_err());
        assert!(state.owner.is_none());
    }
}
