//! Session evidence for the runtime layer (RT-009).
//!
//! Emits M1's schema as-is (ADR-0007/0012): `trace.jsonl` in the trace-event
//! vocabulary and `result.json` as a `recordKind: "session"` record — verdict is
//! forbidden there, and this writer will not produce one.
//!
//! Validation is done here, in Rust, against the same shapes M1 declares in
//! `schemas/`. An invalid artifact is worse than a missing one: refusal to write
//! is the only honest failure mode.

use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum EvidenceError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid evidence: {0}")]
    Invalid(String),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

/// One runtime session's evidence.
pub struct SessionRecorder {
    run_id: String,
    task_id: String,
    started_at: String,
    dir: PathBuf,
    events: Vec<Value>,
    steps: Vec<Value>,
    unresolved: Option<String>,
}

impl SessionRecorder {
    /// Create a recorder writing into `<root>/runs/<run_id>/`.
    pub fn new(root: &Path, run_id: &str, task_id: &str) -> Result<Self, EvidenceError> {
        // The id becomes a directory name; a `../` would escape the evidence root.
        if run_id.is_empty()
            || run_id.contains('/')
            || run_id.contains('\\')
            || run_id.contains("..")
            || run_id.contains('\0')
        {
            return Err(EvidenceError::Invalid(format!(
                "unsafe run id {run_id:?}: must be a plain path segment"
            )));
        }
        // `root` is the runs directory: artifacts land in `<root>/<run_id>/`.
        let dir = root.join(run_id);
        std::fs::create_dir_all(&dir)?;
        let mut rec = Self {
            run_id: run_id.to_string(),
            task_id: task_id.to_string(),
            started_at: now(),
            dir,
            events: Vec::new(),
            steps: Vec::new(),
            unresolved: None,
        };
        rec.events.push(json!({
            "type": "run-start",
            "runId": rec.run_id,
            "taskId": rec.task_id,
            "startedAt": rec.started_at,
        }));
        Ok(rec)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Record an observation (trace only: observations are not steps).
    pub fn observation(&mut self, state_version: u64, node_count: usize) {
        self.events.push(json!({
            "type": "observation",
            "timestamp": now(),
            "stateVersion": state_version,
            "nodeCount": node_count,
        }));
    }

    /// Record one action and its three-way outcome as an evidence step.
    ///
    /// `outcome` is the runtime's delivery disposition, never a task verdict.
    pub fn action(
        &mut self,
        action: Value,
        state_version_before: u64,
        state_version_after: u64,
        outcome: &str,
        detail: &str,
    ) {
        let step = self.steps.len();
        self.events.push(json!({
            "type": "action",
            "timestamp": now(),
            "step": step,
            "action": action,
        }));
        // The delivery disposition is recorded as an observation of the guard
        // position: "did the action land", not "did the task succeed".
        self.steps.push(json!({
            "step": step,
            "action": action,
            "preconditionResults": [],
            "postconditionResults": [{
                "predicateName": "action_delivery_verified",
                "passed": outcome == "delivered_verified",
                "observed": format!("{outcome}: {detail}"),
            }],
            "stateVersionBefore": state_version_before,
            "stateVersionAfter": state_version_after,
        }));
    }

    pub fn unresolved(&mut self, reason: impl Into<String>) {
        self.unresolved = Some(reason.into());
    }

    /// Write `trace.jsonl` and `result.json`, validating both first.
    ///
    /// Both files are written temp-then-renamed: a crash or an error between the
    /// two writes must never leave a truncated file that looks like a complete
    /// artifact (same discipline the introspection channel mandates, ADR-0016).
    pub fn flush(&self) -> Result<Paths, EvidenceError> {
        let trace = self.trace_bytes()?;
        let result = self.result_bytes()?;
        let trace_path = self.dir.join("trace.jsonl");
        let result_path = self.dir.join("result.json");
        write_atomic(&trace_path, &trace)?;
        write_atomic(&result_path, &result)?;
        Ok(Paths { trace: trace_path, result: result_path })
    }

    pub fn trace_bytes(&self) -> Result<Vec<u8>, EvidenceError> {
        let mut out = Vec::new();
        for e in &self.events {
            validate_trace_event(e)?;
            out.extend_from_slice(serde_json::to_string(e)?.as_bytes());
            out.push(b'\n');
        }
        Ok(out)
    }

    pub fn result_bytes(&self) -> Result<Vec<u8>, EvidenceError> {
        let mut rec = json!({
            "recordKind": "session",
            "runId": self.run_id,
            "taskId": self.task_id,
            "startedAt": self.started_at,
            "steps": self.steps,
        });
        if let Some(u) = &self.unresolved {
            rec["unresolvedState"] = json!(u);
        }
        validate_session_record(&rec)?;
        Ok(serde_json::to_vec_pretty(&rec)?)
    }
}

pub struct Paths {
    pub trace: PathBuf,
    pub result: PathBuf,
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("out")
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

fn now() -> String {
    // RFC-3339 UTC, matching M1's `new Date().toISOString()` shape. No chrono
    // dependency: civil-from-days conversion is exact and testable.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_iso8601(secs)
}

/// Format unix seconds as `YYYY-MM-DDTHH:MM:SSZ` (Howard Hinnant's civil algorithm).
pub fn format_iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // days since 1970-01-01 → civil date
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };

