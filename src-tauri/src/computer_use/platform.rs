//! Native identity and metadata only. No capture or general input executor lives here.
use std::{fs::File, path::PathBuf};

use super::types::{AppInfo, Tier};
use crate::error::{Error, Result};

#[cfg(all(test, windows))]
pub(super) static DESKTOP_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn data_dir() -> Result<PathBuf> {
    let root = dirs::data_local_dir()
        .ok_or_else(|| Error::Other("Local application data directory is unavailable.".into()))?;
    Ok(root.join("Claudinal").join("computer-use"))
}

/// Managed driver downloads live beside the Claudinal executable (portable
/// layout, e.g. `release\computer-use`), falling back to local app data when
/// that directory is not writable.
pub fn install_root() -> Result<PathBuf> {
    let beside_executable = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("computer-use")))
        .filter(|dir| {
            std::fs::create_dir_all(dir).is_ok() && {
                let probe = dir.join(format!(".write-test-{}", uuid::Uuid::new_v4().simple()));
                let writable = std::fs::write(&probe, b"").is_ok();
                let _ = std::fs::remove_file(&probe);
                writable
            }
        });
    match beside_executable {
        Some(dir) => Ok(dir),
        None => data_dir(),
    }
}

/// Paths are canonicalized for verification; show users the familiar form.
pub fn display_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
    }
}

/// An OS file share lock is process lifetime scoped and releases after crashes.
/// Its location is common to portable copies of the app in this user session.
pub fn desktop_lock_in(directory: &std::path::Path) -> Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::create_dir_all(&directory)?;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(directory.join("desktop-lease.lock"))
            .map_err(|_| Error::Other("Another Claudinal instance controls the desktop.".into()))
    }
    #[cfg(not(windows))]
    {
        Err(Error::Other(
            "Computer control is unavailable on this platform.".into(),
        ))
    }
}

pub fn tier(path: &str) -> Tier {
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    if [
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "brave.exe",
        "opera.exe",
        "iexplore.exe",
        "vivaldi.exe",
        "arc.exe",
        "chromium.exe",
        "thorium.exe",
        "yandex.exe",
        "librewolf.exe",
        "waterfox.exe",
        "floorp.exe",
        "zen.exe",
        "360se.exe",
        "360chrome.exe",
        "qqbrowser.exe",
        "sogouexplorer.exe",
        "2345explorer.exe",
        "liebao.exe",
        "quark.exe",
        "msedgewebview2.exe",
        "tradingview.exe",
        "thinkorswim.exe",
        "tws.exe",
        "metatrader.exe",
        "terminal64.exe",
        "ninjatrader.exe",
        "tdxw.exe",
        "xiadan.exe",
        "eastmoney.exe",
        "ths.exe",
        "ibgateway.exe",
        "futu.exe",
        "moomoo.exe",
        "dzh.exe",
        "hexin.exe",
        "taskmgr.exe",
        "systemsettings.exe",
        "applicationframehost.exe",
        "control.exe",
        "mmc.exe",
        "regedit.exe",
    ]
    .contains(&name.as_str())
    {
        Tier::View
    } else if [
        "cmd.exe",
        "powershell.exe",
        "pwsh.exe",
        "windowsterminal.exe",
        "wt.exe",
        "bash.exe",
        "wsl.exe",
        "mintty.exe",
        "conhost.exe",
        "openconsole.exe",
        "alacritty.exe",
        "wezterm-gui.exe",
        "putty.exe",
        "kitty.exe",
        "hyper.exe",
        "tabby.exe",
        "warp.exe",
        "mobaxterm.exe",
        "xshell.exe",
        "securecrt.exe",
        "termius.exe",
        "git-bash.exe",
        "code.exe",
        "cursor.exe",
        "devenv.exe",
        "rider64.exe",
        "idea64.exe",
        "pycharm64.exe",
        "webstorm64.exe",
        "clion64.exe",
        "goland64.exe",
        "phpstorm64.exe",
        "rubymine64.exe",
        "datagrip64.exe",
        "rustrover64.exe",
        "studio64.exe",
        "fleet.exe",
        "zed.exe",
        "windsurf.exe",
        "trae.exe",
        "kiro.exe",
        "void.exe",
        "vscodium.exe",
        "code - insiders.exe",
        "notepad++.exe",
        "sublime_text.exe",
        "antigravity.exe",
        "antigravity ide.exe",
    ]
    .contains(&name.as_str())
    {
        Tier::Click
    } else {
        Tier::Full
    }
}

