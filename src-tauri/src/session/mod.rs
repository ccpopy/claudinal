pub mod reader;
pub mod stats;
pub mod watcher;

pub use reader::{
    delete_session_jsonl, list_project_sessions, read_session_sidecar, read_session_transcript,
    write_session_sidecar, SessionMeta,
};
pub use stats::{scan_activity_heatmap, scan_all_usage_sidecars, ActivityCell, GlobalUsage};
pub use watcher::WatcherState;
