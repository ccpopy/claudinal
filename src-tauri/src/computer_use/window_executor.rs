//! One-shot, job-owned target-window operations. No screen/DC capture fallback.
//! Private requests are constructed by Core after authorization, never by MCP.
use std::{
    io::{Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[cfg(windows)]
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::{
    error::{Error, Result},
    proc::ProcessTree,
};

const MAX_REQUEST: usize = 32 * 1024;
const MAX_PNG: usize = 5 * 1024 * 1024;
const MAX_RESPONSE: usize = MAX_PNG * 4 / 3 + 16 * 1024;
const MAX_EDGE: u32 = 4096;
const OUTPUT_EDGE: u32 = 1372;
const MAX_RAW: usize = 64 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(8);

fn failure(message: &str) -> Error {
    Error::Other(message.into())
}

/// Set immediately before the first posted input message. The worker is
/// one-shot, so a process-wide flag tells the host whether delivery is uncertain.
static DISPATCHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Our own failure texts are static and path-free; anything else stays opaque.
fn safe_reason(error: &Error) -> Option<String> {
    let Error::Other(message) = error else {
        return None;
    };
    (!message.contains(['\\', '/'])).then(|| message.chars().take(300).collect())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    pid: u32,
    process_birth: u64,
    exe_path: String,
    window_id: String,
    witness_key: String,
    witness_nonce: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Geometry {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub dpi: u32,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Capture,
    Click,
    #[serde(rename = "edit_shortcut")]
    EditShortcut,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: Operation,
    identity: Identity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    geometry: Option<Geometry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    button: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    count: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<super::keyboard::EditCommand>,
}

impl Request {
    fn parse(value: Value) -> Result<Self> {
        let request: Self = serde_json::from_value(value)
            .map_err(|_| failure("Invalid private window request."))?;
        let id = &request.identity;
        if id.pid == 0
            || id.process_birth == 0
            || id.witness_nonce == 0
            || id.witness_nonce > usize::MAX as u64
            || id
                .window_id
                .parse::<usize>()
                .ok()
                .filter(|id| *id != 0)
                .is_none()
            || id.exe_path.is_empty()
            || id.exe_path.len() > 32768
            || !Path::new(&id.exe_path).is_absolute()
            || id.exe_path.contains('\0')
            || id.witness_key.is_empty()
            || id.witness_key.len() > 256
            || id.witness_key.contains('\0')
        {
            return Err(failure("Invalid private window identity."));
        }
        match request.operation {
            Operation::Capture
                if request.geometry.is_none()
                    && request.x.is_none()
                    && request.y.is_none()
                    && request.button.is_none()
                    && request.count.is_none()
                    && request.command.is_none() => {}
            Operation::EditShortcut
                if request.command.is_some()
                    && request.geometry.is_none()
                    && request.x.is_none()
                    && request.y.is_none()
                    && request.button.is_none()
                    && request.count.is_none() => {}
            Operation::Click if request.command.is_none() => {
                match (
                    request.button.as_deref().unwrap_or("left"),
                    request.count.unwrap_or(1),
                ) {
                    ("left", 1 | 2) | ("right", 1) => {}
                    _ => return Err(failure("Unsupported click button or count.")),
                }
                let geometry = request
                    .geometry
                    .as_ref()
                    .ok_or_else(|| failure("Missing captured window geometry."))?;
                geometry.screen_point(
                    request
                        .x
                        .ok_or_else(|| failure("Missing image coordinate."))?,
                    request
                        .y
                        .ok_or_else(|| failure("Missing image coordinate."))?,
                )?;
            }
            _ => return Err(failure("Invalid private window operation.")),
        }
        Ok(request)
    }
}

fn dimensions(width: u32, height: u32) -> Result<(u32, u32, usize)> {
    let raw = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4));
    if width == 0
        || height == 0
        || width > MAX_EDGE
        || height > MAX_EDGE
        || raw.is_none_or(|n| n > MAX_RAW)
    {
        return Err(failure("Window capture exceeds its dimension budget."));
    }
    let edge = width.max(height);
    let (out_width, out_height) = if edge > OUTPUT_EDGE {
        (
            ((width as u64 * OUTPUT_EDGE as u64) / edge as u64).max(1) as u32,
            ((height as u64 * OUTPUT_EDGE as u64) / edge as u64).max(1) as u32,
        )
    } else {
        (width, height)
    };
    Ok((out_width, out_height, raw.unwrap()))
}

impl Geometry {
    fn dimensions(&self) -> Result<(u32, u32, usize)> {
        let width = self
            .right
            .checked_sub(self.left)
            .filter(|v| *v > 0)
            .ok_or_else(|| failure("Invalid window geometry."))? as u32;
        let height = self
            .bottom
            .checked_sub(self.top)
            .filter(|v| *v > 0)
            .ok_or_else(|| failure("Invalid window geometry."))? as u32;
        let size = dimensions(width, height)?;
        if self.dpi == 0 || self.screenshot_width != size.0 || self.screenshot_height != size.1 {
            return Err(failure("Captured window geometry is inconsistent."));
        }
        Ok(size)
    }

    fn screen_point(&self, x: f64, y: f64) -> Result<(i32, i32)> {
        self.dimensions()?;
        if !x.is_finite()
            || !y.is_finite()
            || x < 0.0
            || y < 0.0
            || x >= self.screenshot_width as f64
            || y >= self.screenshot_height as f64
        {
            return Err(failure("Click is outside the captured image."));
        }
        let width = self.right as i64 - self.left as i64;
        let height = self.bottom as i64 - self.top as i64;
        let px =
            self.left as i64 + (x * width as f64 / self.screenshot_width as f64).floor() as i64;
        let py =
            self.top as i64 + (y * height as f64 / self.screenshot_height as f64).floor() as i64;
        Ok((px as i32, py as i32))
    }
}

/// Owns the child separately from stdout/write threads so revoke never waits on IO.
pub(super) struct Worker {
    child: Mutex<Option<Child>>,
    tree: Mutex<Option<ProcessTree>>,
    response: tokio::sync::Mutex<mpsc::Receiver<std::result::Result<Value, String>>>,
}

impl Worker {
    /// Core calls this and records the worker under its generation lock.
    pub(super) fn start(exe: &Path, request: Value) -> Result<Arc<Self>> {
        let request = Request::parse(request)?;
        let mut bytes = serde_json::to_vec(&request)
            .map_err(|_| failure("Cannot encode private window request."))?;
        if bytes.len() > MAX_REQUEST {
            return Err(failure("Private window request exceeds its byte budget."));
        }
        bytes.push(b'\n');
        let mut command = Command::new(exe);
        command
            .arg("--computer-use-window-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::child_process::hide_std_window(&mut command);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command
            .spawn()
            .map_err(|_| failure("Window worker could not start."))?;
        Self::from_child(child, Some(bytes))
    }

    fn from_child(mut child: Child, request: Option<Vec<u8>>) -> Result<Arc<Self>> {
        let tree = match ProcessTree::attach_std(&child) {
            Ok(tree) => tree,
            Err(_) => {
                abandon_unstarted(child);
                return Err(failure("Window worker supervision failed."));
            }
        };
        // Both pipes were requested above; never leave an unsupervised child on an error.
        let Some(mut stdin) = child.stdin.take() else {
            drop(tree);
            abandon_unstarted(child);
            return Err(failure("Window worker input is unavailable."));
        };
        let Some(stdout) = child.stdout.take() else {
            drop(tree);
            drop(stdin);
            abandon_unstarted(child);
            return Err(failure("Window worker output is unavailable."));
        };
        let (send, receive) = mpsc::channel(2);
        let writer_error = send.clone();
        if let Some(bytes) = request {
            std::thread::spawn(move || {
                if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                    let _ = writer_error.blocking_send(Err("Window worker input failed.".into()));
                }
                // EOF is part of the one-request protocol; no additional requests can follow.
            });
        }
        std::thread::spawn(move || {
            let result = read_single_frame(stdout, MAX_RESPONSE).map_err(|_| {
                "Window worker returned an invalid or oversized response.".to_string()
            });
            let _ = send.blocking_send(result);
        });
        Ok(Arc::new(Self {
            child: Mutex::new(Some(child)),
            tree: Mutex::new(Some(tree)),
            response: tokio::sync::Mutex::new(receive),
        }))
    }

    /// Offline/owned-fixture cleanup tests may adopt a piped silent child.
    #[cfg(test)]
    pub(super) fn from_test_child(child: Child) -> Result<Arc<Self>> {
        Self::from_child(child, None)
    }

    pub(super) async fn receive(&self) -> Result<Value> {
        let result =
            tokio::time::timeout(DEADLINE, async { self.response.lock().await.recv().await }).await;
        let frame = match result {
            Ok(Some(Ok(frame))) => frame,
            _ => {
                self.kill();
                return Err(failure(
                    "Window worker failed or timed out. No action will be replayed.",
                ));
            }
        };
        if frame.get("ok") == Some(&Value::Bool(true)) {
            if let Some(result) = frame.get("result").filter(|v| v.is_object()) {
                return Ok(result.clone());
            }
        }
        if frame.get("ok") == Some(&Value::Bool(false))
            && frame.get("dispatched") == Some(&Value::Bool(false))
        {
            // Refused before any input message: an ordinary, explainable tool error.
            let reason = frame
                .get("reason")
                .and_then(Value::as_str)
                .filter(|reason| !reason.is_empty())
                .map(|reason| reason.chars().take(300).collect::<String>())
                .unwrap_or_else(|| "Target-window operation is unsupported.".into());
            return Ok(json!({"isError":true,"content":[{"type":"text",
                "text":format!("{reason} Nothing was sent to the app. Observe again before acting.")}]}));
        }
        self.kill();
        // The helper has no reason to disclose a path, witness or raw Win32 error.
        Err(failure(
            "Target-window operation failed or is unsupported. Observe again before acting.",
        ))
    }

    pub(super) fn kill(&self) {
        self.tree.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(child) = self
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            let _ = child.kill();
        }
    }

    pub(super) fn reap(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_millis(1500);
        loop {
            let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
            let Some(process) = child.as_mut() else {
                return Ok(());
            };
            if process
                .try_wait()
                .map_err(|_| failure("Window worker exit could not be confirmed."))?
                .is_some()
            {
                child.take();
                return Ok(());
            }
            drop(child);
            if Instant::now() >= deadline {
                return Err(failure(
                    "Window worker did not exit within 1500 ms. Computer access remains disabled.",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.kill();
    }
}

/// No request has been sent on these spawn-failure paths, so the child cannot
/// operate a window. Never pin Core's revocation lock on a blocking Child::wait.
fn abandon_unstarted(mut child: Child) {
    drop(child.stdin.take());
    let _ = child.kill();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_millis(1500);
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    });
}

fn read_single_frame(reader: impl Read, limit: usize) -> std::io::Result<Value> {
    let mut reader = std::io::BufReader::new(reader);
    let line = super::driver::read_bounded_line(&mut reader, limit)?
        .ok_or_else(|| std::io::Error::other("Missing frame"))?;
    let mut extra = [0u8; 1];
    if reader.read(&mut extra)? != 0 {
        return Err(std::io::Error::other("Extra frame"));
    }
    serde_json::from_slice(&line).map_err(|_| std::io::Error::other("Invalid frame"))
}

/// The sole worker entrypoint. Errors are an opaque single JSON frame, never logs.
pub fn run_stdio() -> Result<()> {
    let result = read_single_frame(std::io::stdin().lock(), MAX_REQUEST)
        .map_err(|_| failure("Invalid private window frame."))
        .and_then(Request::parse)
        .and_then(execute);
    let frame = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => {
            json!({"ok":false,"error":"Target-window operation failed or is unsupported.",
            "dispatched":DISPATCHED.load(std::sync::atomic::Ordering::SeqCst),
            "reason":safe_reason(&error)})
        }
    };
    let bytes =
        serde_json::to_vec(&frame).map_err(|_| failure("Window result encoding failed."))?;
    if bytes.len() > MAX_RESPONSE {
        return Err(failure("Window result exceeds its byte budget."));
    }
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(&bytes)
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush())
        .map_err(|_| failure("Window result output failed."))
}

