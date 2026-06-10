use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::UnboundedSender;

use crate::error::{Error, Result};

#[derive(Clone, Debug)]
pub struct ProxyConfig {
    pub target_url: String,
    pub api_key: String,
    pub input_format: String,
    pub auth_field: String,
    pub use_full_url: bool,
    pub openai_reasoning_effort: String,
    pub network_proxy_url: String,
    pub network_no_proxy: String,
    pub main_model: String,
    pub haiku_model: String,
    pub sonnet_model: String,
    pub opus_model: String,
    pub available_models: Vec<String>,
    pub cch_seed: Option<u64>,
}

/// 上游状态事件：CLI 在 stream-json 模式下静默退避重试（无 stderr、无事件），
/// 本地代理是唯一能观测每次上游响应的位置，借此把 429/5xx/断连暴露给 GUI。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatusEvent {
    pub kind: String,
    pub status: Option<u16>,
    pub message: String,
    pub path: String,
    pub model: Option<String>,
}

#[derive(Clone)]
pub struct ProxyStatusReporter {
    tx: UnboundedSender<ProxyStatusEvent>,
    had_error: Arc<AtomicBool>,
}

impl ProxyStatusReporter {
    pub fn new(tx: UnboundedSender<ProxyStatusEvent>) -> Self {
        Self {
            tx,
            had_error: Arc::new(AtomicBool::new(false)),
        }
    }

    fn error(&self, event: ProxyStatusEvent) {
        self.had_error.store(true, Ordering::Relaxed);
        let _ = self.tx.send(event);
    }

    /// 出错后的首个成功响应发一次 recovered；连续成功不重复发。
    fn success(&self, path: &str) {
        if self.had_error.swap(false, Ordering::Relaxed) {
            let _ = self.tx.send(ProxyStatusEvent {
                kind: "recovered".into(),
                status: None,
                message: String::new(),
                path: path.to_string(),
                model: None,
            });
        }
    }
}

pub async fn start(config: ProxyConfig, reporter: Option<ProxyStatusReporter>) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let config = Arc::new(config);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let config = config.clone();
            let reporter = reporter.clone();
            tokio::spawn(async move {
                let _ = handle(stream, config, reporter).await;
            });
        }
    });
    Ok(format!("http://{addr}"))
}

async fn handle(
    mut stream: TcpStream,
    config: Arc<ProxyConfig>,
    reporter: Option<ProxyStatusReporter>,
) -> Result<()> {
    let mut buffer = Vec::with_capacity(16 * 1024);
    let header_end = loop {
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_header_end(&buffer) {
            break pos;
        }
        if buffer.len() > 1024 * 1024 {
            return Err(Error::Other("proxy request header too large".into()));
        }
    };

    let header_bytes = &buffer[..header_end];
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| Error::Other("proxy missing request line".into()))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| Error::Other("proxy missing method".into()))?;
    let path = parts
        .next()
        .ok_or_else(|| Error::Other("proxy missing path".into()))?;

    let mut content_length = 0usize;
    let mut content_type = String::new();
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name_trimmed = name.trim().to_string();
        let value_trimmed = value.trim().to_string();
        if name_trimmed.eq_ignore_ascii_case("content-length") {
            content_length = value_trimmed.parse::<usize>().unwrap_or(0);
        }
        if name_trimmed.eq_ignore_ascii_case("content-type") {
            content_type = value_trimmed.clone();
        }
        headers.push((name_trimmed, value_trimmed));
    }

    let body_start = header_end + 4;
    let mut body = buffer[body_start..].to_vec();
    while body.len() < content_length {
        let mut chunk = vec![0u8; content_length - body.len()];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }

    if method.eq_ignore_ascii_case("GET") && is_models_path(path) {
        let bytes = models_response(&config);
        write_response(
            &mut stream,
            200,
            vec![("Content-Type".into(), "application/json".into())],
            bytes,
        )
        .await?;
        return Ok(());
    }

    let openai_chat = config.input_format == "openai-chat-completions";
    let messages_path = is_messages_path(path);

    let json_request = content_type
        .to_ascii_lowercase()
        .contains("application/json");
    let mut request_model: Option<String> = None;
    if json_request {
        body = if openai_chat && messages_path {
            let (converted, model) = anthropic_to_openai_request(&body, &config)?;
            request_model = model;
            converted
        } else {
            let (rewritten, model) = rewrite_model(&body, &config)?;
            request_model = model;
            rewritten
        };
    }
    if config.cch_seed.is_some() && messages_path && !openai_chat && !json_request {
        return Err(Error::Other("proxy cch rewrite requires JSON body".into()));
    }
    if let Some(seed) = config.cch_seed.filter(|_| messages_path && !openai_chat) {
        body = rewrite_cch(&body, seed)?;
    }

    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| Error::Other(format!("proxy method: {e}")))?;
    let url = forward_url(&config.target_url, path, config.use_full_url, openai_chat)?;
    let client = http_client(&config, &url)?;
    let mut req = client.request(method, url);
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host"
                | "content-length"
                | "connection"
                | "authorization"
                | "x-api-key"
                | "accept-encoding"
        ) {
            continue;
        }
        req = req.header(name, value);
    }
    if openai_chat {
        let token = config
            .api_key
            .strip_prefix("Bearer ")
            .unwrap_or(config.api_key.as_str());
        req = req.bearer_auth(token);
    } else if config.auth_field == "ANTHROPIC_API_KEY" {
        req = req.header("x-api-key", config.api_key.as_str());
    } else {
        let token = config
            .api_key
            .strip_prefix("Bearer ")
            .unwrap_or(config.api_key.as_str());
        req = req.bearer_auth(token);
    }

    let event_path = path.split('?').next().unwrap_or(path).to_string();
    let resp = match req.body(body).send().await {
        Ok(resp) => resp,
        Err(e) => {
            if let Some(reporter) = &reporter {
                reporter.error(ProxyStatusEvent {
                    kind: "network-error".into(),
                    status: None,
                    message: format!("{e}"),
                    path: event_path,
                    model: request_model,
                });
            }
            return Err(Error::Other(format!("proxy request: {e}")));
        }
    };
    let status = resp.status();
    let upstream_content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let mut response_headers = Vec::new();
    for (name, value) in resp.headers() {
        let lower = name.as_str().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "content-length" | "transfer-encoding" | "connection" | "content-encoding"
        ) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            response_headers.push((name.as_str().to_string(), v.to_string()));
        }
    }

    if !status.is_success() {
        // 错误响应体很小，保持缓冲；同时上报给 GUI（CLI 此时在静默退避重试）。
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| Error::Other(format!("proxy response: {e}")))?;
        if let Some(reporter) = &reporter {
            reporter.error(ProxyStatusEvent {
                kind: "upstream-error".into(),
                status: Some(status.as_u16()),
                message: body_snippet(&bytes),
                path: event_path,
                model: request_model,
            });
        }
        write_response(
            &mut stream,
            status.as_u16(),
            response_headers,
            bytes.to_vec(),
        )
        .await?;
        return Ok(());
    }
    if let Some(reporter) = &reporter {
        reporter.success(&event_path);
    }

    if openai_chat && messages_path {
        // OpenAI → Anthropic 转换需要完整响应，保持缓冲（增量转换不在本任务范围）。
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| Error::Other(format!("proxy response: {e}")))?;
        let (response_headers, bytes) = convert_openai_response(&bytes, &upstream_content_type)
            .unwrap_or((response_headers, bytes.to_vec()));
        write_response(&mut stream, status.as_u16(), response_headers, bytes).await?;
        return Ok(());
    }

    stream_response(
        &mut stream,
        status.as_u16(),
        response_headers,
        resp,
        reporter.as_ref(),
        &event_path,
        request_model.as_deref(),
    )
    .await
}

