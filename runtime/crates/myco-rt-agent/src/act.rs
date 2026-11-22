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
    /// Type into the focused window, with no element target (RT-003 / Discovery S0).
    ///
    /// Some toolkits publish no accessibility nodes -- Tk registers zero AT-SPI
    /// nodes -- so there is no ref to aim at even though the entry holds focus.
    /// Same XTEST path as KeyPress.
    TypeTextGlobal {
        text: String,
    },
    /// Click a raw guest screen coordinate (RT-003 / Discovery S0).
    ClickAt {
        x: i32,
        y: i32,
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
        Action::TypeTextGlobal { text } => type_text_global(text),
        Action::ClickAt { x, y } => click_at(*x, *y),
        Action::KeyPress { keys } => key_press(keys),
    }
}

fn launch(command: &str, args: &[String]) -> (Outcome, Option<String>) {
    crate::load_gui_env();
    match crate::processes::spawn(command, args) {
        Ok(mut child) => {
            let pid = child.id();
            // Verification: the process is still running shortly after spawn.
            // try_wait reaps and distinguishes an exited child from a live one —
            // /proc existence alone would count an unreaped zombie as alive.
            std::thread::sleep(std::time::Duration::from_millis(400));
            match child.try_wait() {
                Ok(None) => (
                    Outcome::DeliveredVerified {
                        verified_by: format!("process_running pid={pid} at +400ms"),
                    },
                    None,
                ),
                Ok(Some(status)) => (
                    Outcome::Failed {
                        reason: format!("spawned pid {pid} exited immediately ({status})"),
                    },
                    Some("process_died".into()),
                ),
                Err(e) => (
                    Outcome::Failed { reason: format!("wait failed: {e}") },
                    Some("wait_error".into()),
                ),
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
    // Baseline BEFORE acting. Without it, "the text is present afterwards" is
    // vacuous: pre-filled or previously typed text passes a containment check
    // even if this action changed nothing (adversarial review M1).
    // Focus first (semantic), then let the toolkit settle before reading the
    // baseline: typing immediately after focus loses leading characters on GTK,
    // and a baseline read mid-settle can be stale, making a correct write look
    // unverified.
    let focus_ok = provider.focus(el.data()).is_ok();
    std::thread::sleep(std::time::Duration::from_millis(250));
    let baseline = read_text(provider, nodes, target);
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
    std::thread::sleep(std::time::Duration::from_millis(200));
    let observed = read_text(provider, nodes, target);

    let Some(before) = baseline else {
        return (
            Outcome::DeliveredUnverified {
                reason: format!(
                    "typed (focus_ok={focus_ok}) but the target exposes no readable text, so \
                     the effect cannot be verified"
                ),
            },
            Some("no_baseline".into()),
        );
    };
    let after = observed.unwrap_or_default();
    let expected = format!("{before}{text}");
    if after == expected {
        (
            Outcome::DeliveredVerified {
                verified_by: "text_readback_delta".into(),
            },
            None,
        )
    } else {
        (
            Outcome::DeliveredUnverified {
                reason: format!(
                    "typed (focus_ok={focus_ok}) but read-back {after:?} != expected {expected:?}"
                ),
            },
            Some("readback_mismatch".into()),
        )
    }
}

/// Read an element's current text, preferring Value then the Text interface
/// (GTK entries expose Text, not Value).
fn read_text(
    provider: &std::sync::Arc<dyn xa11y::Provider>,
    nodes: &[Node],
    target: &str,
) -> Option<String> {
    let el = resolve(provider, nodes, target).ok()?;
    el.value
        .clone()
        .filter(|v| !v.is_empty())
        .or_else(|| el.text().read_all().ok())
}

/// Type into whatever window has focus, with no element target.
///
/// Uses `Keyboard::type_text`, which is XTEST -- the same delivery path as
/// `key_press`. Deliberately reported `delivered_unverified`: the whole reason
/// this primitive exists is that the toolkit exposes nothing to read back, so
/// claiming verification would be a lie. The caller confirms by reading app state
/// (the Tk app writes its widget contents to a file).
fn type_text_global(text: &str) -> (Outcome, Option<String>) {
    if text.is_empty() {
        return (Outcome::Failed { reason: "empty text; nothing to type".into() }, None);
    }
    let input = match xa11y::input_sim() {
        Ok(i) => i,
        Err(e) => {
            return (
                Outcome::Failed { reason: format!("input unavailable: {e}") },
                Some("input_unavailable".into()),
            )
        }
    };
    match input.keyboard().type_text(text) {
        Ok(()) => (
            Outcome::DeliveredUnverified {
                reason: format!(
                    "{} chars typed into the focused window via XTest; no element was                      targeted, so there is nothing to read back at this layer",
                    text.chars().count()
                ),
            },
            Some("typed_focused".into()),
        ),
        Err(e) => (
            Outcome::Failed { reason: format!("focused typing failed: {e}") },
            Some("type_error".into()),
        ),
    }
}

/// Click a raw guest screen coordinate.
///
/// The escape hatch for elements that are not in the accessibility tree. Guarded
/// against negative coordinates: a negative point is a caller bug, and passing it
/// through would move the pointer off-screen and click nothing, which reads as a
/// mysterious no-op rather than an error.
fn click_at(x: i32, y: i32) -> (Outcome, Option<String>) {
    if x < 0 || y < 0 {
        return (
            Outcome::Failed {
                reason: format!("screen coordinate must be non-negative, got ({x}, {y})"),
            },
            Some("bad_coordinate".into()),
        );
    }
    let input = match xa11y::input_sim() {
        Ok(i) => i,
        Err(e) => {
            return (
                Outcome::Failed { reason: format!("input unavailable: {e}") },
                Some("input_unavailable".into()),
            )
        }
    };
    let point = xa11y::Point { x, y };
    match input.mouse().click(point) {
        Ok(()) => (
            Outcome::DeliveredUnverified {
                reason: format!("pointer click delivered at ({x}, {y}) via XTest; no read-back"),
            },
            Some("clicked_point".into()),
        ),
        Err(e) => (
            Outcome::Failed { reason: format!("click at ({x}, {y}) failed: {e}") },
            Some("click_error".into()),
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
            } else if last.chars().count() == 1 {
                // Case matters: inspect the RAW char, not the lowercased token.
                let c = last.chars().next().unwrap();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chord_parsing_covers_common_forms() {
        assert_eq!(parse_chord("ctrl+shift+tab").unwrap(), (xa11y::Key::Tab, vec![xa11y::Key::Ctrl, xa11y::Key::Shift]));
        assert_eq!(parse_chord("Ctrl+Tab").unwrap(), (xa11y::Key::Tab, vec![xa11y::Key::Ctrl]));
        assert_eq!(parse_chord("Return").unwrap(), (xa11y::Key::Enter, vec![]));
        assert_eq!(parse_chord("F5").unwrap(), (xa11y::Key::F(5), vec![]));
        // Uppercase letter: Shift is added, the char stays lowercase.
        assert_eq!(parse_chord("A").unwrap(), (xa11y::Key::Char('a'), vec![xa11y::Key::Shift]));
        assert_eq!(parse_chord("a").unwrap(), (xa11y::Key::Char('a'), vec![]));
    }

    #[test]
    fn chord_parsing_rejects_garbage_instead_of_guessing() {
        assert!(parse_chord("").is_err());
        assert!(parse_chord("a+b").is_err(), "unknown modifier must error");
        assert!(parse_chord("ctrl+").is_err(), "modifier-only must error");
        assert!(parse_chord("ctrl+shift").is_err(), "modifier-only must error");
        assert!(parse_chord("nonsense").is_err());
    }
}

