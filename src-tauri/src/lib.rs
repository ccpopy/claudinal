mod api_proxy;
mod auth;
mod commands;
mod error;
mod keychain;
mod network_proxy;
mod permission_mcp;
mod plugins;
mod proc;
mod session;

pub fn run_permission_mcp_server() -> error::Result<()> {
    permission_mcp::run_stdio_mcp_server()
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,claudecli_desktop_lib=debug")
            }),
        )
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(proc::Manager::new())
        .manage(auth::AuthLoginState::new())
        .manage(permission_mcp::PermissionMcpBridge::new())
        .manage(session::WatcherState::new())
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![
            commands::detect_claude_cli,
            commands::spawn_session,
            commands::resolve_permission_request,
            commands::send_user_message,
            commands::stop_session,
            commands::create_dir,
            commands::path_exists,
            commands::default_workspace_root,
            commands::list_dir,
            commands::list_project_sessions,
            commands::git_worktree_status,
            commands::git_branch_list,
            commands::git_checkout_branch,
            commands::github_cli_status,
            commands::read_session_transcript,
            commands::delete_session_jsonl,
            commands::read_session_sidecar,
            commands::write_session_sidecar,
            commands::watch_sessions,
            commands::unwatch_sessions,
            commands::list_files,
            commands::claude_settings_path_for,
            commands::read_claude_settings,
            commands::write_claude_settings,
            commands::claude_mcp_path_for,
            commands::read_claude_json_mcp_configs,
            commands::read_claude_mcp_config,
            commands::write_claude_mcp_config,
            commands::claude_md_path_for,
            commands::read_claude_md,
            commands::write_claude_md,
            commands::read_claude_oauth_token,
            commands::fetch_oauth_usage,
            commands::fetch_provider_models,
            commands::scan_global_usage,
            commands::scan_activity_heatmap,
            commands::open_path,
            commands::open_external,
            commands::detect_playwright_install,
            commands::test_proxy_connection,
            commands::write_text_file,
            commands::keychain_available,
            commands::keychain_set,
            commands::keychain_get,
            commands::keychain_delete,
            commands::auth_status,
            commands::auth_logout,
            commands::auth_start_login,
            commands::auth_cancel_login,
            commands::auth_open_login_terminal,
            plugins::list_installed_plugins,
            plugins::list_marketplaces,
            plugins::list_skills,
            plugins::install_builtin_skill,
            plugins::install_skill_from_path,
            plugins::run_plugin_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
