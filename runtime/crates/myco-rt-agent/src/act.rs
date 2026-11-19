//! `act` op (RT-008): launch / click / typeText / keyPress with a three-way outcome.
//!
//! Discipline (ADR-0003, ADR-0014):
//! - Never a bare "ok": every action reports `delivered_verified`,
//!   `delivered_unverified`, or `failed`.
//! - AT-SPI write return values are not evidence (agent-desktop post-mortems), so
//!   anything verifiable is verified by re-reading state afterwards.
//! - Refs are bound to the state version of the observation that issued them.

use crate::observe::{resolve, Node};
use serde::Deserialize;
use std::process::{Command, Stdio};

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    Launch {
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Click {
        target: String,
    },
    TypeText {
        target: String,
        text: String,
    },
    KeyPress {
        keys: String,
    },
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Outcome {
    DeliveredVerified { verified_by: String },
    DeliveredUnverified { reason: String },
    Failed { reason: String },
}

/// Cached observation the refs in flight were issued against.
#[derive(Clone)]
pub struct RefCache {
    pub version: u64,
    pub nodes: Vec<Node>,
}

/// Perform one action. `cache` must be the observation whose refs are in use.
pub fn act(
    action: &Action,
    cache: &RefCache,
    request_version: u64,
) -> (Outcome, Option<String>) {
    // Any ref-carrying action is only meaningful against its own observation.
    let needs_refs = matches!(action, Action::Click { .. } | Action::TypeText { .. });
    if needs_refs && request_version != cache.version {
        return (
            Outcome::Failed {
                reason: format!(
                    "stale_ref: action targets state version {request_version}, \
                     current is {}",
                    cache.version
                ),
            },
            Some("stale_ref".into()),
        );
    }

    let provider = match xa11y::provider() {
        Ok(p) => p,
        Err(e) => {
            return (
                Outcome::Failed { reason: format!("provider unavailable: {e}") },
                None,
            )
        }
    };

    match action {
        Action::Launch { command, args } => launch(command, args),
        Action::Click { target } => {
            let el = match resolve(&provider, &cache.nodes, target) {
                Ok(el) => el,
                Err(e) => return (Outcome::Failed { reason: e }, Some("unresolved_ref".into())),
            };
            click(&provider, el)
        }
        Action::TypeText { target, text } => {
            let el = match resolve(&provider, &cache.nodes, target) {
                Ok(el) => el,
                Err(e) => return (Outcome::Failed { reason: e }, Some("unresolved_ref".into())),
            };
            type_text(&provider, el, target, text, &cache.nodes)
        }
        Action::KeyPress { keys } => key_press(keys),
    }
}

fn launch(command: &str, args: &[String]) -> (Outcome, Option<String>) {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Inherit the GUI session env (DISPLAY, bus) so the app joins the desktop.
    crate::load_gui_env();
    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            // Verification: the process is still alive shortly after spawn (a
            // binary that execs and dies — wrong arch, missing lib — fails here).
            std::thread::sleep(std::time::Duration::from_millis(400));
            let alive = std::path::Path::new(&format!("/proc/{pid}")).exists()
                || Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
            if alive {
                (
                    Outcome::DeliveredVerified {
                        verified_by: format!("process_alive pid={pid}"),
                    },
                    None,
                )
            } else {
                (
                    Outcome::Failed {
                        reason: format!("spawned pid {pid} exited immediately"),
                    },
                    Some("process_died".into()),
                )
            }
        }
        Err(e) => (
            Outcome::Failed { reason: format!("spawn failed: {e}") },
            Some("spawn_failed".into()),
        ),
    }
}

fn click(
    provider: &std::sync::Arc<dyn xa11y::Provider>,
    el: xa11y::Element,
) -> (Outcome, Option<String>) {
    // Prefer the structural action (no pointer, works headless): press via AT-SPI.
    let has_press = el.actions.iter().any(|a| a == "press");
    if has_press {
        match provider.press(el.data()) {
            Ok(()) => {
                // Read-back: AT-SPI returning Ok proves nothing on some toolkits.
                // Re-resolve and compare focus/selection state where available.
                return (
                    Outcome::DeliveredUnverified {
                        reason: "at-spi press returned ok; effect not observable for this role"
                            .into(),
                    },
                    Some("press_ok_unverified".into()),
                );
            }
            Err(e) => {
                return (
                    Outcome::Failed { reason: format!("press failed: {e}") },
                    Some("press_error".into()),
                )
            }
        }
    }
    // Fall back to a real pointer click at the element's centre.
    let input = match xa11y::input_sim() {
        Ok(i) => i,
        Err(e) => {
            return (
                Outcome::Failed { reason: format!("input unavailable: {e}") },
                Some("input_unavailable".into()),
            )
        }
    };
    let point = match input.point_for(&el, xa11y::Anchor::Center) {
        Ok(p) => p,
        Err(e) => {
            return (
                Outcome::Failed { reason: format!("no bounds for target: {e}") },
                Some("no_bounds".into()),
            )
        }
    };
    match input.mouse().click(point) {
        Ok(()) => (
            Outcome::DeliveredUnverified {
                reason: "pointer click delivered via XTest; no read-back for this target".into(),
            },
            Some("click_delivered".into()),
        ),
        Err(e) => (
            Outcome::Failed { reason: format!("click failed: {e}") },
            Some("click_error".into()),
        ),
    }
}

