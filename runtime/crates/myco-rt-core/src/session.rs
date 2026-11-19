//! Session state machine and the six runtime operations (RT-005).

use crate::ops::{Action, ActionOutcome, Backend, Observation, SessionSummary};
use crate::state::StateVersion;
use crate::{Permissions, RuntimeError};
use serde::{Deserialize, Serialize};

/// Session lifecycle phases. Transitions are checked; illegal ones are errors,
/// never silent no-ops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionPhase {
    Creating,
    Ready,
    Resetting,
    Destroyed,
    Failed,
}

impl std::fmt::Display for SessionPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            SessionPhase::Creating => "creating",
            SessionPhase::Ready => "ready",
            SessionPhase::Resetting => "resetting",
            SessionPhase::Destroyed => "destroyed",
            SessionPhase::Failed => "failed",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub session_id: String,
    pub permissions: Permissions,
    /// Idle timeout after which the backend may shut the desktop down.
    /// `None` disables idle shutdown (development default; RT-013).
    pub idle_timeout: Option<std::time::Duration>,
}

/// A live session over a backend. `Session` owns permission checks, phase
/// transitions, and state-version tracking; the backend owns the guest.
pub struct Session<B: Backend> {
    config: SessionConfig,
    phase: SessionPhase,
    state_version: StateVersion,
    backend: B,
}

impl<B: Backend> Session<B> {
    pub fn new_creating(config: SessionConfig, backend: B) -> Self {
        Self {
            config,
            phase: SessionPhase::Creating,
            state_version: StateVersion(0),
            backend,
        }
    }

    pub fn phase(&self) -> SessionPhase {
        self.phase
    }

    pub fn state_version(&self) -> StateVersion {
        self.state_version
    }

    fn transition(&mut self, to: SessionPhase) -> Result<(), RuntimeError> {
        use SessionPhase::*;
        let legal = matches!(
            (self.phase, to),
            (Creating, Ready)
                | (Creating, Failed)
                | (Ready, Resetting)
                | (Ready, Destroyed)
                | (Ready, Failed)
                | (Resetting, Ready)
                | (Resetting, Failed)
                | (Failed, Destroyed)
        );
        if !legal {
            return Err(RuntimeError::IllegalTransition {
                from: self.phase,
                to,
            });
        }
        self.phase = to;
        Ok(())
    }

    fn require_ready(&self) -> Result<(), RuntimeError> {
        if self.phase != SessionPhase::Ready {
            return Err(RuntimeError::IllegalTransition {
                from: self.phase,
                to: SessionPhase::Ready,
            });
        }
        Ok(())
    }

    fn backend_err(e: B::Err) -> RuntimeError {
        RuntimeError::Backend(e.to_string())
    }

    /// `create`: finish provisioning and mark the session ready.
    pub fn create(&mut self) -> Result<(), RuntimeError> {
        self.backend.provision().map_err(Self::backend_err)?;
        self.transition(SessionPhase::Ready)
    }

    /// `observe`: accessibility tree + screenshot + process/window info.
    pub fn observe(&mut self) -> Result<Observation, RuntimeError> {
        self.require_ready()?;
        let obs = self.backend.observe().map_err(Self::backend_err)?;
        self.state_version = obs.state_version;
        Ok(obs)
    }

    /// `act`: permission-checked action; stale refs are rejected here, before
    /// the backend is touched.
    pub fn act(&mut self, action: &Action) -> Result<ActionOutcome, RuntimeError> {
        self.require_ready()?;
        if !self.config.permissions.allows(action.kind_name()) {
            return Err(RuntimeError::PermissionDenied(action.kind_name().into()));
        }
        for r in action_refs(action) {
            if r.issued_at > self.state_version {
                // A ref from the future is a bug, not staleness; treat as backend error.
                return Err(RuntimeError::Backend(format!(
                    "ref issued at version {:?} newer than current {:?}",
                    r.issued_at, self.state_version
                )));
            }
            if r.issued_at < self.state_version {
                return Err(RuntimeError::StaleRef {
                    issued_at: r.issued_at,
                    current: self.state_version,
                });
            }
        }
        let outcome = self.backend.act(action).map_err(Self::backend_err)?;
        // Any delivered action may have mutated state.
        if !matches!(outcome, ActionOutcome::Failed { .. }) {
            self.state_version = StateVersion(self.state_version.0 + 1);
        }
        Ok(outcome)
    }

    /// `evidence`: session summary; trace.jsonl/result.json emission lands with
    /// the evidence writer in RT-009, which consumes this summary.
    pub fn evidence(&self) -> Result<SessionSummary, RuntimeError> {
        Ok(SessionSummary {
            session_id: self.config.session_id.clone(),
            started_at: String::new(), // RT-009 wires real timestamps
            events_path: String::new(),
            unresolved_state: match self.phase {
                SessionPhase::Failed => Some("session failed".into()),
                _ => None,
            },
        })
    }