pub fn apps() -> Result<Vec<AppInfo>> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows;
        let mut apps = Vec::<AppInfo>::new();
        if EnumWindows(Some(enumerate_window), &mut apps as *mut _ as isize) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        apps.sort_by(|a, b| a.name.cmp(&b.name).then(a.title.cmp(&b.title)));
        apps.truncate(256);
        Ok(apps)
    }
    #[cfg(not(windows))]
    {
        Err(Error::Other(
            "Windows app discovery is unavailable on this platform.".into(),
        ))
    }
}

#[cfg(windows)]
unsafe extern "system" fn enumerate_window(
    hwnd: windows_sys::Win32::Foundation::HWND,
    data: isize,
) -> i32 {
    if discoverable_window(hwnd) {
        if let Some(app) = window_info(hwnd) {
            if !helper_executable(&app.path) {
                (&mut *(data as *mut Vec<AppInfo>)).push(app);
            }
        }
    }
    1
}

/// Enumerate user-facing task windows, not every HWND carrying WS_VISIBLE.
/// Apply this only to discovery: a minimized/temporarily hidden approved app
/// retains its identity, and actions keep their own geometry/lifetime checks.
#[cfg(windows)]
pub(super) unsafe fn discoverable_window(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    if !task_surface(hwnd) {
        return false;
    }
    if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_APPWINDOW != 0 {
        return true;
    }
    let mut candidate = GetAncestor(hwnd, GA_ROOTOWNER);
    for _ in 0..32 {
        let popup = GetLastActivePopup(candidate);
        if popup == candidate || popup.is_null() || !task_surface(popup) {
            return candidate == hwnd;
        }
        candidate = popup;
    }
    false
}

#[cfg(windows)]
unsafe fn task_surface(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
        UI::WindowsAndMessaging::*,
    };
    let mut rect: RECT = std::mem::zeroed();
    let mut cloaked: u32 = 0;
    let mut class = [0u16; 256];
    let length = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
    if IsWindowVisible(hwnd) == 0
        || GetWindowTextLengthW(hwnd) <= 0
        || GetWindowRect(hwnd, &mut rect) == 0
        || rect.right <= rect.left
        || rect.bottom <= rect.top
        || length <= 0
        || DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut _ as _,
            std::mem::size_of_val(&cloaked) as u32,
        ) < 0
        || cloaked != 0
        || shell_window_class(&String::from_utf16_lossy(&class[..length as usize]))
    {
        return false;
    }
    let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    style & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) == 0
}

fn shell_window_class(class: &str) -> bool {
    [
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
        "IME",
        "MSCTFIME UI",
        "Windows.UI.Core.CoreWindow.IME",
    ]
    .iter()
    .any(|candidate| class.eq_ignore_ascii_case(candidate))
}

fn helper_executable(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    [
        "TextInputHost.exe",
        "InputApp.exe",
        "NVIDIA Overlay.exe",
        "NVIDIA Share.exe",
    ]
    .iter()
    .any(|helper| name.eq_ignore_ascii_case(helper))
}

