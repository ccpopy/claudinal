//! Read-only OAuth usage requests. Credential rotation remains owned by Claude CLI.
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::error::{Error, Result};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1";
const CACHE_TTL: Duration = Duration::from_secs(5);
static CACHE: Mutex<Option<UsageCache>> = Mutex::const_new(None);
static CLIENT_IDENTITY: Mutex<Option<(String, Instant)>> = Mutex::const_new(None);

fn cli_user_agent(version: &str) -> Option<String> {
    let version = version.split_whitespace().next()?;
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some(format!("claude-cli/{version} (external, cli)"))
}

async fn user_agent() -> String {
    let mut cached = CLIENT_IDENTITY.lock().await;
    if let Some((value, checked_at)) = cached.as_ref() {
        if checked_at.elapsed() < Duration::from_secs(60) {
            return value.clone();
        }
    }
    // The reset block is gated on CLI surface/version. Use the actual selected
    // CLI version, never a pinned version that may differ from the installation.
    // Failure to probe must not prevent ordinary quota reads.
    let detected = tokio::time::timeout(Duration::from_secs(3), async {
        let path = crate::proc::spawn::find_claude().ok()?;
        let version = crate::commands::probe_claude_cli_version(&path, &Default::default())
            .await
            .ok()?;
        cli_user_agent(&version)
    })
    .await
    .ok()
    .flatten();
    let value = detected.unwrap_or_else(|| concat!("Claudinal/", env!("CARGO_PKG_VERSION")).into());
    *cached = Some((value.clone(), Instant::now()));
    value
}

struct UsageCache {
    token: String,
    data: Value,
    fetched_at: Instant,
}

fn credentials_path() -> Result<PathBuf> {
    let directory = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
        .ok_or_else(|| Error::Other("无法确定 Claude 配置目录".into()))?;
    Ok(directory.join(".credentials.json"))
}

pub fn read_access_token() -> Result<Option<String>> {
    if let Ok(token) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
        if !token.trim().is_empty() {
            return Ok(Some(token));
        }
    }
    let path = credentials_path()?;
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(Error::Other(
                "暂时无法读取 Claude 登录凭据，请稍后刷新".into(),
            ))
        }
    };
    let data: Value = serde_json::from_str(&raw)
        .map_err(|_| Error::Other("Claude 登录凭据正在更新或格式无效，请稍后刷新".into()))?;
    Ok(data
        .pointer("/claudeAiOauth/accessToken")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .map(str::to_owned))
}

fn required_token() -> Result<String> {
    read_access_token()?.ok_or_else(|| {
        #[cfg(target_os = "macos")]
        let message = "未找到可读取的 OAuth 凭据。macOS 钥匙串中的 CLI 凭据暂不支持读取，可前往 Claude 查看用量";
        #[cfg(not(target_os = "macos"))]
        let message = "未找到 Claude OAuth 登录凭据，请登录后刷新";
        Error::Other(message.into())
    })
}

fn status_error(status: reqwest::StatusCode) -> Error {
    let message = match status.as_u16() {
        401 => "用量服务暂未接受当前登录凭据，重试后仍未恢复。请稍后刷新；若持续失败，请重新登录 Claude",
        403 => "当前账号无权读取计划用量，可前往 Claude 查看",
        429 => "用量查询过于频繁，请稍后刷新",
        500..=599 => "Claude 用量服务暂时不可用，请稍后刷新",
        _ => "计划用量加载失败，请稍后刷新",
    };
    Error::Other(format!("{message}（HTTP {}）", status.as_u16()))
}

async fn request_usage(
    client: &reqwest::Client,
    url: &str,
    beta: &str,
    user_agent: &str,
    read_token: impl Fn() -> Result<String>,
    delays: [Duration; 2],
) -> Result<(String, Value)> {
    for attempt in 0..=2 {
        if attempt > 0 {
            tokio::time::sleep(delays[attempt - 1]).await;
        }
        // A live CLI can replace its bearer between this request and a 401.
        // Re-read on every attempt; never rotate or overwrite its refresh token.
        let token = read_token()?;
        let response = client
            .get(url)
            .bearer_auth(&token)
            .header("anthropic-beta", beta)
            .header("Accept", "application/json")
            .header("User-Agent", user_agent)
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(_) if attempt == 0 => continue,
            Err(_) => {
                return Err(Error::Other(
                    "无法连接 Claude 用量服务，请检查网络后刷新".into(),
                ))
            }
        };
        let status = response.status();
        if (status == reqwest::StatusCode::UNAUTHORIZED && attempt < 2)
            || (status.is_server_error() && attempt == 0)
        {
            continue;
        }
        // Check status before parsing: gateways can return HTML on a 401/5xx.
        // Do not expose upstream bodies, which may include credential details.
        if !status.is_success() {
            return Err(status_error(status));
        }
        let data: Value = response
            .json()
            .await
            .map_err(|_| Error::Other("用量服务返回了无法识别的数据，请稍后刷新".into()))?;
        if !data.is_object()
            || !["five_hour", "seven_day", "cedar_ember", "limits"]
                .iter()
                .any(|key| data.get(key).is_some())
        {
            return Err(Error::Other(
                "用量服务未返回有效的计划用量，请稍后刷新".into(),
            ));
        }
        return Ok((token, data));
    }
    unreachable!("each final attempt returns a result")
}