    format!("{year:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

// ── Validation (mirrors schemas/trace-events.ts and result-record.ts) ─────────

/// Allowed keys per trace event type; `additionalProperties: false` in the schema.
fn validate_trace_event(v: &Value) -> Result<(), EvidenceError> {
    let ty = v.get("type").and_then(|t| t.as_str()).ok_or_else(|| {
        EvidenceError::Invalid("trace event missing type".into())
    })?;
    let allowed: &[&str] = match ty {
        "run-start" => &["type", "runId", "taskId", "startedAt"],
        "observation" => &["type", "timestamp", "stateVersion", "nodeCount"],
        "action" => &["type", "timestamp", "step", "action"],
        "guard-evaluation" => &[
            "type", "timestamp", "step", "phase", "results",
            "stateVersionBefore", "stateVersionAfter",
        ],
        "guard-failure" => &["type", "timestamp", "step", "phase", "guard"],
        "fault-injection" => &["type", "timestamp", "fault", "detail"],
        "recovery" => &["type", "timestamp", "event", "stateVersion"],
        other => {
            return Err(EvidenceError::Invalid(format!(
                "unknown trace event type {other:?}"
            )))
        }
    };
    let obj = v.as_object().ok_or_else(|| EvidenceError::Invalid("event is not an object".into()))?;
    for k in obj.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(EvidenceError::Invalid(format!(
                "{ty}: unexpected field {k:?}"
            )));
        }
    }
    for req in required_fields(ty) {
        if !obj.contains_key(*req) {
            return Err(EvidenceError::Invalid(format!("{ty}: missing required field {req:?}")));
        }
    }
    Ok(())
}

fn required_fields(ty: &str) -> &'static [&'static str] {
    match ty {
        "run-start" => &["type", "runId", "taskId", "startedAt"],
        "observation" => &["type", "timestamp", "stateVersion", "nodeCount"],
        "action" => &["type", "timestamp", "step", "action"],
        "guard-evaluation" => &[
            "type", "timestamp", "step", "phase", "results",
            "stateVersionBefore", "stateVersionAfter",
        ],
        "guard-failure" => &["type", "timestamp", "step", "phase", "guard"],
        "fault-injection" => &["type", "timestamp", "fault", "detail"],
        "recovery" => &["type", "timestamp", "event", "stateVersion"],
        _ => &[],
    }
}

/// SessionRecord: verdict is forbidden (not declared + closed properties).
fn validate_session_record(v: &Value) -> Result<(), EvidenceError> {
    let obj = v.as_object().ok_or_else(|| EvidenceError::Invalid("record not an object".into()))?;
    let allowed = [
        "recordKind", "runId", "taskId", "taskParams", "startedAt",
        "steps", "guardFailure", "checks", "unresolvedState",
    ];
    for k in obj.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(EvidenceError::Invalid(format!(
                "session record: field {k:?} is not part of the schema (verdict included)"
            )));
        }
    }
    if obj.get("recordKind").and_then(|k| k.as_str()) != Some("session") {
        return Err(EvidenceError::Invalid("recordKind must be \"session\"".into()));
    }
    for req in ["runId", "startedAt", "steps"] {
        if !obj.contains_key(req) {
            return Err(EvidenceError::Invalid(format!("session record: missing {req:?}")));
        }
    }
    // Validate every step against the closed EvidenceStep shape; a step with an
    // undeclared field would be rejected by M1's validator, so we must not write it.
    if let Some(steps) = obj.get("steps").and_then(|s| s.as_array()) {
        for (i, step) in steps.iter().enumerate() {
            validate_step(step).map_err(|e| EvidenceError::Invalid(format!("step {i}: {e}")))?;
        }
    }
    Ok(())
}

