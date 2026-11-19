//! `observe` op (RT-007): AT-SPI tree + screenshot + process/window info.
//!
//! Runs inside the guest as the `myco` uid (per-uid AT-SPI registries — RT-003).
//! Refs are opaque and bound to a state version; the host never interprets them.

use serde::Serialize;
use std::collections::HashMap;

/// Hard cap on tree nodes per observation (UFO query-shape lesson, ADR-0003).
pub const MAX_NODES: usize = 2000;
/// Hard cap on traversal depth.
pub const MAX_DEPTH: usize = 24;

#[derive(Debug, Serialize)]
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
    pub nodes: Vec<Node>,
    pub roots: Vec<String>,
    pub windows: Vec<WindowInfo>,
    pub processes: Vec<ProcessInfo>,
    pub screenshot_path: Option<String>,
    /// Explicit statement about the app-side introspection channel (ADR-0016):
    /// `None` = not configured, `Some(record)` = read successfully,
    /// `Some({"unavailable": reason})` = configured but unreadable.
    pub introspection: Option<serde_json::Value>,
    pub truncated: bool,
}

/// Build one observation. `state_version` is supplied by the agent (monotonic
/// per session); `screenshot_path` is where the PNG was written, if capture worked.
pub fn observe(state_version: u64, screenshot_path: Option<String>) -> Result<Observation, String> {
    let provider = xa11y::provider().map_err(|e| format!("provider: {e}"))?;

    let mut nodes: Vec<Node> = Vec::new();
    let mut roots: Vec<String> = Vec::new();
    let mut windows: Vec<WindowInfo> = Vec::new();
    let mut truncated = false;

    let apps = provider.list_apps().map_err(|e| format!("list_apps: {e}"))?;
    for app in apps {
        let app_ref = push_node(&mut nodes, &app, None);
        roots.push(app_ref.clone());
        if nodes.len() >= MAX_NODES {
            truncated = true;
            break;
        }
        // Windows are first-class in the observation (REQ-03: named window).
        if let Ok(wins) = provider.app_windows(&app) {
            for w in wins {
                let title = w.name.clone().unwrap_or_default();
                let pid = w.pid.unwrap_or(0);
                let wref = push_node(&mut nodes, &w, Some(&app_ref));
                windows.push(WindowInfo { id: wref, title, pid });
                if nodes.len() >= MAX_NODES {
                    truncated = true;
                    break;
                }
            }
        }
        if truncated {
            break;
        }
    }

    // Depth-first expansion of every root, breadth-limited by MAX_NODES.
    let mut queue: Vec<(String, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    while let Some((parent_ref, depth)) = queue.pop() {
        if depth >= MAX_DEPTH {
            continue;
        }
        let Some(parent) = find_element(&provider, &nodes, &parent_ref) else { continue };
        let Ok(children) = parent.children() else { continue };
        for child in children {
            let cref = push_node(&mut nodes, child.data(), Some(&parent_ref));
            if let Some(node) = nodes.iter_mut().find(|n| n.r#ref == parent_ref) {
                node.children.push(cref.clone());
            }
            queue.push((cref, depth + 1));
            if nodes.len() >= MAX_NODES {
                truncated = true;
                break;
            }
        }
        if truncated {
            break;
        }
    }

    let processes = list_processes();
    let introspection = read_introspection();

    Ok(Observation {
        state_version,
        nodes,
        roots,
        windows,
        processes,
        screenshot_path,
        introspection,
        truncated,
    })
}

fn push_node(
    nodes: &mut Vec<Node>,
    data: &xa11y::ElementData,
    _parent: Option<&str>,
) -> String {
    let r = format!("n{}", nodes.len());
    nodes.push(Node {
        r#ref: r.clone(),
        role: format!("{:?}", data.role).to_lowercase(),
        name: data.name.clone(),
        value: data.value.clone(),
        description: data.description.clone(),
        bounds: data.bounds.map(|b| [b.x as f64, b.y as f64, b.width as f64, b.height as f64]),
        actions: data.actions.clone(),
        pid: data.pid,
        children: Vec::new(),
    });
    r
}

/// Re-resolve a ref by walking from the app roots. Refs are positional within
/// one observation, so this is only valid for the version they were issued at;
/// the host enforces that (StaleRefError) before calling.
fn find_element(
    provider: &std::sync::Arc<dyn xa11y::Provider>,
    nodes: &[Node],
    target: &str,
) -> Option<xa11y::Element> {
    let idx: usize = target.strip_prefix('n')?.parse().ok()?;
    let node = nodes.get(idx)?;
    // Walk from each app root, matching by (role, name, pid) — the same identity
    // the node was built from. Ambiguity is resolved by first match; the host's
    // AmbiguousTargetError path covers the act side.
    let apps = provider.list_apps().ok()?;
    for app in apps {
        if node.pid.is_some() && app.pid != node.pid {
            continue;
        }
        let el = xa11y::Element::new(app, provider.clone());
        if let Some(found) = search(&el, node, 0) {
            return Some(found);
        }
    }
    None
}

fn search(el: &xa11y::Element, want: &Node, depth: usize) -> Option<xa11y::Element> {
    if depth > MAX_DEPTH {
        return None;
    }
    let role = format!("{:?}", el.role).to_lowercase();
    if role == want.role && el.name == want.name && el.pid == want.pid {
        return Some(el.clone());
    }
    for child in el.children().ok()? {
        if let Some(found) = search(&child, want, depth + 1) {
            return Some(found);
        }
    }
    None
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
                    let _ = e;
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => {
                    return Some(serde_json::json!({"unavailable": format!("parse: {e}")}));
                }
            },
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

/// Unused-import guard for HashMap in future ref maps.
#[allow(dead_code)]
fn _unused(_: HashMap<String, String>) {}
