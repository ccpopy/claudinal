//! Anthropic 账号登录管理：包装 `claude auth` 子命令。
//!
//! `auth status --json` / `auth logout` 都是非交互的，由本模块直接 spawn 等待结束。
//! `auth login` 优先隐藏启动，让 CLI 自己打开浏览器并等待 OAuth 回调；终端登录仅作为兜底能力保留。
//!
//! 已知 schema（2026-05-01 实测）：
//! ```json
//! {
//!   "loggedIn": true,
//!   "authMethod": "claude.ai",          // claude.ai / console / 第三方走 env 不进这里
//!   "apiProvider": "firstParty",        // firstParty / bedrock / vertex
//!   "email": "...",
//!   "orgId": "...",
//!   "orgName": "...",
//!   "subscriptionType": "max"           // free / pro / max / team
//! }
//! ```

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    #[serde(rename = "loggedIn")]
    pub logged_in: bool,
    #[serde(rename = "authMethod")]
    pub auth_method: Option<String>,
    #[serde(rename = "apiProvider")]
    pub api_provider: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default, rename = "orgId")]
    pub org_id: Option<String>,
    #[serde(default, rename = "orgName")]
    pub org_name: Option<String>,
    #[serde(default, rename = "subscriptionType")]
    pub subscription_type: Option<String>,
    /// 原始 JSON 兜底，UI 想展示新字段时不用动 Rust
    #[serde(default, skip_deserializing)]
    pub raw: Option<serde_json::Value>,
}

fn claude_path() -> Result<std::path::PathBuf> {
    crate::proc::spawn::find_claude()
}

pub struct AuthLoginState {
    child: Mutex<Option<Child>>,
}

impl AuthLoginState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    pub async fn start_hidden(&self, use_console: bool) -> Result<()> {
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                }
                Ok(None) => {
                    return Err(Error::Other("auth login already running".into()));
                }
                Err(e) => {
                    return Err(Error::Other(format!("auth login status: {e}")));
                }
            }
        }

        let path = claude_path()?;
        let mut cmd = Command::new(&path);
        cmd.arg("auth").arg("login");
        if use_console {
            cmd.arg("--console");
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd
            .spawn()
            .map_err(|e| Error::Other(format!("spawn auth login: {e}")))?;
        *guard = Some(child);
        Ok(())
    }

    pub async fn cancel(&self) -> Result<()> {
        let mut guard = self.child.lock().await;
        let Some(mut child) = guard.take() else {
            return Ok(());
        };
        match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) => {
                child
                    .start_kill()
                    .map_err(|e| Error::Other(format!("kill auth login: {e}")))?;
                let _ = child.wait().await;
                Ok(())
            }
            Err(e) => Err(Error::Other(format!("auth login status: {e}"))),
        }
    }
}

/// `claude auth status --json`，4s 超时。
pub async fn auth_status() -> Result<AuthStatus> {
    let path = claude_path()?;
    let mut cmd = Command::new(&path);
    cmd.arg("auth")
        .arg("status")
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        // 防止 Windows 上 spawn 闪一下 conhost 黑窗
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::Other(format!("spawn auth status: {e}")))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Other("no stdout".into()))?;
    let mut buf = Vec::new();
    let read = async { stdout.read_to_end(&mut buf).await };
    timeout(Duration::from_secs(4), read)
        .await
        .map_err(|_| Error::Other("auth status timed out".into()))?
        .map_err(|e| Error::Other(format!("read stdout: {e}")))?;
    let _ = child.wait().await;
    let raw: serde_json::Value =
        serde_json::from_slice(&buf).map_err(|e| Error::Other(format!("parse json: {e}")))?;
    let mut parsed: AuthStatus = serde_json::from_value(raw.clone())
        .map_err(|e| Error::Other(format!("decode AuthStatus: {e}")))?;
    parsed.raw = Some(raw);
    Ok(parsed)
}

/// `claude auth logout`，6s 超时。
pub async fn auth_logout() -> Result<String> {
    let path = claude_path()?;
    let mut cmd = Command::new(&path);
    cmd.arg("auth")
        .arg("logout")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd
        .spawn()
        .map_err(|e| Error::Other(format!("spawn auth logout: {e}")))?;
    let out = timeout(Duration::from_secs(6), child.wait_with_output())
        .await
        .map_err(|_| Error::Other("auth logout timed out".into()))?
        .map_err(|e| Error::Other(format!("wait: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        return Err(Error::Other(format!("auth logout failed: {stderr}")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 跨平台开一个独立终端窗口跑 `claude auth login [--console]`。
/// 不 wait，立即返回；命令结束后终端自动关闭。
pub fn open_login_terminal(use_console: bool) -> Result<()> {
    let path = claude_path()?;
    let exe = path.display().to_string();
    let extra = if use_console { " --console" } else { "" };

    #[cfg(target_os = "windows")]
    {
        // 优先 Windows Terminal，其次 cmd；用 /c 让登录命令结束后自动关闭窗口。
        let inner = format!("\"{exe}\" auth login{extra}");
        // 先试 wt.exe
        let wt_ok = std::process::Command::new("wt.exe")
            .arg("--")
            .arg("cmd")
            .arg("/c")
            .arg(&inner)
            .spawn()
            .is_ok();
        if !wt_ok {
            // 回退：start 新的 cmd 窗口
            std::process::Command::new("cmd")
                .args(["/c", "start", "", "cmd", "/c", &inner])
                .spawn()
                .map_err(|e| Error::Other(format!("open terminal: {e}")))?;
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        // AppleScript 让 Terminal.app 跑命令
        let script =
            format!("tell application \"Terminal\" to do script \"{exe} auth login{extra}; exit\"");
        std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| Error::Other(format!("open terminal: {e}")))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // 优先 x-terminal-emulator（Debian 系），其次 gnome-terminal / konsole / xterm
        let cmd_str = format!("{exe} auth login{extra}");
        let candidates: [&[&str]; 4] = [
            &["x-terminal-emulator", "-e", "sh", "-c", &cmd_str],
            &["gnome-terminal", "--", "sh", "-c", &cmd_str],
            &["konsole", "-e", "sh", "-c", &cmd_str],
            &["xterm", "-e", "sh", "-c", &cmd_str],
        ];
        for argv in candidates.iter() {
            if std::process::Command::new(argv[0])
                .args(&argv[1..])
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        return Err(Error::Other(
            "no terminal emulator found (tried x-terminal-emulator/gnome-terminal/konsole/xterm)"
                .into(),
        ));
    }
}
