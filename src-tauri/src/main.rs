#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--computer-use-window-worker") {
        if let Err(e) = claudecli_desktop_lib::run_computer_use_window_worker() {
            eprintln!("computer-use window worker failed: {e}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().any(|arg| arg == "--computer-use-mcp-server") {
        if let Err(e) = claudecli_desktop_lib::run_computer_use_mcp_server() {
            eprintln!("computer-use MCP server failed: {e}");
            std::process::exit(1);
        }
        return;
    }
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
