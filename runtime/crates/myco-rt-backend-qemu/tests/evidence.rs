//! RT-009 live proof: a full session emits schema-valid evidence.
//! Run: MYCO_RT_LIVE=1 cargo test -p myco-rt-backend-qemu --test evidence -- --nocapture

use myco_rt_backend_qemu::{QemuConfig, QemuLinuxBackend};
use myco_rt_core::ops::Action;
use myco_rt_core::state::ElementRef;
use myco_rt_core::Backend;
use std::path::PathBuf;

#[test]
fn live_session_emits_valid_evidence() {
    if std::env::var("MYCO_RT_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set MYCO_RT_LIVE=1");
        return;
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().and_then(|p| p.parent()).and_then(|p| p.parent())
        .unwrap().to_path_buf();
    let run_id = format!("evidence-live-{}", std::process::id());
    let mut cfg = QemuConfig::for_repo(&workspace, "rt009-live");
    cfg.session_id = run_id.clone();
    cfg.evidence_root = workspace.join("runtime").join("target").join("evidence-live");
    let mut backend = QemuLinuxBackend::new(cfg);
    backend.provision().expect("provision");

    let mut obs = None;
    for _ in 0..20 {
        match backend.observe() {
            Ok(o) => { obs = Some(o); break; }
            Err(e) => { eprintln!("waiting for gui: {e}"); std::thread::sleep(std::time::Duration::from_secs(3)); }
        }
    }
    let obs = obs.expect("observe ready");

    // One verified action, so the evidence has a real step with a real disposition.
    let entry = obs.a11y_tree["nodes"].as_array().unwrap().iter().find_map(|n| {
        (n["name"].as_str() == Some("sanity-entry")).then(|| ElementRef {
            payload: n["ref"].as_str().unwrap().to_string(),
            issued_at: obs.state_version,
        })
    }).expect("sanity-entry");
    backend
        .act(&Action::TypeText { target: entry, text: "evidence-probe".into() })
        .expect("typeText");

    let artifacts = backend.evidence().expect("evidence");
    println!("trace: {}", artifacts.trace_path);
    println!("result: {}", artifacts.result_path);

    let trace = std::fs::read_to_string(&artifacts.trace_path).expect("trace readable");
    let result = std::fs::read_to_string(&artifacts.result_path).expect("result readable");
    for line in trace.lines() {
        println!("  {line}");
    }
    println!("{result}");

    // Shapes the schema requires (validated by the writer; asserted here so the
    // test fails if the writer ever stops validating).
    assert!(trace.lines().count() >= 3, "run-start + observation + action");
    assert!(trace.lines().next().unwrap().contains("\"type\":\"run-start\""));
    let rec: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(rec["recordKind"], "session");
    assert!(rec.get("verdict").is_none(), "runtime must never emit a verdict");
    assert_eq!(rec["runId"], run_id.as_str());
    assert!(!rec["steps"].as_array().unwrap().is_empty());

    // Reset and destroy after the evidence is written: artifacts survive.
    backend.reset().expect("reset");
    backend.destroy().expect("destroy");
    assert!(PathBuf::from(&artifacts.trace_path).exists());
    println!("EVIDENCE PASS");
}
