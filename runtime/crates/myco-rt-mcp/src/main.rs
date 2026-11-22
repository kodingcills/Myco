//! `myco-rt-mcp` — MCP server (stdio, newline-delimited JSON-RPC 2.0).
//!
//! Exposes exactly the six ops as tools (ADR-0013). Sessions live in this process,
//! so evidence accumulates and refs stay valid for the observation they came from.

use myco_rt_backend_qemu::{QemuConfig, QemuLinuxBackend};
use myco_rt_core::ops::Action;
use myco_rt_core::{Session, SessionConfig, Permissions};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;

const PROTOCOL_VERSION: &str = "2024-11-05";

struct Server {
    sessions: HashMap<String, Session<QemuLinuxBackend>>,
    /// `Err` carries the remediation message; tools/list still works, `create` reports it.
    workspace: Result<PathBuf, String>,
    next_id: u64,
}

fn main() {
    let workspace = myco_rt_backend_qemu::workspace::discover();
    if let Err(e) = &workspace {
        // Don't die: tools/list must still work; `create` returns this to the agent.
        eprintln!("myco-rt-mcp: {e}");
    }
    let mut srv = Server { sessions: HashMap::new(), workspace, next_id: 1 };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = handle_line(&mut srv, &line) {
            let _ = writeln!(stdout, "{reply}");
            let _ = stdout.flush();
        }
    }
}

/// Handle one wire line. Returns the reply (if any); `None` for notifications.
///
/// Protocol rules this enforces (JSON-RPC 2.0 + MCP):
/// - a batch (top-level array) is not supported by MCP here: `-32600`, not a
///   misleading `-32601` with an empty method name;
/// - `"id": null` is a *request* with a null id and MUST get a reply, unlike a
///   notification which has no `id` member at all;
/// - a missing/invalid `method` is `-32600` invalid request;
/// - unknown methods are `-32601`;
/// - malformed JSON is `-32700` and the server keeps running.
fn handle_line(srv: &mut Server, line: &str) -> Option<String> {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            // Log the detail locally; keep the wire reply uniform and free of
            // fragments of the offending input.
            eprintln!("myco-rt-mcp: parse error: {e}");
            return Some(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}})
                    .to_string(),
            )
        }
    };

    if req.is_array() {
        return Some(
            json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"batch requests are not supported"}})
                .to_string(),
        );
    }

    // `id: null` is a request (reply required); absent `id` is a notification.
    let id_member = req.get("id").cloned();
    let has_id = id_member.is_some();
    let id = id_member.clone().unwrap_or(Value::Null);

    // Invalid-request handling MUST also respect the no-reply rule: a message with
    // no `id` is a notification, so a malformed one gets silence, not -32600
    // with id:null (JSON-RPC 2.0 §4.1).
    let invalid = |code: i64, msg: &str| -> Option<String> {
        if !has_id {
            return None;
        }
        Some(
            json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":msg}}).to_string(),
        )
    };

    if req.get("jsonrpc").and_then(|v| v.as_str()) != Some("2.0") {
        return invalid(-32600, "invalid request: jsonrpc must be \"2.0\"");
    }

    let Some(method) = req.get("method").and_then(|m| m.as_str()) else {
        return invalid(-32600, "invalid request: missing method");
    };
    let params = req.get("params").cloned().unwrap_or(Value::Null);

    let response = match method {
        "initialize" => {
            // Negotiation: echo the client's version when we support it, otherwise
            // reply with ours so the client can decide whether to proceed.
            let requested = params.get("protocolVersion").and_then(|v| v.as_str());
            let negotiated = match requested {
                Some(v) if v == PROTOCOL_VERSION => v,
                _ => PROTOCOL_VERSION,
            };
            if requested != Some(PROTOCOL_VERSION) {
                eprintln!(
                    "myco-rt-mcp: client requested protocol {requested:?}, replying {PROTOCOL_VERSION}"
                );
            }
            Some(Ok(json!({
                "protocolVersion": negotiated,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "myco-rt", "version": env!("CARGO_PKG_VERSION")},
            })))
        }
        "notifications/initialized" => None,
        "ping" => Some(Ok(json!({}))),
        "tools/list" => Some(Ok(json!({"tools": tool_defs()}))),
        "tools/call" => Some(srv.call_tool(&params)),
        other => Some(Err((-32601, format!("method not found: {other}")))),
    };

    let res = response?;
    if !has_id {
        // A notification that produced a result still gets no reply.
        return None;
    }
    Some(match res {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}).to_string(),
        Err((code, message)) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}).to_string()
        }
    })
}

fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "create",
            "description": "Provision a disposable Linux desktop and return a session id.",
            "inputSchema": {"type":"object","properties":{
                "session_id": {"type":"string"},
                "token": {"type":"string"}
            }}
        }),
        json!({
            "name": "observe",
            "description": "Read desktop state: accessibility tree with refs, windows, processes, screenshot path, app introspection record.",
            "inputSchema": {"type":"object","required":["session_id"],"properties":{"session_id":{"type":"string"}}}
        }),
        json!({
            "name": "act",
            "description": "Perform one action (launch, click, typeText, keyPress) with a three-way outcome.",
            "inputSchema": {"type":"object","required":["session_id","action"],"properties":{
                "session_id": {"type":"string"},
                "action": {"type":"object"}
            }}
        }),
        json!({
            "name": "evidence",
            "description": "Export this session's trace.jsonl and result.json (M1 schema, recordKind=session).",
            "inputSchema": {"type":"object","required":["session_id"],"properties":{"session_id":{"type":"string"}}}
        }),
        json!({
            "name": "reset",
            "description": "Return the session's desktop to a clean base.",
            "inputSchema": {"type":"object","required":["session_id"],"properties":{"session_id":{"type":"string"}}}
        }),
        json!({
            "name": "destroy",
            "description": "Tear the session down and free its resources.",
            "inputSchema": {"type":"object","required":["session_id"],"properties":{"session_id":{"type":"string"}}}
        }),
    ]
}

impl Server {
    fn call_tool(&mut self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params["name"].as_str().ok_or((-32602, "missing tool name".to_string()))?;
        let args = params.get("arguments").cloned().unwrap_or(json!({}));
        let out = match name {
            "create" => self.create(&args),
            "observe" => self.observe(&args),
            "act" => self.act(&args),
            "evidence" => self.evidence(&args),
            "reset" => self.reset(&args),
            "destroy" => self.destroy(&args),
            other => Err((-32602, format!("unknown tool {other}"))),
        };
        match out {
            Ok(v) => Ok(json!({
                "content": [{"type": "text", "text": v.to_string()}],
                "isError": false,
            })),
            Err((code, msg)) => {
                // Tool-level failures are reported inside the result (MCP convention),
                // with the code preserved so an agent can branch on it.
                Ok(json!({
                    "content": [{"type":"text","text": json!({"ok":false,"code":code,"error":msg}).to_string()}],
                    "isError": true,
                }))
            }
        }
    }

    fn session(&mut self, args: &Value) -> Result<&mut Session<QemuLinuxBackend>, (i64, String)> {
        let id = args["session_id"]
            .as_str()
            .ok_or((-32602, "missing session_id".to_string()))?;
        self.sessions
            .get_mut(id)
            .ok_or((-32602, format!("unknown session {id}")))
    }

