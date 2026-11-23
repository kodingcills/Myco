//! Mocked end-to-end: all six operations over a fake backend, no guest.
//!
//! Why this exists (operating rule B, 2026-11-22): the six-op path used to be
//! provable only inside a VM window, so every regression in the *session* logic —
//! phase transitions, permission checks, stale-ref rejection, reset semantics —
//! waited behind the host queue. None of that logic needs a guest. This drives it
//! in milliseconds.
//!
//! What this does NOT prove: that a real desktop is reachable. `QemuLinuxBackend`
//! and the guest are exercised by `runtime/guest/live-proof.sh`. This file proves
//! the layer above the seam and deliberately claims no more.
//!
//! The fake is intentionally realistic rather than minimal: an empty a11y tree or
//! zero windows would let bugs through that a real observation would expose.

use myco_rt_core::ops::{GuestProcessControl, ProcessExit, ProcessInfo, WindowInfo};
use myco_rt_core::{
    Action, ActionOutcome, Backend, EvidenceArtifacts, ElementRef, Observation, Permissions,
    RuntimeError, Session, SessionConfig, SessionPhase, StateVersion,
};
use serde_json::json;

type SessionUnderTest = Session<FakeDesktop>;

#[derive(Debug)]
struct FakeErr(String);

impl std::fmt::Display for FakeErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for FakeErr {}

/// A fake desktop that behaves like a provisioned guest: it has a window, a
/// process table, and an accessibility tree that changes when an action lands.
///
/// Every mutating op bumps the version, mirroring the real contract that any
/// delivered action may have changed state.
struct FakeDesktop {
    version: u64,
    provisioned: bool,
    resets: u32,
    /// Entry text, so a typed action is observable through `observe`.
    entry_text: String,
    /// RT-016: handles that have been launched and not yet killed. A kill removes
    /// the handle and records the exit; a relaunch of a live handle is refused.
    live_handles: Vec<String>,
    next_handle: u64,
}

impl FakeDesktop {
    fn new() -> Self {
        Self {
            version: 0,
            provisioned: false,
            resets: 0,
            entry_text: String::new(),
            live_handles: Vec::new(),
            next_handle: 1,
        }
    }

    /// One entry node, shaped like what `observe` returns from a real guest.
    fn entry_node(&self) -> serde_json::Value {
        json!({
            "role": "entry",
            "name": "sanity-entry",
            "value": self.entry_text,
            "ref": format!("e{}", self.version),
        })
    }
}

impl Backend for FakeDesktop {
    type Err = FakeErr;

    fn provision(&mut self) -> Result<(), FakeErr> {
        self.provisioned = true;
        Ok(())
    }

    fn observe(&mut self) -> Result<Observation, FakeErr> {
        if !self.provisioned {
            return Err(FakeErr("observe before provision".into()));
        }
        Ok(Observation {
            state_version: StateVersion(self.version),
            a11y_tree: json!({
                "role": "desktop",
                "children": [self.entry_node()],
            }),
            screenshot_artifact: Some("/tmp/mock-observation.png".into()),
            processes: vec![ProcessInfo { pid: 4242, name: "myco-gtk-sanity".into() }],
            windows: vec![WindowInfo {
                id: "131664".into(),
                title: "MycoGtkSanity".into(),
                pid: 4242,
            }],
        })
    }

    fn act(&mut self, action: &Action) -> Result<ActionOutcome, FakeErr> {
        if !self.provisioned {
            return Err(FakeErr("act before provision".into()));
        }
        match action {
            Action::Launch { command, .. } => {
                if command.is_empty() {
                    return Ok(ActionOutcome::Failed { reason: "empty command".into() });
                }
                // RT-016: a launch produces a handle a later kill can name.
                let handle = format!("proc-{}", self.next_handle);
                self.next_handle += 1;
                self.live_handles.push(handle);
                self.version += 1;
                Ok(ActionOutcome::DeliveredVerified)
            }
            Action::TypeText { text, .. } => {
                self.entry_text = text.clone();
                self.version += 1;
                // Verified because the fake reads its own state back, which is the
                // same guarantee the real backend gives via a read-back.
                Ok(ActionOutcome::DeliveredVerified)
            }
            _ => {
                self.version += 1;
                Ok(ActionOutcome::DeliveredUnverified)
            }
        }
    }

