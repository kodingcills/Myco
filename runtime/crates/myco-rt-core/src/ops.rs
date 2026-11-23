//! The six operations and the Backend trait (ADR-0011, ADR-0013).

use crate::state::{ElementRef, StateVersion};
use serde::{Deserialize, Serialize};

/// Closed action union (ADR-0004 shape, RT-008). Never a bare `ok` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    Launch { command: String, args: Vec<String> },
    Click { target: ElementRef },
    TypeText { target: ElementRef, text: String },
    /// Type into whatever window currently has focus, with no element target.
    ///
    /// Needed because some toolkits expose no accessibility nodes (Tk registers
    /// zero AT-SPI nodes, RT-003), so there is no `ElementRef` to aim at even
    /// though the app's entry field holds focus. Runs through the same XTEST path
    /// as `KeyPress`, which is why it carries no ref and no staleness binding.
    TypeTextGlobal { text: String },
    /// Click a raw screen coordinate.
    ///
    /// The escape hatch for the same case: a canvas or an AT-SPI-blind toolkit
    /// has no element to reference, only a position. `x`/`y` are guest screen
    /// coordinates, so this is deliberately not ref-bound.
    ClickAt { x: i32, y: i32 },
    KeyPress { keys: String },
}

impl Action {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Action::Launch { .. } => "launch",
            Action::Click { .. } => "click",
            Action::TypeText { .. } => "typeText",
            Action::TypeTextGlobal { .. } => "typeTextGlobal",
            Action::ClickAt { .. } => "clickAt",
            Action::KeyPress { .. } => "keyPress",
        }
    }
}

/// Three-way action outcome (ADR-0003): never collapse to boolean success.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionOutcome {
    /// The action landed and a post-action state check confirmed the effect.
    DeliveredVerified,
    /// The action was delivered but no confirmation was possible.
    DeliveredUnverified,
    /// The action did not land; reason attached.
    Failed { reason: String },
}

/// One `observe` result: accessibility tree + screenshot + process/window info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Observation {
    pub state_version: StateVersion,
    /// Serialized accessibility tree (backend-defined node schema).
    pub a11y_tree: serde_json::Value,
    /// Path to the screenshot artifact inside the session run directory.
    pub screenshot_artifact: Option<String>,
    pub processes: Vec<ProcessInfo>,
    pub windows: Vec<WindowInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    pub pid: u32,
}

/// One session-level trace event; serialized into trace.jsonl and validated
/// against M1's trace-events schema at the evidence boundary (ADR-0012).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub seq: u64,
    pub at: String,
    pub event: serde_json::Value,
}

/// Paths of a session's evidence artifacts (ADR-0007 layout).
#[derive(Debug, Clone)]
pub struct EvidenceArtifacts {
    pub trace_path: String,
    pub result_path: String,
}

/// Extension capability (RT-015): a backend that can read guest files under an
/// explicit grant. Separate from `Backend` so a backend without file access is
/// still a valid backend.
pub trait GuestFileRead {
    type ReadErr: std::error::Error + Send + Sync + 'static;
    fn read_guest_file(&mut self, path: &str) -> Result<Vec<u8>, Self::ReadErr>;
}

/// Extension capability (RT-017): a backend that can write a guest file under an
/// explicit grant. Separate from `GuestFileRead` so a backend may support one and
/// not the other; the confinement is the backend's job, and it is the same grant
/// the read uses.
pub trait GuestFileWrite {
    type WriteErr: std::error::Error + Send + Sync + 'static;
    /// Write/replace `path` within the backend's grant, returning bytes written.
    fn write_guest_file(&mut self, path: &str, bytes: &[u8]) -> Result<usize, Self::WriteErr>;
}

/// Exit status of a managed guest process (RT-016).
///
/// Either field may be absent: a process that exited normally has `code` and no
/// `signal`; one killed by a signal has `signal` and no `code`. Modelled as two
/// `Option`s rather than a single status because "exited 0" and "killed by 0" are
/// different facts and collapsing them would lose which happened.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcessExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

/// Extension capability (RT-016): a backend that can kill and relaunch a named
/// guest process. Separate from `Backend` for the same reason as `GuestFileRead`:
/// process control is an extension beyond the six-op surface, and a backend that
/// cannot do it is still a valid backend.
///
/// `launch` already exists as an `act` kind; this adds the two ops an oracle needs
/// to test recovery — kill a process mid-session and bring it back — without a
/// shell.
pub trait GuestProcessControl {
    type ProcErr: std::error::Error + Send + Sync + 'static;
    /// Launch a process and return a handle that `kill_guest_process` and
    /// `relaunch_guest_process` accept. Distinct from `Action::Launch`, which
    /// starts a process but returns no handle: without this, kill/relaunch have
    /// nothing to name.
    fn launch_guest_process(
        &mut self,
        command: &str,
        args: &[String],
    ) -> Result<String, Self::ProcErr>;
    /// SIGKILL the process behind `handle`, returning how it died.
    fn kill_guest_process(&mut self, handle: &str) -> Result<ProcessExit, Self::ProcErr>;
    /// Relaunch the process behind a previously-killed `handle`, returning a new
    /// handle for the replacement.
    fn relaunch_guest_process(&mut self, handle: &str) -> Result<String, Self::ProcErr>;
}

/// The host backend seam. Implementations: QemuLinuxBackend (RT-006), later
/// UtmWindowsBackend (RT-012) and CloudBackend. The six runtime ops route here.
pub trait Backend: Send {
    type Err: std::error::Error + Send + Sync + 'static;

    /// Provision the guest and reach a ready desktop.
    fn provision(&mut self) -> Result<(), Self::Err>;
    /// Read desktop state: a11y tree, screenshot, processes, windows.
    fn observe(&mut self) -> Result<Observation, Self::Err>;
    /// Perform one action. Implementations MUST bound all waits.
    fn act(&mut self, action: &Action) -> Result<ActionOutcome, Self::Err>;
    /// `evidence`: export this session's artifacts (trace + result). Returns the
    /// paths written; validation failures are errors, never partial artifacts.
    fn evidence(&mut self) -> Result<EvidenceArtifacts, Self::Err>;
    /// Return to a clean desktop (discard writes; reboot as needed).
    fn reset(&mut self) -> Result<(), Self::Err>;
    /// Tear down the guest and delete all on-disk state.
    fn destroy(&mut self) -> Result<(), Self::Err>;
}
