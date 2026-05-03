use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::collab::providers::ProviderPathOverride;
use crate::collab::runner::{
    delegate, record_approval, run_verification, start_flow, CollabApprovalRequest,
    CollabDelegateRequest, CollabStartFlowRequest, CollabVerificationRequest,
};
use crate::collab::store::{list_flows, read_flow};
use crate::error::{Error, Result};

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
        if let Some(response) = handle_message(&runtime, message)? {
            let text = serde_json::to_string(&response)?;
            stdout.write_all(text.as_bytes())?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

fn handle_message(runtime: &tokio::runtime::Runtime, message: Value) -> Result<Option<Value>> {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let id = message.get("id").cloned();
    let Some(id) = id else {
        return Ok(None);
    };

    let result = match method {
        "initialize" => json!({
            "protocolVersion": message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2024-11-05"),
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "claudinal-collab",
                "version": env!("CARGO_PKG_VERSION")
            }
        }),
        "ping" => json!({}),
        "tools/list" => tools_list(),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
            match call_tool(runtime, params) {
                Ok(value) => value,
                Err(err) => tool_error(err.to_string()),
            }
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

fn tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "collab_status",
                "description": "Return Claudinal collaboration enablement, available providers, and recent flow state for the current project.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "cwd": { "type": "string" },
                        "flowId": { "type": "string" }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "collab_start_flow",
                "description": "Create a collaboration flow for the current project and user request.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "cwd": { "type": "string" },
                        "userPrompt": { "type": "string" },
                        "claudeSessionId": { "type": "string" }
                    },
                    "required": ["userPrompt"],
                    "additionalProperties": false
                }
            },
            {
                "name": "collab_delegate",
                "description": "Run one linear delegated Agent step. Only one step can run for a flow at a time; writes require explicit allowed paths.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "flowId": { "type": "string" },
                        "cwd": { "type": "string" },
                        "provider": { "type": "string", "enum": ["claude", "codex", "gemini", "opencode"] },
                        "prompt": { "type": "string" },
                        "responsibilityScope": { "type": "string" },
                        "allowedPaths": { "type": "array", "items": { "type": "string" } },
                        "writeAllowed": { "type": "boolean" },
                        "model": { "type": "string" },
                        "approvalMode": { "type": "string" }
                    },
                    "required": ["flowId", "provider", "prompt", "responsibilityScope", "writeAllowed"],
                    "additionalProperties": false
                }
            },
            {
                "name": "collab_get_result",
                "description": "Read a collaboration flow, a specific step, and the recorded stdout/stderr summaries.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "flowId": { "type": "string" },
                        "stepId": { "type": "string" }
                    },
                    "required": ["flowId"],
                    "additionalProperties": false
                }
            },
            {
                "name": "collab_record_approval",
                "description": "Record approval, rejection, or cancellation for one completed collaboration step.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "flowId": { "type": "string" },
                        "stepId": { "type": "string" },
                        "decision": { "type": "string", "enum": ["approve", "reject", "cancel"] },
                        "note": { "type": "string" }
                    },
                    "required": ["flowId", "stepId", "decision"],
                    "additionalProperties": false
                }
            },
            {
                "name": "collab_run_verification",
                "description": "Run a real verification command for a completed or approved step and record exit code, stdout, and stderr.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "flowId": { "type": "string" },
                        "stepId": { "type": "string" },
                        "cwd": { "type": "string" },
                        "command": { "type": "string" }
                    },
                    "required": ["flowId", "command"],
                    "additionalProperties": false
                }
            }
        ]
    })
}