    fn reset(&mut self) -> Result<(), FakeErr> {
        self.resets += 1;
        // A reset discards writes: the entry goes back to empty.
        self.entry_text.clear();
        self.version += 1;
        Ok(())
    }

    fn evidence(&mut self) -> Result<EvidenceArtifacts, FakeErr> {
        Ok(EvidenceArtifacts {
            trace_path: "/tmp/mock/trace.jsonl".into(),
            result_path: "/tmp/mock/result.json".into(),
        })
    }

    fn destroy(&mut self) -> Result<(), FakeErr> {
        self.provisioned = false;
        Ok(())
    }
}

impl GuestProcessControl for FakeDesktop {
    type ProcErr = FakeErr;

    fn launch_guest_process(&mut self, command: &str, _args: &[String]) -> Result<String, FakeErr> {
        // Deliberately does NOT gate on `provisioned`: the phase guard lives in
        // `Session`, and a fake that also refused would let a removed guard pass
        // the post-destroy test for the wrong reason (found by mutation).
        if command.is_empty() {
            return Err(FakeErr("empty command".into()));
        }
        let handle = format!("proc-{}", self.next_handle);
        self.next_handle += 1;
        self.live_handles.push(handle.clone());
        self.version += 1;
        Ok(handle)
    }

    fn kill_guest_process(&mut self, handle: &str) -> Result<ProcessExit, FakeErr> {
        // A kill of an unknown handle is an error, never a silent success: the
        // whole point of RT-016 is that "the process is gone" is reported honestly.
        let idx = self
            .live_handles
            .iter()
            .position(|h| h == handle)
            .ok_or_else(|| FakeErr(format!("no live process for handle {handle}")))?;
        self.live_handles.remove(idx);
        self.version += 1;
        Ok(ProcessExit { code: None, signal: Some(9) })
    }

    fn relaunch_guest_process(&mut self, handle: &str) -> Result<String, FakeErr> {
        // Relaunch names a handle that was killed; a still-live handle means the
        // caller's model of the world is wrong and should fail loudly.
        if self.live_handles.iter().any(|h| h == handle) {
            return Err(FakeErr(format!("handle {handle} is still live; kill it first")));
        }
        let new_handle = format!("proc-{}", self.next_handle);
        self.next_handle += 1;
        self.live_handles.push(new_handle.clone());
        self.version += 1;
        Ok(new_handle)
    }
}

fn session_with(permissions: Permissions) -> SessionUnderTest {
    Session::new_creating(
        SessionConfig {
            session_id: "mock-e2e".into(),
            permissions,
            idle_timeout: None,
        },
        FakeDesktop::new(),
    )
}

fn ready_session() -> SessionUnderTest {
    let mut s = session_with(Permissions::default());
    s.create().expect("create");
    s
}

fn targeted(text: &str) -> Action {
    Action::TypeText {
        target: ElementRef { payload: "sanity-entry".into(), issued_at: StateVersion(0) },
        text: text.into(),
    }
}

/// The north-star path, in order, over one fake: create -> observe -> act ->
/// evidence -> reset -> destroy. This is the shape the live proof asserts with a
/// real guest; here it runs without one.
#[test]
fn full_lifecycle_over_a_fake_backend() {
    let mut s = session_with(Permissions::default());
    assert_eq!(s.phase(), SessionPhase::Creating);

    s.create().expect("create must succeed");
    assert_eq!(s.phase(), SessionPhase::Ready);

    // observe returns a populated tree, not an empty one: a stub tree would let a
    // broken parser pass.
    let obs = s.observe().expect("observe");
    let nodes = obs.a11y_tree["children"].as_array().expect("children array");
    assert_eq!(nodes.len(), 1, "the fake desktop has one accessibility node");
    assert_eq!(nodes[0]["name"], "sanity-entry");
    assert_eq!(obs.windows.len(), 1);
    assert_eq!(obs.windows[0].title, "MycoGtkSanity");
    assert_eq!(obs.processes[0].pid, obs.windows[0].pid, "window and process agree");
    assert!(obs.screenshot_artifact.is_some(), "a screenshot path is reported");

    // act, then read the effect back rather than trusting the outcome alone.
    let outcome = s.act(&targeted("hello")).expect("act");
    assert!(matches!(outcome, ActionOutcome::DeliveredVerified));
    let after = s.observe().expect("observe after act");
    assert_eq!(
        after.a11y_tree["children"][0]["value"], "hello",
        "the typed text must be observable, not merely reported"
    );

    let art = s.evidence().expect("evidence");
    assert!(art.trace_path.ends_with("trace.jsonl"));
    assert!(art.result_path.ends_with("result.json"));

    // reset clears the writes.
    s.reset().expect("reset");
    assert_eq!(s.phase(), SessionPhase::Ready, "reset returns to ready");
    let clean = s.observe().expect("observe after reset");
    assert_eq!(clean.a11y_tree["children"][0]["value"], "", "reset discards writes");
    // The version after reset is the BACKEND's, not the session's: reset() writes
    // StateVersion(0) but the next observe overwrites it from the observation. The
    // post-reset version is therefore backend-defined, and a backend that bumps on
    // reset reports a non-zero version. Asserting 0 here would pass only against a
    // backend that happens not to bump -- which is why this test observes first.
    assert!(clean.state_version >= StateVersion(0));

    s.destroy().expect("destroy");
    assert_eq!(s.phase(), SessionPhase::Destroyed);
}