    fn create(&mut self, args: &Value) -> Result<Value, (i64, String)> {
        let id = args["session_id"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                self.next_id += 1;
                format!("session-{}", self.next_id)
            });
        if self.sessions.contains_key(&id) {
            return Err((-32602, format!("session {id} already exists")));
        }
        let token = args["token"].as_str().unwrap_or("myco-rt-mcp").to_string();
        let workspace = self.workspace.as_ref().map_err(|e| (-32000, e.clone()))?;
        let mut cfg = QemuConfig::for_repo(workspace, &token);
        cfg.session_id = id.clone();
        let mut session = Session::new_creating(
            SessionConfig {
                session_id: id.clone(),
                permissions: Permissions::default(),
                idle_timeout: None,
            },
            QemuLinuxBackend::new(cfg),
        );
        session.create().map_err(|e| (-32000, e.to_string()))?;
        self.sessions.insert(id.clone(), session);
        Ok(json!({"ok": true, "session_id": id}))
    }

    fn observe(&mut self, args: &Value) -> Result<Value, (i64, String)> {
        let s = self.session(args)?;
        let obs = s.observe().map_err(|e| (-32000, e.to_string()))?;
        Ok(json!({
            "ok": true,
            "state_version": obs.state_version.0,
            "a11y_tree": obs.a11y_tree,
            "windows": obs.windows,
            "processes_count": obs.processes.len(),
            "screenshot": obs.screenshot_artifact,
        }))
    }

    fn act(&mut self, args: &Value) -> Result<Value, (i64, String)> {
        // Agents get refs as strings from `observe`; the wire form for an action
        // target is therefore a string, bound to the session's current version.
        let mut action_json = args["action"].clone();
        let kind = action_json["kind"].as_str().unwrap_or("").to_string();
        if matches!(kind.as_str(), "click" | "typeText") {
            let target = action_json.get("target").cloned().unwrap_or(Value::Null);
            if let Some(ref_str) = target.as_str() {
                let version = self
                    .sessions
                    .get(args["session_id"].as_str().unwrap_or(""))
                    .map(|s| s.state_version().0)
                    .ok_or((-32602, "unknown session".to_string()))?;
                action_json["target"] = json!({
                    "payload": ref_str,
                    "issued_at": version,
                });
            }
        }
        let action: Action = serde_json::from_value(action_json)
            .map_err(|e| (-32602, format!("malformed action: {e}")))?;
        let s = self.session(args)?;
        let outcome = s.act(&action).map_err(|e| (-32000, e.to_string()))?;
        Ok(json!({"ok": true, "outcome": outcome_json(&outcome)}))
    }

    fn evidence(&mut self, args: &Value) -> Result<Value, (i64, String)> {
        let s = self.session(args)?;
        let art = s.evidence().map_err(|e| (-32000, e.to_string()))?;
        Ok(json!({"ok": true, "trace": art.trace_path, "result": art.result_path}))
    }

    fn reset(&mut self, args: &Value) -> Result<Value, (i64, String)> {
        let s = self.session(args)?;
        s.reset().map_err(|e| (-32000, e.to_string()))?;
        Ok(json!({"ok": true}))
    }

    fn destroy(&mut self, args: &Value) -> Result<Value, (i64, String)> {
        let id = args["session_id"].as_str().unwrap_or("").to_string();
        let mut s = self
            .sessions
            .remove(&id)
            .ok_or((-32602, format!("unknown session {id}")))?;
        s.destroy().map_err(|e| (-32000, e.to_string()))?;
        Ok(json!({"ok": true}))
    }
}

