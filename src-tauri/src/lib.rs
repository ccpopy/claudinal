mod commands;
mod error;
mod proc;
mod session;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,claudecli_desktop_lib=debug")),
        )
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(proc::Manager::new())
        .manage(session::WatcherState::new())
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![
            commands::detect_claude_cli,
            commands::spawn_session,
            commands::send_user_message,
            commands::stop_session,
            commands::create_dir,
            commands::path_exists,
            commands::default_workspace_root,
            commands::list_dir,
            commands::list_project_sessions,
            commands::read_session_transcript,
            commands::delete_session_jsonl,
            commands::read_session_sidecar,
            commands::write_session_sidecar,
            commands::watch_sessions,
            commands::unwatch_sessions,
            commands::list_files,
            commands::open_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
