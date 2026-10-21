//! Unprivileged stdio helper. All private observation and actions go to the host.
use super::broker::{message_reader, read_json, tool_error, write_json, MAX_REQUEST, MAX_RESPONSE};
use crate::error::{Error, Result};
use serde_json::{json, Value};
use tokio::{io::BufReader, net::TcpStream};

pub fn run_mcp_stdio() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(run());
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    result
}

async fn run() -> Result<()> {
    let runtime_id = std::env::var("CLAUDINAL_COMPUTER_RUNTIME_ID")
        .map_err(|_| Error::Other("Computer helper has no captured runtime.".into()))?;
    let token = std::env::var("CLAUDINAL_COMPUTER_TOKEN")
        .map_err(|_| Error::Other("Computer helper has no host capability.".into()))?;
    let port = std::env::var("CLAUDINAL_COMPUTER_BROKER_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| Error::Other("Computer helper has no host broker.".into()))?;
    let stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let (read, mut broker_write) = stream.into_split();
    let mut broker_read = BufReader::new(read);
    write_json(
        &mut broker_write,
        &json!({"runtimeId":runtime_id,"token":token}),
    )
    .await?;
    let connected = read_json(&mut broker_read, 4096)
        .await?
        .ok_or_else(|| Error::Other("Computer broker authentication failed.".into()))?;
    if connected.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(Error::Other(
            "Computer broker rejected this runtime.".into(),
        ));
    }
    let stdin = BufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();
    let (_stdin_reader, mut input_messages) = message_reader(stdin, MAX_REQUEST);
    let (_broker_reader, mut broker_messages) = message_reader(broker_read, MAX_RESPONSE);
    let mut pending: Option<Value> = None;
    loop {
        tokio::select! {
            biased;
            input = input_messages.recv() => {
                let Some(message) = input.transpose()?.flatten() else { return Ok(()); };
                let method = message.get("method").and_then(Value::as_str).unwrap_or("");
                if pending_cancel(&message, pending.as_ref()) {
                    // Closing this authenticated connection makes host revoke/kill first.
                    return Ok(());
                }
                let Some(id) = message.get("id").cloned() else { continue; };
                let result = match method {
                    "initialize" => json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"claudinal-computer","version":env!("CARGO_PKG_VERSION")}}),
                    "ping" => json!({}),
                    "tools/list" => tools_list(),
                    "tools/call" => {
                        if pending.is_some() { tool_error("A computer action is already in flight. No action was queued.") }
                        else {
                            let name = message.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
                            if !TOOL_NAMES.contains(&name) { tool_error("Unknown Claudinal computer tool.") }
                            else {
                                write_json(&mut broker_write, &json!({"name":name,"arguments":message.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}))})).await?;
                                pending = Some(id);
                                continue;
                            }
                        }
                    }
                    _ => {
                        write_json(&mut stdout, &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unknown computer MCP method."}})).await?;
                        continue;
                    }
                };
                write_json(&mut stdout, &json!({"jsonrpc":"2.0","id":id,"result":result})).await?;
            },
            response = broker_messages.recv() => {
                let Some(response) = response.transpose()?.flatten() else { return Err(Error::Other("Computer host disconnected. Access is revoked.".into())); };
                if let Some(id) = pending.take() { write_json(&mut stdout, &json!({"jsonrpc":"2.0","id":id,"result":response})).await?; }
                else { return Err(Error::Other("Computer broker returned an unsolicited result.".into())); }
            },
        }
    }
}

fn pending_cancel(message: &Value, pending: Option<&Value>) -> bool {
    message.get("method").and_then(Value::as_str) == Some("notifications/cancelled")
        && pending.is_some_and(|id| message.pointer("/params/requestId") == Some(id))
}

const TOOL_NAMES: &[&str] = &[
    "computer_status",
    "computer_list_apps",
    "computer_request_app",
    "computer_observe",
    "computer_click",
    "computer_type",
    "computer_key",
    "computer_scroll",
    "computer_wait",
];

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
}

