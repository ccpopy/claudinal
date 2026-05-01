use tauri::{
    http::{self, header::CONTENT_TYPE},
    AppHandle, Manager,
};

use crate::buddy;

pub const PROTOCOL: &str = "claudinal-startup";

const HTML: &str = include_str!("../../public/startup.html");
const BONES_PLACEHOLDER: &str = "/*__BUDDY_BONES__*/null";

pub fn response() -> http::Response<Vec<u8>> {
    let html = HTML.replacen(BONES_PLACEHOLDER, &buddy::current_json(), 1);
    http::Response::builder()
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .body(html.into_bytes())
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