#[cfg(windows)]
unsafe fn window_info(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<AppInfo> {
    use windows_sys::Win32::{
        Foundation::CloseHandle, System::Threading::*, UI::WindowsAndMessaging::*,
    };
    if IsWindow(hwnd) == 0 {
        return None;
    }
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == 0 || pid == std::process::id() {
        return None;
    }
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if process.is_null() {
        return None;
    }
    let mut path_buf = vec![0u16; 32768];
    let mut path_len = path_buf.len() as u32;
    let path_ok = QueryFullProcessImageNameW(process, 0, path_buf.as_mut_ptr(), &mut path_len);
    let mut created = std::mem::zeroed();
    let mut exited = std::mem::zeroed();
    let mut kernel = std::mem::zeroed();
    let mut user = std::mem::zeroed();
    let time_ok = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user);
    CloseHandle(process);
    if path_ok == 0 || time_ok == 0 {
        return None;
    }
    let path = String::from_utf16_lossy(&path_buf[..path_len as usize]);
    static HOST_EXECUTABLE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    if HOST_EXECUTABLE
        .get_or_init(|| {
            std::env::current_exe().ok().map(|path| {
                path.to_string_lossy()
                    .trim_start_matches("\\\\?\\")
                    .to_string()
            })
        })
        .as_ref()
        .is_some_and(|host| host.eq_ignore_ascii_case(&path))
    {
        return None;
    }
    let name = path
        .rsplit('\\')
        .next()
        .unwrap_or(&path)
        .trim_end_matches(".exe")
        .to_string();
    let mut text = vec![0u16; (GetWindowTextLengthW(hwnd) as usize + 1).min(4096)];
    let len = GetWindowTextW(hwnd, text.as_mut_ptr(), text.len() as i32).max(0) as usize;
    let birth = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
    let app = AppInfo {
        window_witness: None,
        app_id: format!("{pid}:{}:{birth}", hwnd as usize),
        name,
        tier: tier(&path),
        path,
        pid,
        window_id: (hwnd as usize).to_string(),
        title: String::from_utf16_lossy(&text[..len]),
    };
    Some(app)
}

