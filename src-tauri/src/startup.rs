use tauri::{
    http::{self, header::CONTENT_TYPE},
    AppHandle, Manager,
};

pub const PROTOCOL: &str = "claudinal-startup";

const HTML: &str = include_str!("../../public/startup.html");

pub fn response() -> http::Response<Vec<u8>> {
    http::Response::builder()
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .body(HTML.as_bytes().to_vec())
        .expect("failed to build startup screen response")
}

#[tauri::command]
pub fn frontend_ready(app: AppHandle) -> Result<(), String> {
    tracing::info!("frontend reported ready; switching from splash to main window");

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    main.show()
        .map_err(|err| format!("failed to show main window: {err}"))?;
    main.set_focus()
        .map_err(|err| format!("failed to focus main window: {err}"))?;

    let splash = app
        .get_webview_window("splash")
        .ok_or_else(|| "splash window not found".to_string())?;
    splash
        .close()
        .map_err(|err| format!("failed to close splash window: {err}"))?;

    Ok(())
}
