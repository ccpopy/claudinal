use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};
use tracing::{debug, error, warn};

use crate::error::{Error, Result};
use crate::session::reader::project_dirs;

pub struct WatcherState {
    inner: Mutex<HashMap<String, Vec<RecommendedWatcher>>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// 监听 ~/.claude/projects/<encoded-cwd>/，目录下任何 .jsonl 变化都 emit 一次。
    /// 同 cwd 重复 watch 时直接复用既有 watcher，不重建。
    pub fn watch(&self, app: AppHandle, cwd: String) -> Result<()> {
        let mut map = self.inner.lock().expect("watcher map poisoned");
        if map.contains_key(&cwd) {
            return Ok(());
        }

        let dirs = project_dirs(&cwd)?;
        let primary = dirs
            .first()
            .cloned()
            .ok_or_else(|| Error::Other("watch target not found".into()))?;
        if !primary.is_dir() {
            debug!(cwd = %cwd, "creating watch target: {}", primary.display());
            std::fs::create_dir_all(&primary)
                .map_err(|e| Error::Other(format!("watch target create: {e}")))?;
        }

        let mut watchers = Vec::new();
        for dir in dirs.into_iter().filter(|dir| dir.is_dir()) {
            watchers.push(watch_dir(app.clone(), cwd.clone(), dir)?);
        }

        if watchers.is_empty() {
            watchers.push(watch_dir(app, cwd.clone(), primary)?);
        }

        map.insert(cwd, watchers);
        Ok(())
    }

    pub fn unwatch(&self, cwd: &str) {
        let mut map = self.inner.lock().expect("watcher map poisoned");
        map.remove(cwd);
    }
}

fn watch_dir(app: AppHandle, cwd: String, dir: std::path::PathBuf) -> Result<RecommendedWatcher> {
    let cwd_for_event = cwd.clone();
    let topic = format!("claudinal://sessions/{}/changed", cwd);
    let last = Mutex::new(Instant::now() - Duration::from_secs(10));

    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(ev) => {
                let touched_jsonl = ev.paths.iter().any(|p| {
                    p.extension()
                        .and_then(|s| s.to_str())
                        .map(|s| s.eq_ignore_ascii_case("jsonl"))
                        .unwrap_or(false)
                });
                if !touched_jsonl {
                    return;
                }

                let now = Instant::now();
                let mut last_lock = last.lock().expect("last poisoned");
                if now.duration_since(*last_lock) < Duration::from_millis(200) {
                    return;
                }
                *last_lock = now;
                drop(last_lock);

                if let Err(e) = app.emit(&topic, &cwd_for_event) {
                    error!("watcher emit failed: {e}");
                }
            }
            Err(e) => warn!("watcher error: {e}"),
        })
        .map_err(|e| Error::Other(format!("watcher init: {e}")))?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| Error::Other(format!("watch start: {e}")))?;

    Ok(watcher)
}

impl Default for WatcherState {
    fn default() -> Self {
        Self::new()
    }
}