/// Anthropic 直通：上游字节随到随写（SSE 增量可见）。
/// 用 chunked 编码承载完成语义（终止块 `0\r\n\r\n`），不依赖 EOF：
/// Windows 上并发 CreateProcess 会让 accepted socket 的关闭呈现为 RST 而非 FIN，
/// EOF 定界的响应会被客户端当作中断。
async fn stream_response(
    stream: &mut TcpStream,
    status: u16,
    response_headers: Vec<(String, String)>,
    mut resp: reqwest::Response,
    reporter: Option<&ProxyStatusReporter>,
    path: &str,
    model: Option<&str>,
) -> Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", status, reason_phrase(status));
    for (name, value) in response_headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("Transfer-Encoding: chunked\r\n");
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.flush().await?;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if chunk.is_empty() {
                    continue;
                }
                let frame_head = format!("{:x}\r\n", chunk.len());
                stream.write_all(frame_head.as_bytes()).await?;
                stream.write_all(&chunk).await?;
                stream.write_all(b"\r\n").await?;
                stream.flush().await?;
            }
            Ok(None) => {
                stream.write_all(b"0\r\n\r\n").await?;
                stream.flush().await?;
                return Ok(());
            }
            Err(e) => {
                // 响应头已发出，无法回写错误状态；不发终止块直接断开，
                // 让 CLI 把这轮当作传输中断并走自身重试。
                if let Some(reporter) = reporter {
                    reporter.error(ProxyStatusEvent {
                        kind: "network-error".into(),
                        status: None,
                        message: format!("response stream interrupted: {e}"),
                        path: path.to_string(),
                        model: model.map(str::to_string),
                    });
                }
                return Err(Error::Other(format!("proxy response stream: {e}")));
            }
        }
    }
}

fn body_snippet(bytes: &[u8]) -> String {
    const MAX_CHARS: usize = 400;
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    let mut out: String = trimmed.chars().take(MAX_CHARS).collect();
    if trimmed.chars().count() > MAX_CHARS {
        out.push('…');
    }
    out
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    response_headers: Vec<(String, String)>,
    bytes: Vec<u8>,
) -> Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", status, reason_phrase(status));
    for (name, value) in response_headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!("Content-Length: {}\r\n", bytes.len()));
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&bytes).await?;
    stream.flush().await?;
    Ok(())
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}

fn is_models_path(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    path == "/models" || path == "/v1/models"
}

fn is_messages_path(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    path == "/messages" || path == "/v1/messages"
}

fn models_response(config: &ProxyConfig) -> Vec<u8> {
    let mut ids = configured_models(config);
    ids.extend(config.available_models.iter().cloned());
    ids.sort();
    ids.dedup();
    let data: Vec<Value> = ids
        .into_iter()
        .map(|id| {
            serde_json::json!({
                "id": id,
                "type": "model",
                "display_name": id
            })
        })
        .collect();
    serde_json::json!({
        "object": "list",
        "data": data
    })
    .to_string()
    .into_bytes()
}

fn rewrite_model(body: &[u8], config: &ProxyConfig) -> Result<(Vec<u8>, Option<String>)> {
    let mut value = serde_json::from_slice::<Value>(body)
        .map_err(|e| Error::Other(format!("proxy json parse: {e}")))?;
    let obj = value
        .as_object_mut()
        .ok_or_else(|| Error::Other("proxy json body must be an object".into()))?;
    let source = obj.get("model").and_then(Value::as_str).unwrap_or_default();
    let target = mapped_model(source, config);
    let model = if target.is_empty() {
        None
    } else {
        obj.insert("model".into(), Value::String(target.clone()));
        Some(target)
    };
    let bytes = serde_json::to_vec(&value).map_err(Error::from)?;
    Ok((bytes, model))
}

fn rewrite_cch(body: &[u8], seed: u64) -> Result<Vec<u8>> {
    let mut value = serde_json::from_slice::<Value>(body)
        .map_err(|e| Error::Other(format!("proxy cch json parse: {e}")))?;
    replace_billing_header_cch(&mut value, "00000")?;
    let placeholder_body = serde_json::to_vec(&value).map_err(Error::from)?;
    let cch = format!("{:05x}", xxh64(&placeholder_body, seed) & 0x000f_ffff);
    replace_billing_header_cch(&mut value, &cch)?;
    serde_json::to_vec(&value).map_err(Error::from)
}

fn replace_billing_header_cch(value: &mut Value, cch: &str) -> Result<()> {
    let system = value
        .get_mut("system")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| Error::Other("proxy cch billing header not found".into()))?;
    let mut replaced = 0usize;
    for item in system {
        let Some(Value::String(text)) = item.get_mut("text") else {
            continue;
        };
        let Some(next) = replace_cch_segment(text, cch) else {
            continue;
        };
        *text = next;
        replaced += 1;
    }
    match replaced {
        1 => Ok(()),
        0 => Err(Error::Other("proxy cch billing header not found".into())),
        _ => Err(Error::Other("proxy cch billing header is ambiguous".into())),
    }
}

fn replace_cch_segment(text: &str, cch: &str) -> Option<String> {
    let header_start = text.find("x-anthropic-billing-header:")?;
    let cch_key_start = header_start + text[header_start..].find("cch=")?;
    let value_start = cch_key_start + "cch=".len();
    let value_end = text[value_start..]
        .find(';')
        .map(|offset| value_start + offset)?;
    if value_start == value_end {
        return None;
    }
    let mut out = String::with_capacity(text.len() + cch.len());
    out.push_str(&text[..value_start]);
    out.push_str(cch);
    out.push_str(&text[value_end..]);
    Some(out)
}

