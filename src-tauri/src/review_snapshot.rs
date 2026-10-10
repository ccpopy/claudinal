//! Bounded pre-send baselines and frozen end boundaries. No diff computation
//! may read the workspace after `freeze` has returned.
use crate::child_process::hide_std_window;
use crate::commands::{
    classify_review_snapshot_changes, review_snapshot_changes_to_diff, WorktreeDiff,
};
use crate::error::{Error, Result};
use crate::fs_atomic::atomic_write_str;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

const CAPTURE_TIME: Duration = Duration::from_millis(250);
/// The worker stops scanning at its deadline and then publishes a partial
/// manifest; the outer wait must outlast that write or partial is never kept.
const PUBLISH_GRACE: Duration = Duration::from_millis(200);
const DIFF_TIME: Duration = Duration::from_secs(3);
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_FILES: usize = 2000;
const MAX_ENTRIES: usize = 20_000;
const MAX_COMMAND_BYTES: usize = 2 * 1024 * 1024;

fn capture_slots() -> Arc<tokio::sync::Semaphore> {
    static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
}

fn diff_slots() -> Arc<tokio::sync::Semaphore> {
    static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReviewState {
    Ready,
    Partial,
    Unavailable,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTimings {
    pub enumeration_ms: u64,
    pub read_ms: u64,
    pub hash_ms: u64,
    pub write_ms: u64,
    pub total_ms: u64,
    pub freeze_ms: u64,
    pub diff_ms: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStats {
    pub captured_files: usize,
    pub skipped_files: usize,
    pub captured_bytes: u64,
    pub enumerated_entries: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshotStart {
    pub id: String,
    pub cwd: String,
    pub file_count: usize,
    pub state: ReviewState,
    pub reason: Option<String>,
    pub coverage_complete: bool,
    pub timings: ReviewTimings,
    pub stats: ReviewStats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshotFinish {
    #[serde(flatten)]
    pub diff: WorktreeDiff,
    pub review_state: ReviewState,
    pub review_reason: Option<String>,
    pub timings: ReviewTimings,
    pub stats: ReviewStats,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewSnapshotFile {
    pub path: String,
    pub size: u64,
    pub modified_ms: u128,
    pub hash: u64,
    pub binary: bool,
    pub baseline_path: Option<String>,
}

pub(crate) struct ReviewCurrentFile {
    pub size: u64,
    pub hash: u64,
    pub binary: bool,
    pub content: Option<String>,
}

pub(crate) struct ReviewSnapshotChange {
    pub path: String,
    pub status: String,
    pub before: Option<ReviewSnapshotFile>,
    pub after: Option<ReviewCurrentFile>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
    cwd: String,
    files: Vec<ReviewSnapshotFile>,
    excluded: HashSet<String>,
    missing: HashSet<String>,
    enumeration_complete: bool,
    state: ReviewState,
    reason: Option<String>,
    timings: ReviewTimings,
    stats: ReviewStats,
}

impl Capture {
    fn new(cwd: String) -> Self {
        Self {
            cwd,
            files: Vec::new(),
            excluded: HashSet::new(),
            missing: HashSet::new(),
            enumeration_complete: true,
            state: ReviewState::Ready,
            reason: None,
            timings: ReviewTimings::default(),
            stats: ReviewStats::default(),
        }
    }
    fn partial(&mut self, reason: impl Into<String>) {
        self.state = ReviewState::Partial;
        if self.reason.is_none() {
            self.reason = Some(reason.into());
        }
    }
    fn response(&self, id: String) -> ReviewSnapshotStart {
        ReviewSnapshotStart {
            id,
            cwd: self.cwd.clone(),
            file_count: self.files.len(),
            state: self.state,
            reason: self.reason.clone(),
            coverage_complete: self.state == ReviewState::Ready,
            timings: self.timings.clone(),
            stats: self.stats.clone(),
        }
    }
}

struct Job {
    cancelled: Arc<AtomicBool>,
    touched: Instant,
}
fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune_jobs(jobs: &mut HashMap<String, Job>) {
    jobs.retain(|_, job| {
        job.touched.elapsed()
            < if job.cancelled.load(Ordering::Acquire) {
                Duration::from_secs(60)
            } else {
                Duration::from_secs(24 * 3600)
            }
    });
    if jobs.len() >= 128 {
        if let Some(id) = jobs
            .iter()
            .filter(|(_, job)| job.cancelled.load(Ordering::Acquire))
            .min_by_key(|(_, job)| job.touched)
            .map(|(id, _)| id.clone())
        {
            jobs.remove(&id);
        }
    }
}

fn token(id: &str, create: bool) -> Result<Arc<AtomicBool>> {
    let mut jobs = jobs()
        .lock()
        .map_err(|_| Error::Other("review job lock poisoned".into()))?;
    prune_jobs(&mut jobs);
    if !jobs.contains_key(id) {
        if !create {
            return Err(Error::Other("review snapshot expired or cancelled".into()));
        }
        if jobs.len() >= 128 {
            return Err(Error::Other("too many pending review snapshots".into()));
        }
        jobs.insert(
            id.into(),
            Job {
                cancelled: Arc::new(AtomicBool::new(false)),
                touched: Instant::now(),
            },
        );
    }
    let job = jobs.get_mut(id).unwrap();
    job.touched = Instant::now();
    Ok(job.cancelled.clone())
}

fn forget(id: &str) {
    if let Ok(mut jobs) = jobs().lock() {
        jobs.remove(id);
    }
}

fn register_start(id: &str) -> Result<Arc<AtomicBool>> {
    let mut jobs = jobs()
        .lock()
        .map_err(|_| Error::Other("review job lock poisoned".into()))?;
    prune_jobs(&mut jobs);
    if jobs.contains_key(id) {
        return Err(Error::Other(
            "review snapshot already started or cancelled".into(),
        ));
    }
    if jobs.len() >= 128 {
        return Err(Error::Other("too many pending review snapshots".into()));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    jobs.insert(
        id.into(),
        Job {
            cancelled: cancelled.clone(),
            touched: Instant::now(),
        },
    );
    Ok(cancelled)
}

struct CaptureDirectory<'a> {
    path: &'a Path,
    keep: bool,
}
impl Drop for CaptureDirectory<'_> {
    fn drop(&mut self) {
        if !self.keep {
            std::fs::remove_dir_all(self.path).ok();
        }
    }
}

pub(crate) struct Control {
    started: Instant,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    max_bytes: u64,
    max_file_bytes: u64,
    max_files: usize,
}

impl Control {
    pub(crate) fn new(cancelled: Arc<AtomicBool>, duration: Duration) -> Self {
        let started = Instant::now();
        Self {
            started,
            deadline: started + duration,
            cancelled,
            max_bytes: MAX_BYTES,
            max_file_bytes: MAX_FILE_BYTES,
            max_files: MAX_FILES,
        }
    }
    pub(crate) fn check(&self) -> std::result::Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("审查准备已取消或结果已过期".into())
        } else if Instant::now() >= self.deadline {
            Err("审查准备达到时间预算，覆盖范围不完整".into())
        } else {
            Ok(())
        }
    }
    fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

pub(crate) fn root() -> PathBuf {
    std::env::temp_dir().join("claudinal-review-snapshots")
}
pub(crate) fn dir(id: &str) -> Result<PathBuf> {
    if id.is_empty()
        || id.len() > 100
        || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err(Error::Other(format!("invalid review snapshot id: {id}")));
    }
    Ok(root().join(id))
}

fn unavailable(id: String, cwd: String, reason: String) -> ReviewSnapshotStart {
    ReviewSnapshotStart {
        id,
        cwd,
        file_count: 0,
        state: ReviewState::Unavailable,
        reason: Some(reason),
        coverage_complete: false,
        timings: ReviewTimings::default(),
        stats: ReviewStats::default(),
    }
}

/// Expiry cancels the worker token before returning. A blocked OS read may finish
/// later, but the worker cannot publish or use any bytes after cancellation.
pub async fn start(cwd: String, id: Option<String>) -> Result<ReviewSnapshotStart> {
    start_with_budget(cwd, id, CAPTURE_TIME).await
}

async fn start_with_budget(
    cwd: String,
    id: Option<String>,
    time_budget: Duration,
) -> Result<ReviewSnapshotStart> {
    let started = Instant::now();
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let dir = dir(&id)?;
    let cancelled = match register_start(&id) {
        Ok(token) => token,
        Err(error) => return Ok(unavailable(id, cwd, error.to_string())),
    };
    let permit = match capture_slots().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            cancelled.store(true, Ordering::Release);
            forget(&id);
            return Ok(unavailable(
                id,
                cwd,
                "审查准备达到并发预算，本轮审查不可用".into(),
            ));
        }
    };
    let worker_id = id.clone();
    let worker_cwd = cwd.clone();
    let worker_token = cancelled.clone();
    let control = Control::new(worker_token, time_budget);
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let result = capture_start(&worker_cwd, &dir, &control);
        if result.is_ok() && control.cancelled.load(Ordering::Acquire) {
            std::fs::remove_dir_all(&dir).ok();
        }
        if result.is_err() || control.cancelled.load(Ordering::Acquire) {
            forget(&worker_id);
        }
        result
    });
    match tokio::time::timeout(time_budget + PUBLISH_GRACE, task).await {
        Ok(Ok(Ok(capture))) if !cancelled.load(Ordering::Acquire) => {
            let mut response = capture.response(id);
            response.timings.total_ms = started.elapsed().as_millis() as u64;
            Ok(response)
        }
        result => {
            cancelled.store(true, Ordering::Release);
            forget(&id);
            let reason = match result {
                Ok(Ok(Err(error))) => error.to_string(),
                Ok(Err(error)) => format!("审查准备工作线程失败: {error}"),
                _ => "审查准备超时或已取消，本轮审查不可用".into(),
            };
            let mut response = unavailable(id, cwd, reason);
            response.timings.total_ms = started.elapsed().as_millis() as u64;
            Ok(response)
        }
    }
}