pub fn revalidate(app: &AppInfo) -> Result<()> {
    #[cfg(windows)]
    let live = unsafe {
        window_info(
            app.window_id
                .parse::<usize>()
                .map_err(|_| Error::Other("Invalid window identity.".into()))? as _,
        )
    };
    #[cfg(not(windows))]
    let live: Option<AppInfo> = None;
    let identity = live.as_ref().is_some_and(|live| {
        live.app_id == app.app_id
            && live.path.eq_ignore_ascii_case(&app.path)
            && live.pid == app.pid
            && live.window_id == app.window_id
    });
    if !identity {
        return Err(Error::Other(
            "The approved window or executable changed. Approve the app again.".into(),
        ));
    }
    #[cfg(windows)]
    if let Some(expected) = app.window_witness {
        let hwnd = app
            .window_id
            .parse::<usize>()
            .map_err(|_| Error::Other("Invalid window identity.".into()))? as _;
        let current = unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetPropW(
                hwnd,
                witness_key(expected).as_ptr(),
            )
        };
        if current as usize != expected {
            return Err(Error::Other(
                "The approved window lifetime ended. Approve the new window again.".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn witness_key(nonce: usize) -> Vec<u16> {
    static PREFIX: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let prefix = PREFIX.get_or_init(|| {
        format!(
            "ClaudinalComputerUse.{}.{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        )
    });
    format!("{prefix}.{nonce:x}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

/// Called only after an explicit Allow. Windows removes properties on HWND
/// destruction, so same-process HWND reuse cannot inherit this grant.
pub fn bind_window(mut app: AppInfo) -> Result<AppInfo> {
    revalidate(&app)?;
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetPropW, SetPropW};
        let hwnd = app
            .window_id
            .parse::<usize>()
            .map_err(|_| Error::Other("Invalid window identity.".into()))? as _;
        let nonce = (uuid::Uuid::new_v4().as_u128() as usize).max(1);
        if SetPropW(hwnd, witness_key(nonce).as_ptr(), nonce as _) == 0
            || GetPropW(hwnd, witness_key(nonce).as_ptr()) as usize != nonce
        {
            return Err(Error::Other(
                "Windows could not bind this exact window lifetime. App access was not granted."
                    .into(),
            ));
        }
        app.window_witness = Some(nonce);
    }
    #[cfg(not(windows))]
    return Err(Error::Other(
        "Window lifetime binding is unavailable on this platform.".into(),
    ));
    #[cfg(windows)]
    {
        if let Err(error) = revalidate(&app) {
            remove_window_witness(&app);
            return Err(error);
        }
        Ok(app)
    }
}

pub fn remove_window_witness(app: &AppInfo) {
    #[cfg(windows)]
    if let Some(expected) = app.window_witness {
        if let Ok(value) = app.window_id.parse::<usize>() {
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{GetPropW, RemovePropW};
                let hwnd = value as _;
                if GetPropW(hwnd, witness_key(expected).as_ptr()) as usize == expected {
                    RemovePropW(hwnd, witness_key(expected).as_ptr());
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

pub(super) fn posted_click_class(class: &str, root: bool) -> bool {
    class.starts_with("WindowsForms10.")
        || if root {
            [
                "#32770",
                "Notepad",
                "WordPadClass",
                "CabinetWClass",
                "ExploreWClass",
                "ConsoleWindowClass",
            ]
            .contains(&class)
        } else {
            [
                "Edit",
                "Button",
                "Static",
                "ComboBox",
                "ComboBoxEx32",
                "ListBox",
                "ScrollBar",
                "RichEdit20W",
                "RICHEDIT50W",
                "SysListView32",
                "SysTreeView32",
                "SysTabControl32",
                "SysHeader32",
                "ToolbarWindow32",
                "ReBarWindow32",
                "msctls_statusbar32",
                "msctls_progress32",
                "DirectUIHWND",
                "SHELLDLL_DefView",
                "DUIViewWndClassName",
            ]
            .contains(&class)
        }
}

pub(super) fn witness_key_text(app: &AppInfo) -> Result<String> {
    #[cfg(windows)]
    {
        let nonce = app
            .window_witness
            .ok_or_else(|| Error::Other("Approved window lifetime witness is missing.".into()))?;
        let key = witness_key(nonce);
        String::from_utf16(&key[..key.len() - 1])
            .map_err(|_| Error::Other("Window witness key encoding failed.".into()))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(Error::Other(
            "Window capture is unavailable on this platform.".into(),
        ))
    }
}

pub(super) fn worker_identity(app: &AppInfo) -> Result<serde_json::Value> {
    revalidate(app)?;
    let process_birth = app
        .app_id
        .rsplit(':')
        .next()
        .and_then(|part| part.parse::<u64>().ok())
        .ok_or_else(|| Error::Other("Process lifetime identity is missing.".into()))?;
    Ok(
        serde_json::json!({"pid":app.pid,"process_birth":process_birth,"exe_path":app.path,"window_id":app.window_id,
        "witness_key":witness_key_text(app)?,"witness_nonce":app.window_witness.ok_or_else(||Error::Other("Window lifetime witness is missing.".into()))? as u64}),
    )
}

/// The reviewed pinned driver can inject synthetic pen on dropped toolkits.
/// Admit only a positive native/WinForms subtree for the posted-message slice.
pub fn ensure_posted_click(app: &AppInfo) -> Result<()> {
    #[cfg(windows)]
    {
        let root = app
            .window_id
            .parse::<usize>()
            .map_err(|_| Error::Other("Invalid window identity.".into()))?;
        for hwnd in input_targets(app)? {
            let mut buffer = [0u16; 256];
            let len = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW(
                    hwnd as _,
                    buffer.as_mut_ptr(),
                    buffer.len() as i32,
                )
            };
            if len <= 0
                || !posted_click_class(
                    &String::from_utf16_lossy(&buffer[..len.max(0) as usize]),
                    hwnd == root,
                )
            {
                return Err(Error::Other("Background clicks are currently supported only for verified Win32/WinForms windows. This toolkit is unsupported; no pen or foreground fallback was attempted.".into()));
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(Error::Other(
            "Background click is unavailable on this platform.".into(),
        ))
    }
}

/// Only background delivery is exposed. Release messages go to the exact target,
/// never the user's current foreground window or the global physical keyboard.
pub fn input_targets(app: &AppInfo) -> Result<Vec<usize>> {
    revalidate(app)?;
    let root = app
        .window_id
        .parse::<usize>()
        .map_err(|_| Error::Other("Invalid captured window identity.".into()))?;
    let mut targets = vec![root];
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::EnumChildWindows;
        unsafe extern "system" fn child(
            hwnd: windows_sys::Win32::Foundation::HWND,
            data: isize,
        ) -> i32 {
            let targets = &mut *(data as *mut Vec<usize>);
            targets.push(hwnd as usize);
            (targets.len() <= 1024) as i32
        }
        EnumChildWindows(root as _, Some(child), &mut targets as *mut _ as isize);
    }
    if targets.len() > 1024 {
        return Err(Error::Other(
            "Approved window exceeds the bounded input cleanup target budget.".into(),
        ));
    }
    Ok(targets)
}

pub fn release_background_input(
    app: &AppInfo,
    captured_targets: &[usize],
    keys: &[u16],
    mouse: bool,
) -> Result<()> {
    if keys.is_empty() && !mouse {
        return Ok(());
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MapVirtualKeyW, MAPVK_VK_TO_VSC};
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        if let Err(error) = revalidate(app) {
            let still_same = app
                .window_id
                .parse::<usize>()
                .ok()
                .and_then(|hwnd| window_info(hwnd as _))
                .is_some_and(|live| live.app_id == app.app_id);
            return if still_same {
                Err(Error::Other(format!("Held-input window lifetime could not be confirmed; computer access remains disabled: {error}")))
            } else {
                Ok(())
            };
        }
        let root = app
            .window_id
            .parse::<usize>()
            .map_err(|_| Error::Other("Invalid captured window identity.".into()))?
            as windows_sys::Win32::Foundation::HWND;
        let mut targets = input_targets(app)?;
        targets.extend_from_slice(captured_targets);
        targets.sort_unstable();
        targets.dedup();
        let mut ok = true;
        for target in targets {
            let hwnd = target as windows_sys::Win32::Foundation::HWND;
            if IsWindow(hwnd) == 0 || hwnd != root && IsChild(root, hwnd) == 0 {
                continue;
            }
            for key in keys {
                let extended = matches!(*key, 0x21..=0x28 | 0x2D | 0x2E);
                let scan = MapVirtualKeyW(*key as u32, MAPVK_VK_TO_VSC);
                let flags = 1 | (scan << 16) | ((extended as u32) << 24) | (3u32 << 30);
                let message = if keys.contains(&0x12) {
                    WM_SYSKEYUP
                } else {
                    WM_KEYUP
                };
                ok &= PostMessageW(hwnd, message, *key as usize, flags as isize) != 0;
            }
            if mouse {
                for message in [WM_LBUTTONUP, WM_RBUTTONUP, WM_MBUTTONUP] {
                    ok &= PostMessageW(hwnd, message, 0, 0) != 0;
                }
            }
        }
        if !ok {
            return Err(Error::Other(
                "Windows rejected background input release; control remains disabled.".into(),
            ));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, captured_targets, keys, mouse);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trusted_executable_tiers_do_not_accept_input_upgrades() {
        assert_eq!(tier("C:\\Program Files\\Browser\\chrome.exe"), Tier::View);
        assert_eq!(tier("C:\\Program Files\\Code\\Code.exe"), Tier::Click);
        assert_eq!(tier("C:\\Windows\\System32\\notepad.exe"), Tier::Full);
        assert_eq!(tier("C:\\Apps\\Vivaldi\\vivaldi.exe"), Tier::View);
        assert_eq!(tier("C:\\Apps\\WezTerm\\wezterm-gui.exe"), Tier::Click);
        assert_eq!(tier("C:\\Apps\\Zed\\Zed.exe"), Tier::Click);
        for name in [
            "Antigravity.exe",
            "Antigravity IDE.exe",
            "ANTIGRAVITY IDE.EXE",
        ] {
            assert_eq!(tier(&format!(r"C:\Apps\{name}")), Tier::Click);
        }
        for name in [
            "Taskmgr.exe",
            "SystemSettings.exe",
            "control.exe",
            "mmc.exe",
            "regedit.exe",
            "ApplicationFrameHost.exe",
        ] {
            assert_eq!(tier(&format!(r"C:\Windows\{name}")), Tier::View);
        }
        assert_eq!(tier(r"C:\Apps\My Antigravity Notes.exe"), Tier::Full);
    }
    #[test]
    fn shell_surfaces_and_helper_processes_are_not_application_choices() {
        for class in ["Progman", "WorkerW", "Shell_TrayWnd", "IME", "MSCTFIME UI"] {
            assert!(shell_window_class(class));
        }
        assert!(!shell_window_class("Chrome_WidgetWin_1"));
        for name in [
            "TextInputHost.exe",
            "InputApp.exe",
            "NVIDIA Overlay.exe",
            "NVIDIA Share.exe",
        ] {
            assert!(helper_executable(&format!(r"C:\Windows\{name}")));
        }
        assert!(
            !helper_executable(r"C:\Apps\Raycast.exe"),
            "keep real Raycast task windows; filter its auxiliary HWNDs by their properties"
        );
    }
    #[cfg(windows)]
    #[test]
    fn discovery_filters_real_tool_hidden_zero_sized_and_cloaked_windows() {
        let _desktop = DESKTOP_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        use windows_sys::Win32::{Foundation::HWND, Graphics::Dwm::*, UI::WindowsAndMessaging::*};
        fn wide(value: &str) -> Vec<u16> {
            value.encode_utf16().chain(std::iter::once(0)).collect()
        }
        struct Window(HWND);
        impl Drop for Window {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        unsafe {
            for (extended, visible, width, height, expected) in [
                (WS_EX_APPWINDOW, true, 200, 100, true),
                (WS_EX_TOOLWINDOW, true, 200, 100, false),
                (WS_EX_NOACTIVATE, true, 200, 100, false),
                (WS_EX_APPWINDOW, false, 200, 100, false),
                (WS_EX_APPWINDOW, true, 0, 0, false),
            ] {
                let window = Window(CreateWindowExW(
                    extended,
                    wide("#32770").as_ptr(),
                    wide("Claudinal discovery fixture").as_ptr(),
                    WS_POPUP | if visible { WS_VISIBLE } else { 0 },
                    30,
                    30,
                    width,
                    height,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                ));
                assert!(!window.0.is_null());
                assert_eq!(
                    discoverable_window(window.0),
                    expected,
                    "style {extended}, visible {visible}, size {width}x{height}"
                );
                if expected {
                    let cloak: u32 = 1;
                    assert!(
                        DwmSetWindowAttribute(
                            window.0,
                            DWMWA_CLOAK as u32,
                            &cloak as *const _ as _,
                            4
                        ) >= 0
                    );
                    assert!(
                        !discoverable_window(window.0),
                        "DWM-cloaked windows must not appear"
                    );
                }
            }
        }
    }
    #[test]
    fn display_paths_drop_verbatim_prefixes() {
        use std::path::Path;
        assert_eq!(
            display_path(Path::new(r"\\?\F:\release\computer-use\cua-driver.exe")),
            r"F:\release\computer-use\cua-driver.exe"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\cua-driver.exe")),
            r"\\server\share\cua-driver.exe"
        );
        assert_eq!(display_path(Path::new(r"C:\plain.exe")), r"C:\plain.exe");
    }
    #[test]
    fn pen_toolkits_and_unknown_children_are_not_posted_click_targets() {
        for class in [
            "Chrome_WidgetWin_1",
            "HwndWrapper[app]",
            "TkTopLevel",
            "gdkWindowToplevel",
            "gdkSurface",
            "unknown",
        ] {
            assert!(!posted_click_class(class, true));
            assert!(!posted_click_class(class, false));
        }
        assert!(posted_click_class(
            "WindowsForms10.Window.8.app.0.fixture",
            true
        ));
        assert!(posted_click_class(
            "WindowsForms10.EDIT.app.0.fixture",
            false
        ));
        assert!(posted_click_class("#32770", true));
        assert!(posted_click_class("Button", false));
    }
    #[cfg(windows)]
    #[test]
    fn concurrent_window_bindings_use_independent_private_property_keys() {
        assert_ne!(witness_key(1), witness_key(2));
        assert_eq!(witness_key(1), witness_key(1));
        assert_eq!(witness_key(1).last(), Some(&0));
    }
}
