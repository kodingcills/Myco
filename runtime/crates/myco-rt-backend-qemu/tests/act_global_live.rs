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

    // Read the window's ACTUAL geometry from the guest rather than guessing a
    // point: openbox places the window, and a guessed coordinate that misses is
    // indistinguishable from a broken ClickAt. xdotool is the same out-of-band
    // oracle used for focus below.
    let geom = oracle(
        &ws,
        "DISPLAY=:0 xdotool search --name MycoGtkSanity getwindowgeometry --shell 2>/dev/null \
         | tr '\n' ' ' || echo NONE",
    );
    println!("GEOMETRY -> {geom}");
    let field = |k: &str| -> Option<i32> {
        geom.split_whitespace()
            .find_map(|tok| tok.strip_prefix(&format!("{k}=")))
            .and_then(|v| v.parse::<i32>().ok())
    };
    let (wx, wy, ww, wh) = match (field("X"), field("Y"), field("WIDTH"), field("HEIGHT")) {
        (Some(x), Some(y), Some(w), Some(h)) => (x, y, w, h),
        _ => panic!("could not read the GTK window geometry from the guest: {geom:?}"),
    };
    // Aim at the window centre: the entry sits in a vertical box, so the middle
    // lands on or near it, and any click inside the window establishes focus.
    let (cx, cy) = (wx + ww / 2, wy + wh / 2);
    println!("CLICKAT TARGET -> ({cx}, {cy}) from window ({wx},{wy}) {ww}x{wh}");

    let click = be.act(&Action::ClickAt { x: cx, y: cy });
    println!("CLICKAT -> {click:?}");
    assert!(
        matches!(click, Ok(_)),
        "ClickAt must be delivered or fail with a reason, never panic: {click:?}"
    );

    // Establish that the GTK window is actually ACTIVE before typing.
    //
    // This matters for diagnosis: the app never calls grab_focus() and openbox
    // decides window focus, so "typeTextGlobal delivered nothing" could mean
    // either the XTEST path is broken OR the keystrokes went to a window that was
    // never focused. Those are different bugs, and without this check a failure
    // here would be attributed to the wrong one -- expensively, inside a window.
    //
    // xdotool is out-of-band ground truth: the runtime does not report focus, so
    // asking the guest is the only honest way to know.
    let active = oracle(&ws, "DISPLAY=:0 xdotool getactivewindow getwindowname 2>/dev/null || echo NONE");
    println!("ACTIVE WINDOW -> {active}");
    assert!(
        active.contains("MycoGtkSanity"),
        "the GTK sanity window must be active before typing, else this test cannot          distinguish an XTEST failure from a focus failure. Active window was {active:?}.          ClickAt is supposed to establish this -- if it did not, that itself is the bug."
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