fn capture_start(cwd: &str, dir: &Path, control: &Control) -> Result<Capture> {
    let root = Path::new(cwd);
    if !root.is_dir() {
        return Err(Error::Other(format!("cwd not a directory: {cwd}")));
    }
    control.check().map_err(Error::Other)?;
    // A caller id must not replace another still-active baseline.
    std::fs::create_dir_all(dir.parent().unwrap())?;
    std::fs::create_dir(dir)?;
    let mut cleanup = CaptureDirectory {
        path: dir,
        keep: false,
    };
    std::fs::create_dir(dir.join("files"))?;
    let mut capture = Capture::new(cwd.into());
    let paths = candidates(root, control, &mut capture);
    for path in paths {
        if let Err(reason) = control.check() {
            capture.partial(reason);
            capture.enumeration_complete = false;
            break;
        }
        capture_file(root, &path, dir, "start", control, &mut capture, false);
    }
    capture.timings.total_ms = control.elapsed_ms();
    if capture.state == ReviewState::Partial && capture.files.is_empty() {
        capture.state = ReviewState::Unavailable;
    }
    // Deadline exhaustion preserves only bytes captured within budget. Cancellation
    // never publishes a manifest, even if it races the final write.
    if control.cancelled.load(Ordering::Acquire) {
        return Err(Error::Other("review cancelled".into()));
    }
    atomic_write_str(
        &dir.join("manifest.json"),
        &serde_json::to_string(&capture)?,
    )?;
    if control.cancelled.load(Ordering::Acquire) {
        return Err(Error::Other("review cancelled".into()));
    }
    cleanup.keep = true;
    Ok(capture)
}

