mod index;
pub mod reader;
pub mod search;
pub mod stats;
pub mod store;
pub mod watcher;

pub use index::{list_project_sessions, list_recent_sessions_all, GlobalSessionMeta};
pub use reader::{
    delete_session_jsonl, read_session_sidecar, read_session_transcript, write_session_sidecar,
    SessionMeta,
};
pub use search::{search_sessions, SessionSearchHit};
pub use stats::{scan_activity_heatmap, scan_all_usage_sidecars, ActivityCell, GlobalUsage};
pub use store::{
    diagnostics as session_index_diagnostics, rebuild as rebuild_session_index,
    SessionIndexDiagnostics,
};
pub use watcher::WatcherState;
