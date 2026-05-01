//! 跨平台凭据存储：Windows Credential Manager / macOS Keychain / Linux Secret Service。
//!
//! 仅做透传：调用方传 `service` + `account`，写一份字符串密文进系统钥匙串。
//! 失败时返回 `Error::Other`，前端按 Result 决策（不可用时降级 localStorage 明文 + UI 警告）。
//!
//! 注意：keyring 3.x 在 Linux 需要桌面环境提供 secret-service（gnome-keyring / kwallet）。
//! 无桌面 / headless 环境会报 NoBackend，由调用方处理降级。

use crate::error::{Error, Result};

const SERVICE: &str = "claudinal";

fn entry(account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, account).map_err(|e| Error::Other(format!("keyring entry: {e}")))
}

/// 写入 / 覆盖一条密钥条目。空字符串视作删除。
pub fn set(account: &str, secret: &str) -> Result<()> {
    if secret.is_empty() {
        return delete(account);
    }
    let e = entry(account)?;
    e.set_password(secret)
        .map_err(|err| Error::Other(format!("keyring set: {err}")))
}

/// 读取一条；不存在返回 `Ok(None)`，仅在后端真出错时返回 `Err`。
pub fn get(account: &str) -> Result<Option<String>> {
    let e = entry(account)?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(Error::Other(format!("keyring get: {err}"))),
    }
}

/// 删除条目；不存在视作成功（幂等）。
pub fn delete(account: &str) -> Result<()> {
    let e = entry(account)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(Error::Other(format!("keyring delete: {err}"))),
    }
}

/// 探测当前后端是否可用 —— 通过尝试读一个不存在的 account 来判断。
/// 不可用时（NoBackend / PlatformFailure）返回 `Ok(false)`，让前端切到降级路径。
pub fn is_available() -> bool {
    let probe = match keyring::Entry::new(SERVICE, "__claudinal_probe__") {
        Ok(e) => e,
        Err(_) => return false,
    };
    matches!(probe.get_password(), Ok(_) | Err(keyring::Error::NoEntry))
}
