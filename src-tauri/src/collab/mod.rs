pub mod changes;
pub mod mcp;
pub mod providers;
pub mod runner;
pub mod store;

pub use mcp::run_stdio_mcp_server;
pub use providers::{detect_provider_by_id, detect_providers, CollabProviderStatus};
pub use runner::{
    delegate, record_approval, run_verification, start_flow, CollabApprovalRequest,
    CollabCommandResult, CollabDelegateRequest, CollabStartFlowRequest, CollabVerificationRequest,
};
pub use store::CollabFlow;

use crate::error::{Error, Result};
use serde_json::Value;

pub const COLLAB_MCP_SERVER_NAME: &str = "claudinal_collab";

pub fn render_default_mcp_config() -> Result<Value> {
    let exe = std::env::current_exe()?;
    Ok(serde_json::json!({
        "mcpServers": {
            COLLAB_MCP_SERVER_NAME: {
                "command": exe.display().to_string(),
                "args": ["--collab-mcp-server"]
            }
        }
    }))
}

pub fn enabled_from_env() -> bool {
    std::env::var("CLAUDINAL_COLLAB_ENABLED")
        .ok()
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

pub fn runtime_cwd_from_env() -> Result<String> {
    std::env::var("CLAUDINAL_RUNTIME_CWD")
        .map_err(|_| Error::Other("CLAUDINAL_RUNTIME_CWD is required".into()))
}

pub fn runtime_session_from_env() -> Option<String> {
    let runtime_session_id = std::env::var("CLAUDINAL_RUNTIME_SESSION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    match store::resolve_runtime_session_id(&runtime_session_id) {
        Ok(Some(claude_session_id)) => Some(claude_session_id),
        Ok(None) => Some(runtime_session_id),
        Err(_) => Some(runtime_session_id),
    }
}

pub fn enabled_providers_from_env() -> Option<Vec<String>> {
    let raw = std::env::var("CLAUDINAL_COLLAB_ENABLED_PROVIDERS").ok()?;
    serde_json::from_str::<Vec<String>>(&raw).ok()
}
