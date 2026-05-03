#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--permission-mcp-server") {
        if let Err(e) = claudecli_desktop_lib::run_permission_mcp_server() {
            eprintln!("permission MCP server failed: {e}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().any(|arg| arg == "--collab-mcp-server") {
        if let Err(e) = claudecli_desktop_lib::run_collab_mcp_server() {
            eprintln!("collaboration MCP server failed: {e}");
            std::process::exit(1);
        }
        return;
    }
    claudecli_desktop_lib::run();
}