fn type_text(
    provider: &std::sync::Arc<dyn xa11y::Provider>,
    el: xa11y::Element,
    target: &str,
    text: &str,
    nodes: &[Node],
) -> (Outcome, Option<String>) {
    // Focus first (semantic), then let the toolkit settle before typing: typing
    // immediately after focus loses the leading characters on GTK.
    let focus_ok = provider.focus(el.data()).is_ok();
    std::thread::sleep(std::time::Duration::from_millis(250));
    let typed = match xa11y::input_sim() {
        Ok(input) => input.keyboard().type_text(text).map_err(|e| e.to_string()),
        Err(e) => Err(format!("input unavailable: {e}")),
    };
    if let Err(e) = typed {
        return (
            Outcome::Failed { reason: format!("type failed: {e}") },
            Some("type_error".into()),
        );
    }
    // Read-back: re-resolve the SAME ref and read the element's text. GTK entries
    // expose the content through the Text interface, not Value (value is usually
    // None there), so both are consulted.
    std::thread::sleep(std::time::Duration::from_millis(200));
    let observed = match resolve(provider, nodes, target) {
        Ok(e) => {
            let from_value = e.value.clone().filter(|v| !v.is_empty());
            from_value.or_else(|| e.text().read_all().ok().filter(|t| !t.is_empty()))
        }
        Err(_) => None,
    };
    match observed {
        Some(v) if v.contains(text) => (
            Outcome::DeliveredVerified {
                verified_by: "value_readback".into(),
            },
            None,
        ),
        Some(v) => (
            Outcome::DeliveredUnverified {
                reason: format!(
                    "typed but value reads {v:?} (focus_ok={focus_ok}); app may not have committed"
                ),
            },
            Some("readback_mismatch".into()),
        ),
        None => (
            Outcome::DeliveredUnverified {
                reason: format!(
                    "typed with no readable value on the target (focus_ok={focus_ok})"
                ),
            },
            Some("no_readback".into()),
        ),
    }
}

fn key_press(keys: &str) -> (Outcome, Option<String>) {
    let input = match xa11y::input_sim() {
        Ok(i) => i,
        Err(e) => {
            return (
                Outcome::Failed { reason: format!("input unavailable: {e}") },
                Some("input_unavailable".into()),
            )
        }
    };
    let (key, held) = match parse_chord(keys) {
        Ok(v) => v,
        Err(e) => return (Outcome::Failed { reason: e }, Some("bad_chord".into())),
    };
    match input.keyboard().chord(key, &held) {
        Ok(()) => (
            Outcome::DeliveredUnverified {
                reason: "key chord delivered via XTest; effect is app-dependent".into(),
            },
            Some("key_delivered".into()),
        ),
        Err(e) => (
            Outcome::Failed { reason: format!("key chord failed: {e}") },
            Some("key_error".into()),
        ),
    }
}

/// Parse `ctrl+shift+Tab`, `Return`, `a`, `F5` into (key, held modifiers).
fn parse_chord(spec: &str) -> Result<(xa11y::Key, Vec<xa11y::Key>), String> {
    let parts: Vec<&str> = spec.split('+').map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
    let Some((last, mods)) = parts.split_last() else {
        return Err("empty key chord".into());
    };
    let mut held = Vec::new();
    for m in mods {
        held.push(match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => xa11y::Key::Ctrl,
            "shift" => xa11y::Key::Shift,
            "alt" | "option" => xa11y::Key::Alt,
            "meta" | "cmd" | "super" => xa11y::Key::Meta,
            other => return Err(format!("unknown modifier {other:?}")),
        });
    }
    let key = match last.to_ascii_lowercase().as_str() {
        "enter" | "return" => xa11y::Key::Enter,
        "escape" | "esc" => xa11y::Key::Escape,
        "backspace" => xa11y::Key::Backspace,
        "tab" => xa11y::Key::Tab,
        "space" => xa11y::Key::Space,
        "delete" => xa11y::Key::Delete,
        "insert" => xa11y::Key::Insert,
        "up" => xa11y::Key::ArrowUp,
        "down" => xa11y::Key::ArrowDown,
        "left" => xa11y::Key::ArrowLeft,
        "right" => xa11y::Key::ArrowRight,
        "home" => xa11y::Key::Home,
        "end" => xa11y::Key::End,
        "pageup" => xa11y::Key::PageUp,
        "pagedown" => xa11y::Key::PageDown,
        other => {
            if let Some(n) = other.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                xa11y::Key::F(n)
            } else if other.chars().count() == 1 {
                let c = other.chars().next().unwrap();
                if c.is_ascii_uppercase() {
                    // Key::Char must be lowercase; hold Shift for the capital.
                    held.push(xa11y::Key::Shift);
                    xa11y::Key::Char(c.to_ascii_lowercase())
                } else {
                    xa11y::Key::Char(c)
                }
            } else {
                return Err(format!("unknown key {other:?}"));
            }
        }
    };
    Ok((key, held))
}

