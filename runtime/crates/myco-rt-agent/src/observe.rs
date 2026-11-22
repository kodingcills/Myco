//! `observe` op (RT-007): AT-SPI tree + screenshot + process/window info.
//!
//! Runs inside the guest as the `myco` uid (per-uid AT-SPI registries — RT-003).
//! Refs are opaque and bound to a state version; the host never interprets them.
//!
//! Refs carry the element's **positional path** in the tree, not just an identity
//! fingerprint: resolving by `(role, name, pid)` alone would silently pick the first
//! of two identical siblings (e.g. two "Save" buttons) and click the wrong one.
//! The path lets `find_element` walk straight to the exact node and verify identity
//! on arrival — O(depth), and a mismatch is an error rather than a guess.

use serde::Serialize;
use std::collections::HashMap;

/// Hard cap on tree nodes per observation (UFO query-shape lesson, ADR-0003).
pub const MAX_NODES: usize = 2000;
/// Hard cap on traversal depth.
pub const MAX_DEPTH: usize = 24;

#[derive(Debug, Serialize, Clone)]
pub struct Node {
    /// Opaque ref: `n<index>` within this observation. Valid only for `state_version`.
    pub r#ref: String,
    pub role: String,
    pub name: Option<String>,
    pub value: Option<String>,
    pub description: Option<String>,
    pub bounds: Option<[f64; 4]>,
    pub actions: Vec<String>,
    pub pid: Option<u32>,
    /// Child indices from the session root: `[app_idx, child_idx, ...]`.
    /// Opaque to the host; used by the agent to resolve the ref exactly.
    pub path: Vec<usize>,
    pub children: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    pub pid: u32,
}

#[derive(Debug, Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct Observation {
    pub state_version: u64,
    /// Number of applications AT-SPI reported. `0` is never returned as success
    /// by the op handler (see `branch::obs_error_if_empty_desktop`).
    pub app_count: usize,
    pub nodes: Vec<Node>,
    pub roots: Vec<String>,
    pub windows: Vec<WindowInfo>,
    pub processes: Vec<ProcessInfo>,
    pub screenshot_path: Option<String>,
    /// ADR-0016: `None` = not configured, `Some(record)` = read OK,
    /// `Some({"unavailable": reason})` = configured but unreadable.
    pub introspection: Option<serde_json::Value>,
    pub truncated: bool,
}