pub async fn freeze(id: String) -> Result<ReviewSnapshotStart> {
    freeze_with_budget(id, CAPTURE_TIME).await
}

async fn freeze_with_budget(id: String, time_budget: Duration) -> Result<ReviewSnapshotStart> {
    let started = Instant::now();
    let dir = dir(&id)?;
    let cancelled = match token(&id, false) {
        Ok(token) => token,
        Err(error) => return Ok(unavailable(id, String::new(), error.to_string())),
    };
    let permit = match capture_slots().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            cancelled.store(true, Ordering::Release);
            forget(&id);
            tokio::task::spawn_blocking(move || {
                std::fs::remove_dir_all(dir).ok();
            });
            return Ok(unavailable(
                id,
                String::new(),
                "审查终点达到并发预算，本轮审查不可用".into(),
            ));
        }
    };
    let worker_token = cancelled.clone();
    let worker_id = id.clone();
    let control = Control::new(worker_token, time_budget);
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let result = capture_end(&dir, &control);
        if result.is_err() || control.cancelled.load(Ordering::Acquire) {
            std::fs::remove_dir_all(&dir).ok();
            forget(&worker_id);
        }
        result
    });
    match tokio::time::timeout(time_budget + PUBLISH_GRACE, task).await {
        Ok(Ok(Ok(capture))) if !cancelled.load(Ordering::Acquire) => {
            let mut response = capture.response(id);
            response.timings.freeze_ms = started.elapsed().as_millis() as u64;
            Ok(response)
        }
        result => {
            cancelled.store(true, Ordering::Release);
            forget(&id);
            let reason = match result {
                Ok(Ok(Err(error))) => error.to_string(),
                Ok(Err(error)) => format!("审查终点工作线程失败: {error}"),
                _ => "未能在预算内冻结本轮终点，本轮审查不可用".into(),
            };
            let mut response = unavailable(id, String::new(), reason);
            response.timings.freeze_ms = started.elapsed().as_millis() as u64;
            Ok(response)
        }
    }
}

fn capture_end(dir: &Path, control: &Control) -> Result<Capture> {
    if dir.join("frozen.json").is_file() {
        return read_capture(&dir.join("frozen.json"));
    }
    let baseline = read_capture(&dir.join("manifest.json"))?;
    if baseline.state == ReviewState::Unavailable {
        return Err(Error::Other(
            baseline
                .reason
                .unwrap_or_else(|| "review baseline unavailable".into()),
        ));
    }
    let root = Path::new(&baseline.cwd);
    if !root.is_dir() {
        return Err(Error::Other("snapshot cwd no longer exists".into()));
    }
    let mut capture = Capture::new(baseline.cwd.clone());
    // Existing covered paths get priority. Missing is recorded only after a
    // successful NotFound check; skipped/unvisited files are never deletions.
    let known: HashSet<_> = baseline.files.iter().map(|f| f.path.clone()).collect();
    for file in &baseline.files {
        if let Err(reason) = control.check() {
            capture.partial(reason);
            break;
        }
        capture_file(
            root,
            &root.join(&file.path),
            dir,
            "end",
            control,
            &mut capture,
            true,
        );
    }
    if baseline.enumeration_complete && control.check().is_ok() {
        for path in candidates(root, control, &mut capture) {
            let rel = relative(root, &path)?;
            if known.contains(&rel) || baseline.excluded.contains(&rel) {
                continue;
            }
            if let Err(reason) = control.check() {
                capture.partial(reason);
                break;
            }
            capture_file(root, &path, dir, "end", control, &mut capture, false);
        }
    } else {
        capture.enumeration_complete = false;
        capture.partial("起点或终点枚举不完整，仅审查已覆盖文件");
    }
    if baseline.state == ReviewState::Partial {
        capture.partial(baseline.reason.clone().unwrap_or_default());
    }
    capture.timings.freeze_ms = control.elapsed_ms();
    if capture.state == ReviewState::Partial
        && capture.files.is_empty()
        && capture.missing.is_empty()
    {
        capture.state = ReviewState::Unavailable;
    }
    if control.cancelled.load(Ordering::Acquire) {
        return Err(Error::Other("review cancelled".into()));
    }
    atomic_write_str(&dir.join("frozen.json"), &serde_json::to_string(&capture)?)?;
    if control.cancelled.load(Ordering::Acquire) {
        return Err(Error::Other("review cancelled".into()));
    }
    Ok(capture)
}

fn read_capture(path: &Path) -> Result<Capture> {
    let bytes = bounded_read(path, 4 * 1024 * 1024, None)?;
    let capture: Capture = serde_json::from_slice(&bytes)?;
    for file in &capture.files {
        if !safe_relative(Path::new(&file.path))
            || file
                .baseline_path
                .as_ref()
                .is_some_and(|p| !safe_relative(Path::new(p)))
        {
            return Err(Error::Other("invalid review snapshot manifest path".into()));
        }
    }
    Ok(capture)
}

