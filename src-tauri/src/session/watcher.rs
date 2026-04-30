use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};
use tracing::{debug, error, warn};

use crate::error::{Error, Result};
use crate::session::reader::encode_cwd;

pub struct WatcherState {
    inner: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// 监听 ~/.claude/projects/<encoded-cwd>/，目录下任何 .jsonl 变化都 emit 一次
    /// `claudinal://sessions/<cwd>/changed`（事件 payload = cwd 字符串）。
    /// 同 cwd 重复 watch 时直接复用既有 watcher，不重建。
    pub fn watch(&self, app: AppHandle, cwd: String) -> Result<()> {
        let mut map = self.inner.lock().expect("watcher map poisoned");
        if map.contains_key(&cwd) {
            return Ok(());
        }

        let home = dirs::home_dir().ok_or_else(|| Error::Other("home dir not found".into()))?;
        let dir: PathBuf = home.join(".claude").join("projects").join(encode_cwd(&cwd));
        if !dir.is_dir() {
            debug!(cwd = %cwd, "creating watch target: {}", dir.display());
            std::fs::create_dir_all(&dir)
                .map_err(|e| Error::Other(format!("watch target create: {e}")))?;
        }

        let cwd_for_event = cwd.clone();
        let app_clone = app.clone();
        let last = Mutex::new(Instant::now() - Duration::from_secs(10));
        let topic = format!("claudinal://sessions/{}/changed", cwd);

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
                    // 200ms 节流：CLI 写 jsonl 通常会触发多个 modify 事件
                    let now = Instant::now();
                    let mut last_lock = last.lock().expect("last poisoned");
                    if now.duration_since(*last_lock) < Duration::from_millis(200) {
                        return;
                    }
                    *last_lock = now;
                    drop(last_lock);
                    if let Err(e) = app_clone.emit(&topic, &cwd_for_event) {
                        error!("watcher emit failed: {e}");
                    }
                }
                Err(e) => warn!("watcher error: {e}"),
            })
            .map_err(|e| Error::Other(format!("watcher init: {e}")))?;

        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| Error::Other(format!("watch start: {e}")))?;

        map.insert(cwd, watcher);
        Ok(())
    }

    pub fn unwatch(&self, cwd: &str) {
        let mut map = self.inner.lock().expect("watcher map poisoned");
        map.remove(cwd);
    }
}

impl Default for WatcherState {
    fn default() -> Self {
        Self::new()
    }
}
