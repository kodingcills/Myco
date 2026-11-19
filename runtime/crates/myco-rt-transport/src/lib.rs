//! Host-side client for the RT-004 control channel (ADR-0015).
//!
//! v0 transport: a persistent process spawned over SSH running `myco-rt-agent`
//! in the guest, speaking newline-delimited JSON. The same `Channel` works over
//! any child process with the agent on stdin/stdout, so unit tests run the real
//! agent binary directly (no VM, no SSH).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("agent refused session: {0}")]
    AuthRejected(String),
    #[error("agent protocol error: {0}")]
    Protocol(String),
    #[error("channel closed")]
    Closed,
    #[error("op timed out after {0:?}")]
    Timeout(Duration),
}

/// Connection parameters for the SSH channel to a guest agent.
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity_file: String,
    pub token: String,
    /// Path of the agent binary inside the guest.
    pub agent_path: String,
}

impl SshConfig {
    fn command(&self) -> Command {
        let mut c = Command::new("ssh");
        c.arg("-i")
            .arg(&self.identity_file)
            .arg("-p")
            .arg(self.port.to_string())
            .arg("-o")
            .arg("StrictHostKeyChecking=no")
            .arg("-o")
            .arg("UserKnownHostsFile=/dev/null")
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-T") // no pty: NDJSON on raw pipes
            .arg(format!("{}@{}", self.user, self.host))
            // Token via env on the remote command line. v0 accepts that the token
            // is visible in the guest's process list for the lifetime of the agent;
            // the guest is disposable and single-tenant (ADR-0015).
            .arg(format!("MYCO_RT_TOKEN={} {}", self.token, self.agent_path));
        c
    }
}

