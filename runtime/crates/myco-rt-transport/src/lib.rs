//! Host-side client for the RT-004 control channel (ADR-0015).
//!
//! v0 transport: a persistent process spawned over SSH running `myco-rt-agent`
//! in the guest, speaking newline-delimited JSON. The same `Channel` works over
//! any child process with the agent on stdin/stdout, so unit tests run the real
//! agent binary directly (no VM, no SSH).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

/// Report only the byte count the agent confirmed; never assume the full length.
fn confirmed_bytes_written(reply: &serde_json::Value) -> Result<usize, TransportError> {
    reply
        .get("bytes_written")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .ok_or_else(|| TransportError::Protocol("write_file reply has no bytes_written".into()))
}

/// Largest `write_file` payload, matching the agent's cap and `read_file`'s.
pub const WRITE_LIMIT: usize = 1024 * 1024;

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

/// Build the remote command line: token always, introspection file when enabled.
///
/// sshd hands this string to the guest's login shell, so every value in it is
/// single-quoted (TIF-120): a token or a path is data, never shell syntax. The
/// MCP layer additionally restricts the introspection path's character set.
fn remote_command(token: &str, agent_path: &str, introspection: Option<&str>) -> String {
    match introspection {
        Some(path) => format!(
            "MYCO_RT_TOKEN={} MYCO_INTROSPECTION_FILE={} {agent_path}",
            shell_single_quote(token),
            shell_single_quote(path)
        ),
        None => format!("MYCO_RT_TOKEN={} {agent_path}", shell_single_quote(token)),
    }
}

/// POSIX single-quoting: wrap in '…' and turn each embedded ' into '\''.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
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
    /// ADR-0016: guest path the agent should read widget state from. `None`
    /// disables the introspection channel (observation reports `null`).
    pub introspection_file: Option<String>,
    /// Hard per-op deadline; a hung app or agent becomes a `Timeout`, never a hang.
    pub op_timeout: Duration,
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
            .arg(remote_command(&self.token, &self.agent_path, self.introspection_file.as_deref()));
        c
    }
}

/// Exit status for a managed guest process.
#[derive(Debug, serde::Deserialize)]
pub struct ProcessExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

/// A connected, authenticated channel to one agent process.
pub struct Channel {
    child: Child,
    stdin: Option<ChildStdin>,
    /// Parsed responses, produced by one long-lived reader thread. Owning the pipe
    /// in a thread is what makes deadlines enforceable: a grandchild holding the
    /// write end can no longer block the calling thread (only the reader).
    rx: std::sync::mpsc::Receiver<Result<serde_json::Value, TransportError>>,
    op_timeout: Duration,
}

