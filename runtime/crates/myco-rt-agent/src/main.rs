//! Guest-side NDJSON agent (RT-004, ADR-0015).
//!
//! Speaks newline-delimited JSON on stdin/stdout over the SSH control channel.
//! Protocol constants and wire types are duplicated from
//! `myco-rt-transport::protocol` (the guest binary must not depend on the host
//! transport crate; the shapes are frozen and covered by the transport's
//! unit tests against this very binary).
//!
//! v0 surface ONLY: auth handshake, ping, shutdown. observe/act are RT-007/008.

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
                        "guest": guest,
                    })
                );
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
    // /proc/sys/kernel/osrelease is the cheapest stable source on Linux.
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .unwrap_or_default()
        .trim()
        .to_string()
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
