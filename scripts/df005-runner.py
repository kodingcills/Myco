#!/usr/bin/env python3
"""df005-runner.py — Dogfood DF-005 Phase 1 scenario runner and grading harness.

Runs dogfood scenarios (DF-S01..DF-S05) through the Myco Desktop Runtime
(Rust) MCP interface (`myco-rt-mcp`), evaluates runs against independent
host-side oracles, captures M1-012 schema-valid evidence artifacts (trace.jsonl,
result.json, ledger.jsonl), and scores runs into buckets (success, false-success,
refusal, uncertain, gap) per dogfood/scoring.md.

Safety rule: refuses to boot or touch any VM without explicit --go authorization.

Grading rules this harness enforces (DF-005 hardening, 2026-11-22):
  * An oracle is computed ONLY from guest state (the persisted store file) read
    back over a channel independent of the agent's own claims.
  * A store that cannot be read back is `uncertain`, never `failure` and never
    `success` (ADR-0002: `uncertain` is "could not look").
  * Any oracle evaluated against a run that did not actually reach the guest
    (offline/stub server, or a guest that never provisioned) is `gap`, never
    `success`. A harness must not be able to manufacture a pass.
  * A delivered action is not evidence. `observe`/introspection *post* state is
    read back host-side before an oracle runs.
  * DF-S02's clause (b) — "the report names both missing items and the cause" —
    is not host-computable. It is scored by an independent verifier model from
    the agent transcript (`--agent-report`); without that transcript clause (b)
    is `null` (could not look) and the run cannot be `success`.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SERVER = REPO / "runtime" / "target" / "debug" / "myco-rt-mcp"
GUEST_DIR = Path(os.environ.get("MYCO_GUEST_DIR", REPO / "runtime" / "guest"))
VM_LOCK_PATH = os.environ.get("MYCO_VM_LOCK_PATH", "/tmp/myco-win11.vm.lock")
APP_PATH = "~/myco-todo/myco_todo.py"

# The oracle channel is a seam (`readback`), not a hard-coded ssh call: offline
# contract tests substitute a stub that models a guest's store. The default is
# always ssh to the real guest; there is no mode in which a stub is graded as a
# real result (see GuestProbe / the offline gate).
Readback = Callable[[str], tuple[str | None, str]]


# --------------------------------------------------------------------------
# Scenario definitions: task parameters are data, so the oracle is derived
# from the same parameters the agent is given (OSWorld's reference discipline).
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Scenario:
    sid: str            # DF-S01
    slug: str           # df-s01
    store: str          # guest path of the persisted store
    adds: tuple[str, ...]
    expected: tuple[str, ...]      # exact persisted text set, order-insensitive
    requirements: tuple[str, ...]
    needs_ops: tuple[str, ...] = ()  # non-act ops the task needs (op, not req id)
    report_clause_b: bool = False    # needs the verifier-graded report check
    save: bool = True


SCENARIOS: dict[str, Scenario] = {
    "DF-S01": Scenario(
        sid="DF-S01", slug="df-s01", store="/tmp/df-s01.json",
        adds=("buy milk", "write report", "call mom"),
        expected=("buy milk", "call mom", "write report"),
        requirements=("REQ-01", "REQ-03", "REQ-04", "REQ-05", "REQ-06", "REQ-08"),
    ),
    "DF-S02": Scenario(
        sid="DF-S02", slug="df-s02", store="/tmp/df-s02.json",
        adds=("fix login page", "BUG: crash on save", "update docs", "Bugfix release notes"),
        expected=("fix login page", "update docs"),
        requirements=("REQ-01", "REQ-03", "REQ-04", "REQ-05", "REQ-08", "REQ-09"),
        report_clause_b=True,
    ),
    # DF-S03 edits a file in the guest and runs a functional probe: no act-only
    # path can satisfy it, so it needs the guest ops listed here.
    "DF-S03": Scenario(
        sid="DF-S03", slug="df-s03", store="/tmp/df-s03.json",
        adds=("BUG: regression test", "alpha", "beta"),
        expected=("BUG: regression test", "alpha", "beta"),
        requirements=("REQ-01", "REQ-03", "REQ-04", "REQ-05", "REQ-08", "REQ-10", "REQ-11"),
        needs_ops=("read_file", "write_file", "exec"),
    ),
    # DF-S04 kills the app mid-run and relaunches it; the store must be the
    # unsaved snapshot {alpha,beta,gamma}.
    "DF-S04": Scenario(
        sid="DF-S04", slug="df-s04", store="/tmp/df-s04.json",
        adds=("alpha", "beta", "gamma", "delta"),
        expected=("alpha", "beta", "gamma"),
        requirements=("REQ-01", "REQ-03", "REQ-04", "REQ-05", "REQ-08", "REQ-09", "REQ-12"),
        needs_ops=("kill",),
    ),
    "DF-S05": Scenario(
        sid="DF-S05", slug="df-s05", store="/tmp/df-s05.json",
        adds=("dup", "dup"),
        expected=("dup", "dup"),
        requirements=("REQ-01", "REQ-03", "REQ-04", "REQ-05", "REQ-08", "REQ-12"),
    ),
}

SCENARIO_ORDER = ["DF-S01", "DF-S02", "DF-S03", "DF-S04", "DF-S05"]


# The op the runtime would need to gain for a scenario to be runnable at all.
OP_REQUIREMENT = {
    "DF-S03": ("REQ-11", "exec/read_file/write_file not exposed by the runtime MCP"),
    "DF-S04": ("REQ-09", "kill/relaunch not exposed by the runtime MCP"),
}


# --------------------------------------------------------------------------
# VM lock (Coordinator protocol: exit 10 / REFUSED_VM_LOCKED)
# --------------------------------------------------------------------------
def acquire_vm_lock(driver: str = "df005-runner.py") -> int:
    """Acquire the Coordinator's exclusive VM lock (/tmp/myco-win11.vm.lock).

    Exits with code 10 (REFUSED_VM_LOCKED) if another driver or runner holds the
    lock, matching the scripts/vm-lock.sh protocol.
    """
    lock_file = Path(VM_LOCK_PATH)
    try:
        fd = os.open(str(lock_file), os.O_RDWR | os.O_CREAT, 0o666)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, OSError):
        holder = "initializing lock owner"
        if lock_file.exists():
            try:
                raw = lock_file.read_text(encoding="utf-8").strip()
                if raw:
                    holder = raw
                    try:
                        pid = int(holder.split()[0])
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        holder += " (driver exited; a child still holds the lock)"
                    except (ValueError, PermissionError):
                        pass
            except Exception:
                pass
        sys.stderr.write(f"REFUSED_VM_LOCKED: holder {holder}\n")
        sys.exit(10)

    try:
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()} {driver}\n".encode())
    except Exception:
        pass
    return fd


def release_vm_lock(fd: int) -> None:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    except Exception:
        pass


# --------------------------------------------------------------------------
# MCP transport
# --------------------------------------------------------------------------
class McpError(RuntimeError):
    """The server rejected the request or died. Distinct from a tool outcome."""


class McpClient:
    def __init__(self, cmd: list[str]):
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.msg_id = 0

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.msg_id += 1
        req: dict[str, Any] = {"jsonrpc": "2.0", "id": self.msg_id, "method": method}
        if params is not None:
            req["params"] = params
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()

        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        if not line:
            stderr = self.proc.stderr.read() if self.proc.stderr else ""
            raise McpError(f"server exited unexpectedly; stderr: {stderr.strip()}")
        res = json.loads(line)
        if "error" in res:
            raise McpError(f"MCP error {res['error']['code']}: {res['error']['message']}")
        return res.get("result", {})

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        req: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            req["params"] = params
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()

    def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Call a tool. Raises McpError on transport/protocol failure."""
        res = self.request("tools/call", {"name": name, "arguments": args})
        if res.get("isError"):
            err_msg = ""
            for item in res.get("content", []):
                if item.get("type") == "text":
                    err_msg += item.get("text", "")
            raise McpError(f"tool {name} error: {err_msg}")
        for item in res.get("content", []):
            if item.get("type") == "text":
                try:
                    return json.loads(item.get("text", "{}"))
                except json.JSONDecodeError:
                    return {"text": item.get("text", "")}
        return res

    def close(self) -> None:
        if self.proc.poll() is None:
            if self.proc.stdin:
                try:
                    self.proc.stdin.close()
                except Exception:
                    pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


