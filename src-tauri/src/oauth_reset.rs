//! Claude saved-limit resets. Only explicit UI confirmation reaches the POST.
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::error::{Error, Result};
use crate::oauth_reset_ledger::{self as ledger, Owner, Reservation};

const API_ORIGIN: &str = "https://api.anthropic.com";
static RESET: Mutex<()> = Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetRequest {
    pub grant_id: String,
    pub request_id: String,
    pub expected_org_id: String,
    pub expected_email: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetOutcome {
    pub code: String,
    pub resets_left: Option<u64>,
    pub retry_at: Option<i64>,
}

impl ResetOutcome {
    pub(crate) fn new(code: &str) -> Self {
        Self {
            code: code.into(),
            resets_left: None,
            retry_at: None,
        }
    }

    pub(crate) fn retry(code: &str, at: i64) -> Self {
        Self {
            retry_at: Some(at),
            ..Self::new(code)
        }
    }
}

struct ResetClient {
    http: reqwest::Client,
    origin: String,
    agent: String,
    beta: String,
}

impl ResetClient {
    fn request(&self, method: reqwest::Method, path: &str, token: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.origin))
            .bearer_auth(token)
            .header("anthropic-beta", &self.beta)
            .header("User-Agent", &self.agent)
            .header("Accept", "application/json")
    }

    async fn get(&self, path: &str, token: &str) -> Result<Value> {
        let response = self
            .request(reqwest::Method::GET, path, token)
            .send()
            .await
            .map_err(|_| Error::Other("无法核对重置资格，本次未发送。请检查网络后重试".into()))?;
        if !response.status().is_success() {
            let message = match response.status().as_u16() {
                401 | 403 => "无法验证当前 Claude 登录，请刷新账号后重试",
                429 => "查询过于频繁，请稍后重试",
                _ => "无法核对重置资格，本次未发送。请稍后重试",
            };
            return Err(Error::Other(message.into()));
        }
        response
            .json()
            .await
            .map_err(|_| Error::Other("无法识别重置资格信息，本次未发送".into()))
    }

    async fn redeem(
        &self,
        token: &str,
        owner: &Owner,
        grant: &str,
        id: &str,
        now: i64,
    ) -> ResetOutcome {
        // Never retry a mutation automatically. An explicit retry reuses the
        // durable request ID, matching the Claude Code cedar_ember contract.
        let response = self
            .request(
                reqwest::Method::POST,
                &format!("/api/organizations/{}/reset_rate_limits", owner.org),
                token,
            )
            .timeout(Duration::from_secs(25))
            .json(&json!({ "program": "cedar_ember", "grant_id": grant, "request_id": id }))
            .send()
            .await;
        let unknown = || ResetOutcome::retry("unknown", now + 60);
        let Ok(response) = response else {
            return unknown();
        };
        match response.status().as_u16() {
            401 | 403 => return ResetOutcome::new("auth_error"),
            429 => return ResetOutcome::new("rate_limited"),
            _ if !response.status().is_success() => return unknown(),
            _ => {}
        }
        let Ok(body) = response.json::<Value>().await else {
            return unknown();
        };
        let Some(code) = body.get("result").and_then(Value::as_str) else {
            return unknown();
        };
        if ![
            "reset",
            "already_used",
            "not_limited",
            "cooldown",
            "ineligible",
            "unavailable",
        ]
        .contains(&code)
        {
            return unknown();
        }
        ResetOutcome {
            code: code.into(),
            resets_left: body.get("resets_left").and_then(Value::as_u64),
            retry_at: None,
        }
    }
}

fn valid_grant_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn identity(profile: &Value, request: &ResetRequest) -> Result<Owner> {
    let account = profile.pointer("/account/uuid").and_then(Value::as_str);
    let org = profile
        .pointer("/organization/uuid")
        .and_then(Value::as_str);
    let email = profile.pointer("/account/email").and_then(Value::as_str);
    let (Some(account), Some(org), Some(email)) = (account, org, email) else {
        return Err(Error::Other("无法确认 Claude 账号，请刷新后重试".into()));
    };
    if uuid::Uuid::parse_str(account).is_err()
        || uuid::Uuid::parse_str(org).is_err()
        || !org.eq_ignore_ascii_case(&request.expected_org_id)
        || !email
            .trim()
            .eq_ignore_ascii_case(request.expected_email.trim())
    {
        return Err(Error::Other(
            "Claude 登录账号已变化，请关闭确认框并刷新后重试".into(),
        ));
    }
    Ok(Owner {
        account: account.to_ascii_lowercase(),
        org: org.to_ascii_lowercase(),
    })
}

fn timestamp(value: Option<&Value>) -> std::result::Result<Option<i64>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => chrono::DateTime::parse_from_rfc3339(value)
            .map(|v| Some(v.timestamp()))
            .map_err(|_| ()),
        _ => Err(()),
    }
}