/// The ADR-0003 three-way outcome as structured data (review M4): a client must
/// branch on `kind`, never parse a Rust Debug string.
fn outcome_json(outcome: &myco_rt_core::ops::ActionOutcome) -> Value {
    use myco_rt_core::ops::ActionOutcome::*;
    match outcome {
        DeliveredVerified => json!({"kind": "delivered_verified"}),
        DeliveredUnverified => json!({"kind": "delivered_unverified"}),
        Failed { reason } => json!({"kind": "failed", "reason": reason}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn srv() -> Server {
        Server { sessions: HashMap::new(), workspace: Ok(PathBuf::from(".")), next_id: 1 }
    }

    #[test]
    fn create_without_workspace_returns_the_fix_and_never_boots() {
        let mut s = Server {
            sessions: HashMap::new(),
            workspace: Err("no Myco workspace found. Fix: set MYCO_HOME=/path/to/Myco".into()),
            next_id: 1,
        };
        let r = reply(
            &mut s,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create","arguments":{}}}"#,
        );
        assert_eq!(r["result"]["isError"], true);
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("MYCO_HOME"), "{text}");
        assert!(s.sessions.is_empty());
    }

    fn reply(s: &mut Server, line: &str) -> Value {
        serde_json::from_str(&handle_line(s, line).expect("expected a reply")).unwrap()
    }

    #[test]
    fn initialize_returns_protocol_and_server_info() {
        let mut s = srv();
        let r = reply(&mut s, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#);
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(r["result"]["serverInfo"]["name"], "myco-rt");
    }

    #[test]
    fn notification_gets_no_reply() {
        let mut s = srv();
        assert!(handle_line(&mut s, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).is_none());
    }

    #[test]
    fn null_id_is_a_request_and_gets_a_reply() {
        // JSON-RPC: id:null is a request (reply required), unlike an absent id.
        let mut s = srv();
        let r = reply(&mut s, r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#);
        assert!(r.get("result").is_some(), "{r}");
        assert!(r["id"].is_null());
    }

    #[test]
    fn batch_is_invalid_request_not_unknown_method() {
        let mut s = srv();
        let r = reply(&mut s, r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#);
        assert_eq!(r["error"]["code"], -32600, "{r}");
    }

    #[test]
    fn unknown_method_is_32601() {
        let mut s = srv();
        let r = reply(&mut s, r#"{"jsonrpc":"2.0","id":2,"method":"bogus/method"}"#);
        assert_eq!(r["error"]["code"], -32601);
        assert!(r["error"]["message"].as_str().unwrap().contains("bogus/method"));
    }

    #[test]
    fn missing_method_is_invalid_request() {
        let mut s = srv();
        let r = reply(&mut s, r#"{"jsonrpc":"2.0","id":3}"#);
        assert_eq!(r["error"]["code"], -32600, "{r}");
    }

    #[test]
    fn malformed_json_is_parse_error_and_server_survives() {
        let mut s = srv();
        let r = reply(&mut s, "{not json");
        assert_eq!(r["error"]["code"], -32700);
        assert_eq!(r["error"]["message"], "parse error", "must not echo input fragments");
        // and the next request still works
        let r2 = reply(&mut s, r#"{"jsonrpc":"2.0","id":4,"method":"tools/list"}"#);
        assert!(r2["result"]["tools"].as_array().unwrap().len() >= 6);
    }

    #[test]
    fn tools_list_exposes_exactly_the_six_ops() {
        let mut s = srv();
        let r = reply(&mut s, r#"{"jsonrpc":"2.0","id":5,"method":"tools/list"}"#);
        let mut names: Vec<&str> = r["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        names.sort_unstable();
        assert_eq!(names, vec!["act", "create", "destroy", "evidence", "observe", "reset"]);
    }

    #[test]
    fn tool_call_with_unknown_session_is_a_tool_error_not_a_protocol_error() {
        let mut s = srv();
        let r = reply(
            &mut s,
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"observe","arguments":{"session_id":"nope"}}}"#,
        );
        // MCP convention: execution failures are results with isError, not JSON-RPC errors.
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("unknown session"));
    }
}

#[cfg(test)]
mod protocol_edge_tests {
    use super::*;
    use std::collections::HashMap;

    fn srv() -> Server {
        Server { sessions: HashMap::new(), workspace: Ok(PathBuf::from(".")), next_id: 1 }
    }

    #[test]
    fn malformed_notification_gets_no_reply() {
        // No `id` member => notification => MUST NOT reply, even though the
        // message is invalid (-32600 would leak a reply with id:null).
        let mut s = srv();
        assert!(handle_line(&mut s, r#"{"jsonrpc":"2.0"}"#).is_none());
        assert!(handle_line(&mut s, r#"{"method":"ping"}"#).is_none(), "missing jsonrpc, no id");
    }

    #[test]
    fn missing_or_wrong_jsonrpc_member_is_invalid_request() {
        let mut s = srv();
        let r: Value = serde_json::from_str(
            &handle_line(&mut s, r#"{"id":1,"method":"ping"}"#).expect("reply"),
        ).unwrap();
        assert_eq!(r["error"]["code"], -32600);

        let r2: Value = serde_json::from_str(
            &handle_line(&mut s, r#"{"jsonrpc":"1.0","id":2,"method":"ping"}"#).expect("reply"),
        ).unwrap();
        assert_eq!(r2["error"]["code"], -32600);
    }

    #[test]
    fn initialize_negotiates_protocol_version() {
        let mut s = srv();
        // Supported version: echoed.
        let r: Value = serde_json::from_str(&handle_line(&mut s,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#
        ).expect("reply")).unwrap();
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSION);

        // Unknown version: we reply with ours so the client can decide.
        let r2: Value = serde_json::from_str(&handle_line(&mut s,
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#
        ).expect("reply")).unwrap();
        assert_eq!(r2["result"]["protocolVersion"], PROTOCOL_VERSION);
    }
}