fn call_tool(runtime: &tokio::runtime::Runtime, params: Value) -> Result<Value> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = match name {
        "collab_status" => runtime.block_on(collab_status(arguments))?,
        "collab_start_flow" => {
            let req = parse_start_flow(arguments)?;
            json!(runtime.block_on(start_flow(req))?)
        }
        "collab_delegate" => {
            let req = parse_delegate(arguments)?;
            json!(runtime.block_on(delegate(req))?)
        }
        "collab_get_result" => collab_get_result(arguments)?,
        "collab_record_approval" => {
            let req: CollabApprovalRequest = serde_json::from_value(arguments)?;
            json!(runtime.block_on(record_approval(req))?)
        }
        "collab_run_verification" => {
            let req = parse_verification(arguments)?;
            json!(runtime.block_on(run_verification(req))?)
        }
        other => {
            return Err(Error::Other(format!(
                "unknown collaboration MCP tool: {other}"
            )));
        }
    };
    Ok(tool_text(result))
}

async fn collab_status(arguments: Value) -> Result<Value> {
    let cwd = arguments
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| std::env::var("CLAUDINAL_RUNTIME_CWD").ok());
    let flow_id = arguments.get("flowId").and_then(Value::as_str);
    let providers =
        crate::collab::providers::detect_providers(Some(provider_overrides_from_env())).await?;
    let (flows, flows_error) = if let Some(flow_id) = flow_id {
        match read_flow(flow_id) {
            Ok(flow) => (vec![flow], None),
            Err(err) => (Vec::new(), Some(err.to_string())),
        }
    } else {
        match list_flows(cwd.as_deref()) {
            Ok(flows) => (flows.into_iter().take(10).collect(), None),
            Err(err) => (Vec::new(), Some(err.to_string())),
        }
    };
    Ok(json!({
        "enabled": crate::collab::enabled_from_env(),
        "enabledProviders": crate::collab::enabled_providers_from_env(),
        "cwd": cwd,
        "runtimeSessionId": crate::collab::runtime_session_from_env(),
        "providers": providers,
        "flows": flows,
        "flowsError": flows_error,
        "mcpActivation": "new-session"
    }))
}

fn collab_get_result(arguments: Value) -> Result<Value> {
    let flow_id = arguments
        .get("flowId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Other("flowId is required".into()))?;
    let step_id = arguments.get("stepId").and_then(Value::as_str);
    let flow = read_flow(flow_id)?;
    let step = step_id.and_then(|target| flow.steps.iter().find(|step| step.id == target).cloned());
    Ok(json!({
        "flow": flow,
        "step": step
    }))
}

fn parse_start_flow(arguments: Value) -> Result<CollabStartFlowRequest> {
    let mut arguments = arguments;
    if arguments
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .is_none()
    {
        arguments["cwd"] = json!(crate::collab::runtime_cwd_from_env()?);
    }
    let mut req: CollabStartFlowRequest = serde_json::from_value(arguments)?;
    if req.claude_session_id.is_none() {
        req.claude_session_id = crate::collab::runtime_session_from_env();
    }
    Ok(req)
}

fn parse_delegate(arguments: Value) -> Result<CollabDelegateRequest> {
    let mut arguments = arguments;
    if arguments
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .is_none()
    {
        arguments["cwd"] = json!(crate::collab::runtime_cwd_from_env()?);
    }
    serde_json::from_value(arguments).map_err(Error::from)
}

fn parse_verification(arguments: Value) -> Result<CollabVerificationRequest> {
    let mut req: CollabVerificationRequest = serde_json::from_value(arguments)?;
    if req
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .is_none()
    {
        req.cwd = Some(crate::collab::runtime_cwd_from_env()?);
    }
    Ok(req)
}

fn provider_overrides_from_env() -> Vec<ProviderPathOverride> {
    let raw = match std::env::var("CLAUDINAL_COLLAB_PROVIDER_PATHS") {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    let parsed =
        serde_json::from_str::<std::collections::HashMap<String, String>>(&raw).unwrap_or_default();
    parsed
        .into_iter()
        .map(|(provider, path)| ProviderPathOverride { provider, path })
        .collect()
}

fn tool_text(value: Value) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
            }
        ]
    })
}

fn tool_error(message: String) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": message
            }
        ],
        "isError": true
    })
}
