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
    workspace: PathBuf,
    next_id: u64,
}

fn main() {
    let workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut srv = Server { sessions: HashMap::new(), workspace, next_id: 1 };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(stdout, "{}", json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":format!("parse error: {e}")}}));
                let _ = stdout.flush();
                continue;
            }
        };
        // Notifications (no id) get no response.
        let id = req.get("id").cloned();
        let method = req["method"].as_str().unwrap_or("");
        let params = req.get("params").cloned().unwrap_or(Value::Null);
        let response = match method {
            "initialize" => Some(Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "myco-rt", "version": env!("CARGO_PKG_VERSION")},
            }))),
            "notifications/initialized" => None,
            "ping" => Some(Ok(json!({}))),
            "tools/list" => Some(Ok(json!({"tools": tool_defs()}))),
            "tools/call" => Some(srv.call_tool(&params)),
            other => Some(Err((-32601, format!("method not found: {other}")))),
        };
        if let (Some(id), Some(res)) = (id, response) {
            let msg = match res {
                Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                Err((code, message)) => json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
            };
            let _ = writeln!(stdout, "{msg}");
            let _ = stdout.flush();
        }
    }
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
        let mut cfg = QemuConfig::for_repo(&self.workspace, &token);
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
        Ok(json!({"ok": true, "outcome": format!("{outcome:?}")}))
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
