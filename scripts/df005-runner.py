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

# TIF-120: the guest path the fixture publishes its widget record to and the
# runtime reads it back from. Passed on `create` (route 1, preferred over
# gui.env) and set by the runtime as MYCO_TODO_STATE_FILE for apps it launches,
# so the app writes exactly where `observe` reads.
INTROSPECTION_PATH = "/tmp/myco-todo-state.json"

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
def check_score(passed: bool | None) -> float:
    """The one place a check's score is derived from its outcome.

    `check()` publishes this and `RunResult.score` consumes it, so the two can
    never disagree — they did, as two independent encodings of the same rule.
    """
    return 1.0 if passed is True else 0.0


def check(name: str, passed: bool | None, reason: str, weight: float) -> dict[str, Any]:
    return {
        "name": name,
        "passed": passed,
        "reason": reason,
        "partial_score": {"score": check_score(passed), "weight": weight},
    }


def read_agent_report(path: str | None) -> tuple[str | None, str]:
    if not path:
        return None, "no --agent-report supplied"
    try:
        return Path(path).read_text(encoding="utf-8"), ""
    except OSError as e:
        return None, f"agent report unreadable: {e}"


def grade_report_clause_b(sc: Scenario, report: str | None,
                          weight: float) -> dict[str, Any]:
    """DF-S02 clause (b): the report must name BOTH dropped items and the cause.

    Host-computable proxy for the pinned rubric (dogfood/scenarios/DF-S02): both
    missing item texts present verbatim, and the cause identified as a
    BUG-prefix filter at save time. A report blaming permissions/crash/encoding
    fails. Prose casing/ordering does not matter.
    """
    if report is None:
        return check(
            f"{sc.slug}:agent-report-names-missing", None,
            "could not look: no agent transcript supplied for clause (b)", weight,
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
    return check(f"{sc.slug}:agent-report-names-missing", ok, reason, weight)


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
    # Fail-closed defaults: a construction site that forgets to state its
    # verdict must not inherit a pass. Every site sets these explicitly today;
    # this makes a future omission a gap rather than a fabricated success.
    ledger_state: str = "gap"
    oracle: str = "verifier:uncertain"
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
            total += c["partial_score"]["weight"] * check_score(c["passed"])
        # Round: 0.4 + 0.2 accumulates to 0.6000000000000001 in binary float,
        # which is noise in an artifact a human reads.
        return round(total, 10)


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
    all_postconditions: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []

    def finish(res: RunResult) -> RunResult:
        res.started_at = started_at
        res.duration = time.time() - t0
        # `dispatched` is trace-only: EvidenceStep is closed
        # (additionalProperties: false), so the wire actions must not leak into
        # result.json. They are emitted as `action` events in trace.jsonl.
        res.steps = [{k: v for k, v in s.items() if k != "dispatched"} for s, _ in steps]
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
        created = mcp.call_tool("create", {
            "session_id": sid,
            # Route 1 (TIF-120): a per-session path wins over gui.env, and the
            # runtime sets MYCO_TODO_STATE_FILE to it for apps launched via act.
            "introspection_file": INTROSPECTION_PATH,
        })
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

    # --- choose an actuation route ---------------------------------------
    # Two routes, in order of preference:
    #
    #   ref route    — the app exposes AT-SPI nodes: click/typeText by ref.
    #   global route — it exposes none (Tk registers zero, RT-003): clickAt a
    #                  screen point to establish window focus, then
    #                  typeTextGlobal into whatever has focus.
    #
    # The global route is the one the runtime's live proof uses
    # (act_global_live.rs): clickAt the window centre, confirm the window is
    # active out-of-band, then type with no target. Both global actions report
    # `delivered_unverified` by design — there is nothing to read back at that
    # layer — so the oracle below is the only thing that decides the run.
    entry_ref = find_ref_by_role(obs, ("entry", "text", "text-field"))
    save_ref = find_ref_by_role(obs, ("push-button", "button"), name="Save")
    route = "ref" if (entry_ref and save_ref) else "global"

    field: dict[str, Any] = {}
    save_geom: dict[str, Any] = {}
    if route == "global":
        # Geometry comes from the app's own introspection record, which the
        # fixture publishes (REQ-03 option B). Without it there is no point to
        # click, and guessing one would be a fabricated target.
        intro = introspection_record(obs)
        if intro is None:
            obs = observe_until_introspection(mcp, sid)
            intro = introspection_record(obs)
        unavailable = introspection_unavailable(obs)
        field = (intro or {}).get("entry_field") or {}
        save_geom = (intro or {}).get("save_button") or {}
        if not (isinstance(field, dict) and {"x", "y"} <= set(field)):
            why = f"; introspection: {unavailable}" if unavailable else ""
            cleanup(mcp, sid)
            return gap("REQ-03",
                       "no AT-SPI entry ref and no entry_field geometry in the "
                       f"introspection record, so there is no point to click{why}")
        if sc.save and not (isinstance(save_geom, dict) and {"x", "y"} <= set(save_geom)):
            cleanup(mcp, sid)
            return gap("REQ-03",
                       "no AT-SPI Save ref and no save_button geometry in the "
                       "introspection record")

    # --- add the scenario's items through the GUI ------------------------
    step = 2
    for item in sc.adds:
        if route == "ref":
            actions = [
                {"kind": "click", "target": entry_ref},
                {"kind": "keyPress", "keys": "ctrl+a"},      # clear leftovers
                {"kind": "typeText", "target": entry_ref, "text": item},
                {"kind": "keyPress", "keys": "Return"},
            ]
        else:
            actions = [
                # Clicking inside the window establishes X focus; the entry has
                # Tk focus already (focus_set at startup), so this is enough.
                {"kind": "clickAt", "x": field["x"], "y": field["y"]},
                {"kind": "keyPress", "keys": "ctrl+a"},
                {"kind": "typeTextGlobal", "text": item},
                {"kind": "keyPress", "keys": "Return"},
            ]
        outcomes = []
        for action in actions:
            try:
                outcomes.append(act(mcp, sid, action))
            except McpError as e:
                cleanup(mcp, sid)
                return gap("REQ-04", f"add {item!r} failed: {e}")
        post = [predicate(f"add_delivered[{item}][{a['kind']}]", o)
                for a, o in zip(actions, outcomes)]
        all_postconditions.extend(post)
        steps.append(({"step": step,
                       # Report the wire form, not a summary: a consumer reading
                       # steps[].action.kind must be able to tell a ref-targeted
                       # run from a global-input one.
                       "action": ({"kind": "typeText", "text": item} if route == "ref"
                                  else {"kind": "typeTextGlobal", "text": item}),
                       "dispatched": actions,
                       "preconditionResults": [],
                       "postconditionResults": post,
                       "stateVersionBefore": step, "stateVersionAfter": step + 1}, {}))
        step += 1

    # --- save ------------------------------------------------------------
    if sc.save:
        save_action = (
            {"kind": "click", "target": save_ref} if route == "ref"
            else {"kind": "clickAt", "x": save_geom["x"], "y": save_geom["y"]}
        )
        try:
            save_outcome = act(mcp, sid, save_action)
        except McpError as e:
            cleanup(mcp, sid)
            return gap("REQ-04", f"save click failed: {e}")
        save_post = [predicate("save_delivered", save_outcome)]
        all_postconditions.extend(save_post)
        steps.append(({"step": step,
                       "action": ({"kind": "click", "text": "Save"} if route == "ref"
                                  else {"kind": "clickAt", "text": "Save"}),
                       "dispatched": [save_action],
                       "preconditionResults": [], "postconditionResults": save_post,
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
    # Weights sum to 1.0. The delivery check carries real weight so a refuted
    # run cannot report score 1.0 (it did, when that check weighed 0.0).
    if sc.report_clause_b:
        w_persisted, w_report, w_delivery = 0.4, 0.4, 0.2
    else:
        w_persisted, w_report, w_delivery = 0.7, 0.0, 0.3
    checks = [check(f"{sc.slug}:persisted-set-matches", persisted == expected,
                    f"persisted {persisted}, expected {expected}", w_persisted)]
    if sc.report_clause_b:
        checks.append(grade_report_clause_b(sc, agent_report, w_report))

    # Informational, not a check: it can never fail, so it must not look like
    # one. It stays in the evidence as a zero-weight observation.
    checks.append(check(f"{sc.slug}:create-cost-observed", True,
                        f"create took {create_seconds:.2f}s", 0.0))

    # Action outcomes are not evidence of the *outcome*, but a run whose actions
    # all failed did not perform the task, and must not be graded `pass` just
    # because the store already held the expected set (a stale store from a
    # prior run, or an app that pre-seeds it). This is the false-success shape
    # the harness exists to prevent, so a failed delivery is a failing check.
    #
    # `delivered_unverified` is NOT a failure: the global route reports it by
    # design because there is nothing to read back at that layer, and the
    # persisted store is what decides. Only an explicit `failed` counts.
    failed_actions = [p for p in all_postconditions if p["passed"] is False]
    checks.append(check(
        f"{sc.slug}:actions-delivered",
        not failed_actions,
        "all actions delivered" if not failed_actions
        else f"{len(failed_actions)} action(s) did not land: "
             + "; ".join(f"{p['predicateName']}={p['observed']}" for p in failed_actions[:3]),
        w_delivery,
    ))

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


# Widget targets are never hardcoded. `sanity-entry` belongs to the runtime's GTK
# sanity window, not to myco-todo; every target is resolved from the observed
# a11y tree, and a missing target is a diagnosed REQ-04 gap.
def find_ref_by_role(obs: dict[str, Any], roles: tuple[str, ...],
                     name: str | None = None) -> str | None:
    """First node in the a11y tree whose role matches, optionally by name."""
    def walk(node: Any) -> str | None:
        if isinstance(node, dict):
            role = str(node.get("role") or "").lower()
            if (any(r in role for r in roles)
                    and (name is None or node.get("name") == name)
                    and node.get("ref")):
                return str(node["ref"])
            for v in node.values():
                found = walk(v)
                if found:
                    return found
        elif isinstance(node, list):
            for v in node:
                found = walk(v)
                if found:
                    return found
        return None
    return walk(obs.get("a11y_tree") or {})



def introspection_record(obs: dict[str, Any]) -> dict[str, Any] | None:
    """The app-published widget record, or None when absent/unavailable.

    ADR-0016 tri-state: null (channel unset) | record | {"unavailable": reason}.
    The global route needs this for click geometry, so it is live again after
    being removed as dead code when only the ref route existed.
    """
    rec = (obs.get("a11y_tree") or {}).get("introspection")
    if isinstance(rec, dict) and "unavailable" not in rec:
        return rec
    return None


def observe_until_introspection(mcp: McpClient, sid: str, tries: int = 20,
                                delay: float = 0.25) -> dict[str, Any]:
    """Poll observe() until the introspection record appears, or the budget ends.

    Returns the last observation rather than raising: the caller decides gap vs
    proceed from the record, so the failure mode stays explicit.
    """
    last: dict[str, Any] = {}
    for _ in range(tries):
        try:
            last = mcp.call_tool("observe", {"session_id": sid})
        except McpError:
            return last
        if introspection_record(last) is not None:
            return last
        time.sleep(delay)
    return last


def introspection_unavailable(obs: dict[str, Any]) -> str | None:
    """The channel's failure reason, when it exists but could not be read."""
    rec = (obs.get("a11y_tree") or {}).get("introspection")
    if isinstance(rec, dict) and "unavailable" in rec:
        return str(rec["unavailable"])
    return None



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


DELIVERED_KINDS = ("delivered_verified", "delivered_unverified")


def predicate(name: str, response: Any) -> dict[str, Any]:
    """Did this action land? An ALLOWLIST over ADR-0003's outcome kinds.

    `delivered_verified` and `delivered_unverified` both landed; everything else
    did not. The allowlist matters: a denylist (`kind != "failed"`) treats a
    missing outcome, an empty `{}`, or any future kind as delivered, so a
    transport gap would grade as success. Verified: `{}` and an unknown kind
    both fail this predicate.

    `delivered_unverified` is not a failure — the global route reports it by
    design because there is nothing to read back at that layer, and the
    persisted store decides the run. Collapsing it to False would fail every
    honest global-route run.

    `PredicateResult.passed` is boolean-only (M1-012), so the exact kind is
    preserved verbatim in `observed` rather than being coerced away.
    """
    outcome = response.get("outcome") if isinstance(response, dict) else None
    kind = outcome.get("kind") if isinstance(outcome, dict) else None
    return {"predicateName": name, "passed": kind in DELIVERED_KINDS,
            "observed": json.dumps(response, sort_keys=True)}


def act(mcp: McpClient, sid: str, action: dict[str, Any]) -> dict[str, Any]:
    """Perform one action and return the server's full response.

    A `failed` outcome is a real result (the action did not land), not an
    exception: the caller records it as a failing postcondition.
    """
    # Return the whole response, not just `outcome`: a response with no
    # `outcome` key must be distinguishable in the evidence from one whose
    # outcome is an empty object. Collapsing both to `{}` made a transport gap
    # look like an empty outcome.
    return mcp.call_tool("act", {"session_id": sid, "action": action})


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
        # A step's `action` is the logical intent; `dispatched` holds the wire
        # actions that carried it out. Recording the wire form is what lets a
        # reader tell a ref-targeted run from a global-input one — they are
        # indistinguishable from the intent alone and fail in different ways.
        for action in (st.get("dispatched") or [st["action"]]):
            out.append({"type": "action", "timestamp": started_at, "step": st["step"],
                        "action": action})
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


def ledger_detail(sc: Scenario, res: RunResult) -> str:
    """One-line ledger detail, including the failing check's reason.

    The ledger is the artifact most consumers read; a bare `missing=REQ-04`
    cannot distinguish "the app exposes no accessibility tree" from "the
    introspection channel is broken". The first failing check's reason carries
    that discriminator, so it goes in the detail.
    """
    base = f"{sc.sid} bucket={res.bucket} missing={res.missing_req}"
    failing = next((c for c in res.checks if c["passed"] is not True), None)
    if failing is None:
        return base
    reason = " ".join(str(failing["reason"]).split())
    return f"{base} | {failing['name']}: {reason[:200]}"


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
        "detail": ledger_detail(sc, res),
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


TOTAL_CHECKS = 8


def create_accepts_introspection(timeout: float = 15.0) -> tuple[bool, str]:
    """Ask the MCP server whether `create` declares `introspection_file`.

    Read-only: `tools/list` only. No session is created. Returns (ok, detail).

    The failure this catches is silent — the runner sends a key the server does
    not know, `create` ignores it, and the run gaps on REQ-03 after a guest has
    already been booted. Checking the declaration costs one handshake.
    """
    try:
        client = McpClient([str(DEFAULT_SERVER)])
    except Exception as e:  # noqa: BLE001 - a spawn failure (permissions, a
        # partially-written binary) must be a recorded FAIL, not a traceback.
        return False, f"could not start the server: {type(e).__name__}: {e}"

    try:
        client.request("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "df005-preflight", "version": "0.2.0"},
        })
        listed = client.request("tools/list")
    except McpError as e:
        return False, f"could not read the server's tool list: {e}"
    except Exception as e:  # noqa: BLE001 - a banner or a decode error must not
        # crash preflight; it is still a "the server did not answer usefully".
        return False, f"the server did not answer usefully: {type(e).__name__}: {e}"
    finally:
        client.close()

    for tool in listed.get("tools", []):
        if tool.get("name") != "create":
            continue
        props = (tool.get("inputSchema") or {}).get("properties") or {}
        if "introspection_file" in props:
            return True, "create declares introspection_file, so route 1 is honoured"
        return False, (
            "create does not declare introspection_file (has: "
            f"{', '.join(sorted(props)) or 'nothing'}). The runner sends it anyway, "
            "and the server will ignore it — the record will never reach observe. "
            "Rebuild with: cargo build -p myco-rt-mcp (a stale binary predating "
            "TIF-120 reports the same)."
        )
    return False, "the server exposes no `create` tool"


def preflight() -> int:
    """Read-only readiness check, run inside an approved guest window.

    Every check here is something that, if wrong, wastes the slot: a missing
    server binary, an unreachable guest, an undeployed or stale app, a dead
    introspection channel, or a held lock. Nothing is mutated — no create, no
    launch, no reset — so this is safe to run first and cheap to repeat.

    Exit 0 when every check passes, 1 otherwise. Prints one line per check.
    """
    results: list[tuple[str, bool, str]] = []

    def record(name: str, ok: bool | None, detail: str) -> None:
        results.append((name, ok, detail))
        mark = "ok  " if ok is True else ("skip" if ok is None else "FAIL")
        print(f"  {mark} {name}: {detail}")

    print("DF-005 preflight (read-only; no session is created)")

    # 1. Server binary.
    if DEFAULT_SERVER.exists() and os.access(DEFAULT_SERVER, os.X_OK):
        record("mcp-server", True, str(DEFAULT_SERVER))
    else:
        record("mcp-server", False,
               f"missing or not executable: {DEFAULT_SERVER} "
               "(cargo build -p myco-rt-mcp)")

    # 2. VM lock free.
    lock_path = Path(VM_LOCK_PATH)
    lock_free = True
    holder = ""
    if lock_path.exists():
        try:
            fd = os.open(str(lock_path), os.O_RDWR)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)
        except (BlockingIOError, OSError):
            lock_free = False
            holder = lock_path.read_text(encoding="utf-8").strip()[:80]
    record("vm-lock", lock_free,
           "free" if lock_free else f"held by {holder or 'another driver'}")

    # 3. Guest reachable, and it is the expected platform.
    key = GUEST_DIR / "keys" / "id_ed25519"
    ssh_base = [
        "ssh", "-i", str(key), "-p", "10022",
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
        "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null", "myco@localhost",
    ]

    def guest(cmd: str, timeout: int = 15) -> tuple[int, str]:
        try:
            r = subprocess.run([*ssh_base, cmd], capture_output=True, text=True,
                               timeout=timeout)
            return r.returncode, (r.stdout or r.stderr).strip()
        except Exception as e:  # noqa: BLE001
            return 1, str(e)

    # (e) Never probe the guest while another driver holds the lock. The checks
    # are read-only, but they add load to someone else's live slot, so report
    # them as not-run and let the operator see why they are missing.
    # 8. Does `create` actually accept the argument we send? A key-name drift
    # (introspection vs introspection_file) passes every guest-side probe and
    # then burns the slot at REQ-03. Ask the server's own schema rather than
    # trusting a write.
    #
    # Deliberately before the held-lock return: this check needs neither the
    # lock nor the guest, and omitting it while printing "of 8" is the very
    # count-without-measuring defect this file exists to prevent.
    if DEFAULT_SERVER.exists() and os.access(DEFAULT_SERVER, os.X_OK):
        accepted, detail = create_accepts_introspection()
        record("create-schema", accepted, detail)
    elif not DEFAULT_SERVER.exists():
        record("create-schema", None, "not run: the MCP server binary is missing")
    else:
        # exists but is not executable — the same condition check 1 fails on.
        record("create-schema", False,
               f"{DEFAULT_SERVER} is not executable, so its schema cannot be read")

    if not lock_free:
        for name in ("guest-ssh", "app-deployed", "app-self-test",
                     "introspection-file", "introspection-shadow"):
            record(name, None, "not run: another driver holds the VM lock")
        print()
        print(f"preflight FAILED: 1 of {TOTAL_CHECKS} checks failed: vm-lock")
        print("  not run (blocked by the above): guest-ssh, app-deployed, "
              "app-self-test, introspection-file, introspection-shadow")
        print("Fix these before spending the guest slot.")
        return 1

    rc, out = guest("uname -sm")
    record("guest-ssh", rc == 0 and "Linux" in out, out[:80] or "no answer")

    if rc == 0:
        # 4. App deployed and current.
        rc2, deployed = guest(f"sha256sum {APP_PATH} 2>/dev/null | cut -d' ' -f1")
        local_app = REPO / "dogfood" / "apps" / "myco-todo" / "myco_todo.py"
        local_sha = ""
        if local_app.exists():
            import hashlib
            local_sha = hashlib.sha256(local_app.read_bytes()).hexdigest()
        if rc2 != 0 or not deployed:
            record("app-deployed", False,
                   f"{APP_PATH} not found (scripts/deploy-verify-myco-todo.sh --go)")
        elif local_sha and deployed != local_sha:
            record("app-deployed", False,
                   f"stale: guest {deployed[:12]} != repo {local_sha[:12]}")
        else:
            record("app-deployed", True, deployed[:12])

        # 5. App self-test (headless; proves the fixture runs in this guest).
        rc3, st = guest(f"python3 {APP_PATH} --self-test 2>&1 | tail -1")
        record("app-self-test", rc3 == 0 and "self-test OK" in st, st[:80])

        # 6. The exact file is usable, not merely its directory: a stale
        # root-owned or read-only file at this path defeats the channel while a
        # directory probe still passes.
        rc4, probe = guest(
            f"p={shlex.quote(INTROSPECTION_PATH)}; d=$(dirname \"$p\"); "
            "if [ -d \"$p\" ]; then echo not-a-file; "
            "elif [ -e \"$p\" ] && [ ! -w \"$p\" ]; then echo not-writable-file; "
            "elif [ ! -d \"$d\" ] || [ ! -w \"$d\" ]; then echo not-writable-dir; "
            "else echo writable; fi"
        )
        file_state = (probe or "").strip()
        file_ok = rc4 == 0 and file_state == "writable"
        record("introspection-file", file_ok,
               f"{INTROSPECTION_PATH} is writable in the guest" if file_ok else
               f"{INTROSPECTION_PATH}: {file_state or 'probe failed'}. The app cannot "
               "publish there, so observe will report introspection null (REQ-03)")

        # 7. gui.env must not shadow route 1. The runtime's rule is "an explicit
        # value wins", so a MYCO_TODO_STATE_FILE in gui.env makes the app publish
        # somewhere other than the path `create` names — the record then never
        # reaches observe, silently.
        rc5, shadow = guest("printenv MYCO_TODO_STATE_FILE 2>/dev/null || true")
        shadow_value = (shadow or "").strip()
        # The launched app inherits the agent's whole environment, so any channel
        # that sets this (gui.env, /etc/environment, sshd env, a unit's
        # Environment=) makes the runtime's "explicit value wins" rule drop
        # route 1. Probing the effective variable subsumes all of them. A value
        # equal to our own path is not a shadow.
        shadowed = bool(shadow_value) and shadow_value != INTROSPECTION_PATH
        record("introspection-shadow", not shadowed,
               f"MYCO_TODO_STATE_FILE={shadow_value[:60]!r} in the agent's environment "
               f"overrides the path create names ({INTROSPECTION_PATH}) — the app "
               "would publish elsewhere and observe would see nothing"
               if shadowed else
               f"the agent's environment has no MYCO_TODO_STATE_FILE competing "
               f"with {INTROSPECTION_PATH} (equality is a proxy: it does not "
               "prove the app writes there)")
    else:
        # No guest to ask: record the dependent checks as not-run rather than
        # omitting them, so the summary never claims a count it did not measure.
        for name in ("app-deployed", "app-self-test", "introspection-file",
                     "introspection-shadow"):
            record(name, None, "not run: guest unreachable")

    failed = [n for n, ok, _ in results if ok is False]
    skipped = [n for n, ok, _ in results if ok is None]
    print()
    if failed:
        print(f"preflight FAILED: {len(failed)} of {TOTAL_CHECKS} checks failed: "
              f"{', '.join(failed)}")
        if skipped:
            print(f"  not run (blocked by the above): {', '.join(skipped)}")
        print("Fix these before spending the guest slot.")
        return 1
    if skipped:
        # Never report a partial run as a pass.
        print(f"preflight INCOMPLETE: {len(skipped)} of {TOTAL_CHECKS} checks not run: "
              f"{', '.join(skipped)}")
        return 1
    print(f"preflight OK: {len(results)}/{TOTAL_CHECKS} checks passed")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Dogfood DF-005 scenario runner")
    p.add_argument("--scenario", choices=SCENARIO_ORDER + ["all"], default="all")
    p.add_argument("--runs", type=int, default=3, help="runs per scenario")
    p.add_argument("--go", action="store_true", help="authorise real guest execution")
    p.add_argument("--server-cmd", help="MCP server command (default: built myco-rt-mcp)")
    p.add_argument("--eval-id", default=f"df-phase1-{int(time.time())}")
    p.add_argument("--output-dir", default=str(REPO / "runs"))
    p.add_argument("--agent-report", help="agent transcript for verifier-graded clause (b)")
    p.add_argument("--preflight", action="store_true",
                   help="read-only readiness check; creates no session, mutates nothing")
    args = p.parse_args()

    if args.preflight:
        return preflight()

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