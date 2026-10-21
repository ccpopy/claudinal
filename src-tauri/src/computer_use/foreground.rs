//! Opt-in, one-batch Windows shortcuts. Caller holds the native authority lock.
#[cfg(windows)]
use serde_json::json;
use serde_json::Value;

use super::{keyboard::Chord, types::AppInfo};
use crate::error::{Error, Result};

pub(super) fn press(app: &AppInfo, chord: &Chord) -> Result<Value> {
    #[cfg(not(windows))]
    {
        let _ = (app, chord);
        Err(Error::Other(
            "Foreground shortcuts are available on Windows only.".into(),
        ))
    }
    #[cfg(windows)]
    unsafe {
        use std::time::{Duration, Instant};
        use windows_sys::Win32::{
            Foundation::HWND,
            UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
        };
        let mut dispatched = false;
        let result = (|| -> Result<Value> {
            super::platform::revalidate(app)?;
            let root = app
                .window_id
                .parse::<usize>()
                .map_err(|_| Error::Other("Invalid approved window.".into()))?
                as HWND;
            if IsWindowVisible(root) == 0 || IsIconic(root) != 0 {
                return Err(Error::Other(
                    "Open the approved window before using foreground shortcuts.".into(),
                ));
            }
            let keys = chord.virtual_keys();
            let keyboard_idle = || (1..=255).all(|key| GetAsyncKeyState(key) >= 0);
            if !keyboard_idle() {
                return Err(Error::Other("Release the keyboard and mouse before a foreground shortcut; nothing was sent.".into()));
            }
            if GetForegroundWindow() != root && SetForegroundWindow(root) == 0 {
                return Err(Error::Other("Windows did not allow the approved window to become foreground. Activate it and try again after observing.".into()));
            }
            let focused = || {
                let mut pid = 0;
                let thread = GetWindowThreadProcessId(root, &mut pid);
                let mut info: GUITHREADINFO = std::mem::zeroed();
                info.cbSize = std::mem::size_of_val(&info) as u32;
                let mut focus_pid = 0;
                GetForegroundWindow() == root
                    && pid == app.pid
                    && thread != 0
                    && GetGUIThreadInfo(thread, &mut info) != 0
                    && !info.hwndFocus.is_null()
                    && (info.hwndFocus == root || IsChild(root, info.hwndFocus) != 0)
                    && GetWindowThreadProcessId(info.hwndFocus, &mut focus_pid) != 0
                    && focus_pid == app.pid
            };
            let deadline = Instant::now() + Duration::from_millis(250);
            while !focused() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            super::platform::revalidate(app)?;
            if !focused() || !keyboard_idle() {
                return Err(Error::Other(
                    "Foreground focus or physical input changed; no shortcut was sent.".into(),
                ));
            }
            let sequence = super::keyboard::input_sequence(&keys);
            let inputs = sequence
                .iter()
                .map(|(key, up)| input(*key, *up))
                .collect::<Vec<_>>();
            // A single SendInput batch cannot interleave its modifiers with
            // another batch or physical input. Every down has its matching up.
            dispatched = true;
            let count = SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            ) as usize;
            if count != inputs.len() {
                // Only release downs Windows actually accepted; never replay.
                let mut held = Vec::new();
                for (key, up) in sequence.iter().take(count) {
                    if *up {
                        held.retain(|held| held != key);
                    } else {
                        held.push(*key);
                    }
                }
                let releases = held
                    .into_iter()
                    .rev()
                    .map(|key| input(key, true))
                    .collect::<Vec<_>>();
                if !releases.is_empty() {
                    SendInput(
                        releases.len() as u32,
                        releases.as_ptr(),
                        std::mem::size_of::<INPUT>() as i32,
                    );
                }
                return Err(Error::Other("Windows rejected all or part of the shortcut. It was not replayed; observe the app again.".into()));
            }
            Ok(
                json!({"content":[{"type":"text","text":"The foreground shortcut was delivered with all keys released. Observe the approved window to verify its effect."}],
                "structuredContent":{"effect":"unverifiable","route":"SendInput","delivery_mode":"foreground"}}),
            )
        })();
        match result {
            Err(error) if !dispatched => Ok(
                json!({"isError":true,"content":[{"type":"text","text":error.to_string()}],
                "structuredContent":{"effect":"none","route":"SendInput","delivery_mode":"foreground","code":"foreground_unavailable"}}),
            ),
            other => other,
        }
    }
}

