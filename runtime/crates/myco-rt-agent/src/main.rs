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

mod act;
#[cfg(target_os = "linux")]
mod file_grant;
mod processes;
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
    #[cfg(target_os = "linux")]
    let mut grant = None;
    let mut processes = processes::Processes::default();
    let mut last_observation: Option<act::RefCache> = None;
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
                let mut ops = vec!["ping", "observe", "shutdown", "launch_process", "kill_process", "relaunch_process"];
                if cfg!(target_os = "linux") {
                    ops.extend(["grant_read", "read_file"]);
                }
                let _ = writeln!(
                    stdout,
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "op": "ping",
                        "protocol_version": PROTOCOL_VERSION,
                        "ops": ops,
                        "guest": guest,
                    })
                );
                let _ = stdout.flush();
            }
            "observe" => {
                // Bound the op: an AT-SPI/D-Bus call can block indefinitely when an
                // app is wedged. Answer with a timeout rather than hanging the host.
                let started = std::time::Instant::now();
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
                    Ok(obs) => match observe::validate(&obs) {
                        Ok(()) => {
                            // Cache for act: refs are valid only for this version.
                            let cache = act::RefCache {
                                version: obs.state_version,
                                nodes: obs.nodes.clone(),
                            };
                            let _ = writeln!(
                                stdout,
                                "{}",
                                serde_json::json!({"ok": true, "op": "observe", "observation": obs})
                            );
                            last_observation = Some(cache);
                        }
                        Err(e) => {
                            // Never report an empty desktop as a valid observation.
                            let _ = writeln!(
                                stdout,
                                "{}",
                                serde_json::json!({"ok": false, "op": "observe", "error": "gui_not_ready", "detail": e})
                            );
                        }
                    },
                    Err(e) => {
                        let _ = writeln!(
                            stdout,
                            "{}",
                            serde_json::json!({"ok": false, "op": "observe", "error": e})
                        );
                    }
                }
                let _ = stdout.flush();
                if started.elapsed() > std::time::Duration::from_secs(8) {
                    eprintln!("myco-rt-agent: observe took {:?}", started.elapsed());
                }
            }
            "act" => {
                // Refs are only meaningful against the observation that issued
                // them; keep the latest one and require the host to name it.
                let version = req.get("state_version").and_then(|v| v.as_u64()).unwrap_or(0);
                let Some(action) = req.get("action").cloned().and_then(|a| serde_json::from_value::<act::Action>(a).ok()) else {
                    let _ = writeln!(stdout, "{}", serde_json::json!({"ok": false, "op": "act", "error": "malformed action"}));
                    let _ = stdout.flush();
                    line.clear();
                    continue;
                };
                let Some(cache) = last_observation.clone() else {
                    let _ = writeln!(stdout, "{}", serde_json::json!({"ok": false, "op": "act", "error": "no_observation: call observe before act"}));
                    let _ = stdout.flush();
                    line.clear();
                    continue;
                };
                let (outcome, code) = act::act(&action, &cache, version);
                let _ = writeln!(
                    stdout,
                    "{}",
                    serde_json::json!({
                        "ok": !matches!(outcome, act::Outcome::Failed { .. }),
                        "op": "act",
                        "outcome": outcome,
                        "refusal": code,
                    })
                );
                let _ = stdout.flush();
            }
            #[cfg(target_os = "linux")]
            "grant_read" => {
                let result = (|| {
                    if grant.is_some() {
                        return Err(std::io::Error::other("file grant already set"));
                    }
                    let path = request_path(&req, "root")?;
                    grant = Some(file_grant::FileGrant::open(path)?);
                    Ok(serde_json::Value::Null)
                })();
                send_result(&mut stdout, op, result);
            }
            #[cfg(target_os = "linux")]
            "read_file" => {
                let result = (|| {
                    let grant = grant.as_ref().ok_or_else(|| {
                        std::io::Error::new(std::io::ErrorKind::PermissionDenied, "no file grant")
                    })?;
                    Ok(serde_json::json!(grant.read(request_path(&req, "path")?)?))
                })();
                send_result(&mut stdout, op, result);
            }
            "launch_process" => {
                let result = (|| {
                    let spec: LaunchSpec = serde_json::from_value(req.clone())?;
                    load_gui_env();
                    Ok(serde_json::json!(processes.launch(spec.command, spec.args)?.to_string()))
                })();
                send_result(&mut stdout, op, result);
            }
            "kill_process" | "relaunch_process" => {
                let result = (|| {
                    let handle = req.get("handle").and_then(|v| v.as_str())
                        .and_then(|s| uuid::Uuid::parse_str(s).ok())
                        .ok_or_else(|| std::io::Error::other("invalid process handle"))?;
                    if op == "relaunch_process" {
                        return Ok(serde_json::json!(processes.relaunch(handle)?.to_string()));
                    }
                    let status = processes.kill(handle)?;
                    use std::os::unix::process::ExitStatusExt;
                    Ok(serde_json::json!({"code": status.code(), "signal": status.signal()}))
                })();
                send_result(&mut stdout, op, result);
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
pub(crate) fn load_gui_env() {
    // /run/myco is the unit's RuntimeDirectory: systemd recreates it on every
    // start, so this file cannot outlive its session. (An unmanaged fallback path
    // could survive a restart and point at a dead bus.)
    const PATH_ENV: &str = "/run/myco/gui.env";
    let Ok(text) = std::fs::read_to_string(PATH_ENV) else { return };
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

#[derive(serde::Deserialize)]
struct LaunchSpec {
    command: String,
    args: Vec<String>,
}

#[cfg(target_os = "linux")]
fn request_path<'a>(req: &'a serde_json::Value, field: &str) -> std::io::Result<&'a std::path::Path> {
    req.get(field).and_then(|v| v.as_str()).map(std::path::Path::new)
        .ok_or_else(|| std::io::Error::other("missing file path"))
}

fn send_result(out: &mut impl Write, op: &str, result: std::io::Result<serde_json::Value>) {
    match result {
        Ok(value) => send(out, serde_json::json!({"ok": true, "op": op, "value": value})),
        Err(error) => send(out, error_resp(op, &error.to_string())),
    }
}
