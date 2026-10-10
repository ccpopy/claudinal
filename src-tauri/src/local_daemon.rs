//! Public CLI read adapter. Collection stays disabled until profile isolation is
//! independently established by the backend; task JSON cannot establish it.
use std::{path::Path, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt, process::Command};

use crate::{
    child_process::hide_tokio_window,
    error::{Error, Result},
    proc::ProcessTree,
};

const MAX_TASK_BYTES: usize = 512 * 1024;
const MAX_LOG_BYTES: usize = 128 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const MAX_TASKS: usize = 2000;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const ISOLATION_REASON: &str = "后台任务隔离尚未验证：公开任务列表不含 provider、凭据来源或 endpoint 指纹；CLAUDE_CONFIG_DIR 仅能区分 supervisor，不能证明凭据与设置继承隔离；Claudinal 临时代理也不能保证在应用退出后可用。当前禁止应用读取外部任务与日志，请在已确认配置的官方 CLI 中检查。";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDaemonStatus {
    enabled: bool,
    isolation: &'static str,
    reason: &'static str,
    official_tasks_command: &'static str,
    official_logs_command: &'static str,
    docs_url: &'static str,
}

#[tauri::command]
pub fn local_daemon_status() -> LocalDaemonStatus {
    LocalDaemonStatus {
        enabled: false,
        isolation: "unverified",
        reason: ISOLATION_REASON,
        official_tasks_command: "claude agents --json --all",
        official_logs_command: "claude logs <id>",
        docs_url: "https://code.claude.com/docs/en/agent-view#list-sessions-as-json",
    }
}

