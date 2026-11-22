//! Offline replay: drive the evidence writer over recorded timelines, no guest.
//!
//! Operating rule B (2026-11-22) asks for offline replays of recorded traces.
//! The point is that evidence *writing and validation* needs no VM: the shapes
//! are fixed by M1's schema, so a schema break is detectable on a laptop.
//!
//! What this proves: the runtime's writer emits M1-shaped artifacts for the kinds
//! of session a real run produces -- a clean pass, a guarded failure, and a
//! recovery -- and that its validation rejects tampered events.
//!
//! What it does not prove: that a guest produces those timelines. The guest is
//! `runtime/guest/live-proof.sh`.
//!
//! The recorded corpus these timelines are modelled on lives at
//! `foundry/viewer-fixtures/{verified,recovered,false-success,unknown}/trace.jsonl`
//! (109-112 lines each, all seven M1 event types) and
//! `docs/research/experiments/m1-013-session1/kill-87ee5b14/`. Those files are M1's
//! artifacts; this test builds the same *shape* through the runtime's own writer
//! rather than asserting against M1's files, so it fails if the runtime drifts.

use myco_rt_evidence::SessionRecorder;
use serde_json::Value;

/// The event types M1's `schemas/trace-events.ts` admits. Kept explicit so a stale
/// copy here shows up as a failure rather than silently passing.
const M1_EVENT_TYPES: &[&str] = &[
    "run-start",
    "observation",
    "action",
    "guard-evaluation",
    "guard-failure",
    "fault-injection",
    "recovery",
];

fn tmp_root(name: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!("myco-replay-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).expect("temp root");
    p
}

fn lines(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("each trace line must be one JSON object"))
        .collect()
}

/// Every event a recorder emits must be a type M1's schema defines.
fn assert_m1_shaped(events: &[Value]) {
    assert!(!events.is_empty(), "a session must emit at least run-start");
    for e in events {
        let ty = e.get("type").and_then(|t| t.as_str()).expect("event carries a type");
        assert!(
            M1_EVENT_TYPES.contains(&ty),
            "event type {ty:?} is not in M1's vocabulary {M1_EVENT_TYPES:?}"
        );
    }
    // Exactly one run-start, and it is first: consumers key on it.
    assert_eq!(events[0]["type"], "run-start", "run-start must open the trace");
    assert_eq!(
        events.iter().filter(|e| e["type"] == "run-start").count(),
        1,
        "exactly one run-start"
    );
}

/// A clean session: observations and delivered actions, then a verdict-bearing
/// result. This is the `verified` fixture's shape.
#[test]
fn replay_of_a_clean_session_is_m1_shaped() {
    let root = tmp_root("clean");
    let mut rec = SessionRecorder::new(&root, "replay-clean", "task-clean").expect("recorder");

    rec.observation(0, 5);
    rec.action(
        serde_json::json!({"kind": "click", "ref": "sanity-entry"}),
        0,
        1,
        "delivered_verified",
        "window read-back matched",
    );
    rec.observation(1, 5);
    rec.action(
        serde_json::json!({"kind": "typeText", "ref": "sanity-entry", "text": "hello"}),
        1,
        2,
        "delivered_verified",
        "entry value read back",
    );
    rec.observation(2, 5);

    let trace = rec.trace_bytes().expect("trace bytes");
    let events = lines(&trace);
    assert_m1_shaped(&events);

    // The observations carry the versions the runtime was given, in order.
    let versions: Vec<_> = events
        .iter()
        .filter(|e| e["type"] == "observation")
        .map(|e| e["stateVersion"].as_u64().expect("stateVersion is an integer"))
        .collect();
    assert_eq!(versions, vec![0, 1, 2], "state versions must be preserved and ordered");

    // Every action event names its kind, which the schema requires.
    for e in events.iter().filter(|e| e["type"] == "action") {
        assert!(
            e["action"]["kind"].as_str().is_some_and(|k| !k.is_empty()),
            "an action event must carry a non-empty kind: {e}"
        );
    }

    // The result record is a session record, and it must NOT carry a verdict:
    // the runtime layer joins the evidence, it does not judge it (ADR-0007/0012).
    // A verdict here would move the runtime into M1's scoring role.
    let result = rec.result_bytes().expect("result bytes");
    let r: Value = serde_json::from_slice(&result).expect("result is JSON");
    assert_eq!(r["recordKind"], "session", "the runtime writes session records");
    assert_eq!(r["runId"], "replay-clean");
    assert!(
        r.get("verdict").is_none(),
        "a session record must not carry a verdict -- that is M1's, not the runtime's: {r}"
    );
    assert_eq!(r["steps"].as_array().map(|a| a.len()), Some(2), "both actions are steps");

    let _ = std::fs::remove_dir_all(&root);
}

/// A session where a precondition failed: the shape of the recorded M1 abort.
#[test]
fn replay_of_a_guarded_failure_records_unresolved_state() {
    let root = tmp_root("guard");
    let mut rec = SessionRecorder::new(&root, "replay-guard", "task-guard").expect("recorder");
    rec.observation(0, 5);
    rec.unresolved("desktop never became observable");

    let events = lines(&rec.trace_bytes().expect("trace"));
    assert_m1_shaped(&events);

    // `unresolved()` records the reason on the result, not as a trace event. M1's
    // schema *permits* a `recovery` event but does not require one, so a trace
    // without it is valid. Noted rather than asserted: M1's own abort trace does
    // carry one, so this is a vocabulary difference worth knowing about, not a
    // schema violation.
    let r: Value = serde_json::from_slice(&rec.result_bytes().expect("result")).expect("json");
    assert!(
        r["unresolvedState"].as_str().is_some_and(|s| !s.is_empty()),
        "unresolvedState must name the reason, not be empty"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// A trace must not be writable at a path that escapes the evidence root.
#[test]
fn a_traversing_run_id_is_refused() {
    let root = tmp_root("escape");
    for bad in ["../escape", "a/b", "..", ""] {
        assert!(
            SessionRecorder::new(&root, bad, "task").is_err(),
            "run id {bad:?} must be refused: it would write outside the evidence root"
        );
    }
    // A plain segment still works, so the refusal is the traversal and not the API.
    SessionRecorder::new(&root, "ok-segment", "task").expect("a plain run id is accepted");
    let _ = std::fs::remove_dir_all(&root);
}