fn tools_list() -> Value {
    let app = json!({"type":"string","description":"Exact appId returned by computer_list_apps and approved by the user for this conversation."});
    json!({"tools":[
        tool("computer_status", "Read this captured conversation's computer availability and grants. This never captures the screen. Access defaults off; generic tool approval cannot enable it.", json!({}), &[]),
        tool("computer_list_apps", "List Windows app/window metadata after the user enables computer access. No screenshot. Use the exact appId for approval and actions.", json!({}), &[]),
        tool("computer_request_app", "Ask the user in Claudinal to approve an exact app window for this conversation. This does not grant access or wait for consent. Browsers/trading apps are view-only; terminals/IDEs click-only.", json!({"appId":app}), &["appId"]),
        tool("computer_observe", "Capture only the exact approved window with a bounded screenshot and optional accessibility tree. Returns capture_id plus screenshot_width/height. Coordinates are screenshot pixels. Observe again after mutations, errors or new approval; old captures never transfer across runtime generations.", json!({"appId":app,"includeTree":{"type":"boolean","default":true}}), &["appId"]),
        tool("computer_click", "Click in a verified Win32/WinForms approved window using screenshot-local x/y and the exact unconsumed capture_id from computer_observe. Defaults to a single left click; use button=right for a context menu or clickCount=2 for a left double click. Unknown, Chromium, WPF, Tk and GTK toolkits are unsupported; no pen or foreground fallback is permitted. Never retry uncertain mutations without a fresh observation. Each capture can ground at most one click.", json!({"appId":app,"x":{"type":"number","minimum":0},"y":{"type":"number","minimum":0},"captureId":{"type":"string"},"button":{"type":"string","enum":["left","right"],"default":"left"},"clickCount":{"type":"integer","minimum":1,"maximum":2,"default":1}}), &["appId","x","y","captureId"]),
        tool("computer_type", "Type up to 2048 UTF-8 bytes into the approved window after a recent observation, using background delivery only. Browser/trading and terminal/IDE tiers prohibit typing. No automatic replay after uncertain delivery.", json!({"appId":app,"text":{"type":"string","maxLength":2048}}), &["appId","text"]),
        tool("computer_key", "Send one bounded key (return/enter, tab, escape/esc, backspace, delete, insert, space, up/down/left/right, home, end, pageup, pagedown, f1-f12, letter or digit) to the approved window after observation. Background delivery only; full tier required; system window-switching shortcuts are blocked.", json!({"appId":app,"key":{"type":"string"},"modifiers":{"type":"array","maxItems":3,"items":{"type":"string","enum":["ctrl","shift","alt"]}}}), &["appId","key"]),
        tool("computer_wait", "Wait 0.1-10 seconds (default 1) for an approved app to finish loading or animating, then observe again. Never captures the screen; ends early if access is revoked.", json!({"seconds":{"type":"number","minimum":0.1,"maximum":10}}), &[]),
        tool("computer_scroll", "Scroll an approved full/click-tier window by 1-10 ticks after a recent observation. Background delivery only. No full desktop, browser evaluation, shell, registry, clipboard or process-launch access is exposed.", json!({"appId":app,"direction":{"type":"string","enum":["up","down","left","right"]},"amount":{"type":"integer","minimum":1,"maximum":10}}), &["appId","direction"])
    ]})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gateway_catalog_is_narrow_and_never_exposes_driver_defaults() {
        let catalog = tools_list();
        let tools = catalog["tools"].as_array().unwrap();
        assert_eq!(tools.len(), TOOL_NAMES.len());
        assert!(tools
            .iter()
            .all(|tool| TOOL_NAMES.contains(&tool["name"].as_str().unwrap())));
        for tool in tools {
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
            let properties = tool["inputSchema"]["properties"].as_object().unwrap();
            for forbidden in [
                "pid",
                "window_id",
                "target",
                "scope",
                "delivery_mode",
                "screenshot_out_file",
                "command",
                "script",
            ] {
                assert!(!properties.contains_key(forbidden));
            }
        }
    }
    #[test]
    fn stale_or_other_request_cancellation_does_not_cancel_current_tool() {
        let pending = json!("current");
        assert!(!pending_cancel(
            &json!({"method":"notifications/cancelled","params":{"requestId":"old"}}),
            Some(&pending)
        ));
        assert!(!pending_cancel(
            &json!({"method":"notifications/cancelled","params":{}}),
            Some(&pending)
        ));
        assert!(pending_cancel(
            &json!({"method":"notifications/cancelled","params":{"requestId":"current"}}),
            Some(&pending)
        ));
        assert!(!pending_cancel(
            &json!({"method":"notifications/cancelled","params":{"requestId":"current"}}),
            None
        ));
    }
    #[tokio::test]
    async fn helper_reader_preserves_partial_frame_across_concurrent_response() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, read) = tokio::io::duplex(256);
        let (_reader, mut messages) = message_reader(BufReader::new(read), 256);
        writer.write_all(b"{\"id\":7,\"method\":").await.unwrap();
        // Simulate a broker result winning the helper's select while stdin's
        // independent framing reader owns half of the next MCP request.
        tokio::task::yield_now().await;
        assert!(messages.try_recv().is_err());
        writer.write_all(b"\"ping\"}\n").await.unwrap();
        assert_eq!(
            messages.recv().await.unwrap().unwrap(),
            Some(json!({"id":7,"method":"ping"}))
        );
        drop(writer);
        assert!(messages.recv().await.unwrap().unwrap().is_none());
    }
}
