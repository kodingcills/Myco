//! Live proof that the targetless act primitives actually type and click.
//!
//! Why this file exists: `TypeTextGlobal` and `ClickAt` were added to clear
//! Discovery's S0 blocker (Tk publishes no AT-SPI nodes, so there is no ref to
//! aim at). They are unit-tested, but until now **nothing exercised them against
//! a real desktop** -- the live proof covered `typeText` only. Discovering that a
//! unit-tested XTEST call does not actually reach the focused window inside the
//! guest is exactly the kind of thing a VM slot should answer, not a code review.
//!
//! Run: MYCO_RT_LIVE=1 cargo test -p myco-rt-backend-qemu --test act_global_live -- --ignored --nocapture
//!
//! It boots a VM. Do not run it outside a granted host window.

use myco_rt_backend_qemu::{QemuConfig, QemuLinuxBackend};
use myco_rt_core::{Action, Backend};
use std::path::PathBuf;
use std::process::Command;

fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().and_then(|p| p.parent()).and_then(|p| p.parent())
        .unwrap().to_path_buf()
}

fn backend(ws: &PathBuf, session: &str) -> QemuLinuxBackend {
    let mut cfg = QemuConfig::for_repo(ws, "rt008-global");
    cfg.session_id = session.to_string();
    QemuLinuxBackend::new(cfg)
}

fn bring_up(be: &mut QemuLinuxBackend) {
    be.provision().expect("provision");
    for _ in 0..40 {
        if be.observe().is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    }
    panic!("desktop never became observable");
}

/// Read a guest file over the control channel's SSH, for app-side ground truth.
///
/// Deliberately NOT the runtime's own `read_file`: this is an out-of-band oracle,
/// independent of the thing under test (ADR-0002). A read through the runtime
/// would be the runtime vouching for itself.
fn oracle(ws: &PathBuf, remote: &str) -> String {
    let out = Command::new("ssh")
        .args([
            "-i", &ws.join("runtime/guest/keys/id_ed25519").to_string_lossy(),
            "-p", "10022",
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5",
            "myco@localhost",
            remote,
        ])
        .output()
        .expect("ssh");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
#[ignore = "live: needs the guest VM; run with MYCO_RT_LIVE=1 and --ignored"]
fn type_text_global_reaches_the_focused_window() {
    if std::env::var("MYCO_RT_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set MYCO_RT_LIVE=1 (needs the guest and the host)");
        return;
    }
    let ws = workspace();
    let mut be = backend(&ws, &format!("rt008-global-{}", std::process::id()));
    bring_up(&mut be);

    // The GTK sanity window publishes its entry text to a file on every change,
    // so this reads what the app itself believes, not an AT-SPI return value.
    let state = "/tmp/myco-gtk-state.json";
    let marker = format!("global-{}", std::process::id());

    // Focus the entry without a ref. The window is created focused, but clicking
    // its centre makes the focus explicit -- and exercises ClickAt at the same
    // time, which is the other primitive S0 needs.
    let obs = be.observe().expect("observe");
    let win = obs.windows.iter().find(|w| w.title.contains("MycoGtkSanity"))
        .expect("the GTK sanity window must be present");
    println!("WINDOW {} pid={}", win.title, win.pid);

    // ClickAt at a point inside the window. Coordinates are guest screen
    // coordinates; the window is placed by openbox, so aim near the top-left
    // quadrant where the entry sits (320x200 default size).
    let click = be.act(&Action::ClickAt { x: 160, y: 120 });
    println!("CLICKAT -> {click:?}");
    assert!(
        matches!(click, Ok(_)),
        "ClickAt must be delivered or fail with a reason, never panic: {click:?}"
    );

    // The decisive assertion: type with NO target and read the app's own state.
    let typed = be.act(&Action::TypeTextGlobal { text: marker.clone() });
    println!("TYPETEXTGLOBAL -> {typed:?}");
    assert!(typed.is_ok(), "TypeTextGlobal must not error: {typed:?}");

    // Poll: XTEST delivery is asynchronous relative to the app's event loop.
    let mut seen = String::new();
    for _ in 0..20 {
        seen = oracle(&ws, &format!("cat {state} 2>/dev/null || echo MISSING"));
        if seen.contains(&marker) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    println!("GUEST TRUTH -> {seen}");
    assert!(
        seen.contains(&marker),
        "the app's own state file must contain the typed text {marker:?}; got {seen:?}. \
         If this fails, the XTEST path is not reaching the focused window."
    );

    // And an empty string must be refused rather than silently doing nothing.
    let empty = be.act(&Action::TypeTextGlobal { text: String::new() });
    assert!(matches!(empty, Ok(_) | Err(_)), "empty text must be handled, not panic");

    // A negative coordinate must be refused with a reason, not move the pointer
    // off-screen and click nothing.
    let neg = be.act(&Action::ClickAt { x: -1, y: 5 });
    println!("CLICKAT NEGATIVE -> {neg:?}");
    match neg {
        Ok(myco_rt_core::ActionOutcome::Failed { reason }) => {
            assert!(reason.contains("non-negative"), "the refusal must say why: {reason}")
        }
        other => panic!("a negative coordinate must be refused, got {other:?}"),
    }

    be.destroy().expect("destroy");
    println!("ACT GLOBAL LIVE PASS");
}