#[cfg(not(windows))]
fn execute(_: Request) -> Result<Value> {
    Err(failure(
        "Target-window operations are available on Windows only.",
    ))
}

/// Convert only the app-written private DIB. Nearest-neighbor scaling has no ambient source.
#[cfg(any(windows, test))]
fn encode_png(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let (out_width, out_height, raw) = dimensions(width, height)?;
    if bgra.len() != raw || !bgra.chunks_exact(4).any(|pixel| pixel[..3] != [0, 0, 0]) {
        return Err(failure("PrintWindow produced no usable content."));
    }
    let mut rgb = vec![0u8; out_width as usize * out_height as usize * 3];
    for y in 0..out_height {
        let sy = y as usize * height as usize / out_height as usize;
        for x in 0..out_width {
            let sx = x as usize * width as usize / out_width as usize;
            let src = (sy * width as usize + sx) * 4;
            let dst = (y as usize * out_width as usize + x as usize) * 3;
            rgb[dst..dst + 3].copy_from_slice(&[bgra[src + 2], bgra[src + 1], bgra[src]]);
        }
    }
    struct Limited(Vec<u8>);
    impl Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.0.len().saturating_add(bytes.len()) > MAX_PNG {
                return Err(std::io::Error::other("PNG budget exceeded"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Limited(Vec::new());
    {
        let mut encoder = png::Encoder::new(&mut output, out_width, out_height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|_| failure("Window PNG encoding failed."))?;
        writer
            .write_image_data(&rgb)
            .map_err(|_| failure("Window PNG exceeds its budget or could not be encoded."))?;
        writer
            .finish()
            .map_err(|_| failure("Window PNG finalization failed."))?;
    }
    Ok(output.0)
}

#[cfg(windows)]
fn execute(request: Request) -> Result<Value> {
    unsafe { native::execute(request) }
}

#[cfg(all(test, windows))]
pub(super) fn test_edit(
    app: &super::types::AppInfo,
    command: super::keyboard::EditCommand,
) -> Result<Value> {
    execute(Request::parse(json!({"operation":"edit_shortcut",
        "identity":super::platform::worker_identity(app)?,"command":command}))?)
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HWND, POINT, RECT},
        Graphics::Gdi::*,
        Storage::Xps::PrintWindow,
        System::Threading::*,
        UI::{HiDpi::*, WindowsAndMessaging::*},
    };

    struct DpiContext(DPI_AWARENESS_CONTEXT);
    impl Drop for DpiContext {
        fn drop(&mut self) {
            unsafe {
                SetThreadDpiAwarenessContext(self.0);
            }
        }
    }

    unsafe fn attest(id: &Identity) -> Result<HWND> {
        let hwnd = id
            .window_id
            .parse::<usize>()
            .map_err(|_| failure("Invalid window identity."))? as HWND;
        let mut pid = 0;
        if IsWindow(hwnd) == 0
            || GetAncestor(hwnd, GA_ROOT) != hwnd
            || GetWindowThreadProcessId(hwnd, &mut pid) == 0
            || pid != id.pid
        {
            return Err(failure("Approved window identity changed."));
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return Err(failure("Approved process is unavailable."));
        }
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        let mut birth = std::mem::zeroed();
        let mut exit = std::mem::zeroed();
        let mut kernel = std::mem::zeroed();
        let mut user = std::mem::zeroed();
        let ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) != 0
            && GetProcessTimes(process, &mut birth, &mut exit, &mut kernel, &mut user) != 0;
        CloseHandle(process);
        if !ok
            || ((birth.dwHighDateTime as u64) << 32 | birth.dwLowDateTime as u64)
                != id.process_birth
        {
            return Err(failure("Approved process lifetime changed."));
        }
        let image_path = String::from_utf16_lossy(&path[..length as usize]);
        let actual = std::fs::canonicalize(&image_path)
            .map_err(|_| failure("Approved executable identity is unavailable."))?;
        let expected = std::fs::canonicalize(&id.exe_path)
            .map_err(|_| failure("Approved executable identity is unavailable."))?;
        if !actual
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected.to_string_lossy())
        {
            return Err(failure("Approved executable identity changed."));
        }
        let key = id
            .witness_key
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        if GetPropW(hwnd, key.as_ptr()) as usize != id.witness_nonce as usize {
            return Err(failure("Approved window lifetime changed."));
        }
        Ok(hwnd)
    }

    unsafe fn geometry(hwnd: HWND) -> Result<Geometry> {
        let mut rect: RECT = std::mem::zeroed();
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if IsWindowVisible(hwnd) == 0
            || IsIconic(hwnd) != 0
            || style & (WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOREDIRECTIONBITMAP) != 0
            || GetWindowRect(hwnd, &mut rect) == 0
        {
            return Err(failure(
                "Window does not support isolated capture or input.",
            ));
        }
        let width = rect
            .right
            .checked_sub(rect.left)
            .filter(|v| *v > 0)
            .ok_or_else(|| failure("Invalid window bounds."))? as u32;
        let height = rect
            .bottom
            .checked_sub(rect.top)
            .filter(|v| *v > 0)
            .ok_or_else(|| failure("Invalid window bounds."))? as u32;
        let (screenshot_width, screenshot_height, _) = dimensions(width, height)?;
        let result = Geometry {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            dpi: GetDpiForWindow(hwnd),
            screenshot_width,
            screenshot_height,
        };
        result.dimensions()?;
        Ok(result)
    }

    struct Bitmap {
        dc: HDC,
        bitmap: HBITMAP,
        previous: HGDIOBJ,
    }
    impl Drop for Bitmap {
        fn drop(&mut self) {
            unsafe {
                if !self.previous.is_null() {
                    SelectObject(self.dc, self.previous);
                }
                if !self.bitmap.is_null() {
                    DeleteObject(self.bitmap);
                }
                if !self.dc.is_null() {
                    DeleteDC(self.dc);
                }
            }
        }
    }

    unsafe fn capture(hwnd: HWND, size: &Geometry) -> Result<Vec<u8>> {
        let (_, _, raw) = size.dimensions()?;
        let width = (size.right - size.left) as u32;
        let height = (size.bottom - size.top) as u32;
        // A NULL compatible DC creates a private memory DC; no source pixels are read.
        let dc = CreateCompatibleDC(std::ptr::null_mut());
        if dc.is_null() {
            return Err(failure("Private capture surface is unavailable."));
        }
        let mut bitmap = Bitmap {
            dc,
            bitmap: std::ptr::null_mut(),
            previous: std::ptr::null_mut(),
        };
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width as i32;
        info.bmiHeader.biHeight = -(height as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut bits = std::ptr::null_mut();
        bitmap.bitmap = CreateDIBSection(
            dc,
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
        if bitmap.bitmap.is_null() || bits.is_null() {
            return Err(failure("Private capture bitmap is unavailable."));
        }
        bitmap.previous = SelectObject(dc, bitmap.bitmap);
        if bitmap.previous.is_null() || bitmap.previous as isize == -1 {
            return Err(failure("Private capture bitmap could not be selected."));
        }
        let pixels = std::slice::from_raw_parts_mut(bits as *mut u8, raw);
        pixels.fill(0);
        // The only pixel producer is the approved window's PrintWindow rendering.
        if PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT) == 0 || GdiFlush() == 0 {
            return Err(failure(
                "PrintWindow failed; isolated capture is unsupported.",
            ));
        }
        encode_png(pixels, width, height)
    }

    unsafe fn class_allowed(hwnd: HWND, root: bool) -> bool {
        let mut class = [0u16; 256];
        let length = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        length > 0
            && super::super::platform::posted_click_class(
                &String::from_utf16_lossy(&class[..length.max(0) as usize]),
                root,
            )
    }

    unsafe fn click(
        id: &Identity,
        root: HWND,
        size: &Geometry,
        x: f64,
        y: f64,
        right: bool,
        double: bool,
    ) -> Result<()> {
        let (x, y) = size.screen_point(x, y)?;
        let mut target = root;
        let mut reached_leaf = false;
        if !class_allowed(root, true) {
            return Err(failure(
                "Window toolkit does not support scoped posted clicks.",
            ));
        }
        // Only same-process approved descendants are eligible, never a point's top-level window.
        for _ in 0..16 {
            let mut local = POINT { x, y };
            if ScreenToClient(target, &mut local) == 0 {
                return Err(failure("Click coordinate conversion failed."));
            }
            let child = ChildWindowFromPointEx(
                target,
                local,
                CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
            );
            if child.is_null() || child == target {
                reached_leaf = true;
                break;
            }
            let mut pid = 0;
            if IsChild(root, child) == 0
                || GetWindowThreadProcessId(child, &mut pid) == 0
                || pid != id.pid
                || !class_allowed(child, false)
            {
                return Err(failure(
                    "Click target is outside the approved native subtree.",
                ));
            }
            target = child;
        }
        if !reached_leaf {
            return Err(failure(
                "Click target exceeds the approved child-depth budget.",
            ));
        }
        let mut point = POINT { x, y };
        let mut client: RECT = std::mem::zeroed();
        if ScreenToClient(target, &mut point) == 0
            || GetClientRect(target, &mut client) == 0
            || point.x < client.left
            || point.y < client.top
            || point.x >= client.right
            || point.y >= client.bottom
            || point.x > i16::MAX as i32
            || point.y > i16::MAX as i32
        {
            return Err(failure("Click is outside the approved client surface."));
        }
        // Last pre-dispatch checks; parent already tracks this approved subtree for release.
        if attest(id)? != root
            || geometry(root)? != *size
            || IsWindow(target) == 0
            || target != root && IsChild(root, target) == 0
        {
            return Err(failure("Window changed after observation. Observe again."));
        }
        let mut pid = 0;
        if GetWindowThreadProcessId(target, &mut pid) == 0
            || pid != id.pid
            || !class_allowed(target, target == root)
        {
            return Err(failure("Approved click target changed."));
        }
        let packed = ((point.y as u32 & 0xffff) << 16 | (point.x as u32 & 0xffff)) as isize;
        let (down, up, held) = if right {
            (WM_RBUTTONDOWN, WM_RBUTTONUP, 0x0002usize)
        } else {
            (WM_LBUTTONDOWN, WM_LBUTTONUP, 0x0001usize)
        };
        DISPATCHED.store(true, std::sync::atomic::Ordering::SeqCst);
        if PostMessageW(target, WM_MOUSEMOVE, 0, packed) == 0
            || PostMessageW(target, down, held, packed) == 0
        {
            return Err(failure("Windows rejected scoped click dispatch."));
        }
        if PostMessageW(target, up, 0, packed) == 0 {
            // Parent retains held-mouse tracking even when this attempt fails.
            return Err(failure("Windows rejected scoped click release."));
        }
        // Same sequence a physical double click produces for CS_DBLCLKS windows.
        if double
            && (PostMessageW(target, WM_LBUTTONDBLCLK, held, packed) == 0
                || PostMessageW(target, WM_LBUTTONUP, 0, packed) == 0)
        {
            return Err(failure("Windows rejected scoped double-click dispatch."));
        }
        Ok(())
    }

    unsafe fn edit_shortcut(
        id: &Identity,
        root: HWND,
        command: super::super::keyboard::EditCommand,
    ) -> Result<Value> {
        use super::super::keyboard::EditCommand;
        let thread = GetWindowThreadProcessId(root, std::ptr::null_mut());
        let mut info: GUITHREADINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of_val(&info) as u32;
        if thread == 0 || GetGUIThreadInfo(thread, &mut info) == 0 {
            return Err(failure(
                "The approved app's focused edit control is unavailable.",
            ));
        }
        let target = info.hwndFocus;
        let mut pid = 0;
        let mut class = [0u16; 256];
        let length = GetClassNameW(target, class.as_mut_ptr(), class.len() as i32);
        if target.is_null()
            || target != root && IsChild(root, target) == 0
            || GetWindowThreadProcessId(target, &mut pid) == 0
            || pid != id.pid
            || length <= 0
            || IsWindowEnabled(target) == 0
        {
            return Err(failure("Focus is not in the approved app's edit control. Enable Foreground shortcuts for this app."));
        }
        let class = String::from_utf16_lossy(&class[..length as usize]).to_ascii_lowercase();
        let rich = matches!(class.as_str(), "richedit20w" | "richedit50w")
            || class.starts_with("windowsforms10.richedit");
        if !(class == "edit" || class.starts_with("windowsforms10.edit.") || rich) {
            return Err(failure("Background shortcuts require a native edit control. Enable Foreground shortcuts for this app."));
        }
        // These are documented, cross-process system edit messages, not fake
        // modifier keydowns. No clipboard or foreground focus is involved.
        let send = |message, wparam, lparam| -> Result<usize> {
            let mut result = 0;
            if SendMessageTimeoutW(
                target,
                message,
                wparam,
                lparam,
                SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
                1000,
                &mut result,
            ) == 0
            {
                return Err(failure("The approved edit control did not answer in time."));
            }
            Ok(result)
        };
        let (message, wparam, lparam, expected_length) = match command {
            EditCommand::SelectAll => {
                let length = send(WM_GETTEXTLENGTH, 0, 0)?;
                if length > 65534 {
                    return Err(failure("This edit selection is too large to verify in background mode. Enable Foreground shortcuts."));
                }
                (0x00B1, 0, -1, Some(length)) // EM_SETSEL
            }
            EditCommand::Undo => {
                if send(0x00C6, 0, 0)? == 0 {
                    // EM_CANUNDO
                    return Err(failure("The approved edit control has nothing to undo."));
                }
                (0x00C7, 0, 0, None) // EM_UNDO
            }
            EditCommand::Redo => {
                if !rich {
                    return Err(failure("This edit control has no background redo operation. Enable Foreground shortcuts."));
                }
                if send(WM_USER + 85, 0, 0)? == 0 {
                    // EM_CANREDO
                    return Err(failure("The approved edit control has nothing to redo."));
                }
                (WM_USER + 84, 0, 0, None) // EM_REDO (scalar-only message)
            }
        };
        if attest(id)? != root
            || GetGUIThreadInfo(thread, &mut info) == 0
            || info.hwndFocus != target
            || GetWindowThreadProcessId(target, &mut pid) == 0
            || pid != id.pid
            || target != root && IsChild(root, target) == 0
        {
            return Err(failure("The approved edit focus changed before dispatch."));
        }
        DISPATCHED.store(true, std::sync::atomic::Ordering::SeqCst);
        let outcome = send(message, wparam, lparam)?;
        if let Some(expected) = expected_length {
            let selected = send(0x00B0, 0, 0)?; // EM_GETSEL: bounded to two 16-bit positions
            if selected as u32 != (expected as u32) << 16
                || send(WM_GETTEXTLENGTH, 0, 0)? != expected
            {
                return Err(failure("The edit control did not confirm the full selection. Observe again; the operation was not replayed."));
            }
        } else if outcome == 0 {
            return Err(failure(
                "The edit control did not confirm the edit command. Observe again.",
            ));
        }
        Ok(
            json!({"content":[{"type":"text","text":"The approved edit control confirmed the background edit command. Observe again before another action."}],
            "structuredContent":{"effect":"confirmed","route":"edit_message","delivery_mode":"background"}}),
        )
    }

    pub(super) unsafe fn execute(request: Request) -> Result<Value> {
        let context = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if context.is_null() {
            return Err(failure("Physical window coordinates are unavailable."));
        }
        let _dpi = DpiContext(context);
        let hwnd = attest(&request.identity)?;
        let current = geometry(hwnd)?;
        match request.operation {
            Operation::EditShortcut => edit_shortcut(
                &request.identity,
                hwnd,
                request
                    .command
                    .ok_or_else(|| failure("Missing background edit command."))?,
            ),
            Operation::Capture => {
                let png = capture(hwnd, &current)?;
                if attest(&request.identity)? != hwnd || geometry(hwnd)? != current {
                    return Err(failure("Window changed during capture. Observe again."));
                }
                Ok(json!({"content":[{"type":"image","mimeType":"image/png",
                    "data":base64::engine::general_purpose::STANDARD.encode(png)}],"geometry":current}))
            }
            Operation::Click => {
                let captured = request
                    .geometry
                    .as_ref()
                    .ok_or_else(|| failure("Missing captured geometry."))?;
                if current != *captured {
                    return Err(failure("Window moved or its DPI changed. Observe again."));
                }
                click(
                    &request.identity,
                    hwnd,
                    captured,
                    request
                        .x
                        .ok_or_else(|| failure("Missing image coordinate."))?,
                    request
                        .y
                        .ok_or_else(|| failure("Missing image coordinate."))?,
                    request.button.as_deref() == Some("right"),
                    request.count == Some(2),
                )?;
                let kind = match (request.button.as_deref(), request.count) {
                    (Some("right"), _) => "single right click",
                    (_, Some(2)) => "double left click",
                    _ => "single left click",
                };
                Ok(
                    json!({"content":[{"type":"text","text":format!("A background {kind} was posted to the approved window. Application effect is unverifiable; observe again before further action.")}],
                    "structuredContent":{"effect":"unverifiable","route":"PostMessage","delivery_mode":"background"}}),
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn geometry() -> Geometry {
        Geometry {
            left: -1920,
            top: -50,
            right: 0,
            bottom: 1030,
            dpi: 144,
            screenshot_width: 1372,
            screenshot_height: 771,
        }
    }
    #[test]
    fn geometry_maps_negative_desktop_and_scaled_image_pixels() {
        let g = geometry();
        assert_eq!(g.screen_point(0.0, 0.0).unwrap(), (-1920, -50));
        assert_eq!(g.screen_point(686.0, 385.5).unwrap(), (-960, 490));
        let end = g.screen_point(1371.9, 770.9).unwrap();
        assert!(end.0 < g.right && end.1 < g.bottom);
    }
    #[test]
    fn geometry_rejects_nonfinite_outside_overflow_and_inconsistent_frames() {
        let g = geometry();
        for (x, y) in [
            (f64::NAN, 1.0),
            (1.0, f64::INFINITY),
            (-0.01, 1.0),
            (1372.0, 0.0),
            (0.0, 771.0),
        ] {
            assert!(g.screen_point(x, y).is_err());
        }
        let mut bad = g.clone();
        bad.dpi = 0;
        assert!(bad.dimensions().is_err());
        bad = g.clone();
        bad.screenshot_height += 1;
        assert!(bad.dimensions().is_err());
        bad = g;
        bad.left = i32::MIN;
        bad.right = i32::MAX;
        assert!(bad.dimensions().is_err());
        assert!(dimensions(0, 1).is_err());
        assert!(dimensions(4097, 1).is_err());
        assert_eq!(dimensions(4096, 4096).unwrap(), (1372, 1372, MAX_RAW));
    }
    #[test]
    fn framing_requires_exactly_one_bounded_complete_json_line_and_eof() {
        assert_eq!(
            read_single_frame(&b"{\"ok\":true}\n"[..], 100).unwrap()["ok"],
            true
        );
        for bytes in [
            &b"{}"[..],
            &b"{}\n{}\n"[..],
            &b"{}\n \n"[..],
            &b"x\n"[..],
            &b""[..],
        ] {
            assert!(read_single_frame(bytes, 100).is_err());
        }
        assert!(read_single_frame(&b"{\"too\":\"large\"}\n"[..], 4).is_err());
    }
    #[test]
    fn png_only_encodes_bounded_initialized_rgb_and_refuses_blank_content() {
        assert!(encode_png(&[0; 16], 2, 2).is_err());
        assert!(encode_png(&[1; 15], 2, 2).is_err());
        assert!(encode_png(&[], 4097, 1).is_err());
        let bgra = [3, 2, 1, 0, 6, 5, 4, 0, 9, 8, 7, 0, 12, 11, 10, 0];
        let encoded = encode_png(&bgra, 2, 2).unwrap();
        let mut decoder = png::Decoder::new(std::io::Cursor::new(encoded))
            .read_info()
            .unwrap();
        let mut rgb = vec![0; decoder.output_buffer_size()];
        let info = decoder.next_frame(&mut rgb).unwrap();
        assert_eq!((info.width, info.height), (2, 2));
        assert_eq!(
            &rgb[..info.buffer_size()],
            &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        );
    }
    #[test]
    fn png_downscale_is_bounded_and_preserves_private_source_color() {
        let bgra = [40, 30, 20, 0].repeat(2000 * 2);
        let encoded = encode_png(&bgra, 2000, 2).unwrap();
        let mut decoder = png::Decoder::new(std::io::Cursor::new(encoded))
            .read_info()
            .unwrap();
        let mut rgb = vec![0; decoder.output_buffer_size()];
        let info = decoder.next_frame(&mut rgb).unwrap();
        assert_eq!((info.width, info.height), (1372, 1));
        assert!(rgb.chunks_exact(3).all(|pixel| pixel == [20, 30, 40]));
    }
    #[test]
    fn png_refuses_high_entropy_output_above_its_encoded_byte_budget() {
        let mut state = 0x9e3779b9u32;
        let mut bgra = vec![0u8; OUTPUT_EDGE as usize * OUTPUT_EDGE as usize * 4];
        for pixel in bgra.chunks_exact_mut(4) {
            for channel in &mut pixel[..3] {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *channel = state as u8;
            }
        }
        assert!(encode_png(&bgra, OUTPUT_EDGE, OUTPUT_EDGE).is_err());
    }
    #[test]
    fn private_request_refuses_passthrough_fields_and_foreground_operations() {
        let identity = json!({"pid":12,"process_birth":123,"exe_path":std::env::current_exe().unwrap(),"window_id":"99","witness_key":"private","witness_nonce":7});
        assert!(Request::parse(json!({"operation":"capture","identity":identity})).is_ok());
        for (button, count) in [("left", 1), ("left", 2), ("right", 1)] {
            assert!(
                Request::parse(json!({"operation":"click","identity":identity,
                "geometry":geometry(),"x":1,"y":1,"button":button,"count":count}))
                .is_ok()
            );
        }
        for request in [
            json!({"operation":"capture","identity":identity,"x":0}),
            json!({"operation":"capture","identity":identity,"delivery_mode":"foreground"}),
            json!({"operation":"shell","identity":identity}),
            json!({"operation":"click","identity":identity,"geometry":geometry(),"x":1372,"y":0}),
            json!({"operation":"capture","identity":identity,"button":"left"}),
            json!({"operation":"click","identity":identity,"geometry":geometry(),"x":1,"y":1,"button":"middle"}),
            json!({"operation":"click","identity":identity,"geometry":geometry(),"x":1,"y":1,"button":"right","count":2}),
            json!({"operation":"click","identity":identity,"geometry":geometry(),"x":1,"y":1,"count":3}),
        ] {
            assert!(Request::parse(request).is_err());
        }
        let mut bad = identity;
        bad["witness_nonce"] = json!(0);
        assert!(Request::parse(json!({"operation":"capture","identity":bad})).is_err());
    }
}
