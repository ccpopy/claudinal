use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::Arc;

use dashmap::DashMap;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use tracing::{error, warn};
use uuid::Uuid;

use crate::error::{Error, Result};

pub const DEFAULT_PERMISSION_MCP_TOOL: &str = "mcp__claudinal_permission__approval_prompt";
pub const DEFAULT_PERMISSION_MCP_CONFIG: &str = r#"{
  "mcpServers": {
    "claudinal_permission": {
      "command": "${CLAUDINAL_EXE}",
      "args": ["--permission-mcp-server"]
    }
  }
}"#;

#[derive(Clone)]
struct BridgeState {
    url: String,
    token: String,
}

#[derive(Default)]
pub struct PermissionMcpBridge {
    state: Mutex<Option<BridgeState>>,
    pending: Arc<DashMap<String, oneshot::Sender<Value>>>,
}

impl PermissionMcpBridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn env(&self, app: AppHandle) -> Result<HashMap<String, String>> {
        let state = self.ensure_started(app).await?;
        Ok(HashMap::from([
            ("CLAUDINAL_PERMISSION_BRIDGE_URL".into(), state.url),
            ("CLAUDINAL_PERMISSION_BRIDGE_TOKEN".into(), state.token),
        ]))
    }

    pub async fn resolve(&self, request_id: &str, response: Value) -> Result<()> {
        let Some((_, sender)) = self.pending.remove(request_id) else {
            return Err(Error::Other(format!(
                "permission MCP request not found: {request_id}"
            )));
        };
        sender
            .send(response)
            .map_err(|_| Error::Other(format!("permission MCP request closed: {request_id}")))
    }

    async fn ensure_started(&self, app: AppHandle) -> Result<BridgeState> {
        let mut guard = self.state.lock().await;
        if let Some(state) = guard.as_ref() {
            return Ok(state.clone());
        }

        let token = Uuid::new_v4().to_string();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let state = BridgeState {
            url: format!("http://{addr}"),
            token: token.clone(),
        };

        let pending = self.pending.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let app = app.clone();
                        let token = token.clone();
                        let pending = pending.clone();
                        tokio::spawn(async move {
                            if let Err(e) =
                                handle_bridge_connection(stream, app, token, pending).await
                            {
                                warn!("permission MCP bridge request failed: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        error!("permission MCP bridge accept failed: {e}");
                        break;
                    }
                }
            }
        });

        *guard = Some(state.clone());
        Ok(state)
    }
}

pub fn render_default_mcp_config(raw: Option<&str>) -> Result<String> {
    let raw = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_PERMISSION_MCP_CONFIG);
    let exe = std::env::current_exe()?;
    let exe = exe.display().to_string();
    let escaped = serde_json::to_string(&exe)?;
    let escaped = escaped
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .ok_or_else(|| Error::Other("failed to escape current executable path".into()))?;
    let rendered = raw.replace("${CLAUDINAL_EXE}", escaped);
    let _: Value = serde_json::from_str(&rendered)?;
    Ok(rendered)
}

async fn handle_bridge_connection(
    stream: TcpStream,
    app: AppHandle,
    token: String,
    pending: Arc<DashMap<String, oneshot::Sender<Value>>>,
) -> Result<()> {
    let request = read_http_request(stream).await?;
    let mut stream = request.stream;

    if request.method != "POST" || request.path != "/permission-request" {
        return write_http_response(&mut stream, 404, b"not found").await;
    }
    let auth = request
        .headers
        .get("authorization")
        .map(String::as_str)
        .unwrap_or("");
    if auth != format!("Bearer {token}") {
        return write_http_response(&mut stream, 403, b"forbidden").await;
    }

    let mut payload: Value = serde_json::from_slice(&request.body)?;
    let request_id = payload
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Other("permission MCP bridge request missing request_id".into()))?
        .to_string();

    let (sender, receiver) = oneshot::channel();
    pending.insert(request_id.clone(), sender);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("type".into(), json!("control_request"));
        obj.insert("transport".into(), json!("mcp"));
    }

    if let Err(e) = app.emit("claudinal://permission/request", payload) {
        pending.remove(&request_id);
        return Err(Error::from(e));
    }

    let response = receiver
        .await
        .map_err(|_| Error::Other(format!("permission MCP request closed: {request_id}")))?;
    let body = serde_json::to_vec(&response)?;
    write_http_response(&mut stream, 200, &body).await
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
    stream: TcpStream,
}

async fn read_http_request(stream: TcpStream) -> Result<HttpRequest> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| Error::Other("invalid HTTP request line".into()))?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| Error::Other("invalid HTTP request path".into()))?
        .to_string();

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_len = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; content_len];
    if content_len > 0 {
        reader.read_exact(&mut body).await?;
    }
    let stream = reader.into_inner();

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
        stream,
    })
}

