//! RT-007 live proof: observe against the real guest.
//! Run: MYCO_RT_LIVE=1 cargo test -p myco-rt-backend-qemu --test observe -- --nocapture

use myco_rt_backend_qemu::{QemuConfig, QemuLinuxBackend};
use myco_rt_core::Backend;
use std::path::PathBuf;

#[test]
#[ignore = "live: needs the guest VM; run with MYCO_RT_LIVE=1 and --ignored"]
fn live_observe_tree_screenshot_processes() {
    if std::env::var("MYCO_RT_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set MYCO_RT_LIVE=1");
        return;
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .unwrap()
        .to_path_buf();
    let mut backend = QemuLinuxBackend::new(QemuConfig::for_repo(&workspace, "rt007-live"));
    backend.provision().expect("provision");

    // The GUI session may still be starting on a fresh overlay: retry briefly.
    let mut obs = None;
    for _ in 0..30 {
        match backend.observe() {
            Ok(o) => {
                obs = Some(o);
                break;
            }
            Err(e) => {
                eprintln!("observe not ready yet: {e}");
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        }
    }
    let obs = obs.expect("observe never became ready");

    println!("state_version: {:?}", obs.state_version);
    println!("nodes: {}", obs.a11y_tree["nodes"].as_array().map(|a| a.len()).unwrap_or(0));
    println!("windows: {:?}", obs.windows.iter().map(|w| &w.title).collect::<Vec<_>>());
    println!("processes: {}", obs.processes.len());
    println!("screenshot: {:?}", obs.screenshot_artifact);

    // 1. Tree is non-empty and contains the GTK sanity app (proven AT-SPI-visible).
    let nodes = obs.a11y_tree["nodes"].as_array().expect("nodes array");
    assert!(!nodes.is_empty(), "empty a11y tree");
    let names: Vec<String> = nodes
        .iter()
        .filter_map(|n| n["name"].as_str().map(|s| s.to_string()))
        .collect();
    println!("named nodes: {names:?}");
    assert!(
        names.iter().any(|n| n.contains("MycoGtkSanity") || n.contains("gtk-sanity")),
        "GTK sanity app missing from tree: {names:?}"
    );

    // 2. Refs are opaque and unique.
    let refs: Vec<&str> = nodes.iter().filter_map(|n| n["ref"].as_str()).collect();
    let mut uniq = refs.clone();
    uniq.sort_unstable();
    uniq.dedup();
    assert_eq!(refs.len(), uniq.len(), "duplicate refs in one observation");

    // 3. Screenshot is a real PNG on the guest.
    let shot = obs.screenshot_artifact.expect("no screenshot path");
    let head = backend
        .guest_exec(&format!("head -c 8 {shot} | od -An -tx1 | tr -d ' \\n'"))
        .expect("read screenshot header");
    println!("screenshot header: {head}");
    assert!(head.starts_with("89504e470d0a1a0a"), "not a PNG: {head}");

    // 4. state_version advances across observations.
    let v1 = obs.state_version;
    let obs2 = backend.observe().expect("second observe");
    assert!(obs2.state_version > v1, "state_version did not advance");

    // 5. Introspection channel: absent by default, reported explicitly.
    println!("introspection: {:?}", obs2.a11y_tree["introspection"]);
    assert!(
        obs2.a11y_tree["introspection"].is_null(),
        "introspection should be null when MYCO_INTROSPECTION_FILE is unset"
    );

    backend.destroy().expect("destroy");
    println!("OBSERVE PASS");
}