fn anthropic_to_openai_request(
    body: &[u8],
    config: &ProxyConfig,
) -> Result<(Vec<u8>, Option<String>)> {
    let value = serde_json::from_slice::<Value>(body)
        .map_err(|e| Error::Other(format!("proxy json parse: {e}")))?;
    let obj = value
        .as_object()
        .ok_or_else(|| Error::Other("proxy json body must be an object".into()))?;
    let mut out = Map::new();
    let source = obj.get("model").and_then(Value::as_str).unwrap_or_default();
    let model = mapped_model(source, config);
    let mapped = if model.is_empty() {
        None
    } else {
        out.insert("model".into(), Value::String(model.clone()));
        Some(model)
    };

    let mut messages = Vec::new();
    if let Some(system) = obj
        .get("system")
        .and_then(anthropic_content_to_text)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
    {
        messages.push(serde_json::json!({
            "role": "system",
            "content": system
        }));
    }
    if let Some(items) = obj.get("messages").and_then(Value::as_array) {
        for item in items {
            append_openai_messages(&mut messages, item)?;
        }
    }
    out.insert("messages".into(), Value::Array(messages));

    if let Some(tools) = obj.get("tools").and_then(Value::as_array) {
        let converted = tools
            .iter()
            .filter_map(openai_tool_from_anthropic_tool)
            .collect::<Vec<_>>();
        if !converted.is_empty() {
            out.insert("tools".into(), Value::Array(converted));
        }
    }
    if let Some(tool_choice) = obj.get("tool_choice").and_then(openai_tool_choice) {
        out.insert("tool_choice".into(), tool_choice);
    }
    if obj
        .get("tool_choice")
        .and_then(|value| value.get("disable_parallel_tool_use"))
        .and_then(Value::as_bool)
        .is_some_and(|disabled| disabled)
    {
        out.insert("parallel_tool_calls".into(), Value::Bool(false));
    }

    for key in [
        "temperature",
        "top_p",
        "presence_penalty",
        "frequency_penalty",
        "seed",
        "user",
        "n",
        "logit_bias",
        "stream",
    ] {
        if let Some(value) = obj.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(value) = obj
        .get("max_completion_tokens")
        .or_else(|| obj.get("max_tokens"))
    {
        out.insert("max_completion_tokens".into(), value.clone());
    }
    if let Some(value) = obj.get("stop").or_else(|| obj.get("stop_sequences")) {
        out.insert("stop".into(), value.clone());
    }
    if let Some(effort) = openai_reasoning_effort(&config.openai_reasoning_effort) {
        out.insert("reasoning_effort".into(), Value::String(effort));
    }
    if let Some(tier) = openai_service_tier(obj) {
        out.insert("service_tier".into(), Value::String(tier));
    }

    let bytes = serde_json::to_vec(&Value::Object(out)).map_err(Error::from)?;
    Ok((bytes, mapped))
}

fn append_openai_messages(out: &mut Vec<Value>, message: &Value) -> Result<()> {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("user");
    let content = message.get("content").unwrap_or(&Value::Null);
    match role {
        "assistant" => {
            let (text, tool_calls) = assistant_content_to_openai(content)?;
            let mut obj = Map::new();
            obj.insert("role".into(), Value::String("assistant".into()));
            if tool_calls.is_empty() || !text.trim().is_empty() {
                obj.insert("content".into(), Value::String(text));
            } else {
                obj.insert("content".into(), Value::Null);
            }
            if !tool_calls.is_empty() {
                obj.insert("tool_calls".into(), Value::Array(tool_calls));
            }
            out.push(Value::Object(obj));
        }
        "user" => append_user_openai_messages(out, content),
        "system" => {
            if let Some(text) = anthropic_content_to_text(content) {
                out.push(serde_json::json!({
                    "role": "system",
                    "content": text
                }));
            }
        }
        other => {
            if let Some(text) = anthropic_content_to_text(content) {
                out.push(serde_json::json!({
                    "role": other,
                    "content": text
                }));
            }
        }
    }
    Ok(())
}

fn append_user_openai_messages(out: &mut Vec<Value>, content: &Value) {
    let Some(blocks) = content.as_array() else {
        if let Some(text) = anthropic_content_to_text(content) {
            out.push(serde_json::json!({
                "role": "user",
                "content": text
            }));
        }
        return;
    };

    let mut text_parts = Vec::new();
    let flush_text = |out: &mut Vec<Value>, text_parts: &mut Vec<String>| {
        let text = join_nonempty(text_parts);
        text_parts.clear();
        if !text.is_empty() {
            out.push(serde_json::json!({
                "role": "user",
                "content": text
            }));
        }
    };

    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
            flush_text(out, &mut text_parts);
            let tool_call_id = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let content = block
                .get("content")
                .and_then(anthropic_content_to_text)
                .unwrap_or_default();
            if !tool_call_id.is_empty() {
                out.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": content
                }));
            }
            continue;
        }
        if let Some(text) = anthropic_content_to_text(block) {
            text_parts.push(text);
        }
    }
    flush_text(out, &mut text_parts);
}

fn assistant_content_to_openai(content: &Value) -> Result<(String, Vec<Value>)> {
    let Some(blocks) = content.as_array() else {
        return Ok((
            anthropic_content_to_text(content).unwrap_or_default(),
            Vec::new(),
        ));
    };
    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("tool_use") => {
                let id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if id.is_empty() || name.is_empty() {
                    continue;
                }
                let input = block
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new()));
                let arguments = serde_json::to_string(&input)?;
                tool_calls.push(serde_json::json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": arguments
                    }
                }));
            }
            _ => {
                if let Some(text) = anthropic_content_to_text(block) {
                    text_parts.push(text);
                }
            }
        }
    }
    Ok((join_nonempty(&text_parts), tool_calls))
}

fn anthropic_content_to_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if let Some(blocks) = content.as_array() {
        let mut parts = Vec::new();
        for block in blocks {
            if let Some(text) = anthropic_content_to_text(block) {
                parts.push(text);
            }
        }
        return Some(join_nonempty(&parts));
    }
    let obj = content.as_object()?;
    match obj.get("type").and_then(Value::as_str) {
        Some("text") => obj.get("text").and_then(Value::as_str).map(str::to_string),
        Some("tool_result") => obj.get("content").and_then(anthropic_content_to_text),
        Some("thinking") => obj
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn join_nonempty(parts: &[String]) -> String {
    parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn openai_tool_from_anthropic_tool(tool: &Value) -> Option<Value> {
    let name = tool.get("name").and_then(Value::as_str)?;
    let mut function = Map::new();
    function.insert("name".into(), Value::String(name.to_string()));
    if let Some(description) = tool.get("description").and_then(Value::as_str) {
        function.insert("description".into(), Value::String(description.to_string()));
    }
    function.insert(
        "parameters".into(),
        openai_tool_parameters_from_anthropic_tool(name, tool),
    );
    Some(serde_json::json!({
        "type": "function",
        "function": Value::Object(function)
    }))
}

fn openai_tool_parameters_from_anthropic_tool(name: &str, tool: &Value) -> Value {
    let mut schema = tool
        .get("input_schema")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} }));
    tighten_known_openai_tool_schema(name, &mut schema);
    schema
}

fn tighten_known_openai_tool_schema(name: &str, schema: &mut Value) {
    if name != "Read" {
        return;
    }
    let Some(pages) = schema
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .and_then(|properties| properties.get_mut("pages"))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    pages
        .entry("minLength")
        .or_insert_with(|| Value::Number(1.into()));
    pages
        .entry("pattern")
        .or_insert_with(|| Value::String(r"^[1-9][0-9]*(?:-[1-9][0-9]*)?$".into()));
}

fn openai_tool_choice(choice: &Value) -> Option<Value> {
    if let Some(raw) = choice.as_str() {
        return match raw {
            "auto" | "none" | "required" => Some(Value::String(raw.to_string())),
            _ => None,
        };
    }
    let obj = choice.as_object()?;
    match obj.get("type").and_then(Value::as_str)? {
        "auto" => Some(Value::String("auto".into())),
        "none" => Some(Value::String("none".into())),
        "any" => Some(Value::String("required".into())),
        "tool" => {
            let name = obj.get("name").and_then(Value::as_str)?;
            Some(serde_json::json!({
                "type": "function",
                "function": { "name": name }
            }))
        }
        _ => None,
    }
}

