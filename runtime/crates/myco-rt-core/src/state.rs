//! Opaque element references and monotonic state versions (ADR-0003/0006 shapes).

use serde::{Deserialize, Serialize};

/// Monotonically increasing version of the observed desktop state. Any action
/// that can mutate state bumps it; refs older than the current version are stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct StateVersion(pub u64);

impl std::fmt::Display for StateVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Opaque reference to a UI element, valid only for the `issued_at` version.
/// The runtime never interprets the payload; only the issuing backend can.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementRef {
    pub payload: String,
    pub issued_at: StateVersion,
}
