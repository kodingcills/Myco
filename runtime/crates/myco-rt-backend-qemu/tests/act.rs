//! RT-008 live proof: act against the real guest.
//! Run: MYCO_RT_LIVE=1 cargo test -p myco-rt-backend-qemu --test act -- --nocapture

use myco_rt_backend_qemu::{QemuConfig, QemuLinuxBackend};
use myco_rt_core::ops::{Action, ActionOutcome};
use myco_rt_core::state::ElementRef;
use myco_rt_core::Backend;
use std::path::PathBuf;

fn find_ref(obs: &myco_rt_core::Observation, name: &str) -> Option<ElementRef> {
    obs.a11y_tree["nodes"].as_array()?.iter().find_map(|n| {
        let matches = n["name"].as_str() == Some(name)
            || n["name"].as_str().map(|s| s.contains(name)).unwrap_or(false);
        if matches {
            n["ref"].as_str().map(|r| ElementRef {
                payload: r.to_string(),
                issued_at: obs.state_version,
            })
        } else {
            None
        }
    })
}

#[test]
#[ignore = "live: needs the guest VM; run with MYCO_RT_LIVE=1 and --ignored"]
fn live_act_launch_type_and_stale_ref() {
    if std::env::var("MYCO_RT_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set MYCO_RT_LIVE=1");
        return;
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().and_then(|p| p.parent()).and_then(|p| p.parent())
        .unwrap().to_path_buf();
    let mut backend = QemuLinuxBackend::new(QemuConfig::for_repo(&workspace, "rt008-live"));
    backend.provision().expect("provision");

    // Wait for the GUI session (cloud-init may still be finishing).
    let mut obs = None;
    for _ in 0..20 {
        match backend.observe() {
            Ok(o) => { obs = Some(o); break; }
            Err(e) => { eprintln!("waiting for gui: {e}"); std::thread::sleep(std::time::Duration::from_secs(3)); }
        }
    }
    obs.expect("observe never ready");

    // 1. launch an app that exists in the guest — verified by the process
    //    staying alive (a binary that execs and dies is caught here).
    let launch = backend
        .act(&Action::Launch {
            command: "python3".into(),
            args: vec!["/opt/myco/myco-tk-app.py".into()],
        })
        .expect("launch");
    println!("launch outcome: {launch:?}");
    assert!(
        matches!(launch, ActionOutcome::DeliveredVerified { .. }),
        "launching an installed app must verify: {launch:?}"
    );

    // 2. type into the GTK entry and prove it by the APP's own state file, not by
    //    the action's return value (ADR-0014 read-back discipline).
    let obs2 = backend.observe().expect("re-observe");
    let entry = find_ref(&obs2, "sanity-entry").expect("sanity-entry node");
    let pre_action_ref = entry.clone();
    let typed = backend
        .act(&Action::TypeText { target: entry, text: "myco-act-probe".into() })
        .expect("typeText");
    println!("typeText outcome: {typed:?}");
    assert!(
        !matches!(typed, ActionOutcome::Failed { .. }),
        "typing must not report failure: {typed:?}"
    );
    let state = backend
        .guest_exec("cat /tmp/myco-gtk-state.json 2>/dev/null || echo MISSING")
        .expect("read app state");
    println!("app state: {state}");
    assert!(
        state.contains("myco-act-probe"),
        "typing did not reach the app (state: {state})"
    );

    // 3. STALE REF: a ref from the pre-action observation, after the version moved
    //    on. The refusal must be specifically stale_ref, not a generic failure.
    let stale = ElementRef {
        payload: pre_action_ref.payload.clone(),
        issued_at: pre_action_ref.issued_at,
    };
    let res = backend.act(&Action::Click { target: stale }).expect("act call");
    println!("stale ref outcome: {res:?}");
    match &res {
        ActionOutcome::Failed { reason } => {
            assert!(
                reason.contains("stale_ref"),
                "expected a stale_ref refusal, got {reason:?}"
            );
        }
        other => panic!("stale ref must fail, got {other:?}"),
    }

    backend.destroy().expect("destroy");
    println!("ACT PASS");
}
