//! RT-015 live validation: `read_file` against a real guest, including the paths
//! that only run on Linux (`#[cfg(target_os = "linux")]` unit tests cannot run on
//! this macOS host) and the refusal paths that must not depend on the agent
//! already holding a grant.
//!
//! Run: MYCO_RT_LIVE=1 cargo test -p myco-rt-backend-qemu --test read_file_live -- --nocapture
//!
//! Everything here is gated on MYCO_RT_LIVE=1 and boots a VM, so it must not be
//! run while another workstream holds the host.

use myco_rt_backend_qemu::{QemuConfig, QemuLinuxBackend};
use myco_rt_core::Backend;
use std::path::PathBuf;

fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().and_then(|p| p.parent()).and_then(|p| p.parent())
        .unwrap().to_path_buf()
}

fn backend(ws: &PathBuf, session: &str) -> QemuLinuxBackend {
    let mut cfg = QemuConfig::for_repo(ws, "rt015-live");
    cfg.session_id = session.to_string();
    QemuLinuxBackend::new(cfg)
}

/// Wait for the desktop, since a fresh overlay runs cloud-init for minutes.
fn bring_up(be: &mut QemuLinuxBackend) {
    be.provision().expect("provision");
    for _ in 0..30 {
        if be.observe().is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    }
    panic!("desktop never became observable");
}

#[test]
#[ignore = "live: needs the guest VM; run with MYCO_RT_LIVE=1 and --ignored"]
fn live_read_file_round_trips_and_refuses_escapes() {
    if std::env::var("MYCO_RT_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set MYCO_RT_LIVE=1 (needs the guest and the host)");
        return;
    }
    let ws = workspace();
    let dir = format!("/home/myco/rt015-{}", std::process::id());
    let rel = format!("rt015-{}", std::process::id());

    // The grant root must EXIST before provision: `with_read_grant` records it and
    // `connect` opens it with openat2, so granting a directory that does not exist
    // yet fails the boot with ENOENT (and re-fails on every reconnect after reset).
    // Grant the parent that cloud-init always creates, then work one level down.
    let mut granted = backend(&ws, &format!("rt015-glad-{}", std::process::id()))
        .with_read_grant("/home/myco".to_string());
    bring_up(&mut granted);
    granted
        .guest_exec(&format!("mkdir -p {dir} && printf 'hello-rt015' > {dir}/known.txt && printf '\\x00\\x01\\xfe\\xff*' > {dir}/blob"))
        .expect("seed guest files");

    // Exact bytes, including a length that is not a multiple of 3.
    let known = granted.read_guest_file(&format!("{rel}/known.txt")).expect("read known.txt");
    assert_eq!(known, b"hello-rt015", "text round trip must be exact");
    let blob = granted.read_guest_file(&format!("{rel}/blob")).expect("read blob");
    assert_eq!(blob, vec![0x00, 0x01, 0xfe, 0xff, 0x2a], "binary round trip must be exact");
    println!("READ OK known={:?} blob={:?}", String::from_utf8_lossy(&known), blob);

    // Escape attempts must be refused, not silently clamped.
    for bad in ["../etc/passwd", "/etc/passwd", "../../outside"] {
        let r = granted.read_guest_file(bad);
        assert!(r.is_err(), "{bad:?} must be refused, got {:?}", r.map(|b| b.len()));
        println!("REFUSED {bad:?}");
    }

    let art = granted.evidence().expect("evidence");
    println!("evidence: {}", art.trace_path);
    granted.destroy().expect("destroy after granted session");

    // A session WITHOUT a grant must not read anything, on a fresh agent.
    let mut ungranted = backend(&ws, &format!("rt015-nogrant-{}", std::process::id()));
    bring_up(&mut ungranted);
    let r = ungranted.read_guest_file(&format!("{rel}/known.txt"));
    assert!(r.is_err(), "a session with no read_root must refuse reads");
    println!("REFUSED ungranted read: {}", r.unwrap_err());
    ungranted.destroy().expect("destroy after ungranted session");

    println!("READ_FILE LIVE PASS");
}

#[test]
#[ignore = "live: needs the guest VM; run with MYCO_RT_LIVE=1 and --ignored"]
fn live_create_emits_progress_heartbeat() {
    if std::env::var("MYCO_RT_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set MYCO_RT_LIVE=1 (needs the guest and the host)");
        return;
    }
    // Drives the MCP server as a subprocess and asserts that a create carrying a
    // progressToken produces notifications/progress lines while it runs.
    let ws = workspace();
    let bin = ws.join("runtime/target/debug/myco-rt-mcp");
    assert!(bin.exists(), "build the MCP server first");

    let mut child = std::process::Command::new(&bin)
        .current_dir(&ws)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn myco-rt-mcp");

    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2024-11-05","capabilities":{{}},"clientInfo":{{"name":"rt015-live","version":"0"}}}}}}"#
        )
        .unwrap();
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"_meta":{{"progressToken":"live-1"}},"name":"create","arguments":{{"session_id":"rt015-progress"}}}}}}"#
        )
        .unwrap();
        stdin.flush().unwrap();
    }

    // A create takes minutes; read until we see at least one progress line, then
    // stop. We are testing the heartbeat exists, not the whole boot.
    use std::io::{BufRead, BufReader};
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);
    let mut saw_progress = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
    while std::time::Instant::now() < deadline {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        if line.contains("notifications/progress") {
            println!("PROGRESS: {}", line.trim());
            assert!(line.contains("live-1"), "the client's token must be echoed");
            saw_progress = true;
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(saw_progress, "create must emit notifications/progress while provisioning");
    println!("PROGRESS LIVE PASS");
}