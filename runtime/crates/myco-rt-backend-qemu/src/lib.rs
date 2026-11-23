//! QEMU+HVF Linux backend (RT-006, ADR-0011).
//!
//! Lifecycle is real: provision boots a qcow2-overlay guest and authenticates the
//! control channel; reset discards the overlay and reboots to a pristine guest;
//! destroy tears down the guest and deletes session state. The backend drives the
//! proven `runtime/guest/` scripts rather than duplicating QEMU invocation logic.
//!
//! `observe`/`act` are RT-007/008 and return `Unimplemented` here by design.

pub mod workspace;

use myco_rt_core::ops::{Action, ActionOutcome, Observation};
use myco_rt_core::Backend;
use myco_rt_transport::{Channel, SshConfig};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("concurrency cap reached: another session holds {0}")]
    CapReached(String),
    #[error("script failed: {script} (status {status}): {stderr}")]
    Script { script: String, status: String, stderr: String },
    #[error("transport: {0}")]
    Transport(#[from] myco_rt_transport::TransportError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("unimplemented in RT-006: {0}")]
    Unimplemented(&'static str),
    #[error("protocol: {0}")]
    Protocol(String),
    #[error("evidence: {0}")]
    Evidence(String),
}

/// Configuration for one QEMU Linux session.
pub struct QemuConfig {
    /// `runtime/guest/` directory (scripts + state + keys).
    pub guest_dir: PathBuf,
    /// Per-session auth token for the control channel.
    pub token: String,
    /// Guest SSH port (10022 per ADR-0015 provisioning).
    pub ssh_port: u16,
    /// Max time to wait for SSH after boot.
    pub boot_timeout: Duration,
    /// ADR-0016 introspection channel: guest path the agent reads widget state
    /// from. `None` = channel disabled (observation reports `null`).
    pub introspection_file: Option<String>,
    /// Per-op deadline for the control channel.
    pub op_timeout_secs: u64,
    /// How long `provision`/`reset` wait for a usable desktop (cloud-init installs
    /// packages for minutes on a fresh overlay).
    pub desktop_timeout_secs: u64,
    /// Session id, used as the evidence run id.
    pub session_id: String,
    /// Root directory for `runs/<session>/` evidence artifacts.
    pub evidence_root: PathBuf,
}

impl QemuConfig {
    pub fn for_repo(workspace_root: &Path, token: &str) -> Self {
        Self {
            guest_dir: workspace_root.join("runtime").join("guest"),
            token: token.to_string(),
            ssh_port: 10022,
            boot_timeout: Duration::from_secs(180),
            introspection_file: None,
            op_timeout_secs: 10,
            desktop_timeout_secs: 900,
            session_id: format!("session-{}", std::process::id()),
            evidence_root: workspace_root.to_path_buf(),
        }
    }
}

pub struct QemuLinuxBackend {
    config: QemuConfig,
    channel: Option<Channel>,
    read_root: Option<String>,
    lock_path: PathBuf,
    locked: bool,
    /// State version of the last successful `observe`; refs are bound to it.
    last_state_version: u64,
    /// Evidence recorder for this session (RT-009).
    recorder: Option<myco_rt_evidence::SessionRecorder>,
}

/// The session lock file enforcing the concurrency cap (ADR-0011: default 1).
fn lock_path(guest_dir: &Path) -> PathBuf {
    guest_dir.join("state").join("SESSION.lock")
}

impl QemuLinuxBackend {
    pub fn new(config: QemuConfig) -> Self {
        let lock_path = lock_path(&config.guest_dir);
        Self {
            config,
            channel: None,
            read_root: None,
            lock_path,
            locked: false,
            last_state_version: 0,
            recorder: None,
        }
    }

    /// Enable host-oracle reads under one existing guest directory at provision and reset.
    pub fn with_read_grant(mut self, root: String) -> Self {
        self.read_root = Some(root);
        self
    }

    pub fn read_guest_file(&mut self, relative_path: &str) -> Result<Vec<u8>, BackendError> {
        Ok(self.control_channel()?.read_file(relative_path)?)
    }

    /// RT-017: write bytes to a grant-relative guest path via the control channel.
    pub fn write_guest_file(&mut self, relative_path: &str, bytes: &[u8]) -> Result<usize, BackendError> {
        Ok(self.control_channel()?.write_file(relative_path, bytes)?)
    }

    pub fn launch_guest_process(&mut self, command: &str, args: &[String]) -> Result<String, BackendError> {
        self.last_state_version = 0;
        Ok(self.control_channel()?.launch_process(command, args)?)
    }

    pub fn kill_guest_process(&mut self, handle: &str) -> Result<myco_rt_transport::ProcessExit, BackendError> {
        self.last_state_version = 0;
        Ok(self.control_channel()?.kill_process(handle)?)
    }

    pub fn relaunch_guest_process(&mut self, handle: &str) -> Result<String, BackendError> {
        self.last_state_version = 0;
        Ok(self.control_channel()?.relaunch_process(handle)?)
    }

    fn control_channel(&mut self) -> Result<&mut Channel, BackendError> {
        self.channel.as_mut().ok_or_else(|| BackendError::Protocol("no active guest control channel".into()))
    }

    fn run_script(&self, name: &str, args: &[&str]) -> Result<String, BackendError> {
        let script = self.config.guest_dir.join(name);
        let out = Command::new(script.as_os_str())
            .args(args)
            .output()
            .map_err(|e| BackendError::Script {
                script: name.into(),
                status: "spawn-failed".into(),
                stderr: e.to_string(),
            })?;
        if !out.status.success() {
            return Err(BackendError::Script {
                script: name.into(),
                status: out.status.to_string(),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    fn ssh_config(&self) -> SshConfig {
        SshConfig {
            host: "localhost".into(),
            port: self.config.ssh_port,
            user: "myco".into(),
            identity_file: self
                .config
                .guest_dir
                .join("keys")
                .join("id_ed25519")
                .to_string_lossy()
                .to_string(),
            token: self.config.token.clone(),
            agent_path: "/home/myco/bin/myco-rt-agent".into(),
            introspection_file: self.config.introspection_file.clone(),
            op_timeout: Duration::from_secs(self.config.op_timeout_secs),
        }
    }

    fn acquire_lock(&mut self) -> Result<(), BackendError> {
        std::fs::create_dir_all(self.lock_path.parent().unwrap())?;
        // Atomic create: a live lock means another session owns the single guest.
        // Stale locks (holder pid dead) are reclaimed.
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.lock_path)
        {
            Ok(mut f) => {
                use std::io::Write;
                writeln!(f, "{}", std::process::id()).ok();
                self.locked = true;
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let holder = std::fs::read_to_string(&self.lock_path)
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok());
                let alive = holder.map(|pid| Path::new(&format!("/proc/{pid}")).exists() || cfg!(target_os = "macos") && kill_zero(pid));
                if alive == Some(true) {
                    return Err(BackendError::CapReached(
                        self.lock_path.to_string_lossy().to_string(),
                    ));
                }
                // Stale or unreadable lock: remove and retry once.
                let _ = std::fs::remove_file(&self.lock_path);
                self.acquire_lock()
            }
            Err(e) => Err(BackendError::Io(e)),
        }
    }

    fn release_lock(&mut self) {
        if self.locked {
            let _ = std::fs::remove_file(&self.lock_path);
            self.locked = false;
        }
    }

    fn wait_ssh(&self) -> Result<(), BackendError> {
        let deadline = Instant::now() + self.config.boot_timeout;
        loop {
            let ok = Command::new("ssh")
                .args([
                    "-i",
                    &self.config.guest_dir.join("keys").join("id_ed25519").to_string_lossy(),
                    "-p",
                    &self.config.ssh_port.to_string(),
                    "-o", "StrictHostKeyChecking=no",
                    "-o", "UserKnownHostsFile=/dev/null",
                    "-o", "BatchMode=yes",
                    "-o", "ConnectTimeout=3",
                    "myco@localhost",
                    "true",
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                return Ok(());
            }
            if Instant::now() > deadline {
                return Err(BackendError::Protocol("SSH did not come up before boot_timeout".into()));
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    fn connect(&mut self) -> Result<(), BackendError> {
        let mut ch = Channel::connect_ssh(&self.ssh_config())?;
        ch.require_ops(&["ping", "observe"])?;
        if let Some(root) = &self.read_root {
            ch.grant_read(root)?;
        }
        self.channel = Some(ch);
        Ok(())
    }

    /// Poll until the GUI session answers with at least one AT-SPI application.
    ///
    /// Two waits, deliberately ordered: cloud-init FIRST (a fresh overlay installs
    /// packages and restarts services mid-run, which tears down the X session and
    /// the AT-SPI bus), then the desktop. Polling the desktop first "works" only
    /// by accident — it sees a session that is about to be replaced.
    fn wait_desktop(&mut self) -> Result<(), BackendError> {
        let ci_deadline = Instant::now() + Duration::from_secs(self.config.desktop_timeout_secs);
        loop {
            // Bound each probe: an unbounded `cloud-init status --wait` would make
            // this deadline decorative (review M1).
            let probe = self.guest_exec_within(
                "timeout 20 cloud-init status --wait >/dev/null 2>&1 && echo READY",
                Duration::from_secs(40),
            );
            match probe {
                Ok(out) if out.contains("READY") => break,
                Ok(_) | Err(_) if Instant::now() < ci_deadline => {
                    std::thread::sleep(Duration::from_secs(3));
                }
                Ok(_) | Err(_) => {
                    return Err(BackendError::Protocol(
                        "cloud-init did not settle within the desktop timeout".into(),
                    ))
                }
            }
        }
        let deadline = Instant::now() + Duration::from_secs(self.config.desktop_timeout_secs);
        loop {
            // A provider opened before the desktop settled can retain a dead bus
            // connection. Each readiness attempt uses a fresh guest agent.
            self.channel = None;
            match self.connect().and_then(|()| self.observe()) {
                Ok(_) => return Ok(()),
                Err(e) => {
                    if Instant::now() > deadline {
                        return Err(BackendError::Protocol(format!(
                            "desktop not ready within {}s: {e}",
                            self.config.desktop_timeout_secs
                        )));
                    }
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        }
    }

    /// Install the agent binary into the guest (idempotent, and required after every
    /// fresh overlay — the base image carries no agent).
    ///
    /// Both build paths end with a binary on the host: the musl static build, or the
    /// copy fetched back by `build-agent-in-guest.sh`. The guest copy alone is not
    /// enough: `reset()` recreates the overlay and deletes it.
    fn install_agent(&self) -> Result<(), BackendError> {
        self.guest_exec("mkdir -p /home/myco/bin")?;
        let root = self.config.guest_dir.parent().unwrap();
        let candidates = [
            root.join("target/aarch64-unknown-linux-musl/release/myco-rt-agent"),
            self.config.guest_dir.join("state/myco-rt-agent-aarch64"),
        ];
        let Some(local) = candidates.iter().find(|p| p.exists()) else {
            return Err(BackendError::Protocol(
                "no agent binary on the host: build one with runtime/guest/build-agent-in-guest.sh \
                 (it stores a copy under runtime/guest/state/)"
                    .into(),
            ));
        };
        // Freshness guard: an old binary silently shadowing a newer source tree is
        // exactly the stale-agent class this workstream already hit twice. Compare
        // against the newest file in the agent crate and refuse to install.
        let agent_src = self.config.guest_dir.parent().unwrap().join("crates/myco-rt-agent");
        if let (Ok(bin_meta), Some(newest_src)) = (
            std::fs::metadata(local),
            newest_mtime(&agent_src),
        ) {
            if let Ok(bin_mtime) = bin_meta.modified() {
                if bin_mtime < newest_src {
                    return Err(BackendError::Protocol(format!(
                        "agent binary {} is older than the agent sources; rebuild with \
                         runtime/guest/build-agent-in-guest.sh",
                        local.display()
                    )));
                }
            }
        }
        let status = Command::new("scp")
            .args([
                "-i", &self.config.guest_dir.join("keys").join("id_ed25519").to_string_lossy(),
                "-P", &self.config.ssh_port.to_string(),
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
            ])
            .arg(local)
            .arg("myco@localhost:/home/myco/bin/myco-rt-agent")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if !status.success() {
            return Err(BackendError::Protocol("scp of agent failed".into()));
        }
        self.guest_exec("chmod +x /home/myco/bin/myco-rt-agent")?;
        Ok(())
    }

    /// Run a command in the guest over plain SSH (lifecycle ops only; the op
    /// channel is `Channel`). Used for agent installation and reset verification.
    pub fn guest_exec(&self, remote: &str) -> Result<String, BackendError> {
        self.guest_exec_within(remote, Duration::from_secs(self.config.op_timeout_secs.max(30)))
    }

    /// Run a guest command with a HARD host-side deadline covering the whole
    /// operation: spawn, output draining, and exit.
    ///
    /// Three failure modes this must survive, all seen or measured:
    /// - a hung guest sshd (no exit at all);
    /// - a command whose output fills a pipe, blocking ssh because nobody drains
    ///   it (draining only after `try_wait` reports exit deadlocks exactly there);
    /// - a grandchild that keeps the pipe's write end open after the direct child
    ///   exits, so waiting on the child alone still blocks forever.
    /// So: drain both pipes on their own threads from the moment of spawn, poll
    /// the child against the deadline, then join the drainers under a bounded wait.
    pub fn guest_exec_within(
        &self,
        remote: &str,
        deadline: Duration,
    ) -> Result<String, BackendError> {
        let mut child = Command::new("ssh")
            .args([
                "-i", &self.config.guest_dir.join("keys").join("id_ed25519").to_string_lossy(),
                "-p", &self.config.ssh_port.to_string(),
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=10",
                "-o", "ServerAliveInterval=5",
                "-o", "ServerAliveCountMax=3",
                "myco@localhost",
                remote,
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(BackendError::Io)?;

        let mut out_pipe = child
            .stdout
            .take()
            .ok_or_else(|| BackendError::Protocol("guest exec: no stdout pipe".into()))?;
        let mut err_pipe = child
            .stderr
            .take()
            .ok_or_else(|| BackendError::Protocol("guest exec: no stderr pipe".into()))?;

        // Drain immediately: a full pipe blocks ssh and would look like a hang.
        let out_thread = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut out_pipe, &mut buf);
            buf
        });
        let err_thread = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut err_pipe, &mut buf);
            buf
        });

        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) if start.elapsed() < deadline => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    // Drainers may still be blocked by a grandchild holding the
                    // pipe; detach rather than join on this path.
                    return Err(BackendError::Protocol(format!(
                        "guest command exceeded {deadline:?}: `{remote}`. The guest did not \
                         answer in time — check it is up (runtime/guest/boot.sh) and that the \
                         control channel responds, then retry"
                    )));
                }
                Err(e) => return Err(BackendError::Io(e)),
            }
        };

        // Join the drainers, but never past the deadline.
        let remaining = deadline.saturating_sub(start.elapsed());
        let stdout = join_within(out_thread, remaining);
        let stderr = join_within(err_thread, remaining);

        if !status.success() {
            return Err(BackendError::Protocol(format!(
                "guest command failed (`{remote}`): {}",
                String::from_utf8_lossy(&stderr.unwrap_or_default()).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&stdout.unwrap_or_default()).to_string())
    }
}

#[cfg(unix)]
fn kill_zero(pid: u32) -> bool {
    // kill(pid, 0) without libc: use `kill -0` via the shell builtin.
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Lower an action to the JSON the guest agent parses (RT-008).
///
/// Extracted from `act` so the wire form is testable without a guest (RT-022): the
/// agent crate does not depend on this one, so the agent-side tests necessarily
/// assert against a hand-copied literal. Without a test here, a rename on THIS side
/// -- "x" to "px" -- passed every deterministic test and failed only inside a VM.
///
/// Pure: no `self`, no channel. Keep it that way; that is what makes it testable.
fn action_to_wire(action: &Action) -> serde_json::Value {
    match action {
        Action::Launch { command, args } => serde_json::json!({
            "kind": "launch", "command": command, "args": args
        }),
        Action::Click { target } => serde_json::json!({
            "kind": "click", "target": target.payload
        }),
        Action::TypeText { target, text } => serde_json::json!({
            "kind": "typeText", "target": target.payload, "text": text
        }),
        Action::TypeTextGlobal { text } => serde_json::json!({
            "kind": "typeTextGlobal",
            "text": text,
        }),
        Action::ClickAt { x, y } => serde_json::json!({
            "kind": "clickAt",
            "x": x,
            "y": y,
        }),
        Action::KeyPress { keys } => serde_json::json!({
            "kind": "keyPress", "keys": keys
        }),
    }
}

/// The element ref an action carries, if any.
fn action_ref(action: &Action) -> Option<&myco_rt_core::ElementRef> {
    match action {
        Action::Click { target } | Action::TypeText { target, .. } => Some(target),
        // TypeTextGlobal/ClickAt address focus or a raw point, not an observation
        // ref, so there is no version to bind -- see the same note in session.rs.
        Action::KeyPress { .. } | Action::TypeTextGlobal { .. } | Action::ClickAt { .. } => None,
        _ => None,
    }
}

/// Join a drainer thread, giving up after `budget` so a grandchild holding a pipe
/// cannot extend an operation past its deadline.
fn join_within<T>(handle: std::thread::JoinHandle<T>, budget: Duration) -> Option<T> {
    let start = Instant::now();
    while !handle.is_finished() {
        if start.elapsed() >= budget {
            std::mem::forget(handle); // detach: it may stay blocked forever
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    handle.join().ok()
}

/// Newest modification time under `dir` (recursive), used for staleness checks.
fn newest_mtime(dir: &Path) -> Option<std::time::SystemTime> {
    let mut newest = None;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(t) = newest_mtime(&path) {
                newest = Some(match newest {
                    Some(cur) if cur > t => cur,
                    _ => t,
                });
            }
        } else if let Ok(meta) = entry.metadata() {
            if let Ok(t) = meta.modified() {
                newest = Some(match newest {
                    Some(cur) if cur > t => cur,
                    _ => t,
                });
            }
        }
    }
    newest
}

impl myco_rt_core::ops::GuestFileRead for QemuLinuxBackend {
    type ReadErr = BackendError;

    fn read_guest_file(&mut self, path: &str) -> Result<Vec<u8>, BackendError> {
        // Fully-qualified on purpose: `self.read_guest_file(path)` would resolve to
        // this trait method if the inherent one were ever removed, recursing
        // infinitely instead of failing to compile (review §4).
        QemuLinuxBackend::read_guest_file(self, path)
    }
}

impl myco_rt_core::ops::GuestFileWrite for QemuLinuxBackend {
    type WriteErr = BackendError;

    fn write_guest_file(&mut self, path: &str, bytes: &[u8]) -> Result<usize, BackendError> {
        // Fully-qualified for the same reason as the read impl above.
        QemuLinuxBackend::write_guest_file(self, path, bytes)
    }
}

impl myco_rt_core::ops::GuestProcessControl for QemuLinuxBackend {
    type ProcErr = BackendError;

    fn launch_guest_process(
        &mut self,
        command: &str,
        args: &[String],
    ) -> Result<String, BackendError> {
        QemuLinuxBackend::launch_guest_process(self, command, args)
    }

    fn kill_guest_process(
        &mut self,
        handle: &str,
    ) -> Result<myco_rt_core::ops::ProcessExit, BackendError> {
        // Fully-qualified for the same reason as `read_guest_file` above: the
        // inherent method has the same name, and a plain call would recurse if the
        // inherent one were ever removed.
        let exit = QemuLinuxBackend::kill_guest_process(self, handle)?;
        Ok(myco_rt_core::ops::ProcessExit {
            code: exit.code,
            signal: exit.signal,
        })
    }

    fn relaunch_guest_process(&mut self, handle: &str) -> Result<String, BackendError> {
        QemuLinuxBackend::relaunch_guest_process(self, handle)
    }
}

impl Backend for QemuLinuxBackend {
    type Err = BackendError;

    fn provision(&mut self) -> Result<(), BackendError> {
        self.acquire_lock()?;
        let result = (|| {
            self.run_script("boot.sh", &[])?;
            self.wait_ssh()?;
            self.install_agent()?;
            // Evidence is collected from the first op onward (RT-009).
            self.recorder = Some(
                myco_rt_evidence::SessionRecorder::new(
                    &self.config.evidence_root,
                    &self.config.session_id,
                    "myco-runtime-session",
                )
                .map_err(|e| BackendError::Evidence(e.to_string()))?,
            );
            // `provision` promises a usable desktop, not just a live channel.
            self.wait_desktop()?;
            Ok(())
        })();
        if result.is_err() {
            // A failed provision must not strand the lock or a half-booted guest.
            let _ = self.run_script("shutdown.sh", &[]);
            self.release_lock();
        }
        result
    }

    fn observe(&mut self) -> Result<Observation, BackendError> {
        let ch = self
            .channel
            .as_mut()
            .ok_or_else(|| BackendError::Protocol("observe before provision".into()))?;
        let resp = ch.observe()?;
        let obs = resp
            .get("observation")
            .ok_or_else(|| BackendError::Protocol("observe response missing observation".into()))?;
        let version = obs.get("state_version").and_then(|v| v.as_u64()).unwrap_or(0);
        let nodes = obs.get("nodes").cloned().unwrap_or(serde_json::json!([]));
        let windows = obs.get("windows").cloned().unwrap_or(serde_json::json!([]));
        let processes = obs.get("processes").cloned().unwrap_or(serde_json::json!([]));
        let screenshot = obs
            .get("screenshot_path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        self.last_state_version = version;
        if let Some(rec) = self.recorder.as_mut() {
            rec.observation(version, nodes.as_array().map(|a| a.len()).unwrap_or(0));
        }
        Ok(Observation {
            state_version: myco_rt_core::StateVersion(version),
            a11y_tree: serde_json::json!({
                "nodes": nodes,
                "roots": obs.get("roots").cloned().unwrap_or(serde_json::json!([])),
                "truncated": obs.get("truncated").cloned().unwrap_or(serde_json::json!(false)),
                "introspection": obs.get("introspection").cloned().unwrap_or(serde_json::Value::Null),
            }),
            screenshot_artifact: screenshot,
            processes: serde_json::from_value(processes).unwrap_or_default(),
            windows: serde_json::from_value(windows).unwrap_or_default(),
        })
    }

    fn act(&mut self, action: &Action) -> Result<ActionOutcome, BackendError> {
        // Refs carry the version they were issued at; never relabel them with the
        // newest observation (adversarial review M3). A ref from an older
        // observation is stale, and saying so is the whole point of the binding.
        let version = match action_ref(action) {
            Some(r) => {
                if r.issued_at.0 != self.last_state_version {
                    return Ok(ActionOutcome::Failed {
                        reason: format!(
                            "stale_ref: ref issued at version {}, current is {}; re-observe",
                            r.issued_at.0, self.last_state_version
                        ),
                    });
                }
                r.issued_at.0
            }
            None => self.last_state_version,
        };
        let ch = self
            .channel
            .as_mut()
            .ok_or_else(|| BackendError::Protocol("act before provision".into()))?;
        let wire = action_to_wire(action);
        let resp = ch.act(wire.clone(), version)?;
        let outcome = resp
            .get("outcome")
            .cloned()
            .ok_or_else(|| BackendError::Protocol("act response missing outcome".into()))?;
        let resolved = match outcome.get("outcome").and_then(|v| v.as_str()) {
            Some("delivered_verified") => ActionOutcome::DeliveredVerified,
            Some("delivered_unverified") => ActionOutcome::DeliveredUnverified,
            Some("failed") => ActionOutcome::Failed {
                reason: outcome
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unspecified")
                    .to_string(),
            },
            other => {
                return Err(BackendError::Protocol(format!(
                    "unknown act outcome {other:?}"
                )))
            }
        };

        // Evidence: the delivery disposition, never a task verdict (ADR-0012).
        let disposition = match &resolved {
            ActionOutcome::DeliveredVerified => "delivered_verified",
            ActionOutcome::DeliveredUnverified => "delivered_unverified",
            ActionOutcome::Failed { .. } => "failed",
        };
        let detail = match &resolved {
            ActionOutcome::DeliveredVerified => "action landed and read-back confirmed".to_string(),
            ActionOutcome::DeliveredUnverified => "action delivered; no read-back possible".to_string(),
            ActionOutcome::Failed { reason } => reason.clone(),
        };
        let before = version;
        if !matches!(resolved, ActionOutcome::Failed { .. }) {
            self.last_state_version += 1;
        }
        if let Some(rec) = self.recorder.as_mut() {
            rec.action(wire.clone(), before, self.last_state_version, disposition, &detail);
        }
        Ok(resolved)
    }

    fn evidence(&mut self) -> Result<myco_rt_core::ops::EvidenceArtifacts, BackendError> {
        let rec = self
            .recorder
            .as_mut()
            .ok_or_else(|| BackendError::Protocol("evidence before provision".into()))?;
        let paths = rec.flush().map_err(|e| BackendError::Evidence(e.to_string()))?;
        Ok(myco_rt_core::ops::EvidenceArtifacts {
            trace_path: paths.trace.to_string_lossy().to_string(),
            result_path: paths.result.to_string_lossy().to_string(),
        })
    }

    fn reset(&mut self) -> Result<(), BackendError> {
        self.channel = None;
        self.run_script("shutdown.sh", &[])?;
        self.run_script("create-overlay.sh", &["--recreate"])?;
        self.run_script("boot.sh", &[])?;
        self.wait_ssh()?;
        self.install_agent()?;
        // The guest restarts its state counter on a fresh overlay; mirror it so a
        // pre-reset ref can never validate against post-reset state.
        self.last_state_version = 0;
        // A recreated overlay re-runs cloud-init: wait for a usable desktop again.
        self.wait_desktop()?;
        Ok(())
    }

    fn destroy(&mut self) -> Result<(), BackendError> {
        self.channel = None;
        // Destroy must work even after a guest-side crash: shutdown.sh is
        // best-effort; a missing/dead guest is not an error.
        let _ = self.run_script("shutdown.sh", &[]);
        let overlay = self.config.guest_dir.join("state").join("myco-runtime-v0.qcow2");
        if overlay.exists() {
            std::fs::remove_file(&overlay)?;
        }
        self.release_lock();
        Ok(())
    }
}

impl Drop for QemuLinuxBackend {
    fn drop(&mut self) {
        // Never leak the lock; the guest itself is torn down by destroy().
        self.release_lock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RT-022: the backend half of the act wire contract.
    ///
    /// The agent crate does not depend on this one, so its tests assert against a
    /// hand-copied literal. These assert the REAL output, so a rename here fails
    /// deterministically instead of only inside a guest.
    ///
    /// The literals below are the contract. Changing one on either side must fail
    /// exactly one of the two suites, and both are VM-free.
    mod action_to_wire_tests {
        use super::*;
        use myco_rt_core::{Action, ElementRef, StateVersion};

        fn r(payload: &str) -> ElementRef {
            ElementRef { payload: payload.into(), issued_at: StateVersion(0) }
        }

        #[test]
        fn launch_carries_command_and_args() {
            let w = action_to_wire(&Action::Launch {
                command: "x".into(),
                args: vec!["-a".into()],
            });
            assert_eq!(w["kind"], "launch");
            assert_eq!(w["command"], "x");
            assert_eq!(w["args"][0], "-a");
        }

        #[test]
        fn click_carries_the_ref_payload_not_the_version() {
            let w = action_to_wire(&Action::Click { target: r("e1") });
            assert_eq!(w["kind"], "click");
            assert_eq!(
                w["target"], "e1",
                "the wire carries the opaque payload; the version stays host-side"
            );
            assert!(w.get("issued_at").is_none(), "version must not leak onto the wire");
        }

        #[test]
        fn type_text_carries_the_target_payload_and_text() {
            let w = action_to_wire(&Action::TypeText { target: r("e1"), text: "t".into() });
            assert_eq!(w["kind"], "typeText");
            assert_eq!(w["target"], "e1");
            assert_eq!(w["text"], "t");
        }

        /// The S0 primitive. Field name and kind are exactly what the agent parses.
        #[test]
        fn type_text_global_carries_only_text() {
            let w = action_to_wire(&Action::TypeTextGlobal { text: "buy milk".into() });
            assert_eq!(w["kind"], "typeTextGlobal");
            assert_eq!(w["text"], "buy milk");
            assert!(
                w.get("target").is_none(),
                "a targetless action must not emit a target field, or the agent would \
                 expect one"
            );
        }

        #[test]
        fn click_at_carries_xy_as_integers() {
            let w = action_to_wire(&Action::ClickAt { x: 320, y: 240 });
            assert_eq!(w["kind"], "clickAt");
            assert_eq!(w["x"], 320);
            assert_eq!(w["y"], 240);
            assert!(w["x"].is_i64(), "coordinates must stay integers, not strings");
        }

        /// Negative coordinates must reach the wire unchanged, so the agent can
        /// refuse them with a real message rather than the backend silently
        /// clamping them to 0.
        #[test]
        fn negative_coordinates_survive_to_the_wire() {
            let w = action_to_wire(&Action::ClickAt { x: -5, y: 10 });
            assert_eq!(w["x"], -5, "clamping here would make the agent's refusal untestable");
        }

        #[test]
        fn key_press_carries_the_chord() {
            let w = action_to_wire(&Action::KeyPress { keys: "ctrl+Return".into() });
            assert_eq!(w["kind"], "keyPress");
            assert_eq!(w["keys"], "ctrl+Return");
        }

        /// Each variant equals its COMPLETE expected object, so a stray or renamed
        /// field fails -- not just a missing one.
        ///
        /// Field-by-field assertions cannot catch an extra field: the verifier added
        /// a bogus `"target"` to `clickAt` and every test still passed. Whole-object
        /// equality pins the wire exactly, which is what "the contract" means.
        ///
        /// This replaces a weaker test whose only assertion was that the kind
        /// contained no underscore. Deleting a variant from its array still passed
        /// it, so it proved nothing about coverage; the exhaustive `match` in
        /// `action_to_wire` is what guarantees every variant is wired, at compile
        /// time.
        #[test]
        fn every_variant_emits_exactly_its_expected_object() {
            let cases: Vec<(Action, serde_json::Value)> = vec![
                (
                    Action::Launch { command: "x".into(), args: vec!["-a".into()] },
                    serde_json::json!({"kind": "launch", "command": "x", "args": ["-a"]}),
                ),
                (
                    Action::Click { target: r("e1") },
                    serde_json::json!({"kind": "click", "target": "e1"}),
                ),
                (
                    Action::TypeText { target: r("e1"), text: "t".into() },
                    serde_json::json!({"kind": "typeText", "target": "e1", "text": "t"}),
                ),
                (
                    Action::TypeTextGlobal { text: "t".into() },
                    serde_json::json!({"kind": "typeTextGlobal", "text": "t"}),
                ),
                (
                    Action::ClickAt { x: 1, y: 2 },
                    serde_json::json!({"kind": "clickAt", "x": 1, "y": 2}),
                ),
                (
                    Action::KeyPress { keys: "Return".into() },
                    serde_json::json!({"kind": "keyPress", "keys": "Return"}),
                ),
            ];
            assert_eq!(
                cases.len(),
                6,
                "core has six Action variants; adding one must add a case here"
            );
            for (action, expected) in cases {
                let actual = action_to_wire(&action);
                assert_eq!(
                    actual,
                    expected,
                    "{}: the wire object must match exactly, including having no extra \
                     fields",
                    action.kind_name()
                );
            }
        }
    }
}
