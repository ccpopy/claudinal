use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::child_process::hide_std_window;
use crate::error::{Error, Result};

pub fn find_claude() -> Result<PathBuf> {
    for candidate in claude_lookup_candidates() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    which::which("claude").map_err(Error::from)
}

/// 所有用于查找 claude 的候选路径，按优先级排序：
/// 1. Claude 官方 native installer（`~/.local/bin/claude`）
/// 2. npm 全局安装（静态默认目录 + 动态 `npm config get prefix`）
/// 3. Windows 上常见的 nodejs/Program Files 目录
///
/// 这里把 npm 优先级放在 `which::which` 之前是关键：用户机器上若同时存在
/// winget/brew 装的旧 `claude` 在 PATH 中、又用 npm 装了新版，我们需要优先
/// 返回新版本，否则 install/update 后的版本号复查会被旧二进制覆盖。
pub(crate) fn claude_lookup_candidates() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();

    if let Ok(p) = std::env::var("CLAUDE_CLI_PATH") {
        push_unique_path(&mut paths, PathBuf::from(p));
    }

    if let Some(home) = dirs::home_dir() {
        for path in native_install_candidates(&home) {
            push_unique_path(&mut paths, path);
        }
        for path in user_local_npm_candidates(&home) {
            push_unique_path(&mut paths, path);
        }
    }

    #[cfg(target_os = "windows")]
    for path in windows_npm_static_candidates() {
        push_unique_path(&mut paths, path);
    }

    #[cfg(not(target_os = "windows"))]
    for path in unix_npm_static_candidates() {
        push_unique_path(&mut paths, path);
    }

    if let Some(prefix) = npm_global_prefix() {
        for path in claude_executables_under_prefix_bin(&prefix) {
            push_unique_path(&mut paths, path);
        }
    }

    if let Ok(which_paths) = which::which_all("claude") {
        for path in which_paths {
            push_unique_path(&mut paths, path);
        }
    }

    paths
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|seen| seen == &path) {
        paths.push(path);
    }
}

fn native_install_candidates(home: &Path) -> Vec<PathBuf> {
    let bin = home.join(".local").join("bin");
    claude_executables_in_dir(&bin)
}

fn user_local_npm_candidates(home: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    // 用户级别 npm prefix 的常见自定义位置
    for sub in [".npm-global", ".npm-packages"] {
        paths.extend(claude_executables_under_prefix_bin(&home.join(sub)));
    }
    #[cfg(not(target_os = "windows"))]
    paths.extend(claude_executables_in_dir(
        &home.join(".local").join("share").join("npm").join("bin"),
    ));
    paths
}

#[cfg(target_os = "windows")]
fn windows_npm_static_candidates() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(data_dir) = dirs::data_dir() {
        roots.push(data_dir.join("npm"));
    }
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(program_files) = std::env::var(key) {
            roots.push(PathBuf::from(program_files).join("nodejs"));
        }
    }

    roots
        .into_iter()
        .flat_map(|root| claude_executables_in_dir(&root))
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn unix_npm_static_candidates() -> Vec<PathBuf> {
    // 系统级 npm prefix 与 Homebrew 默认目录
    let bins = [
        "/usr/local/bin",
        "/usr/bin",
        "/opt/homebrew/bin",
        "/home/linuxbrew/.linuxbrew/bin",
    ];
    bins.iter()
        .flat_map(|bin| claude_executables_in_dir(Path::new(bin)))
        .collect()
}

fn claude_executables_under_prefix_bin(prefix: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        // Windows 上 npm 把 shim 直接放在 prefix 根目录（与 nodejs 安装时一致）
        let mut paths = claude_executables_in_dir(prefix);
        paths.extend(claude_executables_in_dir(&prefix.join("bin")));
        paths
    }
    #[cfg(not(target_os = "windows"))]
    {
        claude_executables_in_dir(&prefix.join("bin"))
    }
}

fn claude_executables_in_dir(dir: &Path) -> Vec<PathBuf> {
    if dir.as_os_str().is_empty() {
        return Vec::new();
    }
    #[cfg(target_os = "windows")]
    {
        ["claude.cmd", "claude.exe", "claude.ps1", "claude"]
            .iter()
            .map(|name| dir.join(name))
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![dir.join("claude")]
    }
}

/// 探测 `npm config get prefix`，结果用 OnceLock 缓存避免重复 spawn。
fn npm_global_prefix() -> Option<PathBuf> {
    static CACHED: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHED
        .get_or_init(|| match resolve_npm_prefix() {
            Some(prefix) if !prefix.as_os_str().is_empty() => Some(prefix),
            _ => None,
        })
        .clone()
}

fn resolve_npm_prefix() -> Option<PathBuf> {
    let mut cmd = npm_prefix_command()?;
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    hide_std_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let prefix = stdout.lines().next().map(str::trim)?.to_string();
    if prefix.is_empty() {
        return None;
    }
    Some(PathBuf::from(prefix))
}

#[cfg(target_os = "windows")]
fn npm_prefix_command() -> Option<std::process::Command> {
    // Windows 上 `npm` 是 npm.cmd，必须走 cmd.exe 才能被 std::process 直接调用
    use std::os::windows::process::CommandExt;

    let npm = which::which("npm.cmd")
        .or_else(|_| which::which("npm.exe"))
        .or_else(|_| which::which("npm"))
        .ok()?;
    let cmd_line = format!(
        "chcp 65001 >nul && \"{}\" config get prefix",
        npm.display().to_string().replace('"', "\"\"")
    );
    let mut cmd = std::process::Command::new("cmd.exe");
    cmd.arg("/D").arg("/C").raw_arg(cmd_line);
    Some(cmd)
}

#[cfg(not(target_os = "windows"))]
fn npm_prefix_command() -> Option<std::process::Command> {
    let npm = which::which("npm").ok()?;
    let mut cmd = std::process::Command::new(npm);
    cmd.args(["config", "get", "prefix"]);
    Some(cmd)
}