pub async fn finish(id: String) -> Result<ReviewSnapshotFinish> {
    let dir = dir(&id)?;
    let cancelled = match token(&id, false) {
        Ok(token) => token,
        Err(error) => return Ok(unavailable_diff(error.to_string())),
    };
    let control = Control::new(cancelled.clone(), DIFF_TIME);
    let permit = match tokio::time::timeout(DIFF_TIME, diff_slots().acquire_owned()).await {
        Ok(Ok(permit)) => permit,
        _ => {
            cancelled.store(true, Ordering::Release);
            forget(&id);
            tokio::task::spawn_blocking(move || {
                std::fs::remove_dir_all(dir).ok();
            });
            return Ok(unavailable_diff(
                "审查计算达到并发等待预算，结果已丢弃".into(),
            ));
        }
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let result = finish_frozen(&dir, &control);
        std::fs::remove_dir_all(&dir).ok();
        forget(&id);
        Ok(result.unwrap_or_else(|error| unavailable_diff(error.to_string())))
    })
    .await
    .map_err(|error| Error::Other(error.to_string()))?
}

fn unavailable_diff(reason: String) -> ReviewSnapshotFinish {
    ReviewSnapshotFinish {
        diff: WorktreeDiff {
            is_repo: false,
            files: Vec::new(),
            patch_error: Some(reason.clone()),
        },
        review_state: ReviewState::Unavailable,
        review_reason: Some(reason),
        timings: ReviewTimings::default(),
        stats: ReviewStats::default(),
    }
}

fn finish_frozen(dir: &Path, control: &Control) -> Result<ReviewSnapshotFinish> {
    let baseline = read_capture(&dir.join("manifest.json"))?;
    // There is deliberately no legacy fallback to a live workspace scan.
    let endpoint = read_capture(&dir.join("frozen.json"))?;
    if endpoint.state == ReviewState::Unavailable {
        return Ok(unavailable_diff(
            endpoint
                .reason
                .unwrap_or_else(|| "review endpoint unavailable".into()),
        ));
    }
    control.check().map_err(Error::Other)?;
    let mut current = HashMap::new();
    for file in &endpoint.files {
        control.check().map_err(Error::Other)?;
        let content = match &file.baseline_path {
            Some(path) => Some(
                String::from_utf8(bounded_read(
                    &dir.join(path),
                    MAX_FILE_BYTES,
                    Some(control),
                )?)
                .map_err(|e| Error::Other(e.to_string()))?,
            ),
            None => None,
        };
        current.insert(
            file.path.clone(),
            ReviewCurrentFile {
                size: file.size,
                hash: file.hash,
                binary: file.binary,
                content,
            },
        );
    }
    let before = baseline
        .files
        .into_iter()
        .filter(|file| current.contains_key(&file.path) || endpoint.missing.contains(&file.path))
        .collect();
    let changes = classify_review_snapshot_changes(before, current);
    let (files, patch_error) = review_snapshot_changes_to_diff(dir, &changes, control);
    if control.cancelled.load(Ordering::Acquire) {
        return Err(Error::Other("审查计算已取消，结果已丢弃".into()));
    }
    let mut timings = baseline.timings;
    timings.freeze_ms = endpoint.timings.freeze_ms;
    timings.enumeration_ms += endpoint.timings.enumeration_ms;
    timings.read_ms += endpoint.timings.read_ms;
    timings.hash_ms += endpoint.timings.hash_ms;
    timings.write_ms += endpoint.timings.write_ms;
    timings.diff_ms = control.elapsed_ms();
    let partial = baseline.state == ReviewState::Partial
        || endpoint.state == ReviewState::Partial
        || patch_error.is_some();
    let reason = endpoint
        .reason
        .or(baseline.reason)
        .or_else(|| patch_error.clone());
    Ok(ReviewSnapshotFinish {
        diff: WorktreeDiff {
            is_repo: false,
            files,
            patch_error,
        },
        review_state: if partial {
            ReviewState::Partial
        } else {
            ReviewState::Ready
        },
        review_reason: reason,
        timings,
        stats: endpoint.stats,
    })
}

pub async fn cancel(id: String) -> Result<()> {
    let dir = dir(&id)?;
    // A tombstone also covers cancellation arriving just before start registers.
    token(&id, true)?.store(true, Ordering::Release);
    tokio::task::spawn_blocking(move || {
        std::fs::remove_dir_all(dir).ok();
    })
    .await
    .map_err(|error| Error::Other(error.to_string()))?;
    Ok(())
}

fn relative(root: &Path, path: &Path) -> Result<String> {
    Ok(path
        .strip_prefix(root)
        .map_err(|e| Error::Other(e.to_string()))?
        .to_string_lossy()
        .replace('\\', "/"))
}
fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.components().all(|c| {
            matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}
fn skip(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "dist" | "target" | ".cache" | ".next" | "coverage" | "release"
    )
}

fn candidates(root: &Path, control: &Control, capture: &mut Capture) -> Vec<PathBuf> {
    let started = Instant::now();
    let result = candidate_paths(root, control, capture);
    capture.timings.enumeration_ms += started.elapsed().as_millis() as u64;
    result
}

