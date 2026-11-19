//! Guest-side NDJSON agent (RT-004, ADR-0015).
//!
//! Speaks newline-delimited JSON on stdin/stdout over the SSH control channel.
//! Protocol constants and wire types are duplicated from
//! `myco-rt-transport::protocol` (the guest binary must not depend on the host
//! transport crate; the shapes are frozen and covered by the transport's
//! unit tests against this very binary).
//!
//! v0 surface: auth handshake, ping, shutdown (RT-004), observe (RT-007).
//! act lands at RT-008.

mod observe;

use std::io::{BufRead, BufReader, Write};

const PROTOCOL_VERSION: u32 = 1;

#[derive(serde::Deserialize)]
struct AuthLine {
    token: String,
}

#[derive(serde::Serialize)]
struct Response {
    ok: bool,
    op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    guest: Option<GuestInfo>,
}

#[derive(serde::Serialize)]
struct GuestInfo {
    hostname: String,
    kernel: String,
    arch: String,
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());

    // --- Auth handshake: first line is the auth request; wrong/missing token
    // => one error line on stdout (host-visible), then clean exit.
    let expected = std::env::var("MYCO_RT_TOKEN").unwrap_or_default();
    if expected.is_empty() {
        eprintln!("myco-rt-agent: MYCO_RT_TOKEN not set; refusing session");
        std::process::exit(2);
    }
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => std::process::exit(3), // eof before auth
        Ok(_) => {}
        Err(e) => {
            eprintln!("myco-rt-agent: read error during auth: {e}");
            std::process::exit(3);
        }
    }
    let auth: AuthLine = match serde_json::from_str(&line) {
        Ok(a) => a,
        Err(e) => {
            send(&mut stdout, auth_rejected(&format!("malformed auth line: {e}")));
            std::process::exit(4);
        }
    };
    if !constant_time_eq(auth.token.as_bytes(), expected.as_bytes()) {
        send(&mut stdout, auth_rejected("invalid token"));
        eprintln!("myco-rt-agent: auth rejected (bad token)"); // guest-side log
        std::process::exit(5);
    }
    send(&mut stdout, auth_ok());
    let _ = stdout.flush();

    // --- Op loop: one JSON request per line, one JSON response per line.
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // host closed the channel
            Ok(_) => {}
            Err(e) => {
                eprintln!("myco-rt-agent: read error: {e}");
                std::process::exit(3);
            }
        }
        let req: serde_json::Value = match serde_json::from_str(line.trim_end()) {
            Ok(v) => v,
            Err(e) => {
                send(&mut stdout, error_resp(" protocol", &format!("malformed request: {e}")));
                let _ = stdout.flush();
                continue;
            }
        };
        let op = req.get("op").and_then(|o| o.as_str()).unwrap_or("");
        match op {
            "ping" => {
                let guest = GuestInfo {
                    hostname: std::fs::read_to_string("/etc/hostname")
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                    kernel: uname_kernel(),
                    arch: std::env::consts::ARCH.to_string(),
                };
                let _ = writeln!(
                    stdout,
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "op": "ping",
                        "protocol_version": PROTOCOL_VERSION,
                        "ops": ["ping", "observe", "shutdown"],
                        "guest": guest,
                    })
                );
                let _ = stdout.flush();
            }
            "observe" => {
                // GUI-readiness gate: a fresh overlay runs cloud-init in the
                // background after the channel is up. Report readiness explicitly
                // rather than an empty tree that looks like "no apps".
                let ready = gui_ready();
                if !ready {
                    let _ = writeln!(
                        stdout,
                        "{}",
                        serde_json::json!({
                            "ok": false,
                            "op": "observe",
                            "error": "gui_not_ready",
                            "detail": "Xvfb/AT-SPI session not up yet (cloud-init may still be running)"
                        })
                    );
                    let _ = stdout.flush();
                    line.clear();
                    continue;
                }
                let version = next_state_version();
                let shot_path = format!("/tmp/myco-observe-{version}.png");
                let shot = observe::capture_screenshot(&shot_path).ok();
                match observe::observe(version, shot) {
                    Ok(obs) => {
                        let _ = writeln!(
                            stdout,
                            "{}",
                            serde_json::json!({"ok": true, "op": "observe", "observation": obs})
                        );
                    }
                    Err(e) => {
                        let _ = writeln!(
                            stdout,
                            "{}",
                            serde_json::json!({"ok": false, "op": "observe", "error": e})
                        );
                    }
                }
                let _ = stdout.flush();
            }
            "shutdown" => {
                let _ = writeln!(stdout, "{}", serde_json::json!({"ok": true, "op": "shutdown"}));
                let _ = stdout.flush();
                break; // clean exit; NOT a VM poweroff — just this agent session
            }
            _ => {
                send(&mut stdout, error_resp(op, &format!("unknown op: {op}")));
                let _ = stdout.flush();
            }
        }
        line.clear();
    }
}

fn uname_kernel() -> String {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// GUI-readiness gate (RT-007): the X display must exist and the AT-SPI bus must
/// answer. Cheap checks only — no app-specific assumptions.
fn gui_ready() -> bool {
    load_gui_env();
    // 1. X display socket present and connectable.
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
    let sock = format!("/tmp/.X11-unix/X{}", display.trim_start_matches(':').split('.').next().unwrap_or("0"));
    if !std::path::Path::new(&sock).exists() {
        return false;
    }
    // 2. AT-SPI registry reachable: the provider construction is the real probe.
    xa11y::provider().is_ok()
}

/// An agent spawned over SSH inherits none of the GUI session's environment, so
/// the AT-SPI bus would be unreachable. `myco-gui-session` publishes the session
/// environment to /run/myco/gui.env; adopt the missing vars from it.
fn load_gui_env() {
    // Written by myco-gui-session into the unit's RuntimeDirectory. The
    // /run/user/<uid> variant is a fallback for sessions that have one.
    let path = if std::path::Path::new("/run/myco/gui.env").exists() {
        "/run/myco/gui.env".to_string()
    } else {
        std::env::var("XDG_RUNTIME_DIR")
            .map(|d| format!("{d}/myco/gui.env"))
            .unwrap_or_else(|_| "/run/user/1000/myco/gui.env".to_string())
    };
    let Ok(text) = std::fs::read_to_string(path) else { return };
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        // Override, do not merely fill: sshd exports DBUS_SESSION_BUS_ADDRESS for
        // the *login* session, whose bus has no GUI apps — silently preferring it
        // yields an empty desktop (the bug this file exists to prevent).
        // Safety: single-threaded op loop; set before any provider is built.
        unsafe { std::env::set_var(k, v) };
    }
}

/// Monotonic per-session state version. The agent process is per-session, so a
/// process-local counter is sufficient; the host also tracks it.
fn next_state_version() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static V: AtomicU64 = AtomicU64::new(0);
    V.fetch_add(1, Ordering::SeqCst) + 1
}

fn send(out: &mut impl Write, v: serde_json::Value) {
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn auth_ok() -> serde_json::Value {
    serde_json::json!({"ok": true, "op": "auth", "protocol_version": PROTOCOL_VERSION})
}

fn auth_rejected(reason: &str) -> serde_json::Value {
    serde_json::json!({"ok": false, "op": "auth", "error": reason})
}

fn error_resp(op: &str, msg: &str) -> serde_json::Value {
    serde_json::json!({"ok": false, "op": op, "error": msg})
}

/// Constant-time comparison so a token guess never gets a timing oracle.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