/// A connected, authenticated channel to one agent process.
pub struct Channel {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Channel {
    /// Spawn an arbitrary agent command (used by tests) and authenticate.
    pub fn spawn(mut cmd: Command, token: &str) -> Result<Self, TransportError> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| TransportError::Spawn(e.to_string()))?;
        let stdin = child.stdin.take().ok_or(TransportError::Closed)?;
        let stdout = BufReader::new(child.stdout.take().ok_or(TransportError::Closed)?);
        let mut ch = Self { child, stdin, stdout };
        ch.authenticate(token)?;
        Ok(ch)
    }

    /// Connect to a guest over SSH and authenticate.
    pub fn connect_ssh(config: &SshConfig) -> Result<Self, TransportError> {
        Self::spawn(config.command(), &config.token)
    }

    fn roundtrip(&mut self, request: serde_json::Value) -> Result<serde_json::Value, TransportError> {
        let mut line = serde_json::to_string(&request).map_err(|e| TransportError::Protocol(e.to_string()))?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).map_err(|_| TransportError::Closed)?;
        self.stdin.flush().map_err(|_| TransportError::Closed)?;
        self.read_line()
    }

    fn read_line(&mut self) -> Result<serde_json::Value, TransportError> {
        // v0: blocking reads; op-level deadlines are enforced by the caller's
        // session timeouts (the agent's own ops are bounded per ADR-0014). A
        // malformed or EOF'd channel is a hard error, never a silent retry.
        let mut buf = String::new();
        let n = self.stdout.read_line(&mut buf).map_err(|_| TransportError::Closed)?;
        if n == 0 {
            return Err(TransportError::Closed);
        }
        serde_json::from_str(buf.trim_end()).map_err(|e| TransportError::Protocol(e.to_string()))
    }

    fn authenticate(&mut self, token: &str) -> Result<(), TransportError> {
        let resp = self.roundtrip(serde_json::json!({"token": token}))?;
        match resp.get("ok").and_then(|v| v.as_bool()) {
            Some(true) => Ok(()),
            _ => Err(TransportError::AuthRejected(
                resp.get("error").and_then(|e| e.as_str()).unwrap_or("unknown").to_string(),
            )),
        }
    }

    /// Verify the agent advertises every op the caller needs. A stale agent
    /// binary (e.g. one built before an op existed) must fail loudly here, not
    /// as a confusing "unknown op" on first use.
    pub fn require_ops(&mut self, required: &[&str]) -> Result<(), TransportError> {
        let resp = self.ping()?;
        let advertised: Vec<String> = resp
            .get("ops")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let missing: Vec<&str> = required
            .iter()
            .copied()
            .filter(|op| !advertised.iter().any(|a| a == op))
            .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(TransportError::Protocol(format!(
                "stale agent: missing ops {missing:?} (advertised {advertised:?}); rebuild with runtime/guest/build-agent-in-guest.sh"
            )))
        }
    }

    /// `ping`: protocol version + guest identity. Returns the raw response.
    pub fn ping(&mut self) -> Result<serde_json::Value, TransportError> {
        let resp = self.roundtrip(serde_json::json!({"op": "ping"}))?;
        if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            Ok(resp)
        } else {
            Err(TransportError::Protocol(resp.to_string()))
        }
    }

    /// Measured ping round-trip latency.
    pub fn ping_timed(&mut self) -> Result<(serde_json::Value, Duration), TransportError> {
        let start = Instant::now();
        let resp = self.ping()?;
        Ok((resp, start.elapsed()))
    }

    /// `observe`: AT-SPI tree + screenshot + process/window info (RT-007).
    pub fn observe(&mut self) -> Result<serde_json::Value, TransportError> {
        let resp = self.roundtrip(serde_json::json!({"op": "observe"}))?;
        if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            Ok(resp)
        } else {
            Err(TransportError::Protocol(resp.to_string()))
        }
    }

    /// `shutdown`: clean agent exit (NOT a VM poweroff).
    pub fn shutdown(mut self) -> Result<(), TransportError> {
        let resp = self.roundtrip(serde_json::json!({"op": "shutdown"}))?;
        let _ = self.child.wait();
        if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            Ok(())
        } else {
            Err(TransportError::Protocol(resp.to_string()))
        }
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Locate the real agent binary built by `cargo test --workspace`.
    /// Tests that need it build it on demand if absent.
    fn agent_command(token: &str) -> Command {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .unwrap()
            .to_path_buf();
        let bin = workspace.join("target").join("debug").join("myco-rt-agent");
        if !bin.exists() {
            let status = Command::new("cargo")
                .args(["build", "-p", "myco-rt-agent"])
                .current_dir(&workspace)
                .status()
                .expect("cargo build -p myco-rt-agent");
            assert!(status.success(), "agent build failed");
        }
        let mut c = Command::new(bin);
        c.env("MYCO_RT_TOKEN", token);
        c
    }

    #[test]
    fn handshake_and_ping_against_real_agent() {
        let mut ch = Channel::spawn(agent_command("s3cret"), "s3cret").expect("connect");
        let resp = ch.ping().expect("ping");
        assert_eq!(resp["op"], "ping");
        assert_eq!(resp["protocol_version"], 1);
        ch.shutdown().expect("clean shutdown");
    }

    #[test]
    fn wrong_token_is_rejected() {
        let err = match Channel::spawn(agent_command("s3cret"), "wrong") {
            Err(e) => e,
            Ok(_) => panic!("wrong token unexpectedly accepted"),
        };
        match err {
            TransportError::AuthRejected(msg) => assert!(msg.contains("invalid token")),
            other => panic!("expected AuthRejected, got {other:?}"),
        }
    }

    #[test]
    fn missing_agent_token_refuses_session() {
        // Ensure the binary is fully built before spawning it directly (the
        // on-demand build in agent_command races a direct spawn on cold targets).
        let _ = agent_command("warmup");
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent().and_then(|p| p.parent()).unwrap().to_path_buf();
        let bin = workspace.join("target").join("debug").join("myco-rt-agent");
        let mut c = Command::new(bin);
        c.env_remove("MYCO_RT_TOKEN");
        // Agent exits(2) before reading auth: channel closes → transport error.
        let res = Channel::spawn(c, "anything");
        assert!(matches!(res, Err(TransportError::Closed) | Err(TransportError::AuthRejected(_))));
    }

    #[test]
    fn unknown_op_gets_structured_error() {
        let mut ch = Channel::spawn(agent_command("s3cret"), "s3cret").expect("connect");
        let resp = ch.roundtrip(serde_json::json!({"op": "nonsense"})).expect("response");
        assert_eq!(resp["ok"], false);
        assert!(resp["error"].as_str().unwrap().contains("unknown op"));
        ch.shutdown().unwrap();
    }
}