fn validate_grant(data: &Value, id: &str, now: i64) -> Result<()> {
    let unavailable = || Error::Other("该重置当前不可用或已被使用，请刷新用量后确认".into());
    let status = data.get("cedar_ember").ok_or_else(unavailable)?;
    if status.get("eligible").and_then(Value::as_bool) != Some(true) {
        return Err(unavailable());
    }
    let cooldown = timestamp(status.get("cooldown_until")).map_err(|_| unavailable())?;
    if cooldown.is_some_and(|at| at > now) {
        return Err(unavailable());
    }
    let grants = status
        .get("grants")
        .and_then(Value::as_array)
        .ok_or_else(unavailable)?;
    let mut matching = grants
        .iter()
        .filter(|g| g.get("id").and_then(Value::as_str) == Some(id));
    let grant = matching.next().ok_or_else(unavailable)?;
    if matching.next().is_some() {
        return Err(unavailable());
    }
    let left = grant
        .get("resets_left")
        .and_then(Value::as_u64)
        .ok_or_else(unavailable)?;
    let total = grant
        .get("resets_total")
        .and_then(Value::as_u64)
        .ok_or_else(unavailable)?;
    let starts = timestamp(grant.get("starts_at")).map_err(|_| unavailable())?;
    let ends = timestamp(grant.get("ends_at")).map_err(|_| unavailable())?;
    let requires_limit = grant
        .get("use_requires_limit")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if left == 0
        || left > total
        || grant.get("paused").and_then(Value::as_bool) != Some(false)
        || grant.get("usable_now").and_then(Value::as_bool) != Some(true)
        || starts.is_some_and(|at| at > now)
        || ends.is_some_and(|at| at <= now)
        || requires_limit && status.get("at_limit").and_then(Value::as_bool) != Some(true)
    {
        return Err(unavailable());
    }
    Ok(())
}