#[cfg(windows)]
unsafe fn input(key: u16, up: bool) -> windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    let mut value: INPUT = std::mem::zeroed();
    value.r#type = INPUT_KEYBOARD;
    value.Anonymous.ki.wVk = key;
    value.Anonymous.ki.dwFlags = if up { KEYEVENTF_KEYUP } else { 0 }
        | if matches!(key, 0x21..=0x28 | 0x2D | 0x2E) {
            KEYEVENTF_EXTENDEDKEY
        } else {
            0
        };
    value
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::computer_use::{keyboard::EditCommand, platform, window_executor};
    use std::{
        path::PathBuf,
        process::{Child, Command, Stdio},
        sync::atomic::{AtomicIsize, Ordering},
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::*,
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };

    static EDIT_PROC: AtomicIsize = AtomicIsize::new(0);
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn edit_proc(
        hwnd: HWND,
        message: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if message == WM_KEYDOWN && wparam == 0x41 && GetKeyState(0x11) < 0 {
            SetPropW(
                hwnd,
                wide("ClaudinalFixtureCtrlObserved").as_ptr(),
                1usize as _,
            );
            SendMessageW(hwnd, 0x00B1, 0, -1); // The fixture's real Ctrl+A handler.
            return 0;
        }
        let previous: WNDPROC = std::mem::transmute(EDIT_PROC.load(Ordering::SeqCst));
        CallWindowProcW(previous, hwnd, message, wparam, lparam)
    }

    #[test]
    fn shortcut_fixture_child() {
        let Some(path) = std::env::var_os("CLAUDINAL_SHORTCUT_FIXTURE") else {
            return;
        };
        unsafe {
            let root = CreateWindowExW(
                WS_EX_APPWINDOW,
                wide("#32770").as_ptr(),
                wide("Disposable Claudinal shortcut fixture").as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                60,
                60,
                500,
                200,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!root.is_null());
            let edit = CreateWindowExW(
                0,
                wide("Edit").as_ptr(),
                wide("Hello Claudinal 中文").as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                10,
                10,
                450,
                40,
                root,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!edit.is_null());
            EDIT_PROC.store(
                SetWindowLongPtrW(edit, GWLP_WNDPROC, edit_proc as *const () as isize),
                Ordering::SeqCst,
            );
            SetForegroundWindow(root);
            SetFocus(edit);
            let parent: u32 = std::env::var("CLAUDINAL_SHORTCUT_PARENT")
                .unwrap()
                .parse()
                .unwrap();
            AllowSetForegroundWindow(parent);
            std::fs::write(
                path,
                serde_json::to_vec(&json!({"root":root as usize,"edit":edit as usize})).unwrap(),
            )
            .unwrap();
            SetTimer(root, 1, 60_000, None);
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                if message.message == WM_TIMER {
                    break;
                }
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            DestroyWindow(root);
        }
    }

    struct Fixture {
        child: Child,
        directory: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    struct Window(HWND);
    impl Drop for Window {
        fn drop(&mut self) {
            unsafe {
                DestroyWindow(self.0);
            }
        }
    }

    #[test]
    fn native_shortcuts_select_text_without_typing_a_and_release_modifiers() {
        let _desktop = platform::DESKTOP_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let directory =
            std::env::temp_dir().join(format!("claudinal-shortcuts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let executable = directory.join("ShortcutFixture.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        let snapshot = directory.join("ready.json");
        let child = Command::new(executable)
            .args([
                "--exact",
                "computer_use::foreground::tests::shortcut_fixture_child",
                "--nocapture",
            ])
            .env("CLAUDINAL_SHORTCUT_FIXTURE", &snapshot)
            .env("CLAUDINAL_SHORTCUT_PARENT", std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut fixture = Fixture { child, directory };
        let deadline = Instant::now() + Duration::from_secs(20);
        let state: Value = loop {
            if let Some(state) = std::fs::read(&snapshot)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            {
                break state;
            }
            assert!(
                fixture.child.try_wait().unwrap().is_none(),
                "fixture exited before readiness"
            );
            assert!(Instant::now() < deadline, "fixture readiness timed out");
            std::thread::sleep(Duration::from_millis(10));
        };
        let app = platform::apps()
            .unwrap()
            .into_iter()
            .find(|app| app.pid == fixture.child.id())
            .expect("visible fixture in app list");
        let app = platform::bind_window(app).unwrap();
        unsafe {
            let root = state["root"].as_u64().unwrap() as usize as HWND;
            let edit = state["edit"].as_u64().unwrap() as usize as HWND;
            let length = SendMessageW(edit, WM_GETTEXTLENGTH, 0, 0) as u32;
            let background = window_executor::test_edit(&app, EditCommand::SelectAll).unwrap();
            assert_eq!(background["structuredContent"]["effect"], "confirmed");
            assert_eq!(SendMessageW(edit, 0x00B0, 0, 0) as u32, length << 16);
            assert_eq!(SendMessageW(edit, WM_GETTEXTLENGTH, 0, 0) as u32, length);
            assert!(
                GetPropW(edit, wide("ClaudinalFixtureCtrlObserved").as_ptr()).is_null(),
                "background all-select must not fake Ctrl+A"
            );
            SendMessageW(edit, 0x00B1, 0, 0);

            let other = Window(CreateWindowExW(
                WS_EX_APPWINDOW,
                wide("#32770").as_ptr(),
                wide("Disposable focus decoy").as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                600,
                60,
                250,
                150,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            ));
            assert!(!other.0.is_null());
            assert_ne!(SetForegroundWindow(other.0), 0);
            assert_eq!(GetForegroundWindow(), other.0);
            let result = press(&app, &Chord::parse("a", &["ctrl".into()]).unwrap()).unwrap();
            assert_ne!(
                result.get("isError").and_then(Value::as_bool),
                Some(true),
                "{result}"
            );
            assert_eq!(result["structuredContent"]["route"], "SendInput");
            assert_eq!(GetForegroundWindow(), root);
            let deadline = Instant::now() + Duration::from_secs(3);
            while GetPropW(edit, wide("ClaudinalFixtureCtrlObserved").as_ptr()).is_null()
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                !GetPropW(edit, wide("ClaudinalFixtureCtrlObserved").as_ptr()).is_null(),
                "fixture must see Ctrl pressed for A"
            );
            assert_eq!(SendMessageW(edit, 0x00B0, 0, 0) as u32, length << 16);
            assert_eq!(
                SendMessageW(edit, WM_GETTEXTLENGTH, 0, 0) as u32,
                length,
                "no stray a may replace the text"
            );
            for key in [0x11, 0x10, 0x12, 0x41] {
                assert!(GetAsyncKeyState(key) >= 0, "key {key} remained pressed");
            }

            // The same executable with a destroyed witness cannot receive another chord.
            platform::remove_window_witness(&app);
            assert_eq!(
                press(&app, &Chord::parse("a", &["ctrl".into()]).unwrap()).unwrap()["isError"],
                true
            );
        }
    }
}
