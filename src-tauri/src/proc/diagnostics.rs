use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;

const MAX_EVENTS: usize = 500;

/// Only fixed stage labels and numeric metadata enter this ring. Never capture
/// prompts, stderr text, CLI arguments, environment variables or tool payloads.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnosticEvent {
    at: String,
    runtime_id: String,
    stage: &'static str,
    bytes: Option<usize>,
    code: Option<i32>,
    installation: Option<(String, String)>,
}

#[derive(Default)]
struct Ring {
    events: VecDeque<RuntimeDiagnosticEvent>,
    dropped: u64,
}

#[derive(Default)]
pub struct Diagnostics(Mutex<Ring>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostics {
    schema_version: u32,
    app_version: &'static str,
    captured_at: String,
    dropped_events: u64,
    events: Vec<RuntimeDiagnosticEvent>,
}

impl Diagnostics {
    pub fn record(
        &self,
        runtime: &str,
        stage: &'static str,
        bytes: Option<usize>,
        code: Option<i32>,
    ) {
        self.push(runtime, stage, bytes, code, None);
    }

    pub fn installation(&self, runtime: &str, path: &std::path::Path, version: &str) {
        self.push(
            runtime,
            "cli_selected",
            None,
            None,
            Some((path.display().to_string(), version.into())),
        );
    }

    fn push(
        &self,
        runtime: &str,
        stage: &'static str,
        bytes: Option<usize>,
        code: Option<i32>,
        installation: Option<(String, String)>,
    ) {
        let mut ring = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if ring.events.len() == MAX_EVENTS {
            ring.events.pop_front();
            ring.dropped += 1;
        }
        ring.events.push_back(RuntimeDiagnosticEvent {
            at: chrono::Utc::now().to_rfc3339(),
            runtime_id: runtime.into(),
            stage,
            bytes,
            code,
            installation,
        });
    }

    pub fn snapshot(&self) -> RuntimeDiagnostics {
        let ring = self.0.lock().unwrap_or_else(|error| error.into_inner());
        RuntimeDiagnostics {
            schema_version: 1,
            app_version: env!("CARGO_PKG_VERSION"),
            captured_at: chrono::Utc::now().to_rfc3339(),
            dropped_events: ring.dropped,
            events: ring.events.iter().cloned().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_bounds_memory_and_preserves_runtime_failure_codes() {
        let diagnostics = Diagnostics::default();
        for _ in 0..600 {
            diagnostics.record("runtime-a", "stderr_received", Some(42), None);
        }
        diagnostics.record("runtime-b", "write_failed", None, Some(232));
        let snapshot = diagnostics.snapshot();
        assert_eq!(snapshot.events.len(), 500);
        assert_eq!(snapshot.dropped_events, 101);
        let last = snapshot.events.last().unwrap();
        assert_eq!(last.runtime_id, "runtime-b");
        assert_eq!(last.code, Some(232));
        let json = serde_json::to_value(snapshot).unwrap();
        assert!(json["events"][0].get("content").is_none());
        assert!(json["events"][0].get("stderr").is_none());
    }
}