fn openai_reasoning_effort(effort: &str) -> Option<String> {
    match effort.trim().to_ascii_lowercase().as_str() {
        "none" => Some("none".into()),
        "minimal" => Some("minimal".into()),
        "low" => Some("low".into()),
        "medium" => Some("medium".into()),
        "high" => Some("high".into()),
        "xhigh" | "extra_high" | "extra-high" | "max" | "maximum" => Some("xhigh".into()),
        _ => None,
    }
}

fn openai_service_tier(obj: &Map<String, Value>) -> Option<String> {
    let raw = obj
        .get("service_tier")
        .or_else(|| obj.get("speed"))
        .and_then(Value::as_str)?
        .trim()
        .to_ascii_lowercase();
    match raw.as_str() {
        "auto" | "default" | "flex" | "priority" => Some(raw),
        "fast" => Some("priority".into()),
        "standard" => Some("default".into()),
        _ => None,
    }
}

fn convert_openai_response(
    bytes: &[u8],
    content_type: &str,
) -> Option<(Vec<(String, String)>, Vec<u8>)> {
    let text = String::from_utf8_lossy(bytes);
    if content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
        || text.trim_start().starts_with("data:")
    {
        let body = openai_stream_to_anthropic_sse(bytes).ok()?;
        return Some((
            vec![("Content-Type".into(), "text/event-stream".into())],
            body,
        ));
    }
    let value = serde_json::from_slice::<Value>(bytes).ok()?;
    let body = serde_json::to_vec(&openai_json_to_anthropic_message(&value)).ok()?;
    Some((
        vec![("Content-Type".into(), "application/json".into())],
        body,
    ))
}

fn openai_json_to_anthropic_message(value: &Value) -> Value {
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let message = choice
        .get("message")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let mut content = Vec::new();
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        if !text.is_empty() {
            content.push(serde_json::json!({ "type": "text", "text": text }));
        }
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for tool_call in tool_calls {
            if let Some(block) = anthropic_tool_use_from_openai_tool_call(tool_call) {
                content.push(block);
            }
        }
    }
    serde_json::json!({
        "id": value.get("id").and_then(Value::as_str).unwrap_or("msg_claudinal_openai"),
        "type": "message",
        "role": "assistant",
        "model": value.get("model").and_then(Value::as_str).unwrap_or_default(),
        "content": content,
        "stop_reason": anthropic_stop_reason(choice.get("finish_reason").and_then(Value::as_str)),
        "stop_sequence": null,
        "usage": anthropic_usage(value.get("usage"))
    })
}

fn anthropic_tool_use_from_openai_tool_call(tool_call: &Value) -> Option<Value> {
    let id = tool_call.get("id").and_then(Value::as_str)?;
    let function = tool_call.get("function")?;
    let name = function.get("name").and_then(Value::as_str)?;
    let arguments = function
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let input =
        serde_json::from_str::<Value>(arguments).unwrap_or_else(|_| Value::Object(Map::new()));
    let input = normalize_anthropic_tool_input(name, input);
    Some(serde_json::json!({
        "type": "tool_use",
        "id": id,
        "name": name,
        "input": input
    }))
}

fn normalize_anthropic_tool_input(name: &str, mut input: Value) -> Value {
    if name != "Read" {
        return input;
    }
    // OpenAI-compatible providers sometimes serialize an omitted optional page range
    // as an invalid string such as "" or "/". Claude Code rejects these before
    // the Read tool runs, and they cannot represent a real 1-indexed page range.
    if let Some(obj) = input.as_object_mut() {
        if obj
            .get("pages")
            .and_then(Value::as_str)
            .is_some_and(|pages| !is_valid_read_pages(pages))
        {
            obj.remove("pages");
        }
    }
    input
}

fn is_valid_read_pages(pages: &str) -> bool {
    let trimmed = pages.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Some((start, end)) = trimmed.split_once('-') else {
        return parse_positive_page(trimmed).is_some();
    };
    let Some(start) = parse_positive_page(start) else {
        return false;
    };
    let Some(end) = parse_positive_page(end) else {
        return false;
    };
    start <= end
}

fn parse_positive_page(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let page = trimmed.parse::<u64>().ok()?;
    (page > 0).then_some(page)
}

fn anthropic_stop_reason(reason: Option<&str>) -> Value {
    let mapped = match reason {
        Some("tool_calls") => "tool_use",
        Some("length") => "max_tokens",
        Some("stop") | None => "end_turn",
        Some("content_filter") => "end_turn",
        Some(_) => "end_turn",
    };
    Value::String(mapped.into())
}