fn candidate_paths(root: &Path, control: &Control, capture: &mut Capture) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if which::which("git").is_ok() {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C")
            .arg(root)
            .args(["ls-files", "-co", "--exclude-standard", "-z", "--", "."]);
        match command_output(&mut cmd, control, MAX_COMMAND_BYTES) {
            Ok((code, bytes, truncated)) if code == 0 || truncated => {
                if truncated {
                    capture.partial("Git 候选枚举达到时间或输出预算");
                    capture.enumeration_complete = false;
                }
                let mut seen = HashSet::new();
                for raw in bytes.split_inclusive(|byte| *byte == 0) {
                    if let Err(reason) = control.check() {
                        capture.partial(reason);
                        capture.enumeration_complete = false;
                        break;
                    }
                    capture.stats.enumerated_entries += 1;
                    if capture.stats.enumerated_entries > MAX_ENTRIES {
                        capture.partial("Git 候选枚举达到条目预算");
                        capture.enumeration_complete = false;
                        break;
                    }
                    if raw.last() != Some(&0) {
                        continue;
                    }
                    let rel =
                        PathBuf::from(String::from_utf8_lossy(&raw[..raw.len() - 1]).as_ref());
                    if !safe_relative(&rel)
                        || rel
                            .components()
                            .any(|c| c.as_os_str().to_str().is_some_and(skip))
                        || !seen.insert(rel.clone())
                    {
                        continue;
                    }
                    if paths.len() >= control.max_files {
                        capture.partial("审查候选文件达到数量预算");
                        capture.enumeration_complete = false;
                        break;
                    }
                    paths.push(root.join(rel));
                }
                paths.sort();
                return paths;
            }
            Err(reason) if control.check().is_err() => {
                capture.partial(reason);
                capture.enumeration_complete = false;
                return paths;
            }
            _ => {} // Non-Git folders keep the bounded local enumeration fallback.
        }
    }
    let mut directories = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = directories.pop() {
        if depth > 128 {
            capture.partial("审查目录深度达到预算");
            capture.enumeration_complete = false;
            continue;
        }
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) => {
                capture.partial(format!("审查枚举失败: {error}"));
                capture.enumeration_complete = false;
                continue;
            }
        };
        for entry in entries {
            capture.stats.enumerated_entries += 1;
            if let Err(reason) = control.check() {
                capture.partial(reason);
                capture.enumeration_complete = false;
                return paths;
            }
            if capture.stats.enumerated_entries > MAX_ENTRIES || paths.len() >= control.max_files {
                capture.partial("审查枚举达到数量预算");
                capture.enumeration_complete = false;
                return paths;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    capture.partial(error.to_string());
                    capture.enumeration_complete = false;
                    continue;
                }
            };
            if skip(&entry.file_name().to_string_lossy()) {
                continue;
            }
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => directories.push((entry.path(), depth + 1)),
                Ok(kind) if kind.is_file() || kind.is_symlink() => paths.push(entry.path()),
                Ok(_) => {}
                Err(error) => {
                    capture.partial(error.to_string());
                    capture.enumeration_complete = false;
                }
            }
        }
    }
    paths.sort();
    paths
}

fn capture_file(
    root: &Path,
    path: &Path,
    dir: &Path,
    prefix: &str,
    control: &Control,
    capture: &mut Capture,
    allow_missing: bool,
) {
    let rel = match relative(root, path) {
        Ok(rel) => rel,
        Err(error) => {
            capture.partial(error.to_string());
            return;
        }
    };
    let result = capture_file_inner(root, path, dir, prefix, control, capture);
    match result {
        Ok(Some(file)) => {
            capture.stats.captured_files += 1;
            capture.files.push(file);
        }
        Ok(None) if allow_missing => {
            capture.missing.insert(rel);
        }
        Ok(None) => {
            capture.excluded.insert(rel);
            capture.stats.skipped_files += 1;
            capture.partial("基线准备时文件消失，已排除该文件");
        }
        Err(reason) => {
            capture.excluded.insert(rel);
            capture.stats.skipped_files += 1;
            capture.partial(reason);
        }
    }
}

fn capture_file_inner(
    root: &Path,
    path: &Path,
    dir: &Path,
    prefix: &str,
    control: &Control,
    capture: &mut Capture,
) -> std::result::Result<Option<ReviewSnapshotFile>, String> {
    control.check()?;
    if capture.files.len() + capture.stats.skipped_files >= control.max_files {
        return Err("审查读取达到文件数量预算".into());
    }
    let rel = relative(root, path).map_err(|error| error.to_string())?;
    if !safe_relative(Path::new(&rel)) {
        return Err("审查路径越界".into());
    }
    // Do not follow symlinks, including symlinked parents in Git candidates.
    let mut checked = root.to_path_buf();
    for component in Path::new(&rel).components() {
        control.check()?;
        checked.push(component);
        match std::fs::symlink_metadata(&checked) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("审查跳过符号链接文件或目录".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        }
    }
    let before = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !before.is_file() {
        return Err("审查目标不再是普通文件".into());
    }
    if before.len() > control.max_file_bytes {
        return Err("审查跳过超过单文件预算的文件".into());
    }
    if capture.stats.captured_bytes + before.len() > control.max_bytes {
        return Err("审查读取达到总字节预算".into());
    }
    let read = Instant::now();
    let remaining = control.max_bytes - capture.stats.captured_bytes;
    let bytes = bounded_read(path, control.max_file_bytes.min(remaining), Some(control))
        .map_err(|error| error.to_string())?;
    capture.timings.read_ms += read.elapsed().as_millis() as u64;
    capture.stats.captured_bytes += bytes.len() as u64;
    control.check()?;
    let after = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || bytes.len() as u64 != after.len()
    {
        return Err("审查读取期间文件变化，已排除不可靠版本".into());
    }
    let hash_start = Instant::now();
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(&bytes);
    let hash = hasher.finish();
    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
    capture.timings.hash_ms += hash_start.elapsed().as_millis() as u64;
    control.check()?;
    let baseline_path = if binary {
        None
    } else {
        let rel_copy = format!("files/{prefix}-{}.txt", capture.files.len());
        let write = Instant::now();
        std::fs::write(dir.join(&rel_copy), &bytes)
            .map_err(|error| format!("审查临时副本不可写: {error}"))?;
        capture.timings.write_ms += write.elapsed().as_millis() as u64;
        control.check()?;
        Some(rel_copy)
    };
    Ok(Some(ReviewSnapshotFile {
        path: rel,
        size: bytes.len() as u64,
        modified_ms: after
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |t| t.as_millis()),
        hash,
        binary,
        baseline_path,
    }))
}