fn validate_step(v: &Value) -> Result<(), String> {
    let obj = v.as_object().ok_or("not an object")?;
    let allowed = [
        "step",
        "action",
        "preconditionResults",
        "postconditionResults",
        "stateVersionBefore",
        "stateVersionAfter",
    ];
    for k in obj.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(format!("unexpected field {k:?}"));
        }
    }
    for req in allowed {
        if !obj.contains_key(req) {
            return Err(format!("missing required field {req:?}"));
        }
    }
    for field in ["preconditionResults", "postconditionResults"] {
        let arr = obj[field].as_array().ok_or(format!("{field} is not an array"))?;
        for p in arr {
            let pobj = p.as_object().ok_or("predicate result is not an object")?;
            if !pobj.contains_key("predicateName")
                || !pobj.contains_key("passed")
                || !pobj.contains_key("observed")
            {
                return Err("predicate result missing a required field".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(dir: &Path) -> SessionRecorder {
        SessionRecorder::new(dir, "run-1", "task-1").unwrap()
    }

    #[test]
    fn writes_schema_shaped_artifacts() {
        let dir = std::env::temp_dir().join(format!("myco-ev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut r = rec(&dir);
        r.observation(1, 4);
        r.action(
            json!({"kind": "typeText", "ref": "n4", "text": "hi"}),
            1,
            2,
            "delivered_verified",
            "text_readback_delta",
        );
        let paths = r.flush().unwrap();
        let trace = std::fs::read_to_string(&paths.trace).unwrap();
        let lines: Vec<&str> = trace.lines().collect();
        assert_eq!(lines.len(), 3, "run-start + observation + action");
        for l in &lines {
            let v: Value = serde_json::from_str(l).unwrap();
            validate_trace_event(&v).unwrap();
        }
        let result: Value =
            serde_json::from_str(&std::fs::read_to_string(&paths.result).unwrap()).unwrap();
        assert_eq!(result["recordKind"], "session");
        assert!(result.get("verdict").is_none());
        assert_eq!(result["steps"][0]["step"], 0);
        assert_eq!(result["steps"][0]["stateVersionAfter"], 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_record_carrying_a_verdict_is_refused() {
        let dir = std::env::temp_dir().join(format!("myco-ev-v-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let r = rec(&dir);
        let mut v: Value = serde_json::from_slice(&r.result_bytes().unwrap()).unwrap();
        v["verdict"] = json!({"status": "verified"});
        let err = validate_session_record(&v).unwrap_err();
        assert!(err.to_string().contains("verdict"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsafe_run_id_is_refused() {
        let dir = std::env::temp_dir().join(format!("myco-ev-id-{}", std::process::id()));
        for bad in ["../escape", "a/b", "", "x\\y", ".."] {
            assert!(
                SessionRecorder::new(&dir, bad, "t").is_err(),
                "run id {bad:?} must be refused"
            );
        }
    }

    #[test]
    fn flush_is_atomic_and_leaves_no_temp_files() {
        let dir = std::env::temp_dir().join(format!("myco-ev-a-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut r = rec(&dir);
        r.observation(1, 2);
        let paths = r.flush().unwrap();
        assert!(paths.trace.exists() && paths.result.exists());
        // No `.tmp` survivors: a reader never sees a partial artifact.
        let leftovers: Vec<_> = std::fs::read_dir(paths.trace.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timestamps_are_rfc3339() {
        assert_eq!(format_iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_iso8601(1_765_000_000), "2025-12-06T05:46:40Z");
        let now = now();
        assert_eq!(now.len(), 20, "YYYY-MM-DDTHH:MM:SSZ is 20 chars: {now}");
        assert!(now.ends_with('Z'));
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");
    }

    #[test]
    fn a_step_with_an_undeclared_field_is_refused() {
        let dir = std::env::temp_dir().join(format!("myco-ev-s-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut r = rec(&dir);
        r.action(json!({"kind": "click", "ref": "n1"}), 0, 1, "delivered_unverified", "x");
        let mut v: Value = serde_json::from_slice(&r.result_bytes().unwrap()).unwrap();
        v["steps"][0]["verdict"] = json!("nope");
        let err = validate_session_record(&v).unwrap_err();
        assert!(err.to_string().contains("unexpected field"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_trace_field_is_refused() {
        let bad = json!({
            "type": "observation",
            "timestamp": "t",
            "stateVersion": 1,
            "nodeCount": 1,
            "extra": true
        });
        assert!(validate_trace_event(&bad).is_err());
    }

    #[test]
    fn missing_required_field_is_refused() {
        let bad = json!({"type": "action", "timestamp": "t", "step": 0});
        assert!(validate_trace_event(&bad).is_err());
    }
}
