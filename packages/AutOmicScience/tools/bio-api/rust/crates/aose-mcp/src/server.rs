//! Minimal MCP server over a stdio transport.
//!
//! This is the symmetric counterpart to the MCP *client* in this crate: where
//! the client connects out to external MCP servers, [`serve_stdio`] turns an
//! [`aose_core::ToolSet`] into an MCP server that any MCP client (including the
//! Magenta3 harness) can spawn and drive over stdin/stdout.
//!
//! The transport is newline-delimited JSON-RPC 2.0 — one JSON object per line —
//! matching the stdio transport every MCP client speaks. Only the subset the
//! harness needs is implemented: the `initialize` handshake, the
//! `notifications/initialized` notification (accepted and ignored), `tools/list`
//! discovery, and `tools/call` dispatch. Tool schemas come straight from each
//! tool's [`aose_core::ToolDefinition`], so no schema is hand-authored here.

use anyhow::Result;
use aose_core::{ExecutionContext, ToolSet};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// MCP protocol revision this server implements.
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

/// JSON-RPC standard error code for an unknown method.
const METHOD_NOT_FOUND: i64 = -32601;
/// JSON-RPC standard error code for invalid params.
const INVALID_PARAMS: i64 = -32602;

/// Serve the given [`ToolSet`] as an MCP server over stdin/stdout until EOF.
///
/// `server_name` is reported to the client during `initialize`. The function
/// returns when stdin reaches EOF (the client disconnected) or on an
/// unrecoverable IO error.
pub async fn serve_stdio(tools: Arc<ToolSet>, server_name: &str) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(stdin).lines();

    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => {
                // Not valid JSON: we cannot recover an id, so skip it. Per
                // JSON-RPC, parse errors on a stream without an id are dropped.
                continue;
            }
        };

        let Some(response) = handle_message(&tools, server_name, &request).await else {
            // Notification (no id): no response is sent.
            continue;
        };

        let mut serialized = serde_json::to_string(&response)?;
        serialized.push('\n');
        stdout.write_all(serialized.as_bytes()).await?;
        stdout.flush().await?;
    }

    Ok(())
}

/// Handle a single JSON-RPC message. Returns `Some(response)` for requests and
/// `None` for notifications (messages without an `id`).
async fn handle_message(tools: &ToolSet, server_name: &str, request: &Value) -> Option<Value> {
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let id = request.get("id").cloned();
    let params = request.get("params").cloned().unwrap_or(Value::Null);

    // Notifications carry no id and never receive a response.
    if id.is_none() {
        return None;
    }
    let id = id.unwrap_or(Value::Null);

    match method {
        "initialize" => Some(success(id, initialize_result(server_name))),
        "tools/list" => Some(success(id, tools_list_result(tools))),
        "tools/call" => Some(tools_call_response(tools, id, &params).await),
        "ping" => Some(success(id, json!({}))),
        _ => Some(error(
            id,
            METHOD_NOT_FOUND,
            &format!("method not found: {method}"),
        )),
    }
}

/// Build the `initialize` result advertising tool capability.
fn initialize_result(server_name: &str) -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": server_name,
            "version": env!("CARGO_PKG_VERSION"),
        }
    })
}

/// Map the tool set's definitions into MCP `tools/list` entries. Each tool's
/// JSON-Schema `parameters` becomes the MCP `inputSchema`.
fn tools_list_result(tools: &ToolSet) -> Value {
    let entries = tools
        .list()
        .into_iter()
        .map(|def| {
            json!({
                "name": def.name,
                "description": def.description,
                "inputSchema": def.parameters,
            })
        })
        .collect::<Vec<_>>();
    json!({ "tools": entries })
}

/// Dispatch a `tools/call` request through the tool set and wrap the textual
/// result in MCP content.
async fn tools_call_response(tools: &ToolSet, id: Value, params: &Value) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return error(id, INVALID_PARAMS, "tools/call requires a string \"name\"");
    };
    if !tools.has(name) {
        return error(id, INVALID_PARAMS, &format!("unknown tool: {name}"));
    }

    // MCP sends arguments under "arguments"; normalize a missing/null value to
    // an empty object so tools that take no arguments still receive `{}`.
    let args = match params.get("arguments") {
        Some(Value::Null) | None => json!({}),
        Some(value) => value.clone(),
    };

    let result = tools.execute(name, args, ExecutionContext::default()).await;
    // The tool set reports failures in-band rather than via a Result: a failed
    // execution returns a ToolResult whose `metadata.errorCode` is set (e.g.
    // "tool_not_found", "invalid_input") and whose `content` holds the message.
    // Map the presence of an errorCode to the MCP `isError` flag so clients can
    // distinguish failures from successful output.
    let is_error = result
        .metadata
        .as_ref()
        .and_then(|meta| meta.get("errorCode"))
        .is_some();
    success(
        id,
        json!({
            "content": [ { "type": "text", "text": result.content } ],
            "isError": is_error,
        }),
    )
}

/// Build a JSON-RPC success response.
fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Build a JSON-RPC error response.
fn error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}
