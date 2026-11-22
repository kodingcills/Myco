//! Myco desktop runtime core (RT-005).
//!
//! Scope per ADR-0012: desktop lifecycle and session layer only. No program
//! runner, no verifier orchestration, no verdicts — those belong to M1's
//! TypeScript runtime. This crate speaks M1's adapter vocabulary (ADR-0003):
//! opaque refs with state versions, `StaleRefError`, three-way action outcomes.

use serde::{Deserialize, Serialize};

pub mod ops;
pub mod session;
pub mod state;

pub use ops::{Action, ActionOutcome, Backend, EvidenceArtifacts, Observation, SessionEvent};
pub use session::{Session, SessionConfig, SessionPhase};
pub use state::{ElementRef, StateVersion};

/// Errors surfaced by the runtime. Verdict-shaped outcomes do not exist here
/// (ADR-0012); failures are operational, never task-success claims.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("stale element ref: issued at state version {issued_at}, current is {current}")]
    StaleRef { issued_at: StateVersion, current: StateVersion },

    #[error("ambiguous target: {0}")]
    AmbiguousTarget(String),

    #[error("illegal session transition: {from} -> {to}")]
    IllegalTransition { from: SessionPhase, to: SessionPhase },

    #[error("permission denied: {0}")]
    PermissionDenied(String),

    #[error("backend error: {0}")]
    Backend(String),
}

/// A permission grant scoped to one session (RT-005). v0 is coarse: the set of
/// action kinds an agent may perform. Finer policy (path allowlists, network
/// policy) is a later ADR.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Permissions {
    pub allowed_actions: Vec<String>,
}

impl Default for Permissions {
    fn default() -> Self {
        Self {
            allowed_actions: vec![
                "launch".into(),
                "click".into(),
                "typeText".into(),
                "keyPress".into(),
                // The targetless variants. Without these, Discovery's S0 would be
                // refused by the permission set rather than reaching the guest --
                // and the refusal would look like an XTEST failure.
                "typeTextGlobal".into(),
                "clickAt".into(),
            ],
        }
    }
}

impl Permissions {
    pub fn allows(&self, action_kind: &str) -> bool {
        self.allowed_actions.iter().any(|a| a == action_kind)
    }
}