async fn write_http_response(stream: &mut TcpStream, status: u16, body: &[u8]) -> Result<()> {
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await?;
    Ok(())
}

pub fn run_stdio_mcp_server() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let message: Value = serde_json::from_str(trimmed)?;
        if let Some(response) = handle_mcp_message(&runtime, message)? {
            let text = serde_json::to_string(&response)?;
            stdout.write_all(text.as_bytes())?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

fn handle_mcp_message(runtime: &tokio::runtime::Runtime, message: Value) -> Result<Option<Value>> {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let id = message.get("id").cloned();
    if id.is_none() {
        return Ok(None);
    }
    let id = id.unwrap();

    let result = match method {
        "initialize" => json!({
            "protocolVersion": message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2024-11-05"),
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "claudinal-permission",
                "version": env!("CARGO_PKG_VERSION")
            }
        }),
        "ping" => json!({}),
        "tools/list" => json!({
            "tools": [
                {
                    "name": "approval_prompt",
                    "description": "Forward Claude Code permission prompts to Claudinal.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "tool_name": {
                                "type": "string",
                                "description": "The Claude Code tool requesting permission."
                            },
                            "input": {
                                "type": "object",
                                "description": "The original tool input."
                            }
                        },
                        "required": ["tool_name", "input"],
                        "additionalProperties": true
                    }
                }
            ]
        }),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
            call_permission_tool(runtime, params)?
        }
        _ => {
            return Ok(Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("unknown MCP method: {method}")
                }
            })));
        }
    };

    Ok(Some(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })))
}

fn call_permission_tool(runtime: &tokio::runtime::Runtime, params: Value) -> Result<Value> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    if name != "approval_prompt" {
        return Ok(json!({
            "content": [
                {
                    "type": "text",
                    "text": serde_json::to_string(&json!({
                        "behavior": "deny",
                        "message": format!("Unknown permission MCP tool: {name}")
                    }))?
                }
            ],
            "isError": true
        }));
    }
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let response = runtime.block_on(resolve_permission(arguments))?;
    Ok(json!({
        "content": [
            {
                "type": "text",
                "text": serde_json::to_string(&response)?
            }
        ]
    }))
}

async fn resolve_permission(arguments: Value) -> Result<Value> {
    let input = arguments.get("input").cloned().unwrap_or_else(|| json!({}));
    if let Ok(url) = std::env::var("CLAUDINAL_PERMISSION_BRIDGE_URL") {
        let token = std::env::var("CLAUDINAL_PERMISSION_BRIDGE_TOKEN")
            .map_err(|_| Error::Other("CLAUDINAL_PERMISSION_BRIDGE_TOKEN is required".into()))?;
        let request_id = Uuid::new_v4().to_string();
        let runtime_session_id =
            std::env::var("CLAUDINAL_RUNTIME_SESSION_ID").unwrap_or_else(|_| "mcp".into());
        let runtime_cwd = std::env::var("CLAUDINAL_RUNTIME_CWD").ok();
        let tool_name = arguments
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let mut body = json!({
            "request_id": request_id,
            "session_id": runtime_session_id,
            "request": {
                "subtype": "can_use_tool",
                "tool_name": tool_name,
                "display_name": tool_name,
                "input": input,
                "description": permission_description(tool_name, arguments.get("input"))
            }
        });
        if let (Some(obj), Some(cwd)) = (body.as_object_mut(), runtime_cwd) {
            obj.insert("cwd".into(), json!(cwd));
        }
        let endpoint = format!("{}/permission-request", url.trim_end_matches('/'));
        let resp = reqwest::Client::new()
            .post(endpoint)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::Other(format!("permission bridge request failed: {e}")))?;
        let status = resp.status();
        let value: Value = resp
            .json()
            .await
            .map_err(|e| Error::Other(format!("permission bridge response parse failed: {e}")))?;
        if !status.is_success() {
            return Err(Error::Other(format!(
                "permission bridge returned {status}: {value}"
            )));
        }
        return Ok(value);
    }

    let decision = permission_mcp_default_decision();
    if decision == "allow" {
        Ok(json!({ "behavior": "allow", "updatedInput": input }))
    } else {
        Ok(json!({
            "behavior": "deny",
            "message": "Permission denied by Claudinal MCP permission server."
        }))
    }
}

fn permission_description(tool_name: &str, input: Option<&Value>) -> String {
    let Some(input) = input else {
        return tool_name.to_string();
    };
    if let Some(command) = input.get("command").and_then(Value::as_str) {
        return command.to_string();
    }
    if let Some(path) = input.get("file_path").and_then(Value::as_str) {
        return path.to_string();
    }
    tool_name.to_string()
}

fn permission_mcp_default_decision() -> String {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--permission-mcp-default" {
            if let Some(value) = args.next() {
                return value;
            }
        }
    }
    std::env::var("CLAUDINAL_PERMISSION_MCP_DEFAULT").unwrap_or_else(|_| "deny".into())
}