impl Channel {
    /// Spawn an arbitrary agent command (used by tests) and authenticate.
    pub fn spawn(mut cmd: Command, token: &str) -> Result<Self, TransportError> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // Own process group: a hung op must be killable as a group, or a child that
        // inherited the pipe (e.g. a shell's `sleep`) keeps the read blocked.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| TransportError::Spawn(e.to_string()))?;
        let stdin = child.stdin.take().ok_or(TransportError::Closed)?;
        let stdout = BufReader::new(child.stdout.take().ok_or(TransportError::Closed)?);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = stdout;
            loop {
                let mut buf = String::new();
                match reader.read_line(&mut buf) {
                    Ok(0) => { let _ = tx.send(Err(TransportError::Closed)); break; }
                    Ok(_) => {
                        let parsed = serde_json::from_str(buf.trim_end())
                            .map_err(|e| TransportError::Protocol(e.to_string()));
                        let failed = parsed.is_err();
                        if tx.send(parsed).is_err() || failed { break; }
                    }
                    Err(_) => { let _ = tx.send(Err(TransportError::Closed)); break; }
                }
            }
        });
        let mut ch = Self { child, stdin: Some(stdin), rx, op_timeout: Duration::from_secs(10) };
        ch.authenticate(token)?;
        Ok(ch)
    }

    /// Connect to a guest over SSH and authenticate.
    pub fn connect_ssh(config: &SshConfig) -> Result<Self, TransportError> {
        let mut ch = Self::spawn(config.command(), &config.token)?;
        ch.op_timeout = config.op_timeout;
        Ok(ch)
    }

    /// Spawn with an explicit op deadline (tests).
    pub fn spawn_with_timeout(
        cmd: Command,
        token: &str,
        op_timeout: Duration,
    ) -> Result<Self, TransportError> {
        let mut ch = Self::spawn(cmd, token)?;
        ch.op_timeout = op_timeout;
        Ok(ch)
    }

    fn roundtrip(&mut self, request: serde_json::Value) -> Result<serde_json::Value, TransportError> {
        self.roundtrip_inner(request)
    }

    fn roundtrip_inner(
        &mut self,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, TransportError> {
        let mut line = serde_json::to_string(&request).map_err(|e| TransportError::Protocol(e.to_string()))?;
        line.push('\n');
        let stdin = self.stdin.as_mut().ok_or(TransportError::Closed)?;
        stdin.write_all(line.as_bytes()).map_err(|_| TransportError::Closed)?;
        stdin.flush().map_err(|_| TransportError::Closed)?;
        self.read_line()
    }

    fn read_line(&mut self) -> Result<serde_json::Value, TransportError> {
        // The deadline is enforced HERE, on the receiver — the reader thread may stay
        // blocked on a dead pipe, but the caller never does.
        match self.rx.recv_timeout(self.op_timeout) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                let pid = self.child.id();
                let _ = Command::new("kill")
                    .args(["-9", &format!("-{pid}")])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                Err(TransportError::Timeout(self.op_timeout))
            }
        }
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

    /// `act`: perform one action and return the raw three-way outcome (RT-008).
    /// The outcome envelope is returned even for `failed`, so callers can report
    /// why instead of losing it to an error.
    pub fn act(
        &mut self,
        action: serde_json::Value,
        state_version: u64,
    ) -> Result<serde_json::Value, TransportError> {
        let resp = self.roundtrip(serde_json::json!({
            "op": "act",
            "action": action,
            "state_version": state_version,
        }))?;
        if resp.get("op").and_then(|v| v.as_str()) == Some("act") {
            Ok(resp)
        } else {
            Err(TransportError::Protocol(resp.to_string()))
        }
    }

    pub fn grant_read(&mut self, root: &str) -> Result<(), TransportError> {
        self.extension("grant_read", serde_json::json!({"root": root}))
    }

    pub fn read_file(&mut self, path: &str) -> Result<Vec<u8>, TransportError> {
        self.extension("read_file", serde_json::json!({"path": path}))
    }

    /// RT-017: write bytes to a grant-relative guest file path. Bytes travel as a
    /// JSON array of numbers, the same encoding `read_file` uses.
    pub fn write_file(&mut self, path: &str, bytes: &[u8]) -> Result<usize, TransportError> {
        if bytes.len() > WRITE_LIMIT {
            return Err(TransportError::Protocol("write_file content exceeds 1 MiB limit".into()));
        }
        let resp: serde_json::Value = self.extension(
            "write_file",
            serde_json::json!({"path": path, "content": bytes}),
        )?;
        confirmed_bytes_written(&resp)
    }

    pub fn launch_process(&mut self, command: &str, args: &[String]) -> Result<String, TransportError> {
        self.extension("launch_process", serde_json::json!({"command": command, "args": args}))
    }

    pub fn kill_process(&mut self, handle: &str) -> Result<ProcessExit, TransportError> {
        self.extension("kill_process", serde_json::json!({"handle": handle}))
    }

    pub fn relaunch_process(&mut self, handle: &str) -> Result<String, TransportError> {
        self.extension("relaunch_process", serde_json::json!({"handle": handle}))
    }

    fn extension<T: serde::de::DeserializeOwned>(
        &mut self,
        op: &str,
        mut request: serde_json::Value,
    ) -> Result<T, TransportError> {
        request["op"] = serde_json::json!(op);
        let response = self.roundtrip(request)?;
        if response["op"] != op || response["ok"] != true {
            return Err(TransportError::Protocol(response.to_string()));
        }
        serde_json::from_value(response["value"].clone())
            .map_err(|error| TransportError::Protocol(format!("{op}: {error}")))
    }

    /// `shutdown`: clean agent exit (NOT a VM poweroff).
    pub fn shutdown(mut self) -> Result<(), TransportError> {
        let resp = self.roundtrip(serde_json::json!({"op": "shutdown"}))?;
        if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            Ok(())
        } else {
            Err(TransportError::Protocol(resp.to_string()))
        }
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_millis(500);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => break,
            }
        }
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
    fn workspace() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .unwrap()
            .to_path_buf()
    }

    /// Where `cargo build -p myco-rt-agent` puts the binary. Honours
    /// CARGO_TARGET_DIR (TIF-141 / N-D): looking only under <workspace>/target
    /// missed it whenever the target dir was overridden.
    fn agent_bin() -> PathBuf {
        let target = match std::env::var_os("CARGO_TARGET_DIR") {
            Some(dir) => {
                let dir = PathBuf::from(dir);
                if dir.is_absolute() { dir } else { workspace().join(dir) }
            }
            None => workspace().join("target"),
        };
        target.join("debug").join("myco-rt-agent")
    }

    fn agent_command(token: &str) -> Command {
        let workspace = workspace();
        let bin = agent_bin();
        // Always build (a no-op when current): reusing an existing binary let
        // these tests run a STALE agent that predates the code under test
        // (TIF-120 review). Serialized so parallel tests don't race cargo.
        static BUILD: std::sync::Once = std::sync::Once::new();
        BUILD.call_once(|| {
            let status = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
                .args(["build", "-p", "myco-rt-agent"])
                .current_dir(&workspace)
                .status()
                .expect("cargo build -p myco-rt-agent");
            assert!(status.success(), "agent build failed");
        });
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

    #[cfg(target_os = "linux")]
    #[test]
    fn file_read_over_control_channel_requires_grant() {
        let dir = std::env::temp_dir().join(format!("myco-channel-grant-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("state"), [0, 255]).unwrap();
        // A root grant must be refused on a FRESH agent: asserting it after a
        // grant already succeeded only proves the "already granted" guard
        // (review must-fix 2).
        let mut fresh = Channel::spawn(agent_command("s3cret"), "s3cret").unwrap();
        assert!(
            fresh.grant_read("/").is_err(),
            "a grant rooted at / must be refused, not treated as a bounded grant"
        );
        fresh.shutdown().unwrap();

        let mut ch = Channel::spawn(agent_command("s3cret"), "s3cret").unwrap();
        assert!(ch.read_file("state").is_err());
        ch.grant_read(dir.to_str().unwrap()).unwrap();
        assert!(ch.grant_read("/").is_err());
        assert!(ch.read_file("../outside").is_err());
        assert_eq!(ch.read_file("state").unwrap(), [0, 255]);

        // End-to-end: arbitrary bytes (length 5, non-multiple of 3) must survive
        // the whole wire path, not just the encoder in isolation (must-fix 3).
        let blob: Vec<u8> = vec![0, 1, 254, 255, 42];
        std::fs::write(dir.join("blob"), &blob).unwrap();
        assert_eq!(ch.read_file("blob").unwrap(), blob);

        ch.shutdown().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// TIF-120: the introspection path reaches the agent as one shell word,
    /// whatever it contains; nothing in it can run as shell syntax.
    #[test]
    fn introspection_path_is_quoted_into_the_remote_command() {
        assert_eq!(
            remote_command("t", "/home/myco/bin/myco-rt-agent", Some("/tmp/state.json")),
            "MYCO_RT_TOKEN='t' MYCO_INTROSPECTION_FILE='/tmp/state.json' /home/myco/bin/myco-rt-agent"
        );
        assert_eq!(remote_command("t", "a", None), "MYCO_RT_TOKEN='t' a");
        assert_eq!(remote_command("a b;c", "a", None), "MYCO_RT_TOKEN='a b;c' a", "the token is quoted too");
        // A hostile path round-trips through a real POSIX shell as plain data.
        let hostile = "/tmp/x'; touch /tmp/pwned-myco; echo '$(id) `id`";
        let cmd = format!("printf %s {}", shell_single_quote(hostile));
        let out = Command::new("sh").arg("-c").arg(&cmd).output().unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), hostile);
    }

    #[test]
    fn write_reply_without_bytes_written_is_an_error() {
        assert_eq!(confirmed_bytes_written(&serde_json::json!({"bytes_written": 3})).unwrap(), 3);
        assert!(confirmed_bytes_written(&serde_json::json!({})).is_err(), "must not assume a length");
        assert!(confirmed_bytes_written(&serde_json::json!({"bytes_written": "3"})).is_err());
    }

    /// RT-017 end to end through the REAL agent over the wire: grant, write,
    /// read back, replace with shorter content, refuse over the cap, refuse
    /// without a grant. Catches a renamed wire field or a dropped reply field,
    /// which unit tests on either side cannot. Linux-only (the agent's grant is).
    #[cfg(target_os = "linux")]
    #[test]
    fn file_write_over_control_channel_round_trips_through_the_agent() {
        let dir = std::env::temp_dir().join(format!("myco-channel-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();

        let mut ch = Channel::spawn(agent_command("s3cret"), "s3cret").unwrap();
        assert!(ch.write_file("f", b"x").is_err(), "no grant, no write");
        assert!(!dir.join("f").exists());
        ch.grant_read(dir.to_str().unwrap()).unwrap();

        let blob: Vec<u8> = vec![0, 1, 254, 255, 42];
        assert_eq!(ch.write_file("f", &blob).unwrap(), blob.len(), "agent confirms the count");
        assert_eq!(ch.read_file("f").unwrap(), blob, "bytes survive the wire both ways");
        assert_eq!(std::fs::read(dir.join("f")).unwrap(), blob);

        assert_eq!(ch.write_file("f", b"z").unwrap(), 1);
        assert_eq!(ch.read_file("f").unwrap(), b"z", "a shorter write truncates");

        assert!(ch.write_file("../escape", b"x").is_err());
        assert!(ch.write_file("big", &vec![0u8; WRITE_LIMIT + 1]).is_err(), "transport cap");
        assert!(!dir.join("big").exists());

        ch.shutdown().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The agent's own cap, bypassing the transport's: an oversize raw request
    /// is refused by the agent, not written.
    #[cfg(target_os = "linux")]
    #[test]
    fn agent_refuses_an_oversize_write_on_its_own() {
        let dir = std::env::temp_dir().join(format!("myco-channel-bigwrite-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let mut ch = Channel::spawn(agent_command("s3cret"), "s3cret").unwrap();
        ch.grant_read(dir.to_str().unwrap()).unwrap();
        let resp = ch
            .roundtrip(serde_json::json!({"op": "write_file", "path": "big", "content": vec![0u8; WRITE_LIMIT + 1]}))
            .unwrap();
        assert_ne!(resp["ok"], true, "agent must refuse: {resp}");
        assert!(!dir.join("big").exists());
        ch.shutdown().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// TIF-120 end to end through the REAL agent: an agent started with
    /// MYCO_INTROSPECTION_FILE hands it to the apps it launches as
    /// MYCO_TODO_STATE_FILE (the production `spawn` path reads the env var).
    #[test]
    fn launched_app_sees_the_introspection_file_as_its_state_file() {
        let dir = std::env::temp_dir().join(format!("myco-channel-intro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let seen = dir.join("seen");
        let mut cmd = agent_command("s3cret");
        cmd.env("MYCO_INTROSPECTION_FILE", "/tmp/myco-intro-e2e.json")
            .env_remove("MYCO_TODO_STATE_FILE");
        let mut ch = Channel::spawn(cmd, "s3cret").unwrap();
        let script = format!("printf %s \"$MYCO_TODO_STATE_FILE\" > {}", seen.display());
        let handle = ch.launch_process("sh", &["-c".into(), script]).unwrap();
        for _ in 0..50 {
            if seen.exists() { break; }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = ch.kill_process(&handle);
        ch.shutdown().unwrap();
        assert_eq!(std::fs::read_to_string(&seen).unwrap(), "/tmp/myco-intro-e2e.json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn process_control_over_channel_rejects_previous_session_handles() {
        let mut ch = Channel::spawn(agent_command("s3cret"), "s3cret").unwrap();
        let handle = ch.launch_process("sleep", &["60".into()]).unwrap();
        assert_eq!(ch.kill_process(&handle).unwrap().signal, Some(9));
        let replacement = ch.relaunch_process(&handle).unwrap();
        ch.shutdown().unwrap();
        let mut next = Channel::spawn(agent_command("s3cret"), "s3cret").unwrap();
        let current = next.launch_process("sleep", &["60".into()]).unwrap();
        assert!(next.kill_process(&replacement).is_err());
        assert_eq!(next.kill_process(&current).unwrap().signal, Some(9));
        next.shutdown().unwrap();
    }

    #[test]
    fn closing_channel_reaps_managed_child() {
        let dir = std::env::temp_dir().join(format!("myco-channel-child-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let pid_path = dir.join("pid");
        let mut ch = Channel::spawn(agent_command("s3cret"), "s3cret").unwrap();
        ch.launch_process("sh", &[
            "-c".into(), "echo $$ > \"$1\"; exec sleep 60".into(),
            "fixture".into(), pid_path.to_string_lossy().into_owned()
        ]).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let pid = loop {
            if let Ok(pid) = std::fs::read_to_string(&pid_path) {
                if let Ok(pid) = pid.trim().parse::<u32>() {
                    break pid;
                }
            }
            assert!(Instant::now() < deadline, "fixture did not publish its PID");
            std::thread::sleep(Duration::from_millis(10));
        };
        drop(ch);
        let alive = Command::new("kill").args(["-0", &pid.to_string()])
            .stderr(Stdio::null()).status().unwrap().success();
        std::fs::remove_dir_all(dir).unwrap();
        assert!(!alive, "managed child survived disconnect");
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
        let bin = agent_bin();
        let mut c = Command::new(bin);
        c.env_remove("MYCO_RT_TOKEN");
        // Agent exits(2) before reading auth: channel closes → transport error.
        let res = Channel::spawn(c, "anything");
        assert!(matches!(res, Err(TransportError::Closed) | Err(TransportError::AuthRejected(_))));
    }

    #[test]
    fn hung_agent_becomes_timeout_not_hang() {
        // A fake agent that authenticates then stops answering: the transport must
        // return Timeout within the deadline, not block forever (review finding #2).
        let bin = agent_bin();
        let _ = agent_command("warmup");
        let mut c = Command::new("sh");
        c.arg("-c").arg(format!(
            "printf '%s\n' '{{\"ok\":true,\"op\":\"auth\"}}'; sleep 30; exec {}",
            bin.display()
        ));
        // The shell prints an auth OK, so the channel authenticates; then the agent
        // never answers because the shell is still sleeping.
        let mut ch = Channel::spawn_with_timeout(c, "any", Duration::from_millis(300))
            .expect("authenticate against the fake");
        let start = Instant::now();
        match ch.ping() {
            Err(TransportError::Timeout(_)) => {
                assert!(start.elapsed() < Duration::from_secs(5), "timeout fired late");
            }
            other => panic!("expected Timeout, got {other:?}"),
        }
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
