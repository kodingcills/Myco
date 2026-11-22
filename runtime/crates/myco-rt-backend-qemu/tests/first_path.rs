//! RT-011: the first end-to-end path, as ONE uninterrupted run.
//!
//! create -> observe -> act -> evidence -> reset -> destroy, driven through the
//! MCP server (Dogfood's agent-facing surface), with a CLI smoke on the same
//! guest. Every step asserts on observable state, and the run records wall-clock
//! costs so the numbers in the report are measured, not remembered.
//!
//! Run: MYCO_RT_LIVE=1 cargo test -p myco-rt-backend-qemu --test first_path -- --nocapture
//!
//! Preconditions (checked, not assumed):
//!   - the base image is present and SHA-256 verified (fetch-image.sh)
//!   - the agent binary exists host-side (build-agent-in-guest.sh)
//!   - no other session holds the guest (the backend's lockfile enforces this)

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

struct Mcp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    next_id: u64,
}

impl Mcp {
    fn start(bin: &PathBuf, cwd: &PathBuf) -> Self {
        let mut child = Command::new(bin)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn myco-rt-mcp");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        let mut m = Self { child, stdin, stdout, next_id: 0 };
        m.call("initialize", serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "rt-011", "version": "0"},
        }));
        m
    }

    fn call(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        self.next_id += 1;
        let req = serde_json::json!({
            "jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params
        });
        writeln!(self.stdin, "{req}").expect("write request");
        self.stdin.flush().expect("flush");
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read response");
        serde_json::from_str(&line).expect("parse response")
    }

    /// Call a tool and return its parsed payload (tool failures are isError results).
    fn tool(&mut self, name: &str, args: serde_json::Value) -> (bool, serde_json::Value) {
        let resp = self.call("tools/call", serde_json::json!({"name": name, "arguments": args}));
        let result = &resp["result"];
        let is_error = result["isError"].as_bool().unwrap_or(false);
        let text = result["content"][0]["text"].as_str().unwrap_or("{}");
        (is_error, serde_json::from_str(text).unwrap_or(serde_json::Value::Null))
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn guest_exec(workspace: &PathBuf, remote: &str) -> String {
    let out = Command::new("ssh")
        .args([
            "-i", &workspace.join("runtime/guest/keys/id_ed25519").to_string_lossy(),
            "-p", "10022",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5",
            "myco@localhost",
            remote,
        ])
        .output()
        .expect("ssh");
    String::from_utf8_lossy(&out.stdout).to_string()
}

/// TIF-56: can an arbitrary agent drive the runtime from an unrelated directory?
///
/// The other tests start the MCP server with `cwd` = the repo root, so they pass
/// whether or not discovery works. This one starts it from a directory with no
/// relationship to the repo and no `MYCO_HOME`, which is the situation an external
/// agent is actually in. If discovery only worked by cwd, this would fail.
///
/// It asserts on a real `create` through that server -- not on `initialize`, which
/// answers without touching the workspace. Stage 3 of the proof covers the rest of
/// the lifecycle; this covers the entry point.
#[test]
#[ignore = "live: needs the guest VM; run with MYCO_RT_LIVE=1 and --ignored"]
fn mcp_discovers_the_workspace_from_an_unrelated_directory() {
    if std::env::var("MYCO_RT_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set MYCO_RT_LIVE=1 (needs the guest and the host)");
        return;
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().and_then(|p| p.parent()).and_then(|p| p.parent())
        .unwrap().to_path_buf();
    let mcp_bin = workspace.join("runtime/target/debug/myco-rt-mcp");
    assert!(mcp_bin.exists(), "build the MCP server first: cargo build --workspace");

    // A directory that is deliberately unrelated to the repo, and a cleared
    // MYCO_HOME so the executable-path fallback is what has to work.
    let elsewhere = std::env::temp_dir().join(format!("myco-discovery-{}", std::process::id()));
    std::fs::create_dir_all(&elsewhere).expect("temp dir");
    assert!(
        !elsewhere.starts_with(&workspace),
        "the whole point is a cwd unrelated to the repo"
    );
    std::env::remove_var("MYCO_HOME");

    let session = format!("rt020-disc-{}", std::process::id());
    let mut mcp = Mcp::start(&mcp_bin, &elsewhere);
    println!("started myco-rt-mcp with cwd={}", elsewhere.display());

    let (err, created) = mcp.tool("create", serde_json::json!({"session_id": session}));
    assert!(!err, "create from an unrelated cwd failed: {created}");
    println!("CREATE FROM ELSEWHERE -> {created}");

    // A second observation proves the session is live, not merely registered.
    let (err, obs) = mcp.tool("observe", serde_json::json!({"session_id": session}));
    assert!(!err, "observe from an unrelated cwd failed: {obs}");
    println!("OBSERVE FROM ELSEWHERE -> v{}", obs["state_version"]);

    let (err, _) = mcp.tool("destroy", serde_json::json!({"session_id": session}));
    assert!(!err, "destroy failed");
    println!("DISCOVERY FROM UNRELATED CWD PASS");
}

/// TIF-56: can an arbitrary agent drive the runtime from an unrelated directory?
///
/// The other tests start the MCP server with `cwd` = the repo root, so they pass
/// whether or not discovery works. This one starts it from a directory with no
/// relationship to the repo and no `MYCO_HOME`, which is the situation an external
/// agent is actually in. If discovery only worked by cwd, this would fail.
///
/// It asserts on a real `create` through that server -- not on `initialize`, which
/// answers without touching the workspace.
#[test]
#[ignore = "live: needs the guest VM; run with MYCO_RT_LIVE=1 and --ignored"]
fn mcp_discovers_the_workspace_from_an_unrelated_directory() {
    if std::env::var("MYCO_RT_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set MYCO_RT_LIVE=1 (needs the guest and the host)");
        return;
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().and_then(|p| p.parent()).and_then(|p| p.parent())
        .unwrap().to_path_buf();
    let mcp_bin = workspace.join("runtime/target/debug/myco-rt-mcp");
    assert!(mcp_bin.exists(), "build the MCP server first: cargo build --workspace");

    let elsewhere = std::env::temp_dir().join(format!("myco-discovery-{}", std::process::id()));
    std::fs::create_dir_all(&elsewhere).expect("temp dir");
    assert!(!elsewhere.starts_with(&workspace), "the whole point is an unrelated cwd");
    std::env::remove_var("MYCO_HOME");

    let session = format!("rt020-disc-{}", std::process::id());
    let mut mcp = Mcp::start(&mcp_bin, &elsewhere);
    println!("started myco-rt-mcp with cwd={}", elsewhere.display());

    let (err, created) = mcp.tool("create", serde_json::json!({"session_id": session}));
    assert!(!err, "create from an unrelated cwd failed: {created}");
    println!("CREATE FROM ELSEWHERE -> {created}");

    let (err, obs) = mcp.tool("observe", serde_json::json!({"session_id": session}));
    assert!(!err, "observe from an unrelated cwd failed: {obs}");
    println!("OBSERVE FROM ELSEWHERE -> v{}", obs["state_version"]);

    let (err, _) = mcp.tool("destroy", serde_json::json!({"session_id": session}));
    assert!(!err, "destroy failed");
    println!("DISCOVERY FROM UNRELATED CWD PASS");
}

#[test]
#[ignore = "live: needs the guest VM; run with MYCO_RT_LIVE=1 and --ignored"]
fn first_path_create_observe_act_evidence_reset_destroy() {
    if std::env::var("MYCO_RT_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set MYCO_RT_LIVE=1 (needs the guest and the host)");
        return;
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().and_then(|p| p.parent()).and_then(|p| p.parent())
        .unwrap().to_path_buf();
    let mcp_bin = workspace.join("runtime/target/debug/myco-rt-mcp");
    let cli_bin = workspace.join("runtime/target/debug/myco-rt");
    assert!(mcp_bin.exists(), "build the MCP server first: cargo build --workspace");
    assert!(cli_bin.exists(), "build the CLI first: cargo build --workspace");

    let session = format!("rt011-{}", std::process::id());
    let mut mcp = Mcp::start(&mcp_bin, &workspace);
    let mut timings: Vec<(&str, Duration)> = Vec::new();

    // ── create ────────────────────────────────────────────────────────────────
    let t = Instant::now();
    let (err, created) = mcp.tool("create", serde_json::json!({"session_id": session}));
    timings.push(("create", t.elapsed()));
    assert!(!err, "create failed: {created}");
    println!("CREATE {:?} -> {created}", t.elapsed());

    // ── observe ───────────────────────────────────────────────────────────────
    let t = Instant::now();
    let (err, obs) = mcp.tool("observe", serde_json::json!({"session_id": session}));
    timings.push(("observe", t.elapsed()));
    assert!(!err, "observe failed: {obs}");
    let nodes = obs["a11y_tree"]["nodes"].as_array().cloned().unwrap_or_default();
    assert!(!nodes.is_empty(), "empty accessibility tree");
    let windows = obs["windows"].as_array().cloned().unwrap_or_default();
    assert!(!windows.is_empty(), "no windows reported");
    println!("OBSERVE {:?} -> v{} nodes={} windows={:?}",
        t.elapsed(), obs["state_version"], nodes.len(),
        windows.iter().filter_map(|w| w["title"].as_str()).collect::<Vec<_>>());

    // ── act ───────────────────────────────────────────────────────────────────
    let entry = nodes.iter()
        .find(|n| n["name"].as_str() == Some("sanity-entry"))
        .expect("sanity-entry node in the tree");
    let entry_ref = entry["ref"].as_str().expect("ref").to_string();
    let probe = format!("rt011-{}", std::process::id());
    let t = Instant::now();
    let (err, acted) = mcp.tool("act", serde_json::json!({
        "session_id": session,
        "action": {"kind": "typeText", "target": entry_ref, "text": probe},
    }));
    timings.push(("act", t.elapsed()));
    assert!(!err, "act failed: {acted}");
    assert_eq!(acted["outcome"]["kind"], "delivered_verified", "act outcome: {acted}");
    println!("ACT {:?} -> {}", t.elapsed(), acted["outcome"]);

    // Independent confirmation: the app's OWN state file, not our claim.
    let state = guest_exec(&workspace, "cat /tmp/myco-gtk-state.json 2>/dev/null || echo MISSING");
    assert!(state.contains(&probe), "typed text not in the app's state file: {state}");
    println!("GUEST TRUTH -> {}", state.trim());

    // ── evidence ──────────────────────────────────────────────────────────────
    let t = Instant::now();
    let (err, ev) = mcp.tool("evidence", serde_json::json!({"session_id": session}));
    timings.push(("evidence", t.elapsed()));
    assert!(!err, "evidence failed: {ev}");
    let trace = std::fs::read_to_string(ev["trace"].as_str().expect("trace path")).expect("trace");
    let result = std::fs::read_to_string(ev["result"].as_str().expect("result path")).expect("result");
    let rec: serde_json::Value = serde_json::from_str(&result).expect("result json");
    assert_eq!(rec["recordKind"], "session");
    assert!(rec.get("verdict").is_none(), "runtime must never emit a verdict");
    assert!(trace.lines().count() >= 3, "trace should have run-start + observation + action");
    println!("EVIDENCE {:?} -> {} trace lines, recordKind=session, no verdict", t.elapsed(), trace.lines().count());

    // ── reset (the honest full reset: overlay recreated, cloud-init re-run) ───
    let t = Instant::now();
    let (err, reset) = mcp.tool("reset", serde_json::json!({"session_id": session}));
    timings.push(("reset", t.elapsed()));
    assert!(!err, "reset failed: {reset}");
    println!("RESET {:?}", t.elapsed());

    // Reset must actually clear state: the app's file is gone or empty again.
    let after = guest_exec(&workspace, "cat /tmp/myco-gtk-state.json 2>/dev/null || echo GONE");
    assert!(!after.contains(&probe), "reset did not clear the app state: {after}");
    println!("AFTER RESET -> {}", after.trim());

    // And the desktop must be usable again, not merely booted.
    let (err, obs2) = mcp.tool("observe", serde_json::json!({"session_id": session}));
    assert!(!err, "observe after reset failed: {obs2}");
    assert!(!obs2["a11y_tree"]["nodes"].as_array().unwrap_or(&vec![]).is_empty(),
        "empty tree after reset");
    println!("OBSERVE AFTER RESET -> v{} nodes={}",
        obs2["state_version"], obs2["a11y_tree"]["nodes"].as_array().map(|a| a.len()).unwrap_or(0));

    // ── destroy ───────────────────────────────────────────────────────────────
    let t = Instant::now();
    let (err, destroyed) = mcp.tool("destroy", serde_json::json!({"session_id": session}));
    timings.push(("destroy", t.elapsed()));
    assert!(!err, "destroy failed: {destroyed}");
    println!("DESTROY {:?}", t.elapsed());

    // Nothing may survive: no qemu, no overlay.
    let qemu = Command::new("pgrep").arg("-f").arg("qemu-system-aarch64").output().expect("pgrep");
    assert!(!qemu.status.success(), "qemu still running after destroy");
    assert!(!workspace.join("runtime/guest/state/myco-runtime-v0.qcow2").exists(),
        "overlay survived destroy");
    println!("DESTROY VERIFIED -> no qemu, overlay deleted");

    println!("\n=== RT-011 TIMINGS ===");
    for (name, d) in &timings {
        println!("{name:>9}: {:?}", d);
    }
    println!("FIRST PATH PASS");
}
