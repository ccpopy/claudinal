use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::error::{Error, Result};

#[derive(Clone, Debug)]
pub struct ProxyConfig {
    pub target_url: String,
    pub api_key: String,
    pub auth_field: String,
    pub use_full_url: bool,
    pub main_model: String,
    pub haiku_model: String,
    pub sonnet_model: String,
    pub opus_model: String,
}

pub async fn start(config: ProxyConfig) -> Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let config = Arc::new(config);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let config = config.clone();
            tokio::spawn(async move {
                let _ = handle(stream, config).await;
            });
        }
    });
    Ok(format!("http://{addr}"))
}

async fn handle(mut stream: TcpStream, config: Arc<ProxyConfig>) -> Result<()> {
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

    if content_type
        .to_ascii_lowercase()
        .contains("application/json")
    {
        body = rewrite_model(&body, &config)?;
    }

    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| Error::Other(format!("proxy method: {e}")))?;
    let url = forward_url(&config.target_url, path, config.use_full_url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| Error::Other(format!("proxy http client: {e}")))?;
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
    if config.auth_field == "ANTHROPIC_API_KEY" {
        req = req.header("x-api-key", config.api_key.as_str());
    } else {
        let token = config
            .api_key
            .strip_prefix("Bearer ")
            .unwrap_or(config.api_key.as_str());
        req = req.bearer_auth(token);
    }

    let resp = req
        .body(body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("proxy request: {e}")))?;
    let status = resp.status();
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
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| Error::Other(format!("proxy response: {e}")))?;

    write_response(
        &mut stream,
        status.as_u16(),
        response_headers,
        bytes.to_vec(),
    )
    .await?;
    Ok(())
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    response_headers: Vec<(String, String)>,
    bytes: Vec<u8>,
) -> Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "",
    };
    let mut head = format!("HTTP/1.1 {} {}\r\n", status, reason);
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

fn is_models_path(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    path == "/models" || path == "/v1/models"
}

fn models_response(config: &ProxyConfig) -> Vec<u8> {
    let mut ids = configured_models(config);
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

fn rewrite_model(body: &[u8], config: &ProxyConfig) -> Result<Vec<u8>> {
    let mut value = serde_json::from_slice::<Value>(body)
        .map_err(|e| Error::Other(format!("proxy json parse: {e}")))?;
    let obj = value
        .as_object_mut()
        .ok_or_else(|| Error::Other("proxy json body must be an object".into()))?;
    let source = obj.get("model").and_then(Value::as_str).unwrap_or_default();
    let target = mapped_model(source, config);
    if !target.is_empty() {
        obj.insert("model".into(), Value::String(target));
    }
    serde_json::to_vec(&value).map_err(Error::from)
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
    if !config.main_model.trim().is_empty() {
        return config.main_model.trim().to_string();
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

fn forward_url(target_url: &str, incoming_path: &str, use_full_url: bool) -> Result<String> {
    let target = target_url.trim().trim_end_matches('/');
    if target.is_empty() {
        return Err(Error::Other("proxy target url required".into()));
    }
    let lower = target.to_ascii_lowercase();
    if use_full_url && (lower.ends_with("/messages") || lower.ends_with("/chat/completions")) {
        return Ok(target.to_string());
    }
    let mut path = incoming_path;
    if target.ends_with("/v1") && path.starts_with("/v1/") {
        path = &path[3..];
    }
    Ok(format!("{target}{path}"))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|w| w == b"\r\n\r\n")
}