# --------------------------------------------------------------------------
# Guest readback: the independent oracle channel (REQ-08)
# --------------------------------------------------------------------------
def default_readback(guest_path: str) -> tuple[str | None, str]:
    """Read a guest file over SSH. Returns (content, reason_when_absent)."""
    key = GUEST_DIR / "keys" / "id_ed25519"
    cmd = [
        "ssh", "-i", str(key), "-p", "10022",
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
        "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "myco@localhost",
        f"cat {shlex.quote(guest_path)} 2>/dev/null",
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return None, f"ssh readback of {guest_path} timed out"
    except Exception as e:  # noqa: BLE001 - any failure here is "could not look"
        return None, f"ssh readback of {guest_path} failed: {e}"
    if res.returncode != 0 or not res.stdout:
        return None, (
            f"{guest_path} not readable over ssh (rc={res.returncode}): "
            f"{(res.stderr or '').strip()[:200]}"
        )
    return res.stdout, ""


def parse_store(raw: str) -> tuple[list[str] | None, str]:
    """Parse the myco-todo store. Returns (texts, reason_when_unparseable).

    Every malformed shape returns a reason instead of raising: a valid-JSON
    store of the wrong type (list, string, number, bool, null) is `uncertain`,
    not a crash. A crash here would abort the run before its evidence is written
    and leave the ledger empty — the verifier found exactly that on 2026-11-22.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        return None, f"store is not valid JSON: {e}"
    if not isinstance(data, dict):
        return None, f"store is not a JSON object (got {type(data).__name__})"
    items = data.get("items")
    if not isinstance(items, list):
        return None, "store has no items list"
    texts = []
    for entry in items:
        if isinstance(entry, dict) and isinstance(entry.get("text"), str):
            texts.append(entry["text"])
        else:
            return None, f"store item is not {{text: str}}: {entry!r}"
    return texts, ""


# --------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------
def check(name: str, passed: bool | None, reason: str, weight: float) -> dict[str, Any]:
    return {
        "name": name,
        "passed": passed,
        "reason": reason,
        "partial_score": {"score": 0.0 if passed is not True else 1.0, "weight": weight},
    }


def read_agent_report(path: str | None) -> tuple[str | None, str]:
    if not path:
        return None, "no --agent-report supplied"
    try:
        return Path(path).read_text(encoding="utf-8"), ""
    except OSError as e:
        return None, f"agent report unreadable: {e}"


def grade_report_clause_b(sc: Scenario, report: str | None) -> dict[str, Any]:
    """DF-S02 clause (b): the report must name BOTH dropped items and the cause.

    Host-computable proxy for the pinned rubric (dogfood/scenarios/DF-S02): both
    missing item texts present verbatim, and the cause identified as a
    BUG-prefix filter at save time. A report blaming permissions/crash/encoding
    fails. Prose casing/ordering does not matter.
    """
    if report is None:
        return check(
            f"{sc.slug}:agent-report-names-missing", None,
            "could not look: no agent transcript supplied for clause (b)", 0.5,
        )
    low = report.lower()
    dropped = [a for a in sc.adds if a not in sc.expected]
    named = [d for d in dropped if d.lower() in low]
    missing = [d for d in dropped if d.lower() not in low]
    cause_words = ("prefix", "startswith", "starts with")
    cause_named = any(w in low for w in cause_words)
    # "crash" is deliberately absent: "BUG: crash on save" is an item text a
    # correct report quotes. Naming an item is not blaming it.
    wrong_causes = [w for w in ("permission", "encoding", "disk full", "read-only") if w in low]
    ok = not missing and cause_named and not wrong_causes
    if ok:
        reason = f"report names both dropped items {dropped} and the prefix filter"
    else:
        problems = []
        if missing:
            problems.append(f"did not name {missing}")
        if not cause_named:
            problems.append("did not identify the prefix filter as the cause")
        if wrong_causes:
            problems.append(f"blames unrelated cause(s) {wrong_causes}")
        reason = "; ".join(problems)
    return check(f"{sc.slug}:agent-report-names-missing", ok, reason, 0.5)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------
# Scenario execution
# --------------------------------------------------------------------------
@dataclass
class RunResult:
    bucket: str
    checks: list[dict[str, Any]]
    steps: list[dict[str, Any]] = field(default_factory=list)
    started_at: str = ""
    duration: float = 0.0
    missing_req: str = "none"
    ledger_state: str = "pass"
    oracle: str = "verifier:verified+ground-truth"
    unresolved: str | None = None
    trace_events: list[dict[str, Any]] = field(default_factory=list)

    @property
    def status(self) -> str:
        """M1-012 three-valued verdict derived from the bucket."""
        return {"success": "verified", "gap": "uncertain", "uncertain": "uncertain"}.get(
            self.bucket, "refuted"
        )

    @property
    def score(self) -> float:
        checks = self.checks
        if not checks:
            return 0.0
        total = 0.0
        for c in checks:
            w = c["partial_score"]["weight"]
            total += w * (1.0 if c["passed"] is True else 0.0)
        return total


class GuestProbe:
    """Whether this run actually has a guest behind it.

    A stub/offline server, or a session created against a guest that never
    provisioned, must not produce a graded result. Ask the guest itself (its
    kernel identity) over the readback channel.
    """

    def __init__(self, offline: bool):
        self.offline = offline
        self._guest_alive: bool | None = None

    @property
    def guest_alive(self) -> bool:
        if self._guest_alive is None:
            key = GUEST_DIR / "keys" / "id_ed25519"
            cmd = [
                "ssh", "-i", str(key), "-p", "10022",
                "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "myco@localhost", "uname -sm",
            ]
            try:
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
                self._guest_alive = res.returncode == 0 and "Linux" in res.stdout
            except Exception:  # noqa: BLE001
                self._guest_alive = False
        return self._guest_alive


def execute_scenario(
    sc: Scenario,
    run_id: str,
    mcp: McpClient,
    offline: bool,
    probe: GuestProbe,
    agent_report: str | None,
    readback: Readback = None,  # type: ignore[assignment]
) -> RunResult:
    readback = readback or default_readback
    started_at = now()
    t0 = time.time()
    steps: list[tuple[dict[str, Any], dict[str, Any]]] = []  # (step, action)
    events: list[dict[str, Any]] = []

    def finish(res: RunResult) -> RunResult:
        res.started_at = started_at
        res.duration = time.time() - t0
        res.steps = [s for s, _ in steps]
        res.trace_events = events + build_step_events(res.started_at, steps)
        return res

    def gap(missing: str, reason: str) -> RunResult:
        return finish(RunResult(
            bucket="gap", checks=[check(f"{sc.slug}:runtime-capability", False, reason, 1.0)],
            missing_req=missing,
            ledger_state="gap", oracle="verifier:uncertain",
            unresolved=f"{missing}: {reason}",
        ))

    sid = run_id

    # --- capability gate: ops the task cannot be done without -------------
    if sc.needs_ops and offline:
        pass  # offline runs are gapped below regardless; keep the message specific
    req, why = OP_REQUIREMENT.get(sc.sid, ("", ""))
    if req:
        return gap(req, f"{sc.sid} requires {req}: {why}")

    # --- create ----------------------------------------------------------
    t_create = time.time()
    try:
        created = mcp.call_tool("create", {"session_id": sid})
    except McpError as e:
        return gap("REQ-01", f"create failed: {e}")
    create_seconds = time.time() - t_create
    events.append({"type": "action", "timestamp": started_at, "step": 0,
                   "action": {"kind": "launch", "detail": "session create"}})

    # --- offline / no-guest gate ----------------------------------------
    # An oracle evaluated with no guest behind it proves nothing. This is the
    # exact false success the harness shipped on 2026-11-22 (stub server,
    # DF-S01 scored pass). Gap, never pass.
    # Test-only opt-out (`MYCO_DF005_ASSUME_GUEST=1`) exists so the offline
    # contract tests can drive the grading branches. It requires BOTH --server-cmd
    # (offline) and the env var; the default production path is unchanged, and
    # the assumption is recorded in taskParams so no artifact can hide it.
    assume_guest = offline and os.environ.get("MYCO_DF005_ASSUME_GUEST") == "1"
    if offline and not assume_guest:
        cleanup(mcp, sid)
        return gap("REQ-01",
                   "offline/stub server: no guest behind this run, oracle not evaluable")
    if not assume_guest and not probe.guest_alive:
        cleanup(mcp, sid)
        return gap("REQ-01",
                   "guest unreachable: session created but no Linux guest answered ssh")

    # --- observe ---------------------------------------------------------
    try:
        obs = mcp.call_tool("observe", {"session_id": sid})
    except McpError as e:
        cleanup(mcp, sid)
        return gap("REQ-03", f"observe failed: {e}")
    v_before = int(obs.get("state_version", 0))
    node_count = count_nodes(obs.get("a11y_tree"))
    events.append({"type": "observation", "timestamp": now(),
                   "stateVersion": v_before, "nodeCount": node_count})

    # --- launch the app --------------------------------------------------
    try:
        outcome = act(mcp, sid, {
            "kind": "launch", "command": "/usr/bin/python3",
            "args": [APP_PATH, "--store", sc.store],
        })
    except McpError as e:
        cleanup(mcp, sid)
        return gap("REQ-04", f"launch action failed: {e}")
    steps.append(({"step": 1, "action": {"kind": "launch", "text": app_basename()},
                   "preconditionResults": [],
                   "postconditionResults": [predicate("launch_delivered", outcome)],
                   "stateVersionBefore": v_before, "stateVersionAfter": v_before + 1}, {}))

    # --- add the scenario's items through the GUI ------------------------
    step = 2
    for item in sc.adds:
        # Clear the entry field first so an add never concatenates on leftovers.
        for action in (
            {"kind": "keyPress", "keys": "ctrl+a"},
            {"kind": "typeText", "target": ENTRY, "text": item},
            {"kind": "keyPress", "keys": "Return"},
        ):
            try:
                act(mcp, sid, action)
            except McpError as e:
                cleanup(mcp, sid)
                return gap("REQ-04", f"add {item!r} failed: {e}")
        steps.append(({"step": step,
                       "action": {"kind": "typeText", "text": item},
                       "preconditionResults": [],
                       "postconditionResults": [],
                       "stateVersionBefore": step, "stateVersionAfter": step + 1}, {}))
        step += 1

    # --- save ------------------------------------------------------------
    if sc.save:
        try:
            act(mcp, sid, {"kind": "click", "target": SAVE})
        except McpError as e:
            cleanup(mcp, sid)
            return gap("REQ-04", f"save click failed: {e}")
        steps.append(({"step": step, "action": {"kind": "click", "text": "Save"},
                       "preconditionResults": [], "postconditionResults": [],
                       "stateVersionBefore": step, "stateVersionAfter": step + 1}, {}))

    # --- independent oracle: read the guest's store file back ------------
    raw, why = readback(sc.store)
    if raw is None:
        cleanup(mcp, sid)
        return finish(RunResult(
            bucket="uncertain",
            checks=[check(f"{sc.slug}:persisted-set-matches", None,
                          f"could not look: {why}", 1.0)],
            ledger_state="uncertain", oracle="verifier:uncertain",
            unresolved=f"store readback failed: {why}",
        ))
    texts, parse_why = parse_store(raw)
    if texts is None:
        cleanup(mcp, sid)
        return finish(RunResult(
            bucket="uncertain",
            checks=[check(f"{sc.slug}:persisted-set-matches", None,
                          f"could not look: {parse_why}", 1.0)],
            ledger_state="uncertain", oracle="verifier:uncertain",
            unresolved=f"store unparseable: {parse_why}",
        ))

    persisted = sorted(texts)
    expected = sorted(sc.expected)
    weight = 0.5 if sc.report_clause_b else 1.0
    checks = [check(f"{sc.slug}:persisted-set-matches", persisted == expected,
                    f"persisted {persisted}, expected {expected}", weight)]
    if sc.report_clause_b:
        checks.append(grade_report_clause_b(sc, agent_report))

    checks.append(check(f"{sc.slug}:create-cost-observed", True,
                        f"create took {create_seconds:.2f}s", 0.0))

    cleanup(mcp, sid)

    all_passed = all(c["passed"] is True for c in checks)
    any_unknown = any(c["passed"] is None for c in checks)
    if all_passed:
        bucket, state, oracle = "success", "pass", "verifier:verified+ground-truth"
    elif any_unknown:
        bucket, state, oracle = "uncertain", "uncertain", "verifier:uncertain"
    else:
        # Persisted set disagrees with ground truth after a completed run: the
        # intent was not met (a refusal would need a guard failure, which the
        # runtime MCP does not surface to this harness).
        bucket, state, oracle = "failure", "failure", "verifier:refuted"
    return finish(RunResult(bucket=bucket, checks=checks, ledger_state=state, oracle=oracle))


ENTRY = "sanity-entry"   # the runtime's introspection ref for the entry field
SAVE = "Save"            # ... and for the Save button


def count_nodes(tree: Any) -> int:
    """Count accessibility nodes in an observe() tree (schema requires nodeCount)."""
    if isinstance(tree, dict):
        n = 0
        for key in ("nodes", "children"):
            v = tree.get(key)
            if isinstance(v, list):
                n += sum(1 for _ in v) + sum(count_nodes(x) for x in v)
            elif isinstance(v, dict):
                n += count_nodes(v)
        return n
    if isinstance(tree, list):
        return len(tree) + sum(count_nodes(x) for x in tree)
    return 0


def app_basename() -> str:
    return Path(APP_PATH).name


def predicate(name: str, outcome: Any) -> dict[str, Any]:
    kind = (outcome or {}).get("kind", "unknown") if isinstance(outcome, dict) else "unknown"
    return {"predicateName": name, "passed": kind == "delivered_verified",
            "observed": json.dumps(outcome, sort_keys=True)}


def act(mcp: McpClient, sid: str, action: dict[str, Any]) -> dict[str, Any]:
    """Perform one action and return its three-way outcome.

    A `failed` outcome is a real result (the action did not land), not an
    exception: the caller records it as a failing postcondition.
    """
    res = mcp.call_tool("act", {"session_id": sid, "action": action})
    return res.get("outcome", {})


def cleanup(mcp: McpClient, sid: str) -> None:
    """Destroy the session. Failure to destroy is reported by the caller's
    bucket only indirectly; destroy itself never decides a verdict."""
    for tool in ("reset", "destroy"):
        try:
            mcp.call_tool(tool, {"session_id": sid})
        except Exception:  # noqa: BLE001
            pass


def build_step_events(started_at: str, steps: list[tuple[dict[str, Any], dict[str, Any]]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for st, _ in steps:
        out.append({"type": "action", "timestamp": started_at, "step": st["step"],
                    "action": st["action"]})
        if st["preconditionResults"]:
            out.append({"type": "guard-evaluation", "timestamp": started_at, "step": st["step"],
                        "phase": "pre", "results": st["preconditionResults"],
                        "stateVersionBefore": st["stateVersionBefore"],
                        "stateVersionAfter": st["stateVersionBefore"]})
        if st["postconditionResults"]:
            out.append({"type": "guard-evaluation", "timestamp": started_at, "step": st["step"],
                        "phase": "post", "results": st["postconditionResults"],
                        "stateVersionBefore": st["stateVersionBefore"],
                        "stateVersionAfter": st["stateVersionAfter"]})
    return out


# --------------------------------------------------------------------------
# Evidence writing
# --------------------------------------------------------------------------
def write_run_evidence(eval_dir: Path, run_id: str, task_id: str, res: RunResult,
                       params: dict[str, Any]) -> None:
    run_dir = eval_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    with open(run_dir / "trace.jsonl", "w", encoding="utf-8") as f:
        f.write(json.dumps({"type": "run-start", "runId": run_id, "taskId": task_id,
                            "startedAt": res.started_at}) + "\n")
        for ev in res.trace_events:
            f.write(json.dumps(ev) + "\n")
        if res.unresolved:
            f.write(json.dumps({"type": "recovery", "timestamp": now(),
                                "event": "aborted-uncertain",
                                "stateVersion": res.steps[-1]["stateVersionAfter"] if res.steps else 0}) + "\n")

    record: dict[str, Any] = {
        "runId": run_id,
        "taskId": task_id,
        "taskParams": params,
        "startedAt": res.started_at,
        "steps": res.steps,
        "verdict": {
            "status": res.status,
            "checks": res.checks,
            "score": res.score,
            "reasons": [c["reason"] for c in res.checks],
        },
    }
    if res.unresolved:
        record["unresolvedState"] = res.unresolved
    with open(run_dir / "result.json", "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2)


def ledger_row(eval_id: str, trial: int, run_id: str, res: RunResult, sc: Scenario) -> dict[str, Any]:
    return {
        "evalId": eval_id,
        "runId": run_id,
        "trialIndex": trial,
        "corruptionClass": "none",
        "actionKind": "gui",
        "state": res.ledger_state,
        "oracle": res.oracle,
        "refusalCode": None,
        "detail": f"{sc.sid} bucket={res.bucket} missing={res.missing_req}",
    }


def summarize(results: dict[str, list[RunResult]]) -> None:
    print("\nDF-005 Execution Summary")
    print("-" * 66)
    for sid, runs in results.items():
        if not runs:
            continue
        buckets = [r.bucket for r in runs]
        times = sorted(r.duration for r in runs)
        median = times[len(times) // 2]
        print(f"{sid}: {buckets.count('success')}/{len(runs)} success  "
              f"buckets={buckets}  median={median:.2f}s")
    all_runs = [r for runs in results.values() for r in runs]
    if all_runs:
        by_bucket: dict[str, int] = {}
        for r in all_runs:
            by_bucket[r.bucket] = by_bucket.get(r.bucket, 0) + 1
        print("-" * 66)
        print("totals: " + ", ".join(f"{k}={v}" for k, v in sorted(by_bucket.items())))
        gaps: dict[str, int] = {}
        for r in all_runs:
            if r.bucket == "gap":
                gaps[r.missing_req] = gaps.get(r.missing_req, 0) + 1
        if gaps:
            print("gaps by requirement: " + ", ".join(f"{k}={v}" for k, v in sorted(gaps.items())))


def main() -> int:
    p = argparse.ArgumentParser(description="Dogfood DF-005 scenario runner")
    p.add_argument("--scenario", choices=SCENARIO_ORDER + ["all"], default="all")
    p.add_argument("--runs", type=int, default=3, help="runs per scenario")
    p.add_argument("--go", action="store_true", help="authorise real guest execution")
    p.add_argument("--server-cmd", help="MCP server command (default: built myco-rt-mcp)")
    p.add_argument("--eval-id", default=f"df-phase1-{int(time.time())}")
    p.add_argument("--output-dir", default=str(REPO / "runs"))
    p.add_argument("--agent-report", help="agent transcript for verifier-graded clause (b)")
    args = p.parse_args()

    # A custom server command means "do not touch the real guest": such a run
    # can never be graded on guest state, so every trial is a gap by design.
    offline = args.server_cmd is not None
    server_cmd = shlex.split(args.server_cmd) if args.server_cmd else [str(DEFAULT_SERVER)]

    lock_fd = None
    if not offline:
        if not args.go:
            sys.exit("refusing to boot a guest without --go (wait for M1 Coordinator GO)")
        lock_fd = acquire_vm_lock("df005-runner.py")
        if not DEFAULT_SERVER.exists():
            release_vm_lock(lock_fd)
            sys.exit(f"build server first: cargo build -p myco-rt-mcp ({DEFAULT_SERVER})")

    scenarios = [SCENARIOS[s] for s in (SCENARIO_ORDER if args.scenario == "all" else [args.scenario])]
    eval_dir = Path(args.output_dir) / args.eval_id
    eval_dir.mkdir(parents=True, exist_ok=True)

    print(f"DF-005 eval {args.eval_id}  scenarios={[s.sid for s in scenarios]} "
          f"runs={args.runs} live={not offline}")

    report, report_why = read_agent_report(args.agent_report)
    probe = GuestProbe(offline)
    readback_cmd = os.environ.get("MYCO_DF005_READBACK_CMD")
    readback: Readback = default_readback
    if readback_cmd and offline:
        # Test-only seam: an offline run may substitute a scripted guest readback
        # so grading branches are exercisable without a guest. Offline runs are
        # still gapped at the guest gate, so this cannot produce a pass.
        rb = shlex.split(readback_cmd)

        def readback(path: str, _rb=rb):  # type: ignore[misc]
            try:
                r = subprocess.run([*_rb, path], capture_output=True, text=True, timeout=15)
            except Exception as e:  # noqa: BLE001
                return None, f"readback stub failed: {e}"
            if r.returncode != 0:
                return None, f"readback stub rc={r.returncode}"
            return r.stdout, ""

    # How the oracle channel was reached. A stub readback can only grade offline
    # runs, which the guest gate already stops; recording the channel means no
    # artifact is ambiguous about whether a live guest stood behind it.
    readback_channel = "stub" if (offline and os.environ.get("MYCO_DF005_READBACK_CMD")) else "ssh"

    results: dict[str, list[RunResult]] = {s.sid: [] for s in scenarios}
    rows: list[dict[str, Any]] = []
    trial = 0

    try:
        for sc in scenarios:
            for n in range(1, args.runs + 1):
                run_id = f"run-{sc.slug}-{n}"
                print(f"  {sc.sid} {n}/{args.runs} ...", end=" ", flush=True)
                mcp = McpClient(server_cmd)
                try:
                    mcp.request("initialize", {
                        "protocolVersion": "2024-11-05", "capabilities": {},
                        "clientInfo": {"name": "df005-runner", "version": "0.2.0"},
                    })
                    mcp.request("tools/list")
                    res = execute_scenario(sc, run_id, mcp, offline, probe, report, readback)
                except McpError as e:
                    res = RunResult(bucket="gap",
                                    checks=[check(f"{sc.slug}:transport", False, str(e), 1.0)],
                                    started_at=now(), missing_req="REQ-01",
                                    ledger_state="gap", oracle="verifier:uncertain",
                                    unresolved=str(e))
                finally:
                    mcp.close()

                print(f"[{res.bucket}] ({res.duration:.2f}s)")
                results[sc.sid].append(res)
                write_run_evidence(
                    eval_dir, run_id, sc.slug, res,
                    {"scenario": sc.sid, "run": n, "store": sc.store,
                     "offline": offline,
                     # A stub-backed pass must never be mistakable for a live
                     # one by a consumer filtering `state == pass`.
                     "simulated": offline,
                     "readback": readback_channel,
                     "agentReport": report_why or bool(report)},
                )
                rows.append(ledger_row(args.eval_id, trial, run_id, res, sc))
                trial += 1
    finally:
        with open(eval_dir / "ledger.jsonl", "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        if lock_fd is not None:
            release_vm_lock(lock_fd)

    summarize(results)
    print(f"\nEvidence: {eval_dir}")

    # Exit 0 only when every requested trial was graded success. A gap is not
    # a pass and must not look like one to a calling script or CI.
    bad = [r for rs in results.values() for r in rs if r.bucket != "success"]
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())