    /// `reset`: back to a clean desktop; session becomes ready again.
    pub fn reset(&mut self) -> Result<(), RuntimeError> {
        self.require_ready()?;
        self.transition(SessionPhase::Resetting)?;
        match self.backend.reset() {
            Ok(()) => {
                self.state_version = StateVersion(0);
                self.transition(SessionPhase::Ready)
            }
            Err(e) => {
                let _ = self.transition(SessionPhase::Failed);
                Err(Self::backend_err(e))
            }
        }
    }

    /// `destroy`: terminal. After this the session rejects every op.
    ///
    /// Allowed from `Failed` too: a failed reset must not strand a live guest and
    /// overlay with no handle (REQ-12). The backend's destroy is crash-tolerant.
    pub fn destroy(&mut self) -> Result<(), RuntimeError> {
        if !matches!(self.phase, SessionPhase::Ready | SessionPhase::Failed) {
            return Err(RuntimeError::IllegalTransition {
                from: self.phase,
                to: SessionPhase::Destroyed,
            });
        }
        self.backend.destroy().map_err(Self::backend_err)?;
        self.transition(SessionPhase::Destroyed)
    }
}

fn action_refs(action: &Action) -> Vec<&crate::state::ElementRef> {
    match action {
        Action::Click { target } | Action::TypeText { target, .. } => vec![target],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::{ProcessInfo, WindowInfo};
    use crate::state::ElementRef;

    #[derive(Debug, thiserror::Error)]
    #[error("fake backend failure")]
    struct FakeErr;

    struct FakeBackend {
        version: u64,
        provisioned: bool,
        destroyed: bool,
        reset_count: u32,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self { version: 0, provisioned: false, destroyed: false, reset_count: 0 }
        }
    }

    impl Backend for FakeBackend {
        type Err = FakeErr;

        fn provision(&mut self) -> Result<(), FakeErr> {
            self.provisioned = true;
            Ok(())
        }

        fn observe(&mut self) -> Result<Observation, FakeErr> {
            Ok(Observation {
                state_version: StateVersion(self.version),
                a11y_tree: serde_json::json!({"role": "desktop", "children": []}),
                screenshot_artifact: None,
                processes: Vec::<ProcessInfo>::new(),
                windows: Vec::<WindowInfo>::new(),
            })
        }

        fn act(&mut self, action: &Action) -> Result<ActionOutcome, FakeErr> {
            match action {
                Action::Launch { .. } => {
                    self.version += 1;
                    Ok(ActionOutcome::DeliveredVerified)
                }
                _ => Ok(ActionOutcome::DeliveredUnverified),
            }
        }

        fn reset(&mut self) -> Result<(), FakeErr> {
            self.reset_count += 1;
            Ok(())
        }

        fn destroy(&mut self) -> Result<(), FakeErr> {
            self.destroyed = true;
            Ok(())
        }
    }

    fn session() -> Session<FakeBackend> {
        Session::new_creating(
            SessionConfig {
                session_id: "s1".into(),
                permissions: Permissions::default(),
                idle_timeout: None,
            },
            FakeBackend::new(),
        )
    }

    fn ready() -> Session<FakeBackend> {
        let mut s = session();
        s.create().unwrap();
        s
    }

    #[test]
    fn create_makes_session_ready() {
        let s = ready();
        assert_eq!(s.phase(), SessionPhase::Ready);
    }

    #[test]
    fn ops_before_create_are_rejected() {
        let mut s = session();
        assert!(matches!(
            s.observe(),
            Err(RuntimeError::IllegalTransition { .. })
        ));
        assert!(matches!(
            s.act(&Action::Launch { command: "x".into(), args: vec![] }),
            Err(RuntimeError::IllegalTransition { .. })
        ));
        assert!(matches!(s.destroy(), Err(RuntimeError::IllegalTransition { .. })));
    }

    #[test]
    fn observe_adopts_backend_state_version() {
        let mut s = ready();
        s.backend.version = 7;
        let obs = s.observe().unwrap();
        assert_eq!(obs.state_version, StateVersion(7));
        assert_eq!(s.state_version(), StateVersion(7));
    }

    #[test]
    fn stale_ref_is_rejected_before_backend() {
        let mut s = ready();
        let obs = s.observe().unwrap(); // version 0
        let r = ElementRef { payload: "n1".into(), issued_at: obs.state_version };
        // Mutate state: launch bumps the version.
        s.act(&Action::Launch { command: "x".into(), args: vec![] }).unwrap();
        let err = s.act(&Action::Click { target: r.clone() }).unwrap_err();
        assert!(matches!(err, RuntimeError::StaleRef { .. }));
        // And a current-version ref still reaches the backend.
        let obs2 = s.observe().unwrap();
        let ok = ElementRef { payload: "n1".into(), issued_at: obs2.state_version };
        assert!(s.act(&Action::Click { target: ok }).is_ok());
    }

    #[test]
    fn failed_action_does_not_bump_version() {
        let s = ready();
        let _v = s.state_version();
        // FakeBackend never fails; exercise via a failing backend instead.
        struct Fail;
        impl Backend for Fail {
            type Err = FakeErr;
            fn provision(&mut self) -> Result<(), FakeErr> { Ok(()) }
            fn observe(&mut self) -> Result<Observation, FakeErr> {
                Ok(Observation {
                    state_version: StateVersion(0),
                    a11y_tree: serde_json::json!(null),
                    screenshot_artifact: None,
                    processes: vec![],
                    windows: vec![],
                })
            }
            fn act(&mut self, _: &Action) -> Result<ActionOutcome, FakeErr> {
                Ok(ActionOutcome::Failed { reason: "no display".into() })
            }
            fn reset(&mut self) -> Result<(), FakeErr> { Ok(()) }
            fn destroy(&mut self) -> Result<(), FakeErr> { Ok(()) }
        }
        let mut fs = Session::new_creating(
            SessionConfig { session_id: "s2".into(), permissions: Permissions::default(), idle_timeout: None },
            Fail,
        );
        fs.create().unwrap();
        let out = fs.act(&Action::KeyPress { keys: "Return".into() }).unwrap();
        assert!(matches!(out, ActionOutcome::Failed { .. }));
        assert_eq!(fs.state_version(), StateVersion(0));
    }

    #[test]
    fn permission_denied_action_never_reaches_backend() {
        let mut s = session();
        s.config.permissions.allowed_actions.retain(|a| a != "launch");
        s.create().unwrap();
        let err = s
            .act(&Action::Launch { command: "x".into(), args: vec![] })
            .unwrap_err();
        assert!(matches!(err, RuntimeError::PermissionDenied(_)));
    }

    #[test]
    fn reset_returns_to_ready_and_zeroes_version() {
        let mut s = ready();
        s.act(&Action::Launch { command: "x".into(), args: vec![] }).unwrap();
        s.reset().unwrap();
        assert_eq!(s.phase(), SessionPhase::Ready);
        assert_eq!(s.state_version(), StateVersion(0));
        assert_eq!(s.backend.reset_count, 1);
    }

    #[test]
    fn destroy_is_terminal() {
        let mut s = ready();
        s.destroy().unwrap();
        assert!(s.backend.destroyed);
        assert!(matches!(
            s.observe(),
            Err(RuntimeError::IllegalTransition { .. })
        ));
        assert!(matches!(s.reset(), Err(RuntimeError::IllegalTransition { .. })));
        assert!(matches!(s.destroy(), Err(RuntimeError::IllegalTransition { .. })));
    }

    #[test]
    fn destroy_works_after_a_failed_reset() {
        struct ResetFails;
        #[derive(Debug, thiserror::Error)]
        #[error("reset failed")]
        struct E;
        impl Backend for ResetFails {
            type Err = E;
            fn provision(&mut self) -> Result<(), E> { Ok(()) }
            fn observe(&mut self) -> Result<Observation, E> {
                Ok(Observation {
                    state_version: StateVersion(0),
                    a11y_tree: serde_json::json!(null),
                    screenshot_artifact: None,
                    processes: vec![],
                    windows: vec![],
                })
            }
            fn act(&mut self, _: &Action) -> Result<ActionOutcome, E> { Ok(ActionOutcome::DeliveredUnverified) }
            fn reset(&mut self) -> Result<(), E> { Err(E) }
            fn destroy(&mut self) -> Result<(), E> { Ok(()) }
        }
        let mut s = Session::new_creating(
            SessionConfig { session_id: "s3".into(), permissions: Permissions::default(), idle_timeout: None },
            ResetFails,
        );
        s.create().unwrap();
        assert!(s.reset().is_err());
        assert_eq!(s.phase(), SessionPhase::Failed);
        // REQ-12: a failed reset must not strand the guest behind a terminal state.
        s.destroy().expect("destroy from Failed");
        assert_eq!(s.phase(), SessionPhase::Destroyed);
    }

    #[test]
    fn double_create_is_rejected() {
        let mut s = ready();
        assert!(matches!(
            s.create(),
            Err(RuntimeError::IllegalTransition { .. })
        ));
    }
}
