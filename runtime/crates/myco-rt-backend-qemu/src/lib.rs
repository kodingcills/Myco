//! QEMU+HVF Linux backend (RT-006, ADR-0011).
//!
//! Lifecycle is real: provision boots a qcow2-overlay guest and authenticates the
//! control channel; reset discards the overlay and reboots to a pristine guest;
//! destroy tears down the guest and deletes session state. The backend drives the
//! proven `runtime/guest/` scripts rather than duplicating QEMU invocation logic.
//!
//! `observe`/`act` are RT-007/008 and return `Unimplemented` here by design.

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
        }
    }
}

pub struct QemuLinuxBackend {
    config: QemuConfig,
    channel: Option<Channel>,
    lock_path: PathBuf,
    locked: bool,
}

/// The session lock file enforcing the concurrency cap (ADR-0011: default 1).
fn lock_path(guest_dir: &Path) -> PathBuf {
    guest_dir.join("state").join("SESSION.lock")
}

impl QemuLinuxBackend {
    pub fn new(config: QemuConfig) -> Self {
        let lock_path = lock_path(&config.guest_dir);
        Self { config, channel: None, lock_path, locked: false }
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
        self.channel = Some(ch);
        Ok(())
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
        let out = Command::new("ssh")
            .args([
                "-i", &self.config.guest_dir.join("keys").join("id_ed25519").to_string_lossy(),
                "-p", &self.config.ssh_port.to_string(),
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "BatchMode=yes",
                "myco@localhost",
                remote,
            ])
            .output()?;
        if !out.status.success() {
            return Err(BackendError::Protocol(format!(
                "guest exec failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
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

impl Backend for QemuLinuxBackend {
    type Err = BackendError;

    fn provision(&mut self) -> Result<(), BackendError> {
        self.acquire_lock()?;
        let result = (|| {
            self.run_script("boot.sh", &[])?;
            self.wait_ssh()?;
            self.install_agent()?;
            self.connect()
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

    fn act(&mut self, _action: &Action) -> Result<ActionOutcome, BackendError> {
        Err(BackendError::Unimplemented("act lands at RT-008"))
    }

    fn reset(&mut self) -> Result<(), BackendError> {
        self.channel = None;
        self.run_script("shutdown.sh", &[])?;
        self.run_script("create-overlay.sh", &["--recreate"])?;
        self.run_script("boot.sh", &[])?;
        self.wait_ssh()?;
        self.install_agent()?;
        self.connect()
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

    fn config_for(dir: &Path) -> QemuConfig {
        QemuConfig {
            guest_dir: dir.to_path_buf(),
            token: "t".into(),
            ssh_port: 10022,
            boot_timeout: Duration::from_secs(1),
            introspection_file: None,
            op_timeout_secs: 10,
        }
    }

    #[test]
    fn concurrency_cap_rejects_second_live_session() {
        let dir = tempfile_dir("myco-rt-cap");
        let mut a = QemuLinuxBackend::new(config_for(&dir));
        a.acquire_lock().unwrap();
        let mut b = QemuLinuxBackend::new(config_for(&dir));
        match b.acquire_lock() {
            Err(BackendError::CapReached(_)) => {}
            other => panic!("expected CapReached, got {other:?}"),
        }
        a.release_lock();
        // Lock released: a third session may proceed.
        let mut c = QemuLinuxBackend::new(config_for(&dir));
        c.acquire_lock().unwrap();
        c.release_lock();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drop_releases_lock() {
        let dir = tempfile_dir("myco-rt-drop");
        {
            let mut a = QemuLinuxBackend::new(config_for(&dir));
            a.acquire_lock().unwrap();
        }
        let mut b = QemuLinuxBackend::new(config_for(&dir));
        b.acquire_lock().unwrap();
        b.release_lock();
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tempfile_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