async fn consume_with(
    client: &ResetClient,
    path: &Path,
    request: &ResetRequest,
    read_token: impl Fn() -> Result<String>,
    clock: impl Fn() -> i64,
) -> Result<ResetOutcome> {
    if !valid_grant_id(&request.grant_id)
        || uuid::Uuid::parse_str(&request.request_id).is_err()
        || uuid::Uuid::parse_str(&request.expected_org_id).is_err()
        || request.expected_email.trim().is_empty()
    {
        return Err(Error::Other(
            "重置请求无效，请关闭确认框并刷新后重试".into(),
        ));
    }
    let token = read_token()?;
    let owner = identity(&client.get("/api/oauth/profile", &token).await?, request)?;
    let existing = ledger::has_operation(path, &owner, &request.grant_id, &request.request_id)?;
    let usage = if !existing {
        Some(
            client
                .get("/api/oauth/usage?cedar_ember=1&skip_spend=1", &token)
                .await?,
        )
    } else {
        None
    };
    // An unresolved retry must reach the same claim even if its first attempt
    // consumed the grant; a zero count must not be mistaken for a settled reply.
    if read_token()? != token {
        return Err(Error::Other(
            "登录凭据已更新，本次未发送。请刷新后重试".into(),
        ));
    }
    // Preflight requests may take seconds; check expiry and the retry window
    // against the time of submission, not when the confirmation was clicked.
    let now = clock();
    if let Some(usage) = usage {
        validate_grant(&usage, &request.grant_id, now)?;
    }
    let id = match ledger::reserve(
        path,
        &owner,
        &request.grant_id,
        &request.request_id,
        now,
        !existing,
    )? {
        Reservation::Send(id) => id,
        Reservation::Answer(outcome) => return Ok(outcome),
    };
    let outcome = client
        .redeem(&token, &owner, &request.grant_id, &id, now)
        .await;
    if outcome.code != "unknown" && ledger::settle(path, &id, &outcome).is_err() {
        // A successful network reply without durable settlement remains uncertain.
        return Ok(ResetOutcome::retry("unknown", now + 60));
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn consume_claude_usage_reset(request: ResetRequest) -> Result<ResetOutcome> {
    let _guard = RESET
        .try_lock()
        .map_err(|_| Error::Other("已有重置操作正在进行，请等待结果".into()))?;
    let client = ResetClient {
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Other("无法初始化重置连接".into()))?,
        origin: API_ORIGIN.into(),
        agent: crate::oauth_usage::user_agent().await,
        beta: std::env::var("ANTHROPIC_OAUTH_BETA").unwrap_or_else(|_| "oauth-2025-04-20".into()),
    };
    let path = crate::app_paths::claudinal_dir()?.join("claude-reset-operations.sqlite");
    let outcome = consume_with(
        &client,
        &path,
        &request,
        crate::oauth_usage::required_token,
        || chrono::Utc::now().timestamp(),
    )
    .await;
    // Wait for in-flight usage reads before clearing their cache, then let every
    // consumer refresh using the server's post-reset state.
    crate::oauth_usage::invalidate().await;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const ORG: &str = "11111111-1111-4111-8111-111111111111";
    const ACCOUNT: &str = "22222222-2222-4222-8222-222222222222";
    const NOW: i64 = 1_790_000_000;

    fn request() -> ResetRequest {
        ResetRequest {
            grant_id: "test-grant".into(),
            request_id: uuid::Uuid::new_v4().to_string(),
            expected_org_id: ORG.into(),
            expected_email: "person@example.test".into(),
        }
    }

    fn profile() -> String {
        json!({"account": {"uuid": ACCOUNT, "email": "person@example.test"}, "organization": {"uuid": ORG}}).to_string()
    }

    fn usage() -> Value {
        json!({"cedar_ember": {"eligible": true, "at_limit": false, "grants": [{
            "id": "test-grant", "resets_left": 1, "resets_total": 1,
            "paused": false, "usable_now": true, "use_requires_limit": false,
            "ends_at": "2099-01-01T00:00:00Z", "clears": ["five_hour", "seven_day"]
        }]}})
    }

    fn path() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("claudinal-reset-wire-{}", uuid::Uuid::new_v4()))
            .join("reset.sqlite")
    }

    async fn server(
        replies: Vec<(u16, String)>,
    ) -> (ResetClient, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, body) in replies {
                let (mut stream, _) =
                    tokio::time::timeout(Duration::from_secs(3), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let size = stream.read(&mut chunk).await.unwrap();
                    assert!(size > 0);
                    bytes.extend_from_slice(&chunk[..size]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                stream.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            requests
        });
        (
            ResetClient {
                http: reqwest::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap(),
                origin,
                agent: "claude-cli/2.1.284 (external, cli)".into(),
                beta: "oauth-2025-04-20".into(),
            },
            task,
        )
    }

    #[tokio::test]
    async fn sends_the_claude_contract_once_and_replays_success_without_another_post() {
        let (client, server) = server(vec![
            (200, profile()),
            (200, usage().to_string()),
            (
                200,
                r#"{"result":"reset","resets_left":0,"cleared":["five_hour","seven_day"]}"#.into(),
            ),
            (200, profile()),
        ])
        .await;
        let path = path();
        let request = request();
        for now in [NOW, NOW + 1] {
            let result = consume_with(
                &client,
                &path,
                &request,
                || Ok("fake-bearer".into()),
                || now,
            )
            .await
            .unwrap();
            assert_eq!(result.code, "reset");
            assert_eq!(result.resets_left, Some(0));
        }
        let requests = server.await.unwrap();
        assert_eq!(
            requests.iter().filter(|r| r.starts_with("POST ")).count(),
            1
        );
        assert!(
            requests[2].starts_with(&format!("POST /api/organizations/{ORG}/reset_rate_limits "))
        );
        assert!(requests[2].contains("Bearer fake-bearer"));
        assert!(requests[2].contains("claude-cli/2.1.284 (external, cli)"));
        let body: Value =
            serde_json::from_str(requests[2].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"program":"cedar_ember", "grant_id":"test-grant", "request_id":request.request_id})
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn refuses_unusable_expired_malformed_or_duplicate_grants() {
        let data = usage();
        validate_grant(&data, "test-grant", NOW).unwrap();
        for (field, value) in [
            ("paused", json!(true)),
            ("usable_now", json!(false)),
            ("resets_left", json!(0)),
            ("resets_total", json!(0)),
            ("use_requires_limit", json!(true)),
            ("ends_at", json!("2020-01-01T00:00:00Z")),
            ("starts_at", json!("2099-01-01T00:00:00Z")),
            ("ends_at", json!("invalid")),
        ] {
            let mut bad = data.clone();
            bad["cedar_ember"]["grants"][0][field] = value;
            assert!(validate_grant(&bad, "test-grant", NOW).is_err(), "{field}");
        }
        let mut duplicate = data.clone();
        duplicate["cedar_ember"]["grants"]
            .as_array_mut()
            .unwrap()
            .push(data["cedar_ember"]["grants"][0].clone());
        assert!(validate_grant(&duplicate, "test-grant", NOW).is_err());
        for (field, value) in [
            ("eligible", json!(false)),
            ("cooldown_until", json!("2099-01-01T00:00:00Z")),
        ] {
            let mut bad = data.clone();
            bad["cedar_ember"][field] = value;
            assert!(validate_grant(&bad, "test-grant", NOW).is_err());
        }
    }

    #[tokio::test]
    async fn rejected_preflight_and_rotated_credentials_never_send_a_mutation() {
        for changed_token in [false, true] {
            let mut usage = usage();
            if !changed_token {
                usage["cedar_ember"]["eligible"] = json!(false);
            }
            let (client, server) = server(vec![(200, profile()), (200, usage.to_string())]).await;
            let path = path();
            let reads = AtomicUsize::new(0);
            assert!(consume_with(
                &client,
                &path,
                &request(),
                || {
                    Ok(if reads.fetch_add(1, Ordering::SeqCst) == 0 {
                        "first"
                    } else {
                        "changed"
                    }
                    .into())
                },
                || NOW
            )
            .await
            .is_err());
            assert_eq!(server.await.unwrap().len(), 2);
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[tokio::test]
    async fn another_account_is_rejected_before_usage_or_reset() {
        let (client, server) = server(vec![(200, profile())]).await;
        let mut request = request();
        request.expected_email = "another@example.test".into();
        let result = consume_with(&client, &path(), &request, || Ok("fake".into()), || NOW).await;
        assert!(result.unwrap_err().to_string().contains("账号已变化"));
        assert_eq!(server.await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn uncertain_result_retries_only_on_explicit_call_and_uses_durable_id() {
        let (client, server) = server(vec![
            (200, profile()),
            (200, usage().to_string()),
            (503, "sensitive-body".into()),
            (200, profile()),
            (200, profile()),
            (200, r#"{"result":"reset","resets_left":0}"#.into()),
        ])
        .await;
        let path = path();
        let first = request();
        let a = consume_with(&client, &path, &first, || Ok("fake".into()), || NOW)
            .await
            .unwrap();
        assert_eq!(a.code, "unknown");
        let b = consume_with(&client, &path, &request(), || Ok("fake".into()), || NOW + 1)
            .await
            .unwrap();
        assert_eq!(b.code, "in_flight");
        let c = consume_with(
            &client,
            &path,
            &request(),
            || Ok("fake".into()),
            || NOW + 61,
        )
        .await
        .unwrap();
        assert_eq!(c.code, "reset");
        let requests = server.await.unwrap();
        let posts: Vec<_> = requests.iter().filter(|r| r.starts_with("POST ")).collect();
        assert_eq!(posts.len(), 2);
        for post in posts {
            assert!(post.contains(&first.request_id));
        }
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn expiry_is_checked_after_preflight_for_both_new_and_pending_operations() {
        for pending in [false, true] {
            let path = path();
            let request = request();
            let mut replies = vec![(200, profile())];
            if pending {
                let owner = identity(&serde_json::from_str(&profile()).unwrap(), &request).unwrap();
                ledger::reserve(
                    &path,
                    &owner,
                    &request.grant_id,
                    &request.request_id,
                    NOW,
                    true,
                )
                .unwrap();
            } else {
                let mut usage = usage();
                usage["cedar_ember"]["grants"][0]["ends_at"] =
                    json!(chrono::DateTime::from_timestamp(NOW + 600, 0)
                        .unwrap()
                        .to_rfc3339());
                replies.push((200, usage.to_string()));
            }
            let (client, server) = server(replies).await;
            let reads = AtomicUsize::new(0);
            let result = consume_with(
                &client,
                &path,
                &request,
                || {
                    reads.fetch_add(1, Ordering::SeqCst);
                    Ok("fake".into())
                },
                || {
                    assert_eq!(reads.load(Ordering::SeqCst), 2);
                    NOW + 601
                },
            )
            .await;
            if pending {
                assert_eq!(result.unwrap().code, "unknown_expired");
            } else {
                assert!(result.is_err());
            }
            let requests = server.await.unwrap();
            assert_eq!(requests.len(), if pending { 1 } else { 2 });
            assert!(requests.iter().all(|request| request.starts_with("GET ")));
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[tokio::test]
    async fn refusals_and_unknown_bodies_never_masquerade_as_success() {
        for (status, body, code) in [
            (401, "private-token", "auth_error"),
            (403, "private-token", "auth_error"),
            (429, "private-token", "rate_limited"),
            (200, "not JSON", "unknown"),
            (200, r#"{"result":"unexpected"}"#, "unknown"),
            (200, r#"{"result":"already_used"}"#, "already_used"),
        ] {
            let (client, server) = server(vec![
                (200, profile()),
                (200, usage().to_string()),
                (status, body.into()),
            ])
            .await;
            let path = path();
            let result = consume_with(&client, &path, &request(), || Ok("fake".into()), || NOW)
                .await
                .unwrap();
            assert_eq!(result.code, code);
            assert!(!serde_json::to_string(&result)
                .unwrap()
                .contains("private-token"));
            assert_eq!(server.await.unwrap().len(), 3);
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }
}
