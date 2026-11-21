//! `myco-rt` — the six runtime ops with JSON in / JSON out (ADR-0013).
//!
//! Usage: `myco-rt <op> ['<json-args>']`
//!   create | observe | act | evidence | reset | destroy
//!
//! Each invocation is its own process, so the session is described by a small
//! state file (`$MYCO_RT_STATE`, default `<repo>/runtime/state/session.json`).
//! `create` writes it; every other op attaches to the guest it names. For a
//! long-lived session with accumulating evidence, use the MCP server instead —
//! it keeps the recorder in memory.

use myco_rt_backend_qemu::{QemuConfig, QemuLinuxBackend};
use myco_rt_core::ops::Action;
use myco_rt_core::{Backend, Session, SessionConfig, Permissions};
use serde_json::{json, Value};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let op = args.first().cloned().unwrap_or_default();
    let payload: Value = args
        .get(1)
        .map(|s| serde_json::from_str(s).unwrap_or(Value::Null))
        .unwrap_or(Value::Null);

    match run(&op, payload) {
        Ok(v) => println!("{v}"),
        Err(e) => {
            println!("{}", json!({"ok": false, "op": op, "error": e}));
            std::process::exit(1);
        }
    }
}

fn state_path() -> PathBuf {
    std::env::var("MYCO_RT_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("runtime/state/session.json"))
}

fn workspace() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn load_session(state: &PathBuf) -> Result<(String, String), String> {
    let text = std::fs::read_to_string(state)
        .map_err(|e| format!("no session state at {} ({e}); run `myco-rt create`", state.display()))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("corrupt session state: {e}"))?;
    Ok((
        v["session_id"].as_str().unwrap_or("session").to_string(),
        v["token"].as_str().unwrap_or("").to_string(),
    ))
}

fn backend(session_id: &str, token: &str) -> QemuLinuxBackend {
    let ws = workspace();
    let mut cfg = QemuConfig::for_repo(&ws, token);
    cfg.session_id = session_id.to_string();
    QemuLinuxBackend::new(cfg)
}

/// A fresh overlay runs cloud-init in the background after the channel is up, so
/// the GUI can lag the boot by minutes. Wait for readiness with a bounded retry
/// instead of returning a confusing one-shot failure.
fn wait_observe(be: &mut QemuLinuxBackend) -> Result<myco_rt_core::Observation, String> {
    let mut last = String::new();
    for _ in 0..40 {
        match be.observe() {
            Ok(o) => return Ok(o),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(std::time::Duration::from_secs(3));
            }
        }
    }
    Err(format!("desktop did not become observable within 120s: {last}"))
}

fn run(op: &str, payload: Value) -> Result<Value, String> {
    match op {
        "create" => {
            let session_id = payload["session_id"]
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("session-{}", std::process::id()));
            let token = payload["token"].as_str().unwrap_or("myco-rt-cli").to_string();
            let ws = workspace();
            let mut cfg = QemuConfig::for_repo(&ws, &token);
            cfg.session_id = session_id.clone();
            let mut session = Session::new_creating(
                SessionConfig {
                    session_id: session_id.clone(),
                    permissions: Permissions::default(),
                    idle_timeout: None,
                },
                QemuLinuxBackend::new(cfg),
            );
            // provision() already waits for a usable desktop (desktop_timeout),
            // so no second readiness loop belongs here.
            session.create().map_err(|e| e.to_string())?;
            let obs = session.observe().map_err(|e| e.to_string())?;
            let state = state_path();
            if let Some(dir) = state.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(
                &state,
                serde_json::to_string_pretty(&json!({
                    "session_id": session_id,
                    "token": token,
                }))
                .unwrap(),
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({
                "ok": true,
                "op": "create",
                "session_id": session_id,
                "state_version": obs.state_version.0,
                "nodes": obs.a11y_tree["nodes"].as_array().map(|a| a.len()).unwrap_or(0),
            }))
        }
        "observe" => {
            let (id, token) = load_session(&state_path())?;
            let mut be = backend(&id, &token);
            // Attach: boot is idempotent and returns immediately for a live guest.
            be.provision().map_err(|e| e.to_string())?;
            let obs = wait_observe(&mut be)?;
            Ok(json!({
                "ok": true,
                "op": "observe",
                "state_version": obs.state_version.0,
                "a11y_tree": obs.a11y_tree,
                "windows": obs.windows,
                "processes_count": obs.processes.len(),
                "screenshot": obs.screenshot_artifact,
            }))
        }
        "act" => {
            let (id, token) = load_session(&state_path())?;
            let mut be = backend(&id, &token);
            be.provision().map_err(|e| e.to_string())?;
            let obs = wait_observe(&mut be)?;
            // Refs are scoped to one agent process (and thus one CLI invocation), so
            // a ref from a previous invocation is meaningless here. The CLI therefore
            // resolves the target by NAME against this invocation's observation; a
            // raw `target` ref is refused with an explanation rather than silently
            // retargeted.
            let mut action_json = payload.clone();
            let kind = action_json["kind"].as_str().unwrap_or("").to_string();
            if matches!(kind.as_str(), "click" | "typeText") {
                let Some(name) = action_json["name"].as_str().map(|s| s.to_string()) else {
                    return Err(
                        "act over the CLI needs `name` (a target's accessible name), not `target`: \
                         refs are scoped to one agent session — use the MCP server to act on refs"
                            .into(),
                    );
                };
                let nodes = obs.a11y_tree["nodes"].as_array().cloned().unwrap_or_default();
                let node = resolve_by_name(&nodes, &name)?;
                let r = node["ref"].as_str().ok_or("node without a ref")?.to_string();
                // The wire form of a ref is a string; bind it to the version of the
                // observation it was just resolved from.
                action_json["target"] = json!({
                    "payload": r,
                    "issued_at": obs.state_version.0,
                });
                action_json.as_object_mut().unwrap().remove("name");
            }
            let action: Action = serde_json::from_value(action_json)
                .map_err(|e| format!("malformed action: {e}"))?;
            let outcome = be.act(&action).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true, "op": "act", "outcome": outcome_json(&outcome)}))
        }
        "evidence" => {
            let (id, token) = load_session(&state_path())?;
            let mut be = backend(&id, &token);
            be.provision().map_err(|e| e.to_string())?;
            let art = be.evidence().map_err(|e| e.to_string())?;
            Ok(json!({"ok": true, "op": "evidence", "trace": art.trace_path, "result": art.result_path}))
        }
        "reset" => {
            let (id, token) = load_session(&state_path())?;
            let mut be = backend(&id, &token);
            be.provision().map_err(|e| e.to_string())?;
            be.reset().map_err(|e| e.to_string())?;
            Ok(json!({"ok": true, "op": "reset"}))
        }
        "destroy" => {
            let (id, token) = load_session(&state_path())?;
            let mut be = backend(&id, &token);
            be.destroy().map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(state_path());
            Ok(json!({"ok": true, "op": "destroy"}))
        }
        "" => Err("usage: myco-rt <create|observe|act|evidence|reset|destroy> ['<json>']".into()),
        other => Err(format!("unknown op {other:?}")),
    }
}