pub async fn fetch() -> Result<Value> {
    // Collapse simultaneous requests from Settings and the composer. Only
    // successful results are cached, and only for the same current credential.
    let mut cache = CACHE.lock().await;
    let token = required_token()?;
    if let Some(cached) = cache.as_ref() {
        if cached.token == token && cached.fetched_at.elapsed() < CACHE_TTL {
            return Ok(cached.data.clone());
        }
    }
    *cache = None;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::Other("无法初始化用量查询连接".into()))?;
    let beta = std::env::var("ANTHROPIC_OAUTH_BETA").unwrap_or_else(|_| "oauth-2025-04-20".into());
    let (token, data) = request_usage(
        &client,
        USAGE_URL,
        &beta,
        &user_agent().await,
        required_token,
        [Duration::from_millis(400), Duration::from_millis(1200)],
    )
    .await?;
    // An account switch while the request was in flight must not cache old data.
    if required_token()? != token {
        return Err(Error::Other("登录凭据已更新，请刷新计划用量".into()));
    }
    *cache = Some(UsageCache {
        token,
        data: data.clone(),
        fetched_at: Instant::now(),
    });
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const VALID: &str = r#"{"five_hour":{"utilization":17,"resets_at":null},"cedar_ember":{"eligible":true,"grants":[]}}"#;
    const AGENT: &str = "claude-cli/2.1.284 (external, cli)";

    #[test]
    fn client_identity_uses_only_a_valid_installed_version() {
        assert_eq!(
            cli_user_agent("2.1.284 (Claude Code)").as_deref(),
            Some(AGENT)
        );
        assert_eq!(
            cli_user_agent("2.1.63").as_deref(),
            Some("claude-cli/2.1.63 (external, cli)")
        );
        for invalid in ["", "error", "2.1", "2.1.bad", "2..3", "2.1.284-beta"] {
            assert!(cli_user_agent(invalid).is_none());
        }
    }

    async fn server(
        replies: Vec<(u16, &'static str)>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/usage?cedar_ember=1",
            listener.local_addr().unwrap()
        );
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, body) in replies {
                let (mut stream, _) =
                    tokio::time::timeout(Duration::from_secs(3), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut buffer = Vec::new();
                while !buffer.windows(4).any(|part| part == b"\r\n\r\n") {
                    let mut chunk = [0u8; 1024];
                    let size = stream.read(&mut chunk).await.unwrap();
                    assert!(size > 0);
                    buffer.extend_from_slice(&chunk[..size]);
                }
                requests.push(String::from_utf8(buffer).unwrap());
                let response = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        (url, task)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn retries_401_with_newly_read_bearer_even_if_error_body_is_html() {
        let (url, task) = server(vec![(401, "<html>expired</html>"), (200, VALID)]).await;
        let reads = AtomicUsize::new(0);
        let (token, data) = request_usage(
            &client(),
            &url,
            "test-beta",
            AGENT,
            || {
                Ok(if reads.fetch_add(1, Ordering::SeqCst) == 0 {
                    "old-bearer"
                } else {
                    "fresh-bearer"
                }
                .into())
            },
            [Duration::ZERO; 2],
        )
        .await
        .unwrap();
        let requests = task.await.unwrap();
        assert_eq!(token, "fresh-bearer");
        assert!(requests[0].contains("Bearer old-bearer"));
        assert!(requests[1].contains("Bearer fresh-bearer"));
        assert!(requests[1].contains("cedar_ember=1"));
        assert!(requests[1].contains(AGENT));
        assert_eq!(data["five_hour"]["utilization"], 17);
        assert_eq!(data["cedar_ember"]["eligible"], true);
    }

    #[tokio::test]
    async fn transient_401_recovers_without_requiring_a_token_change() {
        let (url, task) = server(vec![(401, "temporarily rejected"), (200, VALID)]).await;
        assert!(request_usage(
            &client(),
            &url,
            "test",
            AGENT,
            || Ok("same-bearer".into()),
            [Duration::ZERO; 2]
        )
        .await
        .is_ok());
        assert_eq!(task.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn persistent_401_is_bounded_and_does_not_expose_upstream_body() {
        let (url, task) = server(vec![(401, "sensitive upstream body"); 3]).await;
        let error = request_usage(
            &client(),
            &url,
            "test",
            AGENT,
            || Ok("fake-token".into()),
            [Duration::ZERO; 2],
        )
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(task.await.unwrap().len(), 3);
        assert!(error.contains("401"));
        assert!(!error.contains("sensitive") && !error.contains("fake-token"));
    }

    #[tokio::test]
    async fn forbidden_and_throttled_requests_are_not_retried() {
        for status in [403, 429] {
            let (url, task) = server(vec![(status, "not JSON")]).await;
            let reads = AtomicUsize::new(0);
            let error = request_usage(
                &client(),
                &url,
                "test",
                AGENT,
                || {
                    reads.fetch_add(1, Ordering::SeqCst);
                    Ok("fake-token".into())
                },
                [Duration::ZERO; 2],
            )
            .await
            .unwrap_err()
            .to_string();
            assert_eq!(reads.load(Ordering::SeqCst), 1);
            assert!(error.contains(&status.to_string()));
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn server_failure_retries_once() {
        let (url, task) = server(vec![(503, "unavailable"), (200, VALID)]).await;
        assert!(request_usage(
            &client(),
            &url,
            "test",
            AGENT,
            || Ok("fake-token".into()),
            [Duration::ZERO; 2]
        )
        .await
        .is_ok());
        assert_eq!(task.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn fieldless_success_cannot_replace_valid_usage_with_empty_data() {
        for body in ["{}", "[]", r#"{"error":"not authorized"}"#, "not JSON"] {
            let (url, task) = server(vec![(200, body)]).await;
            assert!(request_usage(
                &client(),
                &url,
                "test",
                AGENT,
                || Ok("fake-token".into()),
                [Duration::ZERO; 2]
            )
            .await
            .is_err());
            task.await.unwrap();
        }
    }
}