fn anthropic_usage(usage: Option<&Value>) -> Value {
    serde_json::json!({
        "input_tokens": usage
            .and_then(|value| value.get("prompt_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        "output_tokens": usage
            .and_then(|value| value.get("completion_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    })
}

#[derive(Default)]
struct StreamToolCall {
    block_index: usize,
    id: String,
    name: String,
    started: bool,
}

fn openai_stream_to_anthropic_sse(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut events = Vec::new();
    let mut message_started = false;
    let mut text_block: Option<usize> = None;
    let mut next_block_index = 0usize;
    let mut tool_calls: BTreeMap<usize, StreamToolCall> = BTreeMap::new();
    let mut id = "msg_claudinal_openai".to_string();
    let mut model = String::new();
    let mut usage = anthropic_usage(None);
    let mut stop_reason: Option<Value> = None;

    for data in sse_data_items(bytes) {
        if data.trim() == "[DONE]" {
            break;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if let Some(chunk_id) = chunk.get("id").and_then(Value::as_str) {
            id = chunk_id.to_string();
        }
        if let Some(chunk_model) = chunk.get("model").and_then(Value::as_str) {
            model = chunk_model.to_string();
        }
        if chunk.get("usage").is_some() {
            usage = anthropic_usage(chunk.get("usage"));
        }
        let choices = chunk
            .get("choices")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if choices.is_empty() {
            continue;
        }
        ensure_stream_message_start(&mut events, &mut message_started, &id, &model)?;
        for choice in choices {
            let delta = choice
                .get("delta")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                if !text.is_empty() {
                    let index = match text_block {
                        Some(index) => index,
                        None => {
                            let index = next_block_index;
                            next_block_index += 1;
                            push_sse_event(
                                &mut events,
                                "content_block_start",
                                serde_json::json!({
                                    "type": "content_block_start",
                                    "index": index,
                                    "content_block": { "type": "text", "text": "" }
                                }),
                            )?;
                            text_block = Some(index);
                            index
                        }
                    };
                    push_sse_event(
                        &mut events,
                        "content_block_delta",
                        serde_json::json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "text_delta", "text": text }
                        }),
                    )?;
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                if let Some(index) = text_block.take() {
                    push_sse_event(
                        &mut events,
                        "content_block_stop",
                        serde_json::json!({ "type": "content_block_stop", "index": index }),
                    )?;
                }
                for (fallback_index, call) in calls.iter().enumerate() {
                    let tool_index = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|index| index as usize)
                        .unwrap_or(fallback_index);
                    let state = tool_calls.entry(tool_index).or_insert_with(|| {
                        let block_index = next_block_index;
                        next_block_index += 1;
                        StreamToolCall {
                            block_index,
                            ..Default::default()
                        }
                    });
                    if let Some(call_id) = call.get("id").and_then(Value::as_str) {
                        state.id = call_id.to_string();
                    }
                    if let Some(function) = call.get("function") {
                        if let Some(name) = function.get("name").and_then(Value::as_str) {
                            state.name = name.to_string();
                        }
                        if !state.started && !state.id.is_empty() && !state.name.is_empty() {
                            state.started = true;
                            push_sse_event(
                                &mut events,
                                "content_block_start",
                                serde_json::json!({
                                    "type": "content_block_start",
                                    "index": state.block_index,
                                    "content_block": {
                                        "type": "tool_use",
                                        "id": state.id,
                                        "name": state.name,
                                        "input": {}
                                    }
                                }),
                            )?;
                        }
                        if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                            if state.started && !arguments.is_empty() {
                                push_sse_event(
                                    &mut events,
                                    "content_block_delta",
                                    serde_json::json!({
                                        "type": "content_block_delta",
                                        "index": state.block_index,
                                        "delta": {
                                            "type": "input_json_delta",
                                            "partial_json": arguments
                                        }
                                    }),
                                )?;
                            }
                        }
                    }
                }
            }
            if choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .is_some()
            {
                stop_reason = Some(anthropic_stop_reason(
                    choice.get("finish_reason").and_then(Value::as_str),
                ));
            }
        }
    }

    ensure_stream_message_start(&mut events, &mut message_started, &id, &model)?;
    if let Some(index) = text_block.take() {
        push_sse_event(
            &mut events,
            "content_block_stop",
            serde_json::json!({ "type": "content_block_stop", "index": index }),
        )?;
    }
    for state in tool_calls.values() {
        if state.started {
            push_sse_event(
                &mut events,
                "content_block_stop",
                serde_json::json!({ "type": "content_block_stop", "index": state.block_index }),
            )?;
        }
    }
    push_sse_event(
        &mut events,
        "message_delta",
        serde_json::json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": stop_reason.unwrap_or_else(|| Value::String("end_turn".into())),
                "stop_sequence": null
            },
            "usage": usage
        }),
    )?;
    push_sse_event(
        &mut events,
        "message_stop",
        serde_json::json!({ "type": "message_stop" }),
    )?;
    Ok(events.concat().into_bytes())
}

fn ensure_stream_message_start(
    events: &mut Vec<String>,
    started: &mut bool,
    id: &str,
    model: &str,
) -> Result<()> {
    if *started {
        return Ok(());
    }
    *started = true;
    push_sse_event(
        events,
        "message_start",
        serde_json::json!({
            "type": "message_start",
            "message": {
                "id": id,
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": null,
                "stop_sequence": null,
                "usage": { "input_tokens": 0, "output_tokens": 0 }
            }
        }),
    )
}

fn push_sse_event(events: &mut Vec<String>, event: &str, data: Value) -> Result<()> {
    let data = serde_json::to_string(&data)?;
    events.push(format!("event: {event}\ndata: {data}\n\n"));
    Ok(())
}

fn sse_data_items(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut out = Vec::new();
    let mut current = Vec::new();
    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            if !current.is_empty() {
                out.push(current.join("\n"));
                current.clear();
            }
            continue;
        }
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        current.push(rest.trim_start().to_string());
    }
    if !current.is_empty() {
        out.push(current.join("\n"));
    }
    out
}

fn mapped_model(source: &str, config: &ProxyConfig) -> String {
    let source = source.trim();
    if source.is_empty() {
        return config.main_model.trim().to_string();
    }
    if configured_models(config)
        .iter()
        .any(|model| model.as_str() == source)
    {
        return source.to_string();
    }
    if !looks_like_claude_model(source) {
        return source.to_string();
    }
    let source_lower = source.to_ascii_lowercase();
    if source_lower.contains("haiku") && !config.haiku_model.trim().is_empty() {
        return config.haiku_model.trim().to_string();
    }
    if source_lower.contains("opus") && !config.opus_model.trim().is_empty() {
        return config.opus_model.trim().to_string();
    }
    if source_lower.contains("sonnet") && !config.sonnet_model.trim().is_empty() {
        return config.sonnet_model.trim().to_string();
    }
    source.to_string()
}

fn configured_models(config: &ProxyConfig) -> Vec<String> {
    [
        config.main_model.as_str(),
        config.haiku_model.as_str(),
        config.sonnet_model.as_str(),
        config.opus_model.as_str(),
    ]
    .into_iter()
    .map(str::trim)
    .filter(|model| !model.is_empty())
    .map(str::to_string)
    .collect()
}

fn looks_like_claude_model(model: &str) -> bool {
    matches!(
        model,
        "default" | "best" | "sonnet" | "opus" | "haiku" | "opusplan" | "sonnet[1m]" | "opus[1m]"
    ) || model.starts_with("claude-")
        || model.starts_with("anthropic.")
}

fn forward_url(
    target_url: &str,
    incoming_path: &str,
    use_full_url: bool,
    openai_chat: bool,
) -> Result<String> {
    let target = target_url.trim().trim_end_matches('/');
    if target.is_empty() {
        return Err(Error::Other("proxy target url required".into()));
    }
    let lower = target.to_ascii_lowercase();
    if use_full_url && (lower.ends_with("/messages") || lower.ends_with("/chat/completions")) {
        return Ok(target.to_string());
    }
    if openai_chat && is_messages_path(incoming_path) {
        if lower.ends_with("/v1") {
            return Ok(format!("{target}/chat/completions"));
        }
        return Ok(format!("{target}/v1/chat/completions"));
    }
    let mut path = incoming_path;
    if target.ends_with("/v1") && path.starts_with("/v1/") {
        path = &path[3..];
    }
    Ok(format!("{target}{path}"))
}

fn http_client(config: &ProxyConfig, request_url: &str) -> Result<reqwest::Client> {
    // 不用总超时：流式响应整轮可超过任意固定上限，会被中途掐断。
    // connect 上限 + 块间空闲（read）上限既放行长流，又能让挂死连接失败。
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(300));
    let proxy_url = config.network_proxy_url.trim();
    if !proxy_url.is_empty() && !matches_no_proxy(request_url, &config.network_no_proxy) {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|e| Error::Other(format!("proxy network url: {e}")))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|e| Error::Other(format!("proxy http client: {e}")))
}