/// Resolve a target by accessible name, refusing ambiguity instead of guessing.
///
/// Exact matches win; two exact matches, or only substring matches, is an error
/// naming the candidates — silently picking the first node in tree order would
/// retarget a click to the wrong control (review M2).
fn resolve_by_name<'a>(nodes: &'a [Value], name: &str) -> Result<&'a Value, String> {
    if name.is_empty() {
        return Err("target name must not be empty".to_string());
    }
    let exact: Vec<&Value> = nodes
        .iter()
        .filter(|n| n["name"].as_str() == Some(name))
        .collect();
    match exact.len() {
        1 => return Ok(exact[0]),
        0 => {}
        _ => {
            return Err(format!(
                "ambiguous target {name:?}: {} nodes share that exact name ({});                  re-observe and use a unique target",
                exact.len(),
                describe(&exact)
            ))
        }
    }
    let sub: Vec<&Value> = nodes
        .iter()
        .filter(|n| n["name"].as_str().map(|s| s.contains(name)).unwrap_or(false))
        .collect();
    match sub.len() {
        0 => Err(format!("no node named {name:?} in the current observation")),
        1 => Ok(sub[0]),
        _ => Err(format!(
            "ambiguous target {name:?}: {} nodes contain that name ({}); be more specific",
            sub.len(),
            describe(&sub)
        )),
    }
}

fn describe(nodes: &[&Value]) -> String {
    nodes
        .iter()
        .take(5)
        .map(|n| {
            format!(
                "{:?} ({})",
                n["name"].as_str().unwrap_or(""),
                n["role"].as_str().unwrap_or("?")
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The ADR-0003 three-way outcome as structured data, not a Debug string: a
/// client must be able to branch on it without parsing Rust syntax (review M4).
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

    fn nodes() -> Vec<Value> {
        vec![
            json!({"ref": "n0", "role": "frame", "name": "Untitled — Editor"}),
            json!({"ref": "n1", "role": "push button", "name": "OK"}),
            json!({"ref": "n2", "role": "push button", "name": "OK"}),
            json!({"ref": "n3", "role": "menu", "name": "File"}),
            json!({"ref": "n4", "role": "push button", "name": "Open File"}),
        ]
    }

    #[test]
    fn exact_unique_name_resolves() {
        let n = nodes();
        let f = resolve_by_name(&n, "File").unwrap();
        assert_eq!(f["ref"], "n3", "exact match must win over the substring match");
    }

    #[test]
    fn duplicate_exact_names_are_refused_not_guessed() {
        let err = resolve_by_name(&nodes(), "OK").unwrap_err();
        assert!(err.contains("ambiguous"), "{err}");
        assert!(err.contains("2 nodes"), "{err}");
    }

    #[test]
    fn multiple_substring_matches_are_refused() {
        // "File" matches the exact menu AND the "Open File" button by substring;
        // the exact match wins, so a second, non-exact query must be refused.
        let n = vec![
            json!({"ref": "n0", "role": "push button", "name": "Save File"}),
            json!({"ref": "n1", "role": "push button", "name": "Open File"}),
        ];
        let err = resolve_by_name(&n, "File").unwrap_err();
        assert!(err.contains("ambiguous"), "{err}");
        assert!(err.contains("2 nodes"), "{err}");
    }

    #[test]
    fn empty_name_is_refused() {
        assert!(resolve_by_name(&nodes(), "").is_err());
    }

    #[test]
    fn unknown_name_is_refused() {
        assert!(resolve_by_name(&nodes(), "Nonexistent").is_err());
    }

    #[test]
    fn outcomes_serialize_as_data_not_debug_text() {
        use myco_rt_core::ops::ActionOutcome;
        assert_eq!(outcome_json(&ActionOutcome::DeliveredVerified)["kind"], "delivered_verified");
        let f = outcome_json(&ActionOutcome::Failed { reason: "boom".into() });
        assert_eq!(f["kind"], "failed");
        assert_eq!(f["reason"], "boom");
        assert!(f.get("reason").is_some());
    }
}