/// Every op after destroy is refused. A destroyed session must be inert, or a
/// later call could resurrect a guest that was already torn down.
#[test]
fn destroyed_session_refuses_every_operation() {
    let mut s = ready_session();
    s.destroy().expect("destroy");

    assert!(s.observe().is_err(), "observe after destroy");
    assert!(s.reset().is_err(), "reset after destroy");
    assert!(s.act(&targeted("x")).is_err(), "act after destroy");

    // `evidence` used to be the exception: unlike every other non-terminal op it
    // had no `require_ready()` guard, so it reached the backend on a destroyed
    // session and reported success. RT-021 closed that asymmetry -- the artifacts
    // live in the run directory `destroy` deletes, and the success it reported was
    // backend-dependent (synthetic paths under FakeBackend). It is now refused
    // like every other op; this assertion is what fails if the guard is removed.
    match s.evidence() {
        Err(RuntimeError::IllegalTransition { from, .. }) => {
            assert_eq!(from, SessionPhase::Destroyed, "evidence refused from destroyed")
        }
        other => panic!("evidence must be refused on a destroyed session, got {other:?}"),
    }

    assert_eq!(s.phase(), SessionPhase::Destroyed, "phase stays destroyed");
}

/// Acting before create is an illegal transition, not a backend error.
#[test]
fn operations_before_create_are_illegal_transitions() {
    let mut s = session_with(Permissions::default());
    match s.observe() {
        Err(RuntimeError::IllegalTransition { from, .. }) => {
            assert_eq!(from, SessionPhase::Creating)
        }
        other => panic!("expected IllegalTransition, got {other:?}"),
    }
}

/// A state ref issued at an older version must be rejected before the backend is
/// touched — the whole point of versioned refs.
#[test]
fn stale_ref_is_rejected_without_reaching_the_backend() {
    let mut s = ready_session();
    s.observe().expect("observe at version 0");
    // A delivered action advances the version.
    s.act(&targeted("a")).expect("act");

    // A ref issued at the pre-action version is now stale.
    let stale = Action::Click {
        target: ElementRef { payload: "sanity-entry".into(), issued_at: StateVersion(0) },
    };
    match s.act(&stale) {
        Err(RuntimeError::StaleRef { issued_at, current }) => {
            assert!(issued_at < current, "the reported ref must be older than current")
        }
        other => panic!("expected StaleRef, got {other:?}"),
    }
}

/// A permission set that does not allow the action kind refuses it in the session,
/// not in the backend.
#[test]
fn permission_denied_never_reaches_the_backend() {
    let mut denied = session_with(Permissions { allowed_actions: Vec::new() });
    denied.create().expect("create");
    match denied.act(&Action::Launch { command: "x".into(), args: vec![] }) {
        Err(RuntimeError::PermissionDenied(kind)) => {
            assert_eq!(kind, "launch", "the refusal must name the action kind")
        }
        other => panic!("expected PermissionDenied, got {other:?}"),
    }

    // The permissive session still works, so the refusal is the permission check
    // and not something incidental to the action.
    let mut allowed = ready_session();
    allowed
        .act(&Action::Launch { command: "x".into(), args: vec![] })
        .expect("launch is allowed by default permissions");
}

