//! RT-006 live lifecycle proof against the real QEMU+HVF guest.
//! Gated on MYCO_RT_LIVE=1 (needs the provisioned base image + keys).
//! Run: MYCO_RT_LIVE=1 cargo test -p myco-rt-backend-qemu --test lifecycle -- --nocapture

use myco_rt_backend_qemu::{QemuConfig, QemuLinuxBackend};
use myco_rt_core::Backend;
use std::path::PathBuf;
use std::time::Instant;

#[test]
#[ignore = "live: needs the guest VM; run with MYCO_RT_LIVE=1 and --ignored"]
fn live_lifecycle_create_reset_destroy() {
    if std::env::var("MYCO_RT_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set MYCO_RT_LIVE=1 to run against the real guest");
        return;
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .unwrap()
        .to_path_buf();
    let mut backend = QemuLinuxBackend::new(QemuConfig::for_repo(&workspace, "rt006-live"));

    let t0 = Instant::now();
    backend.provision().expect("provision");
    let create_time = t0.elapsed();
    println!("CREATE (boot + channel ready): {create_time:?}");

    // Marker file in the guest proves reset really discards writes.
    backend.guest_exec("echo dirty > /home/myco/RESET_MARKER").expect("write marker");
    assert!(backend.guest_exec("cat /home/myco/RESET_MARKER").unwrap().contains("dirty"));

    let t1 = Instant::now();
    backend.reset().expect("reset");
    let reset_time = t1.elapsed();
    println!("RESET (discard overlay + reboot + channel ready): {reset_time:?}");

    let marker = backend.guest_exec("cat /home/myco/RESET_MARKER 2>/dev/null || echo GONE").unwrap();
    assert!(marker.contains("GONE"), "marker survived reset: {marker}");
    println!("MARKER after reset: GONE (guest is clean)");

    let t2 = Instant::now();
    backend.destroy().expect("destroy");
    let destroy_time = t2.elapsed();
    println!("DESTROY: {destroy_time:?}");

    let overlay = workspace.join("runtime/guest/state/myco-runtime-v0.qcow2");
    assert!(!overlay.exists(), "overlay survived destroy");
    let qemu = std::process::Command::new("pgrep")
        .arg("-f")
        .arg("qemu-system-aarch64")
        .output()
        .unwrap();
    assert!(!qemu.status.success(), "qemu still running after destroy");
    println!("DESTROY verified: overlay deleted, no qemu process");
}