fn bounded_read(path: &Path, max_bytes: u64, control: Option<&Control>) -> Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        if let Some(control) = control {
            control.check().map_err(Error::Other)?;
        }
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        if bytes.len() as u64 + count as u64 > max_bytes {
            return Err(Error::Other("review file grew past byte budget".into()));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok(bytes)
}

pub(crate) fn command_output(
    cmd: &mut std::process::Command,
    control: &Control,
    max_bytes: usize,
) -> std::result::Result<(i32, Vec<u8>, bool), String> {
    control.check()?;
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    hide_std_window(cmd);
    let mut child = cmd.spawn().map_err(|error| error.to_string())?;
    let mut tree = match crate::proc::ProcessTree::attach_std(&child) {
        Ok(tree) => Some(tree),
        Err(error) => {
            child.kill().ok();
            child.wait().ok();
            return Err(format!("cannot supervise review subprocess: {error}"));
        }
    };
    let mut stdout = child.stdout.take().unwrap();
    let overflow = Arc::new(AtomicBool::new(false));
    let reader_overflow = overflow.clone();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        while let Ok(count) = stdout.read(&mut chunk) {
            if count == 0 {
                break;
            }
            let keep = count.min(max_bytes.saturating_sub(bytes.len()));
            bytes.extend_from_slice(&chunk[..keep]);
            if keep < count {
                reader_overflow.store(true, Ordering::Release);
                break;
            }
        }
        bytes
    });
    let mut truncated = false;
    let code = loop {
        if overflow.load(Ordering::Acquire) || control.check().is_err() {
            truncated = true;
            drop(tree.take());
            child.kill().ok();
            break child
                .wait()
                .ok()
                .and_then(|status| status.code())
                .unwrap_or(2);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(2),
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
            Err(error) => {
                drop(tree.take());
                child.kill().ok();
                child.wait().ok();
                reader.join().ok();
                return Err(error.to_string());
            }
        }
    };
    // Windows Git may be a launcher with a descendant holding stdout. Closing
    // the job/process group before joining prevents inherited-pipe hangs.
    drop(tree.take());
    let bytes = reader
        .join()
        .map_err(|_| "review command reader failed".to_string())?;
    truncated |= overflow.load(Ordering::Acquire);
    Ok((code, bytes, truncated))
}

