mod api_proxy;
mod app_paths;
mod auth;
mod buddy;
mod child_process;
mod collab;
mod commands;
mod error;
mod keychain;
mod network_proxy;
mod permission_mcp;
mod plugins;
mod proc;
mod session;
mod startup;

use tauri::{
    webview::{PageLoadEvent, WebviewWindowBuilder},
    Manager,
};

pub fn run_permission_mcp_server() -> error::Result<()> {
    permission_mcp::run_stdio_mcp_server()
}

pub fn run_collab_mcp_server() -> error::Result<()> {
    collab::run_stdio_mcp_server()
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol(startup::PROTOCOL, |_ctx, _request| startup::response())
        .plugin(tauri_plugin_dialog::init())
        .manage(proc::Manager::new())
        .manage(auth::AuthLoginState::new())
        .manage(permission_mcp::PermissionMcpBridge::new())
        .manage(session::WatcherState::new())
        .on_page_load(|webview, payload| {
            if webview.label() != "splash" || payload.event() != PageLoadEvent::Finished {
                return;
            }

            tracing::info!("startup splash loaded; scheduling main window creation");
            let app = webview.app_handle().clone();
            if app.get_webview_window("main").is_some() {
                tracing::debug!("main window already exists");
                return;
            }

            let Some(config) = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
            else {
                tracing::error!("main window config not found");
                return;
            };

            tauri::async_runtime::spawn(async move {
                tokio::task::yield_now().await;
                let app_for_main_thread = app.clone();
                if let Err(err) = app.run_on_main_thread(move || {
                    tracing::info!("creating main window");
                    match WebviewWindowBuilder::from_config(&app_for_main_thread, &config)
                        .and_then(|builder| builder.build())
                    {
                        Ok(_) => tracing::info!("main window created"),
                        Err(err) => tracing::error!("failed to create main window: {err}"),
                    }
                }) {
                    tracing::error!("failed to schedule main window creation: {err}");
                }
            });
        })
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![
            startup::frontend_ready,
            buddy::get_buddy_bones,
            commands::app_runtime_info,
            commands::detect_claude_cli,
            commands::claude_cli_version_info,
            commands::spawn_session,
            commands::resolve_permission_request,
            commands::send_user_message,
            commands::stop_session,
            commands::create_dir,
            commands::path_exists,
            commands::default_workspace_root,
            commands::list_dir,
            commands::list_project_sessions,
            commands::list_recent_sessions_all,
            commands::git_worktree_status,
            commands::worktree_diff,
            commands::git_branch_list,
            commands::git_checkout_branch,
            commands::git_worktree_list,
            commands::git_remove_worktree,
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
            commands::write_claude_json_mcp_config,
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
            commands::search_sessions,
            commands::session_index_diagnostics,
            commands::rebuild_session_index,
            commands::open_path,
            commands::run_project_action,
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
            commands::collab_detect_providers,
            commands::collab_detect_provider,
            commands::collab_list_flows,
            commands::collab_read_flow,
            commands::collab_start_flow,
            commands::collab_delegate,
            commands::collab_record_approval,
            commands::collab_run_verification,
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
