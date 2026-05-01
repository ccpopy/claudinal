use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    http::{self, header::CONTENT_TYPE},
    AppHandle, Manager,
};

use crate::buddy;

pub const PROTOCOL: &str = "claudinal-startup";

const HTML: &str = include_str!("../../public/startup.html");
const BONES_PLACEHOLDER: &str = "/*__BUDDY_BONES__*/null";

/// 防御性幂等：main webview 在某些场景下（dev 热更新、StrictMode、用户 reload）
/// 会让 main.tsx 顶层逻辑跑多次，进而把 `frontend_ready` 命令重复 invoke。第一次
/// 走完整流程，后续直接返回 Ok 不重复 show / close / 打 INFO 日志。
static FRONTEND_READY_FIRED: AtomicBool = AtomicBool::new(false);

pub fn response() -> http::Response<Vec<u8>> {
    let html = HTML.replacen(BONES_PLACEHOLDER, &buddy::current_json(), 1);
    http::Response::builder()
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .body(html.into_bytes())
        .expect("failed to build startup screen response")
}

#[tauri::command]
pub fn frontend_ready(app: AppHandle) -> Result<(), String> {
    if FRONTEND_READY_FIRED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    tracing::info!("frontend reported ready; switching from splash to main window");

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    main.show()
        .map_err(|err| format!("failed to show main window: {err}"))?;
    main.set_focus()
        .map_err(|err| format!("failed to focus main window: {err}"))?;

    if let Some(splash) = app.get_webview_window("splash") {
        splash
            .close()
            .map_err(|err| format!("failed to close splash window: {err}"))?;
    }

    Ok(())
}