pub(crate) fn git_diff(
    old: &Path,
    new: &Path,
    control: &Control,
) -> std::result::Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args([
        "diff",
        "--no-index",
        "--patch",
        "--no-color",
        "--unified=80",
    ])
    .arg(old)
    .arg(new);
    let (code, bytes, truncated) = command_output(&mut cmd, control, MAX_COMMAND_BYTES)?;
    if truncated {
        Err("审查 diff 达到时间或输出预算，保留文件列表".into())
    } else if code == 0 || code == 1 {
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        Err(format!("git diff --no-index failed ({code})"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "claudinal-review-budget-test-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(path.join("workspace")).unwrap();
            Self(path)
        }
        fn workspace(&self) -> PathBuf {
            self.0.join("workspace")
        }
        fn snapshot(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }
    fn control() -> Control {
        Control::new(Arc::new(AtomicBool::new(false)), Duration::from_secs(3))
    }

    #[test]
    fn fake_review_subprocess() {
        let Ok(mode) = std::env::var("CLAUDINAL_FAKE_REVIEW_PROCESS") else {
            return;
        };
        match mode.as_str() {
            "hold_stdout" => std::thread::sleep(Duration::from_secs(10)),
            "launcher" => {
                let _child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "review_snapshot::tests::fake_review_subprocess",
                        "--nocapture",
                    ])
                    .env("CLAUDINAL_FAKE_REVIEW_PROCESS", "hold_stdout")
                    .stdout(std::process::Stdio::inherit())
                    .spawn()
                    .unwrap();
                println!("launcher exited while descendant holds stdout");
                std::process::exit(0);
            }
            "large_output" => {
                use std::io::Write;
                let bytes = vec![b'x'; 64 * 1024];
                for _ in 0..100 {
                    if std::io::stdout().write_all(&bytes).is_err() {
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    #[test]
    fn review_subprocess_deadline_output_and_inherited_stdout_are_bounded() {
        for mode in ["hold_stdout", "launcher", "large_output"] {
            let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
            cmd.args([
                "--exact",
                "review_snapshot::tests::fake_review_subprocess",
                "--nocapture",
            ])
            .env("CLAUDINAL_FAKE_REVIEW_PROCESS", mode);
            let control =
                Control::new(Arc::new(AtomicBool::new(false)), Duration::from_millis(500));
            let (_, bytes, truncated) = command_output(&mut cmd, &control, 32 * 1024).unwrap();
            assert!(bytes.len() <= 32 * 1024);
            assert!(
                control.elapsed_ms() < 2000,
                "subprocess descendants must not keep stdout join blocked"
            );
            if mode != "launcher" {
                assert!(truncated);
            }
        }
    }

    #[test]
    fn frozen_boundaries_do_not_include_next_round_workspace_edits() {
        let fixture = Fixture::new();
        let workspace = fixture.workspace();
        std::fs::write(workspace.join("a.txt"), "a0\n").unwrap();
        std::fs::write(workspace.join("b.txt"), "b0\n").unwrap();
        let round1 = fixture.snapshot("round1");
        capture_start(workspace.to_str().unwrap(), &round1, &control()).unwrap();
        std::fs::write(workspace.join("a.txt"), "a1\n").unwrap();
        capture_end(&round1, &control()).unwrap();
        let round2 = fixture.snapshot("round2");
        capture_start(workspace.to_str().unwrap(), &round2, &control()).unwrap();
        std::fs::write(workspace.join("b.txt"), "b1\n").unwrap();
        capture_end(&round2, &control()).unwrap();
        // Both diffs run after still later workspace writes (or workspace deletion).
        std::fs::write(workspace.join("a.txt"), "a2\n").unwrap();
        std::fs::remove_dir_all(&workspace).unwrap();
        let first = finish_frozen(&round1, &control()).unwrap();
        let second = finish_frozen(&round2, &control()).unwrap();
        assert_eq!(
            first
                .diff
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt"]
        );
        assert_eq!(
            second
                .diff
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["b.txt"]
        );
        let lines: Vec<_> = first.diff.files[0]
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .collect();
        assert!(lines.iter().any(|line| line.as_str() == "+a1"));
        assert!(!lines.iter().any(|line| line.contains("a2")));
    }

    #[test]
    fn finish_without_frozen_endpoint_is_unavailable_and_never_scans_workspace() {
        let fixture = Fixture::new();
        let workspace = fixture.workspace();
        std::fs::write(workspace.join("a.txt"), "before\n").unwrap();
        let dir = fixture.snapshot("snapshot");
        capture_start(workspace.to_str().unwrap(), &dir, &control()).unwrap();
        std::fs::write(workspace.join("a.txt"), "next round\n").unwrap();
        assert!(finish_frozen(&dir, &control()).is_err());
        assert!(!dir.join("frozen.json").exists());
    }

    #[test]
    fn skipped_endpoint_file_is_not_reported_as_deleted() {
        let fixture = Fixture::new();
        let workspace = fixture.workspace();
        std::fs::write(workspace.join("a.txt"), "small\n").unwrap();
        std::fs::write(workspace.join("b.txt"), "unchanged\n").unwrap();
        let dir = fixture.snapshot("snapshot");
        capture_start(workspace.to_str().unwrap(), &dir, &control()).unwrap();
        std::fs::write(
            workspace.join("a.txt"),
            vec![b'a'; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        let endpoint = capture_end(&dir, &control()).unwrap();
        assert_eq!(endpoint.state, ReviewState::Partial);
        let diff = finish_frozen(&dir, &control()).unwrap();
        assert!(diff.diff.files.is_empty());
        assert_eq!(diff.review_state, ReviewState::Partial);
        assert_eq!(diff.stats.skipped_files, 1);
    }

    #[test]
    fn partial_baseline_only_reports_covered_paths_and_suppresses_unknown_additions() {
        let fixture = Fixture::new();
        let workspace = fixture.workspace();
        for name in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(workspace.join(name), "before\n").unwrap();
        }
        let dir = fixture.snapshot("snapshot");
        let mut limit = control();
        limit.max_files = 1;
        let baseline = capture_start(workspace.to_str().unwrap(), &dir, &limit).unwrap();
        assert_eq!(baseline.state, ReviewState::Partial);
        let covered = baseline.files[0].path.clone();
        std::fs::write(workspace.join(&covered), "covered change\n").unwrap();
        std::fs::write(workspace.join("later-new.txt"), "unknown origin\n").unwrap();
        capture_end(&dir, &control()).unwrap();
        let diff = finish_frozen(&dir, &control()).unwrap();
        assert_eq!(diff.diff.files.len(), 1);
        assert_eq!(diff.diff.files[0].path, covered);
        assert_eq!(diff.diff.files[0].status, "M");
    }

    #[test]
    fn total_bytes_and_single_file_bytes_are_bounded() {
        let fixture = Fixture::new();
        let workspace = fixture.workspace();
        for name in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(workspace.join(name), "1234").unwrap();
        }
        std::fs::write(workspace.join("large.txt"), vec![b'x'; 1000]).unwrap();
        let mut limit = control();
        limit.max_bytes = 8;
        limit.max_file_bytes = 10;
        let capture = capture_start(
            workspace.to_str().unwrap(),
            &fixture.snapshot("snapshot"),
            &limit,
        )
        .unwrap();
        assert_eq!(capture.state, ReviewState::Partial);
        assert_eq!(capture.stats.captured_bytes, 8);
        assert_eq!(capture.files.len(), 2);
        assert_eq!(capture.stats.skipped_files, 2);
    }

    #[test]
    fn temporary_storage_failure_leaves_no_baseline_and_degrades() {
        let fixture = Fixture::new();
        let blocker = fixture.snapshot("not-a-directory");
        std::fs::write(&blocker, "file blocks snapshot storage").unwrap();
        let dir = blocker.join("snapshot");
        let error = match capture_start(fixture.workspace().to_str().unwrap(), &dir, &control()) {
            Err(error) => error,
            Ok(_) => panic!("storage failure must not create a ready baseline"),
        };
        let response = unavailable(
            "storage-test".into(),
            fixture.workspace().display().to_string(),
            error.to_string(),
        );
        assert_eq!(response.state, ReviewState::Unavailable);
        assert!(!response.coverage_complete);
        assert!(!dir.join("manifest.json").exists());
        assert_eq!(
            std::fs::read_to_string(blocker).unwrap(),
            "file blocks snapshot storage"
        );
    }

    #[test]
    fn large_and_many_file_fixture_obeys_default_capture_budget() {
        let fixture = Fixture::new();
        let workspace = fixture.workspace();
        let large = std::fs::File::create(workspace.join("000-large.txt")).unwrap();
        large.set_len(128 * 1024 * 1024).unwrap();
        for index in 0..10_000 {
            std::fs::write(workspace.join(format!("file-{index:05}.txt")), "fixture\n").unwrap();
        }
        let capture_control = Control::new(Arc::new(AtomicBool::new(false)), CAPTURE_TIME);
        let capture = capture_start(
            workspace.to_str().unwrap(),
            &fixture.snapshot("snapshot"),
            &capture_control,
        )
        .unwrap();
        assert_ne!(capture.state, ReviewState::Ready);
        assert!(capture.files.len() <= MAX_FILES);
        assert!(capture.stats.captured_bytes <= MAX_BYTES);
        assert!(capture.files.iter().all(|file| file.size <= MAX_FILE_BYTES));
        eprintln!("A4 large/many fixture: total={} ms enumerate={} ms read={} ms write={} ms files={} skipped={} bytes={} state={:?}",
            capture_control.elapsed_ms(), capture.timings.enumeration_ms, capture.timings.read_ms,
            capture.timings.write_ms, capture.files.len(), capture.stats.skipped_files, capture.stats.captured_bytes, capture.state);
        assert!(
            capture_control.elapsed_ms() < 1500,
            "budgeted fixture should not scan all 10,001 files"
        );
    }

    #[test]
    fn cancellation_and_expiry_never_publish_a_baseline() {
        let fixture = Fixture::new();
        std::fs::write(fixture.workspace().join("a.txt"), "before").unwrap();
        let cancelled = control();
        cancelled.cancelled.store(true, Ordering::Release);
        let dir = fixture.snapshot("cancelled");
        assert!(capture_start(fixture.workspace().to_str().unwrap(), &dir, &cancelled).is_err());
        assert!(!dir.exists());
        let expired = Control::new(Arc::new(AtomicBool::new(false)), Duration::ZERO);
        assert!(capture_start(
            fixture.workspace().to_str().unwrap(),
            &fixture.snapshot("expired"),
            &expired
        )
        .is_err());
    }

    #[tokio::test]
    async fn public_commands_degrade_missing_workspace_and_cancel_before_start() {
        let fixture = Fixture::new();
        let id = uuid::Uuid::new_v4().to_string();
        let response = start(
            fixture.snapshot("missing").display().to_string(),
            Some(id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(response.state, ReviewState::Unavailable);
        assert!(!dir(&id).unwrap().exists());
        let cancelled_id = uuid::Uuid::new_v4().to_string();
        cancel(cancelled_id.clone()).await.unwrap();
        let response = start(
            fixture.workspace().display().to_string(),
            Some(cancelled_id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(response.state, ReviewState::Unavailable);
        assert!(!dir(&cancelled_id).unwrap().exists());
        forget(&cancelled_id);
    }

    #[tokio::test]
    async fn async_start_and_freeze_can_cancel_and_finish_only_after_freeze() {
        let fixture = Fixture::new();
        std::fs::write(fixture.workspace().join("a.txt"), "before\n").unwrap();
        // Stable success-path fixture: production's 250 ms budget is separately
        // measured by the large/many-file test and expiry tests. Concurrent cargo
        // suites can legitimately exhaust that budget even for a small directory.
        let response = start_with_budget(
            fixture.workspace().display().to_string(),
            None,
            Duration::from_secs(3),
        )
        .await
        .unwrap();
        assert_eq!(response.state, ReviewState::Ready);
        std::fs::write(fixture.workspace().join("a.txt"), "after\n").unwrap();
        let endpoint = freeze_with_budget(response.id.clone(), Duration::from_secs(3))
            .await
            .unwrap();
        assert_eq!(endpoint.state, ReviewState::Ready);
        let result = finish(response.id.clone()).await.unwrap();
        assert_eq!(result.diff.files.len(), 1);
        assert!(!dir(&response.id).unwrap().exists());
        assert!(jobs().lock().unwrap().get(&response.id).is_none());
        let cancelled = start_with_budget(
            fixture.workspace().display().to_string(),
            None,
            Duration::from_secs(3),
        )
        .await
        .unwrap();
        cancel(cancelled.id.clone()).await.unwrap();
        let result = finish(cancelled.id.clone()).await.unwrap();
        assert_eq!(result.review_state, ReviewState::Unavailable);
        assert!(result.diff.files.is_empty());
        forget(&cancelled.id);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_excluded_from_baseline_and_never_followed() {
        let fixture = Fixture::new();
        let external = fixture.0.join("external.txt");
        std::fs::write(&external, "outside workspace").unwrap();
        std::os::unix::fs::symlink(external, fixture.workspace().join("link.txt")).unwrap();
        let capture = capture_start(
            fixture.workspace().to_str().unwrap(),
            &fixture.snapshot("snapshot"),
            &control(),
        )
        .unwrap();
        assert!(capture.files.is_empty());
        assert_eq!(capture.state, ReviewState::Unavailable);
        assert_eq!(capture.stats.skipped_files, 1);
    }
}