fn matches_no_proxy(request_url: &str, no_proxy: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(request_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .trim_matches(|ch| ch == '[' || ch == ']')
        .to_ascii_lowercase();
    no_proxy
        .split(',')
        .map(str::trim)
        .filter(|rule| !rule.is_empty())
        .any(|rule| host_matches_no_proxy_rule(&host, rule))
}

fn host_matches_no_proxy_rule(host: &str, rule: &str) -> bool {
    let raw = rule.trim_matches(|ch| ch == '[' || ch == ']').trim();
    let rule = if raw.matches(':').count() == 1
        && raw
            .rsplit_once(':')
            .is_some_and(|(_, port)| port.chars().all(|ch| ch.is_ascii_digit()))
    {
        raw.rsplit_once(':').map(|(host, _)| host).unwrap_or(raw)
    } else {
        raw
    }
    .to_ascii_lowercase();
    if rule == "*" {
        return true;
    }
    if let Some(domain) = rule.strip_prefix("*.") {
        return host == domain || host.ends_with(&format!(".{domain}"));
    }
    if let Some(domain) = rule.strip_prefix('.') {
        return host == domain || host.ends_with(&format!(".{domain}"));
    }
    host == rule || host.ends_with(&format!(".{rule}"))
}

const XXH64_PRIME1: u64 = 11_400_714_785_074_694_791;
const XXH64_PRIME2: u64 = 14_029_467_366_897_019_727;
const XXH64_PRIME3: u64 = 1_609_587_929_392_839_161;
const XXH64_PRIME4: u64 = 9_650_029_242_287_828_579;
const XXH64_PRIME5: u64 = 2_870_177_450_012_600_261;

fn xxh64(input: &[u8], seed: u64) -> u64 {
    let mut index = 0usize;
    let len = input.len();
    let mut hash = if len >= 32 {
        let mut v1 = seed.wrapping_add(XXH64_PRIME1).wrapping_add(XXH64_PRIME2);
        let mut v2 = seed.wrapping_add(XXH64_PRIME2);
        let mut v3 = seed;
        let mut v4 = seed.wrapping_sub(XXH64_PRIME1);
        while index <= len - 32 {
            v1 = xxh64_round(v1, read_u64_le(input, index));
            index += 8;
            v2 = xxh64_round(v2, read_u64_le(input, index));
            index += 8;
            v3 = xxh64_round(v3, read_u64_le(input, index));
            index += 8;
            v4 = xxh64_round(v4, read_u64_le(input, index));
            index += 8;
        }
        let mut h = v1
            .rotate_left(1)
            .wrapping_add(v2.rotate_left(7))
            .wrapping_add(v3.rotate_left(12))
            .wrapping_add(v4.rotate_left(18));
        h = xxh64_merge_round(h, v1);
        h = xxh64_merge_round(h, v2);
        h = xxh64_merge_round(h, v3);
        xxh64_merge_round(h, v4)
    } else {
        seed.wrapping_add(XXH64_PRIME5)
    };

    hash = hash.wrapping_add(len as u64);
    while index + 8 <= len {
        let k1 = xxh64_round(0, read_u64_le(input, index));
        hash ^= k1;
        hash = hash
            .rotate_left(27)
            .wrapping_mul(XXH64_PRIME1)
            .wrapping_add(XXH64_PRIME4);
        index += 8;
    }
    if index + 4 <= len {
        hash ^= (read_u32_le(input, index) as u64).wrapping_mul(XXH64_PRIME1);
        hash = hash
            .rotate_left(23)
            .wrapping_mul(XXH64_PRIME2)
            .wrapping_add(XXH64_PRIME3);
        index += 4;
    }
    while index < len {
        hash ^= (input[index] as u64).wrapping_mul(XXH64_PRIME5);
        hash = hash.rotate_left(11).wrapping_mul(XXH64_PRIME1);
        index += 1;
    }
    xxh64_avalanche(hash)
}

fn xxh64_round(acc: u64, input: u64) -> u64 {
    acc.wrapping_add(input.wrapping_mul(XXH64_PRIME2))
        .rotate_left(31)
        .wrapping_mul(XXH64_PRIME1)
}

fn xxh64_merge_round(acc: u64, value: u64) -> u64 {
    (acc ^ xxh64_round(0, value))
        .wrapping_mul(XXH64_PRIME1)
        .wrapping_add(XXH64_PRIME4)
}

fn xxh64_avalanche(mut hash: u64) -> u64 {
    hash ^= hash >> 33;
    hash = hash.wrapping_mul(XXH64_PRIME2);
    hash ^= hash >> 29;
    hash = hash.wrapping_mul(XXH64_PRIME3);
    hash ^ (hash >> 32)
}

fn read_u64_le(input: &[u8], index: usize) -> u64 {
    u64::from_le_bytes(input[index..index + 8].try_into().expect("u64 chunk"))
}

fn read_u32_le(input: &[u8], index: usize) -> u32 {
    u32::from_le_bytes(input[index..index + 4].try_into().expect("u32 chunk"))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|w| w == b"\r\n\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy_config() -> ProxyConfig {
        ProxyConfig {
            target_url: "https://api.example.com".into(),
            api_key: "token".into(),
            input_format: "anthropic".into(),
            auth_field: "ANTHROPIC_AUTH_TOKEN".into(),
            use_full_url: false,
            openai_reasoning_effort: String::new(),
            network_proxy_url: String::new(),
            network_no_proxy: String::new(),
            main_model: "mimo-v2.5-pro".into(),
            haiku_model: String::new(),
            sonnet_model: String::new(),
            opus_model: String::new(),
            available_models: vec!["opus[1m]".into(), "mimo-v2.5-pro".into()],
            cch_seed: None,
        }
    }

    #[test]
    fn mapped_model_uses_main_model_for_missing_source() {
        let config = proxy_config();
        assert_eq!(mapped_model("", &config), "mimo-v2.5-pro");
    }

    #[test]
    fn mapped_model_preserves_explicit_claude_alias_without_family_mapping() {
        let config = proxy_config();
        assert_eq!(mapped_model("opus[1m]", &config), "opus[1m]");
        assert_eq!(mapped_model("sonnet", &config), "sonnet");
    }

    #[test]
    fn mapped_model_rewrites_explicit_claude_alias_with_family_mapping() {
        let mut config = proxy_config();
        config.opus_model = "mimo-v2.5-pro".into();
        assert_eq!(mapped_model("opus[1m]", &config), "mimo-v2.5-pro");
    }

    #[test]
    fn models_response_includes_available_provider_models() {
        let config = proxy_config();
        let body: Value = serde_json::from_slice(&models_response(&config)).expect("models json");
        let ids = body
            .get("data")
            .and_then(Value::as_array)
            .expect("data")
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(ids.contains(&"mimo-v2.5-pro"));
        assert!(ids.contains(&"opus[1m]"));
    }

    #[test]
    fn xxh64_matches_known_empty_digest() {
        assert_eq!(xxh64(b"", 0), 0xef46_db37_51d8_e999);
    }

    #[test]
    fn rewrite_cch_updates_only_billing_header_segment() {
        let body = serde_json::json!({
            "model": "sonnet",
            "system": [
                {
                    "type": "text",
                    "text": "x-anthropic-billing-header: t=1;cch=abcde;k=v;"
                }
            ],
            "messages": [
                {
                    "role": "user",
                    "content": "literal cch=00000 should remain"
                }
            ]
        });
        let out = rewrite_cch(body.to_string().as_bytes(), 0).expect("rewrite cch");
        let value: Value = serde_json::from_slice(&out).expect("json");
        let system_text = value["system"][0]["text"].as_str().expect("system text");
        let user_text = value["messages"][0]["content"].as_str().expect("user text");

        assert!(system_text.contains("x-anthropic-billing-header:"));
        assert!(!system_text.contains("cch=abcde;"));
        assert!(!system_text.contains("cch=00000;"));
        assert!(user_text.contains("literal cch=00000 should remain"));
    }

    #[test]
    fn rewrite_cch_errors_when_billing_header_missing() {
        let body = serde_json::json!({
            "model": "sonnet",
            "system": [{ "type": "text", "text": "no billing header" }],
            "messages": []
        });
        let err = rewrite_cch(body.to_string().as_bytes(), 0).expect_err("missing cch");
        assert!(err
            .to_string()
            .contains("proxy cch billing header not found"));
    }

    #[test]
    fn anthropic_request_converts_to_openai_chat_tools() {
        let mut config = proxy_config();
        config.input_format = "openai-chat-completions".into();
        config.openai_reasoning_effort = "max".into();
        let body = serde_json::json!({
            "model": "opus",
            "max_tokens": 1024,
            "stream": true,
            "messages": [
                {
                    "role": "user",
                    "content": "hello"
                }
            ],
            "tools": [
                {
                    "name": "Read",
                    "description": "Read a file",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" }
                        }
                    }
                }
            ],
            "tool_choice": { "type": "auto" }
        });
        let (out, mapped) =
            anthropic_to_openai_request(body.to_string().as_bytes(), &config).unwrap();
        let value: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(mapped.as_deref(), Some("opus"));
        assert_eq!(value["model"], "opus");
        assert_eq!(value["max_completion_tokens"], 1024);
        assert_eq!(value["reasoning_effort"], "xhigh");
        assert_eq!(value["tools"][0]["type"], "function");
        assert_eq!(value["tools"][0]["function"]["name"], "Read");
        assert_eq!(value["tool_choice"], "auto");
    }

    #[test]
    fn openai_reasoning_effort_passes_through_full_level_set() {
        // OpenAI reasoning_effort 全集（前端 OPENAI_EFFORT_LEVELS）应原样透传，
        // 含低档位 none/minimal（PR3 新增覆盖）。
        assert_eq!(openai_reasoning_effort("none"), Some("none".into()));
        assert_eq!(openai_reasoning_effort("minimal"), Some("minimal".into()));
        assert_eq!(openai_reasoning_effort("low"), Some("low".into()));
        assert_eq!(openai_reasoning_effort("medium"), Some("medium".into()));
        assert_eq!(openai_reasoning_effort("high"), Some("high".into()));
        assert_eq!(openai_reasoning_effort("xhigh"), Some("xhigh".into()));
        // 大小写 / 空白宽松
        assert_eq!(openai_reasoning_effort(" Minimal "), Some("minimal".into()));
        // 旧会话残留的 Claude 语义 max 兜底为 xhigh
        assert_eq!(openai_reasoning_effort("max"), Some("xhigh".into()));
        // 未知 / 空 不发送
        assert_eq!(openai_reasoning_effort(""), None);
        assert_eq!(openai_reasoning_effort("ultracode"), None);
    }

    #[test]
    fn openai_tool_schema_rejects_empty_read_pages() {
        let tool = serde_json::json!({
            "name": "Read",
            "description": "Read a file",
            "input_schema": {
                "type": "object",
                "properties": {
                    "file_path": { "type": "string" },
                    "pages": { "type": "string" }
                }
            }
        });
        let converted = openai_tool_from_anthropic_tool(&tool).expect("tool");
        assert_eq!(
            converted["function"]["parameters"]["properties"]["pages"]["minLength"],
            1
        );
        assert_eq!(
            converted["function"]["parameters"]["properties"]["pages"]["pattern"],
            r"^[1-9][0-9]*(?:-[1-9][0-9]*)?$"
        );
    }

    #[test]
    fn openai_tool_call_removes_invalid_read_pages() {
        let tool_call = serde_json::json!({
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "Read",
                "arguments": "{\"file_path\":\"installAntigravity.sh\",\"pages\":\"/\"}"
            }
        });
        let converted = anthropic_tool_use_from_openai_tool_call(&tool_call).expect("tool use");
        assert_eq!(converted["input"]["file_path"], "installAntigravity.sh");
        assert!(converted["input"].get("pages").is_none());
    }

    #[test]
    fn openai_tool_call_preserves_valid_read_pages() {
        let tool_call = serde_json::json!({
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "Read",
                "arguments": "{\"file_path\":\"paper.pdf\",\"pages\":\"10-20\"}"
            }
        });
        let converted = anthropic_tool_use_from_openai_tool_call(&tool_call).expect("tool use");
        assert_eq!(converted["input"]["pages"], "10-20");
    }

    #[test]
    fn read_pages_validation_matches_cli_range_format() {
        assert!(is_valid_read_pages("3"));
        assert!(is_valid_read_pages("1-5"));
        assert!(is_valid_read_pages(" 10-20 "));
        assert!(!is_valid_read_pages(""));
        assert!(!is_valid_read_pages("/"));
        assert!(!is_valid_read_pages("0"));
        assert!(!is_valid_read_pages("5-1"));
    }

    #[test]
    fn openai_chat_response_converts_tool_calls_to_anthropic() {
        let body = serde_json::json!({
            "id": "chatcmpl-1",
            "model": "gpt-5.5",
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "Read",
                                    "arguments": "{\"path\":\"README.md\"}"
                                }
                            }
                        ]
                    }
                }
            ],
            "usage": {
                "prompt_tokens": 7,
                "completion_tokens": 3
            }
        });
        let converted = openai_json_to_anthropic_message(&body);
        assert_eq!(converted["stop_reason"], "tool_use");
        assert_eq!(converted["content"][0]["type"], "tool_use");
        assert_eq!(converted["content"][0]["name"], "Read");
        assert_eq!(converted["content"][0]["input"]["path"], "README.md");
        assert_eq!(converted["usage"]["input_tokens"], 7);
        assert_eq!(converted["usage"]["output_tokens"], 3);
    }

    #[test]
    fn openai_stream_converts_tool_call_deltas_to_anthropic_sse() {
        let stream = concat!(
            "data: {\"id\":\"chatcmpl-1\",\"model\":\"gpt-5.5\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"model\":\"gpt-5.5\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"Read\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"model\":\"gpt-5.5\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let converted =
            String::from_utf8(openai_stream_to_anthropic_sse(stream.as_bytes()).unwrap()).unwrap();
        assert!(converted.contains("\"type\":\"message_start\""));
        assert!(converted.contains("\"type\":\"tool_use\""));
        assert!(converted.contains("\"partial_json\":\"{\\\"path\\\":\""));
        assert!(converted.contains("\"stop_reason\":\"tool_use\""));
    }

    #[test]
    fn no_proxy_matches_hosts_and_domains() {
        assert!(matches_no_proxy(
            "https://api.example.com/v1/chat/completions",
            "localhost,*.example.com"
        ));
        assert!(matches_no_proxy("http://127.0.0.1:3000", "127.0.0.1,::1"));
        assert!(matches_no_proxy("http://[::1]:3000", "127.0.0.1,::1"));
        assert!(!matches_no_proxy(
            "https://api.openai.com/v1/models",
            "*.example.com"
        ));
    }

    #[test]
    fn reason_phrase_covers_common_upstream_statuses() {
        assert_eq!(reason_phrase(429), "Too Many Requests");
        assert_eq!(reason_phrase(502), "Bad Gateway");
        assert_eq!(reason_phrase(503), "Service Unavailable");
        assert_eq!(reason_phrase(504), "Gateway Timeout");
        assert_eq!(reason_phrase(418), "");
    }

    #[test]
    fn rewrite_model_returns_mapped_target() {
        let mut config = proxy_config();
        config.opus_model = "mimo-v2.5-pro".into();
        let body = serde_json::json!({ "model": "claude-opus-4-8" });
        let (bytes, model) = rewrite_model(body.to_string().as_bytes(), &config).expect("rewrite");
        let value: Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(model.as_deref(), Some("mimo-v2.5-pro"));
        assert_eq!(value["model"], "mimo-v2.5-pro");
    }

    /// 读完一个 HTTP 请求（头 + Content-Length 定长体），供假上游使用。
    async fn read_http_request(sock: &mut TcpStream) {
        let mut buf = Vec::new();
        loop {
            let mut chunk = [0u8; 1024];
            let n = sock.read(&mut chunk).await.expect("upstream read");
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(pos) = find_header_end(&buf) {
                let header = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
                let content_length = header
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buf.len() >= pos + 4 + content_length {
                    return;
                }
            }
        }
    }

    /// 响应是否已按帧语义读完（Content-Length 满足或 chunked 终止块到达）。
    /// 不依赖 EOF：Windows 上并发 CreateProcess 会让对端关闭呈现为 RST。
    fn http_response_complete(received: &[u8]) -> bool {
        let Some(header_end) = find_header_end(received) else {
            return false;
        };
        let header = String::from_utf8_lossy(&received[..header_end]).to_ascii_lowercase();
        let body = &received[header_end + 4..];
        if let Some(content_length) = header
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())
        {
            return body.len() >= content_length;
        }
        if header.contains("transfer-encoding: chunked") {
            return body.ends_with(b"0\r\n\r\n");
        }
        false
    }

    /// 通过本地代理发一个 /v1/messages 请求并按帧语义读完响应。
    async fn proxy_roundtrip(proxy_url: &str, body: &[u8]) -> String {
        let addr = proxy_url.strip_prefix("http://").expect("proxy url");
        let mut client = TcpStream::connect(addr).await.expect("connect proxy");
        let head = format!(
            "POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        client.write_all(head.as_bytes()).await.expect("write head");
        client.write_all(body).await.expect("write body");
        let mut received = Vec::new();
        loop {
            if http_response_complete(&received) {
                break;
            }
            let mut chunk = [0u8; 1024];
            let n = client.read(&mut chunk).await.expect("read response");
            if n == 0 {
                break;
            }
            received.extend_from_slice(&chunk[..n]);
        }
        String::from_utf8_lossy(&received).into_owned()
    }

    #[tokio::test]
    async fn anthropic_passthrough_streams_chunks_before_upstream_completes() {
        let upstream = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind upstream");
        let upstream_addr = upstream.local_addr().expect("upstream addr");
        // 信号驱动：上游发出第一块后阻塞等待，确保“客户端读到第一块”先于“上游发完”。
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let (mut sock, _) = upstream.accept().await.expect("accept");
            read_http_request(&mut sock).await;
            sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: first\n\n",
            )
            .await
            .expect("write first chunk");
            sock.flush().await.expect("flush first chunk");
            release_rx.await.expect("await release");
            sock.write_all(b"event: second\n\n")
                .await
                .expect("write second chunk");
            sock.flush().await.expect("flush second chunk");
        });

        let mut config = proxy_config();
        config.target_url = format!("http://{upstream_addr}");
        let proxy_url = start(config, None).await.expect("start proxy");
        let addr = proxy_url.strip_prefix("http://").expect("proxy url");
        let mut client = TcpStream::connect(addr).await.expect("connect proxy");
        let body = br#"{"model":"sonnet"}"#;
        let head = format!(
            "POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        client.write_all(head.as_bytes()).await.expect("write head");
        client.write_all(body).await.expect("write body");

        let mut received = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let mut chunk = [0u8; 1024];
                let n = client.read(&mut chunk).await.expect("read first chunk");
                assert!(n > 0, "proxy closed before first chunk");
                received.extend_from_slice(&chunk[..n]);
                if String::from_utf8_lossy(&received).contains("event: first") {
                    break;
                }
            }
        })
        .await
        .expect("first chunk must arrive while upstream is still streaming");

        release_tx.send(()).expect("release upstream");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !http_response_complete(&received) {
                let mut chunk = [0u8; 1024];
                let n = client.read(&mut chunk).await.expect("read rest");
                assert!(n > 0, "connection ended before terminal chunk");
                received.extend_from_slice(&chunk[..n]);
            }
        })
        .await
        .expect("terminal chunk should arrive after upstream closes");

        let text = String::from_utf8_lossy(&received);
        assert!(text.contains("event: second"));
        assert!(
            text.to_ascii_lowercase()
                .contains("transfer-encoding: chunked"),
            "streaming passthrough must use chunked framing"
        );
        assert!(
            !text.to_ascii_lowercase().contains("content-length"),
            "streaming passthrough must not buffer with content-length"
        );
    }

    #[tokio::test]
    async fn reports_upstream_error_then_recovery() {
        let upstream = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind upstream");
        let upstream_addr = upstream.local_addr().expect("upstream addr");
        tokio::spawn(async move {
            let responses: [&[u8]; 2] = [
                b"HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain\r\nContent-Length: 19\r\n\r\nService Unavailable",
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
            ];
            for response in responses {
                let (mut sock, _) = upstream.accept().await.expect("accept");
                read_http_request(&mut sock).await;
                sock.write_all(response).await.expect("write response");
                sock.flush().await.expect("flush response");
            }
        });

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut config = proxy_config();
        config.target_url = format!("http://{upstream_addr}");
        let proxy_url = start(config, Some(ProxyStatusReporter::new(tx)))
            .await
            .expect("start proxy");

        let body = br#"{"model":"sonnet"}"#;
        let first = proxy_roundtrip(&proxy_url, body).await;
        assert!(first.starts_with("HTTP/1.1 429 Too Many Requests"));
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("error event in time")
            .expect("error event");
        assert_eq!(event.kind, "upstream-error");
        assert_eq!(event.status, Some(429));
        assert_eq!(event.path, "/v1/messages");
        assert_eq!(event.model.as_deref(), Some("sonnet"));
        assert!(event.message.contains("Service Unavailable"));

        let second = proxy_roundtrip(&proxy_url, body).await;
        assert!(second.starts_with("HTTP/1.1 200 OK"));
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("recovered event in time")
            .expect("recovered event");
        assert_eq!(event.kind, "recovered");
        assert!(
            rx.try_recv().is_err(),
            "consecutive successes must not emit extra events"
        );
    }
}