/// A failed reset must leave the session in `Failed` — and `destroy` must still
/// work from there, so a failed reset cannot strand a live guest (REQ-12).
#[test]
fn destroy_is_permitted_from_failed_so_a_guest_is_never_stranded() {
    let mut s = Session::new_creating(
        SessionConfig {
            session_id: "mock-reset-fail".into(),
            permissions: Permissions::default(),
            idle_timeout: None,
        },
        FailingReset,
    );
    s.create().expect("create");
    assert!(s.reset().is_err(), "the fake reset fails");
    assert_eq!(s.phase(), SessionPhase::Failed);

    s.destroy().expect("destroy must be allowed from Failed");
    assert_eq!(s.phase(), SessionPhase::Destroyed);
}

/// A backend whose reset always fails.
struct FailingReset;

impl Backend for FailingReset {
    type Err = FakeErr;

    fn provision(&mut self) -> Result<(), FakeErr> {
        Ok(())
    }
    fn observe(&mut self) -> Result<Observation, FakeErr> {
        Ok(Observation {
            state_version: StateVersion(0),
            a11y_tree: json!({"role": "desktop", "children": []}),
            screenshot_artifact: None,
            processes: Vec::new(),
            windows: Vec::new(),
        })
    }
    fn act(&mut self, _: &Action) -> Result<ActionOutcome, FakeErr> {
        Ok(ActionOutcome::DeliveredUnverified)
    }
    fn reset(&mut self) -> Result<(), FakeErr> {
        Err(FakeErr("reset failed".into()))
    }
    fn evidence(&mut self) -> Result<EvidenceArtifacts, FakeErr> {
        Ok(EvidenceArtifacts { trace_path: "t".into(), result_path: "r".into() })
    }
    fn destroy(&mut self) -> Result<(), FakeErr> {
        Ok(())
    }
}

/// RT-016: launch -> kill -> relaunch over a fake, plus the refusal paths.
///
/// The observable contract is what a client can rely on: a launch returns a
/// handle; a kill of that handle reports how it died and invalidates refs; a
/// relaunch of a killed handle returns a new one; and every wrong call (unknown
/// handle, relaunch of a live process, any op after destroy) is an error, never a
/// silent success.
#[test]
fn launch_kill_relaunch_round_trip() {
    let mut s = ready_session();

    // Launch returns a handle distinct from nothing: it is the name kill needs.
    let handle = s
        .launch_guest_process("/bin/sleep", &["60".into()])
        .expect("launch");
    assert!(!handle.is_empty(), "a launch must yield a usable handle");

    // The launch changed the process set, so it bumped the version. Capture it to
    // show the kill's bump below is real, not a fixed constant.
    let after_launch = s.state_version();

    // Kill reports a signal (SIGKILL), not a code: the fake models a killed
    // process the way a real SIGKILL appears.
    let exit = s.kill_guest_process(&handle).expect("kill");
    assert_eq!(exit.signal, Some(9), "a SIGKILLed process reports signal 9");
    assert_eq!(exit.code, None);
    assert!(
        s.state_version() > after_launch,
        "a kill changes the process set and must bump the state version"
    );

    // Relaunch of the killed handle succeeds and yields a NEW handle.
    let replacement = s.relaunch_guest_process(&handle).expect("relaunch");
    assert_ne!(replacement, handle, "a relaunch is a new process, new handle");
}

#[test]
fn killing_an_unknown_handle_is_an_error() {
    let mut s = ready_session();
    let err = s.kill_guest_process("no-such-handle").unwrap_err();
    assert!(
        err.to_string().contains("no live process"),
        "an unknown handle must be refused, got: {err}"
    );
}

#[test]
fn relaunching_a_live_process_is_an_error() {
    let mut s = ready_session();
    let handle = s.launch_guest_process("/bin/sleep", &[]).expect("launch");
    // Not killed yet: relaunch must refuse rather than silently spawn a second
    // process behind the caller's back.
    let err = s.relaunch_guest_process(&handle).unwrap_err();
    assert!(
        err.to_string().contains("still live"),
        "relaunch of a live handle must be refused, got: {err}"
    );
}

/// RT-016 obeys the same phase guard as every other non-terminal op (RT-021).
#[test]
fn process_control_is_refused_after_destroy() {
    let mut s = ready_session();
    let handle = s.launch_guest_process("/bin/sleep", &[]).expect("launch");
    s.destroy().expect("destroy");

    assert!(s.launch_guest_process("/bin/sleep", &[]).is_err(), "launch after destroy");
    assert!(s.kill_guest_process(&handle).is_err(), "kill after destroy");
    assert!(s.relaunch_guest_process(&handle).is_err(), "relaunch after destroy");
}