/// Build one observation. `state_version` is supplied by the agent (monotonic per
/// session); `screenshot_path` is where the PNG was written, if capture worked.
pub fn observe(state_version: u64, screenshot_path: Option<String>) -> Result<Observation, String> {
    let provider = xa11y::provider().map_err(|e| format!("provider: {e}"))?;

    let mut nodes: Vec<Node> = Vec::new();
    let mut roots: Vec<String> = Vec::new();
    let mut windows: Vec<WindowInfo> = Vec::new();
    let mut truncated = false;

    let apps = provider.list_apps().map_err(|e| format!("list_apps: {e}"))?;
    let app_count = apps.len();

    for (app_idx, app) in apps.iter().enumerate() {
        let app_path = vec![app_idx];
        let app_ref = push_node(&mut nodes, app, app_path.clone());
        roots.push(app_ref.clone());

        // One-pass DFS: children are enumerated once, in tree order, so the path
        // built here is exactly the path `find_element` walks back.
        let mut stack: Vec<(xa11y::Element, Vec<usize>)> = vec![(
            xa11y::Element::new(app.clone(), provider.clone()),
            app_path.clone(),
        )];
        while let Some((el, path)) = stack.pop() {
            if path.len() >= MAX_DEPTH {
                continue;
            }
            let Ok(children) = el.children() else { continue };
            let parent_ref = nodes
                .iter()
                .find(|n| n.path == path)
                .map(|n| n.r#ref.clone());
            let mut child_refs = Vec::with_capacity(children.len());
            for (c_idx, child) in children.into_iter().enumerate() {
                let mut cpath = path.clone();
                cpath.push(c_idx);
                let cref = push_node(&mut nodes, child.data(), cpath.clone());
                child_refs.push(cref.clone());
                stack.push((child, cpath));
                if nodes.len() >= MAX_NODES {
                    truncated = true;
                    break;
                }
            }
            if let Some(pref) = parent_ref {
                if let Some(node) = nodes.iter_mut().find(|n| n.r#ref == pref) {
                    node.children.extend(child_refs);
                }
            }
            if truncated {
                break;
            }
        }

        // Windows are the app's top-level frames — they are ALREADY nodes from the
        // DFS above (an application's AT-SPI children are its windows). Reference
        // them by their DFS-assigned ref instead of pushing synthetic paths, which
        // collided with the DFS index space (adversarial review, fix round 2).
        for node in nodes.iter() {
            if node.path.len() == 2 && node.path[0] == app_idx && is_window_role(&node.role) {
                windows.push(WindowInfo {
                    id: node.r#ref.clone(),
                    title: node.name.clone().unwrap_or_default(),
                    pid: node.pid.unwrap_or(0),
                });
            }
        }
        if truncated {
            break;
        }
    }

    Ok(Observation {
        state_version,
        app_count,
        nodes,
        roots,
        windows,
        processes: list_processes(),
        screenshot_path,
        introspection: read_introspection(),
        truncated,
    })
}

fn push_node(nodes: &mut Vec<Node>, data: &xa11y::ElementData, path: Vec<usize>) -> String {
    let r = format!("n{}", nodes.len());
    nodes.push(Node {
        r#ref: r.clone(),
        role: role_token(&data.role),
        name: data.name.clone(),
        value: data.value.clone(),
        description: data.description.clone(),
        bounds: data.bounds.map(|b| [b.x as f64, b.y as f64, b.width as f64, b.height as f64]),
        actions: data.actions.clone(),
        pid: data.pid,
        path,
        children: Vec::new(),
    });
    r
}

fn role_token(role: &xa11y::Role) -> String {
    format!("{role:?}").to_lowercase()
}

/// Roles that count as a top-level window in the observation's `windows` list.
fn is_window_role(role: &str) -> bool {
    matches!(role, "frame" | "window" | "dialog")
}

/// Resolve a ref by walking its recorded path. Fails loudly on any structural or
/// identity mismatch — never falls back to a first-match search.
pub fn resolve(
    provider: &std::sync::Arc<dyn xa11y::Provider>,
    nodes: &[Node],
    target_ref: &str,
) -> Result<xa11y::Element, String> {
    let idx: usize = target_ref
        .strip_prefix('n')
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("malformed ref {target_ref:?}"))?;
    let want = nodes
        .get(idx)
        .filter(|n| n.r#ref == target_ref)
        .ok_or_else(|| format!("unknown ref {target_ref:?} for this observation"))?;

    let apps = provider.list_apps().map_err(|e| format!("list_apps: {e}"))?;
    let app_idx = *want
        .path
        .first()
        .ok_or_else(|| format!("ref {target_ref:?} has an empty path"))?;
    let app = apps
        .get(app_idx)
        .ok_or_else(|| format!("app {app_idx} vanished since observation"))?;

    let mut el = xa11y::Element::new(app.clone(), provider.clone());
    for step in &want.path[1..] {
        let children = el
            .children()
            .map_err(|e| format!("walk to ref {target_ref:?} failed at depth: {e}"))?;
        el = children
            .into_iter()
            .nth(*step)
            .ok_or_else(|| format!("ref {target_ref:?} path diverged (no child {step})"))?;
    }

    // Identity check on arrival: the tree may have changed under us even within a
    // version (an app mutating without a host-visible action).
    let role = role_token(&el.role);
    if role != want.role || el.name != want.name || el.pid != want.pid {
        return Err(format!(
            "ref {target_ref:?} now resolves to a different element (role {role:?} name {:?} pid {:?}); re-observe",
            el.name, el.pid
        ));
    }
    Ok(el)
}

fn list_processes() -> Vec<ProcessInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else { return out };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let comm = std::fs::read_to_string(entry.path().join("comm")).unwrap_or_default();
        let comm = comm.trim();
        if comm.is_empty() {
            continue;
        }
        out.push(ProcessInfo { pid, name: comm.to_string() });
    }
    out.sort_by_key(|p| p.pid);
    out
}

/// ADR-0016: read the app-side introspection record, with one retry on torn JSON.
fn read_introspection() -> Option<serde_json::Value> {
    let path = std::env::var("MYCO_INTROSPECTION_FILE").ok()?;
    for attempt in 0..2 {
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(v) => return Some(v),
                Err(e) if attempt == 0 => {
                    // Torn read mid-mutation: retry once after a short delay.
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    let _ = e;
                }
                Err(e) => {
                    return Some(serde_json::json!({"unavailable": format!("parse: {e}")}));
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Distinguish "the app has not published yet" from "broken":
                // a consumer must know whether to wait or to investigate.
                return Some(serde_json::json!({"unavailable": "not_published_yet"}));
            }
            Err(e) => {
                return Some(serde_json::json!({"unavailable": format!("read: {e}")}));
            }
        }
    }
    None
}

/// Capture a PNG screenshot to `path`. Returns the path on success.
pub fn capture_screenshot(path: &str) -> Result<String, String> {
    let shot = xa11y::screenshot().map_err(|e| format!("screenshot: {e}"))?;
    shot.save_png(path).map_err(|e| format!("save_png: {e}"))?;
    Ok(path.to_string())
}

/// Refuse to report an empty desktop as a successful observation: a connectable
/// but wrong AT-SPI bus yields exactly that, and the host cannot tell it from a
/// genuinely idle desktop (adversarial review finding #4).
pub fn validate(obs: &Observation) -> Result<(), String> {
    if obs.app_count == 0 {
        return Err(
            "empty AT-SPI desktop: no applications registered. The GUI session is not up, \
             or gui.env points at the wrong bus — refusing to report this as a valid state"
                .to_string(),
        );
    }
    Ok(())
}

/// Unused-import guard for HashMap kept for the ref->path index shape.
#[allow(dead_code)]
fn _unused(_: HashMap<String, Vec<usize>>) {}