/// Intentionally has no caller-controlled enable flag, provider ID, or empty-
/// roster exception. A future implementation needs backend-owned verification
/// of credential/config/endpoint provenance before changing this function.
fn require_verified_profile() -> Result<()> {
    Err(Error::Other(ISOLATION_REASON.into()))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Interactive,
    Background,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Working,
    Blocked,
    Done,
    Failed,
    Stopped,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStatus {
    Busy,
    Waiting,
    Idle,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTask {
    cwd: String,
    kind: TaskKind,
    started_at: u64,
    id: Option<String>,
    state: Option<TaskState>,
    pid: Option<u32>,
    status: Option<ProcessStatus>,
    waiting_for: Option<String>,
    session_id: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDaemonTask {
    cwd: String,
    kind: TaskKind,
    started_at: u64,
    id: Option<String>,
    state: Option<TaskState>,
    pid: Option<u32>,
    status: Option<ProcessStatus>,
    waiting_for: Option<String>,
    session_id: Option<String>,
    name: Option<String>,
    source: &'static str,
}

fn schema_error() -> Error {
    Error::Other("官方 CLI 任务数据格式尚不受此版本支持".into())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn plain_field(value: Option<String>) -> Result<Option<String>> {
    value
        .map(|text| {
            if text.len() > 4096 {
                return Err(schema_error());
            }
            Ok(redact_log(&text))
        })
        .transpose()
}

fn parse_tasks(bytes: &[u8]) -> Result<Vec<LocalDaemonTask>> {
    if bytes.len() > MAX_TASK_BYTES {
        return Err(schema_error());
    }
    let tasks: Vec<RawTask> = serde_json::from_slice(bytes).map_err(|_| schema_error())?;
    if tasks.len() > MAX_TASKS {
        return Err(schema_error());
    }
    tasks
        .into_iter()
        .map(|task| {
            if task.cwd.is_empty()
                || task.cwd.len() > 4096
                || task.cwd.chars().any(char::is_control)
                || task.pid == Some(0)
                || task.id.as_deref().is_some_and(|id| !valid_id(id))
                || task.session_id.as_ref().is_some_and(|id| {
                    id.is_empty() || id.len() > 128 || id.chars().any(char::is_control)
                })
                || (task.kind == TaskKind::Background
                    && (task.id.is_none() || task.state.is_none()))
                || (task.kind == TaskKind::Interactive && task.state.is_some())
            {
                return Err(schema_error());
            }
            Ok(LocalDaemonTask {
                cwd: task.cwd,
                kind: task.kind,
                started_at: task.started_at,
                id: task.id,
                state: task.state,
                pid: task.pid,
                status: task.status,
                waiting_for: plain_field(task.waiting_for)?,
                session_id: task.session_id,
                name: plain_field(task.name)?,
                source: "official_cli_agents",
            })
        })
        .collect()
}

fn task_args(cwd: Option<&str>) -> Result<Vec<String>> {
    let mut args = vec!["agents".into(), "--json".into(), "--all".into()];
    if let Some(cwd) = cwd {
        if cwd.is_empty() || cwd.len() > 4096 || cwd.chars().any(char::is_control) {
            return Err(Error::Other("工作目录无效".into()));
        }
        args.extend(["--cwd".into(), cwd.into()]);
    }
    Ok(args)
}

fn log_args(id: &str) -> Result<Vec<String>> {
    if !valid_id(id) {
        return Err(Error::Other("后台任务 ID 无效".into()));
    }
    Ok(vec!["logs".into(), id.into()])
}

async fn read_limited(stream: impl tokio::io::AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stream
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(Error::Other("官方 CLI 只读输出超过上限".into()));
    }
    Ok(bytes)
}

/// Not invoked while isolation is unverified. Exact argument vectors only;
/// native executable required on Windows so arguments never cross a shell.
async fn bounded_read(executable: &Path, args: &[String], limit: usize) -> Result<Vec<u8>> {
    #[cfg(windows)]
    if !executable
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err(Error::Other(
            "后台只读适配器需要原生 Claude 可执行文件".into(),
        ));
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .kill_on_drop(true);
    for key in ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(unix)]
    command.process_group(0);
    hide_tokio_window(&mut command);
    capture_command(command, limit, READ_TIMEOUT).await
}

async fn capture_command(
    mut command: Command,
    limit: usize,
    read_timeout: Duration,
) -> Result<Vec<u8>> {
    let mut child = command.spawn()?;
    let tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
            return Err(error.into());
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Other("无法读取 CLI stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::Other("无法读取 CLI stderr".into()))?;
    let captured = tokio::time::timeout(read_timeout, async {
        tokio::try_join!(
            read_limited(stdout, limit),
            read_limited(stderr, MAX_STDERR_BYTES),
            async { child.wait().await.map_err(Error::from) }
        )
    })
    .await;
    // Closing the job/group precedes joining any inherited pipe readers.
    drop(tree);
    match captured {
        Ok(Ok((stdout, _stderr, status))) if status.success() => Ok(stdout),
        Ok(Ok((_stdout, _stderr, _status))) => {
            Err(Error::Other("官方 CLI 只读查询未成功完成".into()))
        }
        Ok(Err(error)) => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
            Err(error)
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
            Err(Error::Other("官方 CLI 只读查询超时".into()))
        }
    }
}

#[tauri::command]
pub async fn read_local_daemon_tasks(cwd: Option<String>) -> Result<Vec<LocalDaemonTask>> {
    require_verified_profile()?;
    let args = task_args(cwd.as_deref())?;
    let executable = crate::proc::spawn::find_claude()?;
    parse_tasks(&bounded_read(&executable, &args, MAX_TASK_BYTES).await?)
}

#[tauri::command]
pub async fn read_local_daemon_logs(id: String) -> Result<String> {
    require_verified_profile()?;
    let args = log_args(&id)?;
    let executable = crate::proc::spawn::find_claude()?;
    let bytes = bounded_read(&executable, &args, MAX_LOG_BYTES).await?;
    Ok(redact_log(&String::from_utf8_lossy(&bytes)))
}

fn strip_terminal_controls(input: &str) -> String {
    let mut out = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if !ch.is_control() || ch == '\n' || ch == '\t' {
            out.push(ch);
        }
    }
    out
}

fn redact_key_values(mut text: String) -> String {
    for key in [
        "anthropic_api_key",
        "anthropic_auth_token",
        "api_key",
        "apikey",
        "access_token",
        "auth_token",
        "authorization",
        "client_secret",
        "password",
        "token",
    ] {
        let mut offset = 0;
        loop {
            let lower = text.to_ascii_lowercase();
            let Some(found) = lower[offset..].find(key) else {
                break;
            };
            let start = offset + found + key.len();
            let tail = &text[start..];
            let separator = tail.trim_start_matches(['\"', '\'', ' ', '\t']);
            let Some(value) = separator.strip_prefix([':', '=']) else {
                offset = start;
                continue;
            };
            let value = value.trim_start_matches([' ', '\t']);
            let value_start = text.len() - value.len();
            let (quote, value) = match value.chars().next() {
                Some(q @ ('\"' | '\'')) => (Some(q), &value[1..]),
                _ => (None, value),
            };
            let data_start = text.len() - value.len();
            let search_start = if value.to_ascii_lowercase().starts_with("bearer ") {
                7
            } else {
                0
            };
            let length = search_start
                + value[search_start..]
                    .find(|ch: char| {
                        quote.map_or(
                            ch.is_whitespace() || matches!(ch, '&' | ',' | ';'),
                            |quote| ch == quote,
                        )
                    })
                    .unwrap_or(value.len() - search_start);
            if length == 0 {
                offset = value_start + 1;
                if offset >= text.len() {
                    break;
                }
                continue;
            }
            text.replace_range(data_start..data_start + length, "[REDACTED]");
            offset = data_start + "[REDACTED]".len();
            if offset >= text.len() {
                break;
            }
        }
    }
    text
}

fn redact_log(input: &str) -> String {
    let mut text = redact_key_values(strip_terminal_controls(input));
    for prefix in ["sk-ant-", "sk-"] {
        while let Some(start) = text.find(prefix) {
            let length = text[start..]
                .find(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_')
                .unwrap_or(text.len() - start);
            text.replace_range(start..start + length, "[REDACTED]");
        }
    }
    let mut offset = 0;
    while let Some(found) = text[offset..].find("://") {
        let start = offset + found + 3;
        let end = text[start..]
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '/' | '?' | '#'))
            .map_or(text.len(), |end| start + end);
        if let Some(at) = text[start..end].find('@') {
            text.replace_range(start..start + at, "[REDACTED]");
        }
        offset = start;
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documented_json_keeps_done_distinct_from_blocked_and_source_fixed() {
        let tasks = parse_tasks(br#"[{"cwd":"C:\\project","kind":"background","startedAt":1,"id":"ab12","state":"done","pid":12,"status":"idle","unknownFuture":true},{"cwd":"/project","kind":"interactive","startedAt":2,"sessionId":"session-a"}]"#).unwrap();
        assert_eq!(tasks[0].state, Some(TaskState::Done));
        assert_eq!(tasks[1].kind, TaskKind::Interactive);
        assert_eq!(tasks[0].source, "official_cli_agents");
        assert!(parse_tasks(b"[]").unwrap().is_empty());
        assert!(!local_daemon_status().enabled);
        assert!(require_verified_profile().is_err());
        for (raw, expected) in [
            ("working", TaskState::Working),
            ("blocked", TaskState::Blocked),
            ("failed", TaskState::Failed),
            ("stopped", TaskState::Stopped),
        ] {
            let json = format!(
                r#"[{{"cwd":"/project","kind":"background","startedAt":1,"id":"job1","state":"{raw}"}}]"#
            );
            assert_eq!(
                parse_tasks(json.as_bytes()).unwrap()[0].state,
                Some(expected)
            );
        }
    }

    #[test]
    fn unsupported_shapes_fail_without_exposing_raw_output() {
        for value in [
            r#"{}"#,
            r#"[{"cwd":"/p","kind":"daemon","startedAt":1}]"#,
            r#"[{"cwd":"/p","kind":"background","startedAt":1,"id":"x","state":"ready-secret"}]"#,
            r#"[{"cwd":"/p","kind":"background","startedAt":1}]"#,
            r#"[{"cwd":"","kind":"interactive","startedAt":1}]"#,
            r#"[{"cwd":"/p","kind":"interactive","startedAt":-1}]"#,
        ] {
            let error = parse_tasks(value.as_bytes()).unwrap_err().to_string();
            assert!(!error.contains("ready-secret"));
        }
        assert!(parse_tasks(&vec![b' '; MAX_TASK_BYTES + 1]).is_err());
    }

    #[test]
    fn public_read_commands_preserve_argument_boundaries() {
        assert_eq!(
            task_args(Some("C:\\folder with spaces")).unwrap(),
            [
                "agents",
                "--json",
                "--all",
                "--cwd",
                "C:\\folder with spaces"
            ]
        );
        assert_eq!(log_args("ab12").unwrap(), ["logs", "ab12"]);
        for id in ["-p", "../state", "id\nstop", "", "id && rm"] {
            assert!(log_args(id).is_err());
        }
        assert!(!task_args(None)
            .unwrap()
            .iter()
            .any(|arg| ["--bg", "-p", "attach", "stop", "rm", "respawn"].contains(&arg.as_str())));
    }

    #[test]
    fn logs_remain_inert_and_remove_terminal_controls_and_common_credentials() {
        let output = redact_log("\x1b[31m<script>alert(1)</script>\x1b[0m\nANTHROPIC_API_KEY=sk-ant-secret\nAuthorization: Bearer super-secret\nhttps://user:pass@example.test/path?token=private\n{\"api_key\":\"another-secret\"}\x1b]0;evil-title\x07");
        assert!(output.contains("<script>alert(1)</script>"));
        for secret in [
            "\x1b",
            "sk-ant-secret",
            "super-secret",
            "user:pass",
            "private",
            "another-secret",
            "evil-title",
        ] {
            assert!(!output.contains(secret), "{secret}");
        }
    }

    #[tokio::test]
    async fn backend_gate_precedes_validation_and_never_collects_an_empty_roster() {
        assert!(read_local_daemon_tasks(Some("invalid\npath".into()))
            .await
            .unwrap_err()
            .to_string()
            .contains("隔离尚未验证"));
        assert!(read_local_daemon_logs("--malicious".into())
            .await
            .unwrap_err()
            .to_string()
            .contains("隔离尚未验证"));
    }

    #[tokio::test]
    async fn output_bound_is_enforced_before_unbounded_allocation() {
        assert_eq!(read_limited(&b"1234"[..], 4).await.unwrap(), b"1234");
        assert!(read_limited(&b"12345"[..], 4).await.is_err());
    }

    #[test]
    fn fake_read_child() {
        let Ok(mode) = std::env::var("CLAUDINAL_FAKE_DAEMON_READ") else {
            return;
        };
        if mode == "hang" {
            std::thread::sleep(Duration::from_secs(20));
        } else {
            println!("{}", "x".repeat(4096));
        }
    }

    fn fake_command(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "local_daemon::tests::fake_read_child",
                "--nocapture",
            ])
            .env("CLAUDINAL_FAKE_DAEMON_READ", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        hide_tokio_window(&mut command);
        command
    }

    #[tokio::test]
    async fn real_fake_process_is_stopped_on_deadline_or_output_limit() {
        let started = std::time::Instant::now();
        let error = capture_command(fake_command("hang"), 512, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(3));
        let error = capture_command(fake_command("excess"), 512, Duration::from_secs(3))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("超过上限"));
    }
}
