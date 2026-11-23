#!/usr/bin/env python3
"""df005-runner offline contract tests (VM-free).

These tests exist to prove the runner CANNOT manufacture a pass. The shipped
runner scored DF-S01 `pass / verified+ground-truth` with no guest behind it
(2026-11-22); every case below guards a branch of that failure.

  * a stub claiming every action `delivered_verified`, with no guest, is `gap`
    and exits non-zero;
  * a store that cannot be read back is `uncertain`, never `failure`;
  * a store that parses but is wrong is `failure` with `verifier:refuted`;
  * a correct store is `success` only when the report check also passes;
  * DF-S02 clause (b) is `null` (could not look) without a transcript, fails a
    wrong-cause report, passes a correct one;
  * scenarios needing an unexposed op (DF-S03/DF-S04) are gaps attributed to
    that requirement.

Run: python3 test/df005-runner-offline.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "scripts" / "df005-runner.py"

# Import the runner's own scoring rule rather than restating it in the test:
# a test that re-expresses the rule it guards cannot detect a change to it.
import importlib.util as _ilu  # noqa: E402

_spec = _ilu.spec_from_file_location("df005_runner", RUNNER)
df005 = _ilu.module_from_spec(_spec)
# Register before exec: dataclass processing looks the module up in sys.modules.
sys.modules["df005_runner"] = df005
_spec.loader.exec_module(df005)  # type: ignore[union-attr]
check_score = df005.check_score
FAILS: list[str] = []

STUB_TEMPLATE = r'''#!/usr/bin/env python3
import json, os, sys
def text(o, err=False):
    return {"content": [{"type": "text", "text": json.dumps(o)}], "isError": err}
for line in sys.stdin:
    r = json.loads(line); m = r.get("method"); i = r.get("id")
    if i is None:
        continue
    if m == "initialize":
        res = {"protocolVersion": "2024-11-05"}
    elif m == "tools/list":
        res = {"tools": [{"name": n} for n in
                ("create", "observe", "act", "evidence", "reset", "destroy")]}
    else:
        n, a = r["params"]["name"], r["params"]["arguments"]
        if n == "observe":
            tree = ({"nodes": [
                {"name": "myco-todo", "ref": "w1", "role": "frame", "children": [
                    {"name": "", "ref": "e1", "role": "entry"},
                    {"name": "Save", "ref": "b1", "role": "push-button"},
                ]},
            ]} if os.environ.get("STUB_A11Y") == "1" else {"nodes": []})
            if os.environ.get("STUB_GEOMETRY") == "1":
                tree["introspection"] = {
                    "listbox_rows": [], "entry_text": "", "status_text": "",
                    "entry_field": {"x": 200, "y": 40, "width": 300, "height": 24},
                    "save_button": {"x": 200, "y": 320, "width": 60, "height": 24},
                }
            res = text({"ok": True, "state_version": 1, "screenshot": "/x.png",
                        "a11y_tree": tree})
        elif n == "act":
            kind = a.get("action", {}).get("kind")
            mode = os.environ.get("STUB_ACT_MODE", "unverified")
            if kind == "launch":
                res = text({"ok": True, "outcome": {"kind": "delivered_verified"}})
            elif mode == "empty":
                res = text({"ok": True})                      # no outcome at all
            elif mode == "unknown":
                res = text({"ok": True, "outcome": {"kind": "weird_new_kind"}})
            elif mode == "failed":
                res = text({"ok": True, "outcome": {"kind": "failed", "reason": "synthetic"}})
            else:
                res = text({"ok": True, "outcome": {"kind": "delivered_unverified"}})
        elif n == "create":
            res = text({"ok": True, "session_id": a.get("session_id", "s")})
        else:
            res = text({"ok": True})
    print(json.dumps({"jsonrpc": "2.0", "id": i, "result": res}), flush=True)
'''


def expect(cond: bool, what: str) -> None:
    print(f"  {'ok  ' if cond else 'FAIL'} {what}")
    if not cond:
        FAILS.append(what)


def fake_guest_store(items: list[str]) -> str:
    """A readback stub that prints the store the *test* wants the guest to hold."""
    return f'''#!/usr/bin/env python3
import json, os, sys
print(json.dumps({{"items": [{{"text": t}} for t in {json.dumps(items)}]}}))
'''


def unreadable_store() -> str:
    return "#!/usr/bin/env python3\nimport sys\nsys.exit(1)\n"


class Harness:
    """A stub MCP server plus an optional scripted guest readback."""

    def __init__(self, store_items: list[str] | None = None, unreadable: bool = False,
                 a11y: bool = True, geometry: bool = False):
        self.dir = Path(tempfile.mkdtemp(prefix="df005-t-"))
        self.stub = self.dir / "stub.py"
        self.stub.write_text(STUB_TEMPLATE)
        # Grading is only reachable once the driver can resolve an entry and a
        # Save ref; `a11y=False` models an app that exposes no AT-SPI nodes.
        self.env: dict[str, str] = {"STUB_A11Y": "1"} if a11y else {}
        if geometry:
            self.env["STUB_GEOMETRY"] = "1"
        if unreadable:
            rb = self.dir / "readback.py"
            rb.write_text(unreadable_store())
            self.env.update({"MYCO_DF005_ASSUME_GUEST": "1",
                             "MYCO_DF005_READBACK_CMD": f"{sys.executable} {rb}"})
        elif store_items is not None:
            rb = self.dir / "readback.py"
            rb.write_text(fake_guest_store(store_items))
            self.env.update({"MYCO_DF005_ASSUME_GUEST": "1",
                             "MYCO_DF005_READBACK_CMD": f"{sys.executable} {rb}"})

    def run(self, *, scenario: str = "all", agent_report: str | None = None) -> tuple[int, Path]:
        out = Path(tempfile.mkdtemp(prefix="df005-out-"))
        cmd = [sys.executable, str(RUNNER), "--scenario", scenario, "--runs", "1",
               "--server-cmd", f"{sys.executable} {self.stub}",
               "--eval-id", "e", "--output-dir", str(out)]
        if agent_report:
            cmd += ["--agent-report", agent_report]
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT,
                              env={**os.environ, **self.env})
        return proc.returncode, out / "e"


def ledger(d: Path) -> dict[str, dict]:
    rows = [json.loads(x) for x in (d / "ledger.jsonl").read_text().splitlines() if x]
    return {r["runId"]: r for r in rows}


def checks_of(d: Path, run_id: str) -> dict[str, dict]:
    res = json.loads((d / run_id / "result.json").read_text())
    return {c["name"].split(":")[-1]: c for c in res["verdict"]["checks"]}


VALIDATE_JS = r"""
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { traceEventSchema } from "./schemas/trace-events.ts";
import { resultRecordSchema } from "./schemas/result-record.ts";
import { ledgerRowSchema } from "./schemas/ledger-row.ts";
import { validateSchema } from "./schemas/validate.ts";
const d = process.argv[1]; let bad = [];
for (const row of readFileSync(join(d, "ledger.jsonl"), "utf8").trim().split("\n")) {
  const i = validateSchema(JSON.parse(row), ledgerRowSchema);
  if (i.length) bad.push("ledger: " + JSON.stringify(i));
}
for (const e of readdirSync(d)) {
  const rp = join(d, e, "result.json");
  if (existsSync(rp)) {
    const i = validateSchema(JSON.parse(readFileSync(rp, "utf8")), resultRecordSchema);
    if (i.length) bad.push("result " + e + ": " + JSON.stringify(i));
  }
  const tp = join(d, e, "trace.jsonl");
  if (existsSync(tp)) for (const l of readFileSync(tp, "utf8").trim().split("\n")) {
    const i = validateSchema(JSON.parse(l), traceEventSchema);
    if (i.length) bad.push("trace " + e + ": " + JSON.stringify(i));
  }
}
if (bad.length) { console.log(bad.join("; ")); process.exit(1); }
"""


def validate_artifacts(d: Path) -> str:
    """Empty string when every artifact validates, else the validator's output."""
    proc = subprocess.run(
        ["node", "--experimental-strip-types", "-e", VALIDATE_JS, str(d)],
        capture_output=True, text=True, cwd=ROOT,
    )
    return "" if proc.returncode == 0 else (proc.stdout + proc.stderr).strip()


def report_text(body: str) -> str:
    f = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
    f.write(body)
    f.close()
    return f.name


# The declared weight split per scenario. Add a scenario here when it gains a
# weight set, so test 20 fails on a missing declaration instead of guessing.
EXPECTED_WEIGHT_SPLIT: dict[str, dict[str, float]] = {
    "DF-S01": {"persisted-set-matches": 0.7, "create-cost-observed": 0.0,
               "actions-delivered": 0.3},
    "DF-S02": {"persisted-set-matches": 0.4, "agent-report-names-missing": 0.4,
               "create-cost-observed": 0.0, "actions-delivered": 0.2},
}


def main() -> int:
    print("1. stub that lies about delivery, with no guest behind it")
    code, d = Harness().run()
    rows = ledger(d)
    expect(code == 1, "exit is 1 — nothing graded success")
    expect(all(r["state"] != "pass" for r in rows.values()), "no ledger row is `pass`")
    expect(rows["run-df-s01-1"]["state"] == "gap", "DF-S01 offline is `gap` (shipped as `pass`)")
    expect(rows["run-df-s01-1"]["oracle"] == "verifier:uncertain", "oracle is uncertain, not verified")
    expect("REQ-11" in rows["run-df-s03-1"]["detail"], "DF-S03 gap attributed to REQ-11")
    expect("REQ-09" in rows["run-df-s04-1"]["detail"], "DF-S04 gap attributed to REQ-09")

    print("2. guest store unreadable → uncertain, never failure")
    code, d = Harness(unreadable=True).run(scenario="DF-S01")
    expect(ledger(d)["run-df-s01-1"]["state"] == "uncertain", "ledger state `uncertain`")
    c = checks_of(d, "run-df-s01-1")["persisted-set-matches"]
    expect(c["passed"] is None, "check passed is null (could not look)")
    _res = json.loads((d / "run-df-s01-1" / "result.json").read_text())
    expect(_res["verdict"]["score"] == 0.0,
           f"an uncertain run scores 0.0, not a failed-check value: {_res['verdict']['score']}")
    expect("could not look" in c["reason"], f"reason says could not look: {c['reason']}")

    print("3. guest store correct → success")
    code, d = Harness(store_items=["buy milk", "call mom", "write report"]).run(scenario="DF-S01")
    expect(code == 0, "exit 0 when the oracle passes")
    expect(ledger(d)["run-df-s01-1"]["state"] == "pass", "ledger state `pass`")
    expect(ledger(d)["run-df-s01-1"]["oracle"] == "verifier:verified+ground-truth", "oracle verified")

    print("4. guest store wrong after a completed run → failure, not verified")
    code, d = Harness(store_items=["buy milk"]).run(scenario="DF-S01")
    expect(ledger(d)["run-df-s01-1"]["state"] == "failure", "ledger state `failure`")
    expect(ledger(d)["run-df-s01-1"]["oracle"] == "verifier:refuted", "oracle refuted")
    expect(ledger(d)["run-df-s01-1"]["oracle"] != "ground-truth:false",
           "not recorded as a false success (the harness refused, the agent never claimed)")

    print("5. DF-S02: correct store without a transcript → uncertain")
    code, d = Harness(store_items=["fix login page", "update docs"]).run(scenario="DF-S02")
    cb = checks_of(d, "run-df-s02-1")["agent-report-names-missing"]
    expect(cb["passed"] is None, "clause (b) is null — could not look")
    expect(ledger(d)["run-df-s02-1"]["state"] == "uncertain", "verdict uncertain, cannot be success")

    print("6. DF-S02: correct store + wrong-cause report → failure")
    wrong = report_text("Two items were lost. Probably a permissions problem on /tmp.")
    code, d = Harness(store_items=["fix login page", "update docs"]).run(
        scenario="DF-S02", agent_report=wrong)
    cb = checks_of(d, "run-df-s02-1")["agent-report-names-missing"]
    expect(cb["passed"] is False, f"wrong cause fails clause (b): {cb['reason']}")
    os.unlink(wrong)

    print("7. DF-S02: correct store + correct report → success")
    right = report_text(
        "Two items did not persist. The save path drops any item whose text starts "
        "with the BUG prefix, so 'BUG: crash on save' and 'Bugfix release notes' vanished.")
    code, d = Harness(store_items=["fix login page", "update docs"]).run(
        scenario="DF-S02", agent_report=right)
    cb = checks_of(d, "run-df-s02-1")["agent-report-names-missing"]
    expect(cb["passed"] is True, f"correct report passes: {cb['reason']}")
    expect(ledger(d)["run-df-s02-1"]["state"] == "pass", "run is `pass`")
    os.unlink(right)

    print("8. DF-S02: report names only one dropped item → fails clause (b)")
    partial = report_text("'BUG: crash on save' was dropped by a starts-with filter at save.")
    code, d = Harness(store_items=["fix login page", "update docs"]).run(
        scenario="DF-S02", agent_report=partial)
    cb = checks_of(d, "run-df-s02-1")["agent-report-names-missing"]
    expect(cb["passed"] is False, f"one missing item fails: {cb['reason']}")
    os.unlink(partial)

    print("9. no AT-SPI refs and no geometry → REQ-03 gap, never pass")
    code, d = Harness(store_items=["buy milk", "call mom", "write report"], a11y=False).run(
        scenario="DF-S01")
    row = ledger(d)["run-df-s01-1"]
    expect(row["state"] == "gap", f"gap, not pass (got {row['state']})")
    expect("REQ-03" in row["detail"], f"attributed to REQ-03: {row['detail']}")
    expect(code == 1, "exit non-zero")

    print("9b. no AT-SPI refs but geometry present → global route, graded from the store")
    code, d = Harness(store_items=["buy milk", "call mom", "write report"],
                      a11y=False, geometry=True).run(scenario="DF-S01")
    row = ledger(d)["run-df-s01-1"]
    expect(row["state"] == "pass", f"graded pass from the store (got {row['state']})")
    expect(code == 0, "exit 0")
    kinds = [json.loads(l)["action"]["kind"]
             for l in (d / "run-df-s01-1" / "trace.jsonl").read_text().splitlines()
             if json.loads(l)["type"] == "action"]
    expect("typeTextGlobal" in kinds, f"typed with no target: {kinds}")
    expect("clickAt" in kinds, f"focused by coordinate: {kinds}")
    expect("typeText" not in kinds, "never used the ref-targeted form")

    print("9c. global route with a wrong store → failure, not pass")
    code, d = Harness(store_items=["buy milk"], a11y=False, geometry=True).run(
        scenario="DF-S01")
    row = ledger(d)["run-df-s01-1"]
    expect(row["state"] == "failure", f"failure (got {row['state']})")
    expect(row["oracle"] == "verifier:refuted", f"refuted: {row['oracle']}")

    print("10. artifacts from a graded run validate against M1-012")
    code, d = Harness(store_items=["buy milk", "call mom", "write report"]).run(scenario="DF-S01")
    v = validate_artifacts(d)
    expect(v == "", f"schema validation: {v or 'valid'}")

    print("11. non-object JSON store → uncertain, evidence still written")
    for body in ("[1, 2, 3]", '"a string"', "42", "true", "null"):
        rb = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False)
        rb.write(f"#!/usr/bin/env python3\nprint({body!r})\n")
        rb.close()
        env = {"MYCO_DF005_ASSUME_GUEST": "1",
               "MYCO_DF005_READBACK_CMD": f"{sys.executable} {rb.name}"}
        h = Harness()
        h.env.update(env)      # keep STUB_A11Y so the run reaches grading
        code, d = h.run(scenario="DF-S01")
        state = ledger(d)["run-df-s01-1"]["state"]
        c = checks_of(d, "run-df-s01-1")["persisted-set-matches"]
        expect(state == "uncertain", f"{body}: uncertain, not a crash (got {state})")
        expect(c["passed"] is None, f"{body}: passed is null")
        expect((d / "run-df-s01-1" / "trace.jsonl").exists(), f"{body}: trace written")
        os.unlink(rb.name)

    print("12. mutation: each no-guest gate is independently load-bearing")
    src = RUNNER.read_text()
    offline_gate = "if offline and not assume_guest:"
    live_gate = "if not assume_guest and not probe.guest_alive:"
    expect(offline_gate in src, "offline gate present")
    expect(live_gate in src, "live-guest gate present")
    # Behavioural probe, not a source assertion: disable one gate, run, restore.
    for label, gate in (("offline gate", offline_gate), ("live-guest gate", live_gate)):
        mutated = src.replace(gate, "if False:", 1)
        RUNNER.write_text(mutated)
        try:
            code, d = Harness().run(scenario="DF-S01")
            state = ledger(d)["run-df-s01-1"]["state"]
            reason = checks_of(d, "run-df-s01-1").get("runtime-capability", {}).get("reason", "")
        finally:
            RUNNER.write_text(src)
        # With either gate gone the run must still not be `pass`; the other gate
        # or the readback must refuse it.
        expect(state != "pass", f"{label} removed: still not `pass` (got {state})")
        expect(state in ("gap", "uncertain", "failure"),
               f"{label} removed: lands in a non-success bucket ({state}: {reason[:60]})")

    print("13. both gates removed: the readback channel is the third guard")
    mutated = src.replace(offline_gate, "if False:", 1).replace(live_gate, "if False:", 1)
    RUNNER.write_text(mutated)
    try:
        code, d = Harness().run(scenario="DF-S01")
        state = ledger(d)["run-df-s01-1"]["state"]
        reason = checks_of(d, "run-df-s01-1")["persisted-set-matches"]["reason"]
    finally:
        RUNNER.write_text(src)
    # With no gate left, the real ssh readback still fails and the run is
    # `uncertain` (could not look) — never `pass`. Three layers, not one.
    expect(state == "uncertain", f"no gates + dead ssh → uncertain (got {state})")
    expect(state != "pass", "and definitively not `pass`")
    expect("could not look" in reason, f"reason is a could-not-look: {reason[:70]}")

    print("14. preflight is read-only and fails closed")
    out = Path(tempfile.mkdtemp(prefix="df005-pf-"))
    proc = subprocess.run(
        [sys.executable, str(RUNNER), "--preflight"],
        capture_output=True, text=True, cwd=ROOT,
        env={**os.environ, "MYCO_VM_LOCK_PATH": str(out / "free.lock")},
    )
    expect(proc.returncode == 1, "exit 1 when the server binary is missing")
    expect("mcp-server" in proc.stdout, "names the missing server")
    expect("no session is created" in proc.stdout, "states it is read-only")
    expect(not (out / "free.lock").exists() or (out / "free.lock").stat().st_size == 0,
           "does not write a lock it does not hold")

    print("15. preflight reports a held lock without contending for it")
    held = out / "held.lock"
    holder = subprocess.Popen(
        [sys.executable, "-c",
         "import fcntl,time,sys;"
         f"fd=open({str(held)!r},'w');"
         "fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);"
         "fd.write('99999 test-holder');fd.flush();time.sleep(5)"],
    )
    time.sleep(0.4)
    try:
        proc = subprocess.run(
            [sys.executable, str(RUNNER), "--preflight"],
            capture_output=True, text=True, cwd=ROOT,
            env={**os.environ, "MYCO_VM_LOCK_PATH": str(held)},
        )
        expect("test-holder" in proc.stdout, f"names the holder: {proc.stdout.strip()[-120:]}")
        expect(proc.returncode == 1, "exit 1 while the lock is held")
    finally:
        holder.kill()
        holder.wait()

    print("16. preflight accounts for all six checks when the guest is unreachable")
    out2 = Path(tempfile.mkdtemp(prefix="df005-pf2-"))
    proc = subprocess.run(
        [sys.executable, str(RUNNER), "--preflight"],
        capture_output=True, text=True, cwd=ROOT,
        env={**os.environ, "MYCO_VM_LOCK_PATH": str(out2 / "free.lock")},
    )
    # Off-guest, ssh fails; the three dependent checks must still be reported as
    # not-run rather than silently omitted, so the "N of 6" count is honest.
    for name in ("app-deployed", "app-self-test", "introspection-env"):
        expect(f"skip {name}: not run: guest unreachable" in proc.stdout,
               f"{name} reported as not-run, not omitted")
    expect("of 6 checks failed" in proc.stdout, "count is stated against 6")
    expect(proc.returncode == 1, "exit 1")

    print("17. no delivery outcome can pass on a matching store (M1 allowlist)")
    for mode in ("failed", "empty", "unknown"):
        h = Harness(store_items=["buy milk", "call mom", "write report"],
                    a11y=False, geometry=True)
        h.env["STUB_ACT_MODE"] = mode
        code, d = h.run(scenario="DF-S01")
        row = ledger(d)["run-df-s01-1"]
        expect(row["state"] == "failure", f"{mode}: failure, not pass (got {row['state']})")
        expect(code == 1, f"{mode}: exit non-zero")
        c = checks_of(d, "run-df-s01-1").get("actions-delivered")
        expect(c is not None and c["passed"] is False, f"{mode}: actions-delivered fails")
        res = json.loads((d / "run-df-s01-1" / "result.json").read_text())
        expect(res["verdict"]["score"] < 1.0,
               f"{mode}: refuted run does not score 1.0 (got {res['verdict']['score']})")

    print("18. delivered_unverified is not a failure (global route must still pass)")
    code, d = Harness(store_items=["buy milk", "call mom", "write report"],
                      a11y=False, geometry=True).run(scenario="DF-S01")
    row = ledger(d)["run-df-s01-1"]
    expect(row["state"] == "pass", f"pass (got {row['state']})")
    c = checks_of(d, "run-df-s01-1").get("actions-delivered")
    expect(c is not None and c["passed"] is True, f"actions-delivered passes: {c}")

    print("19. result.json step action reports the wire form (N1)")
    res = json.loads((d / "run-df-s01-1" / "result.json").read_text())
    kinds = [st["action"]["kind"] for st in res["steps"]]
    expect("typeTextGlobal" in kinds, f"global route visible in steps: {kinds}")
    expect("typeText" not in kinds, "no ref-form summary on the global route")

    print("20. check weights sum to 1.0 for both weight sets")
    # Round 3 found DF-S02 summing to 1.1 because the report check hardcoded
    # 0.5 while the caller assumed 0.4. Assert the invariant, not the numbers.
    for label, kwargs, scenario in (
        ("DF-S01 (no report clause)", {}, "DF-S01"),
        ("DF-S02 (report clause)", {"agent_report": report_text(
            "Both 'BUG: crash on save' and 'Bugfix release notes' were dropped by a "
            "starts-with prefix filter at save time.")}, "DF-S02"),
    ):
        code, d = Harness(store_items=["fix login page", "update docs"],
                          a11y=False, geometry=True).run(scenario=scenario, **kwargs)
        res = json.loads((d / f"run-{scenario.lower()}-1" / "result.json").read_text())
        weights = {c["name"].split(":")[-1]: c["partial_score"]["weight"]
                   for c in res["verdict"]["checks"]}
        total = sum(weights.values())
        expect(abs(total - 1.0) < 1e-9, f"{label}: weights sum to {total}")
        # The sum alone is not enough: swapping two weights keeps it at 1.0
        # while changing what a partial run scores. Pin the split.
        # Keyed lookup, not an if/else with a default: a third weight set must
        # fail loudly here rather than silently inherit DF-S01's split.
        expected_split = EXPECTED_WEIGHT_SPLIT.get(scenario)
        expect(expected_split is not None,
               f"{label}: a weight split is declared for {scenario}")
        expect(weights == expected_split, f"{label}: split is {weights}")
        if scenario == "DF-S02":
            expect(res["verdict"]["score"] == 1.0,
                   f"a fully correct DF-S02 scores 1.0 (got {res['verdict']['score']})")

    print("21. a missing outcome is distinguishable from an empty one in evidence")
    h = Harness(store_items=["buy milk", "call mom", "write report"],
                a11y=False, geometry=True)
    h.env["STUB_ACT_MODE"] = "empty"
    code, d = h.run(scenario="DF-S01")
    res = json.loads((d / "run-df-s01-1" / "result.json").read_text())
    observed = [p["observed"] for st in res["steps"] for p in st["postconditionResults"]]
    # The gap case: the server answered, but with no `outcome` key. The evidence
    # must show that, not a bare `{}` that reads like an empty outcome.
    expect(any(o == '{"ok": true}' for o in observed),
           f"a response with no outcome is recorded verbatim: {observed[:3]}")
    expect(not any(o == "{}" for o in observed),
           "no postcondition collapses the envelope to {}")

    print("21b. every scenario with a weight set has a declared split")
    # Scenarios that are gaps (S03/S04) or declare no weights (S05) are not in
    # the table. If one later gains weights, this fails until it is declared.
    weighted = {sid for sid, sc in df005.SCENARIOS.items()
                if not sc.needs_ops and sid not in ("DF-S03", "DF-S04", "DF-S05")}
    expect(set(EXPECTED_WEIGHT_SPLIT) == weighted,
           f"declared splits match the weighted scenarios: "
           f"{sorted(EXPECTED_WEIGHT_SPLIT)} vs {sorted(weighted)}")

    print("22. scores are rounded and the rule's literals hold")
    h = Harness(store_items=["fix login page"], a11y=False, geometry=True)
    code, d = h.run(scenario="DF-S02", agent_report=report_text(
        "Both 'BUG: crash on save' and 'Bugfix release notes' were dropped by a "
        "starts-with prefix filter at save time."))
    res = json.loads((d / "run-df-s02-1" / "result.json").read_text())
    score = res["verdict"]["score"]
    expect(score == round(score, 10), f"score is not float noise: {score!r}")
    # Assert the LITERAL rule, not the function against itself. Comparing
    # `published == check_score(passed)` is tautological when both sides call the
    # same function, so it pins nothing about the rule's value.
    for c in res["verdict"]["checks"]:
        want = {True: 1.0, False: 0.0, None: 0.0}[c["passed"]]
        expect(c["partial_score"]["score"] == want,
               f"{c['name']}: passed={c['passed']!r} -> score {c['partial_score']['score']} "
               f"(want {want})")
    recomputed = round(sum(c["partial_score"]["weight"] *
                           {True: 1.0, False: 0.0, None: 0.0}[c["passed"]]
                           for c in res["verdict"]["checks"]), 10)
    expect(score == recomputed, f"published {score} == recomputed {recomputed}")

    print("23. create names the introspection path (TIF-120 route 1)")
    # The runtime sets MYCO_TODO_STATE_FILE to this path for apps it launches,
    # so the app publishes exactly where observe reads. Without it the channel
    # is off and the global route has no geometry.
    seen = {}
    stub = Path(tempfile.mkdtemp(prefix="df005-intro-")) / "stub.py"
    stub.write_text(STUB_TEMPLATE.replace(
        'elif n == "create":',
        'elif n == "create":\n            open(os.environ["STUB_CREATE_LOG"], "a").write(json.dumps(a) + "\\n")',
    ))
    log = Path(tempfile.mkdtemp(prefix="df005-intro-log-")) / "create.jsonl"
    h = Harness(store_items=["buy milk", "call mom", "write report"], a11y=False, geometry=True)
    h.stub = stub
    h.env["STUB_CREATE_LOG"] = str(log)
    code, d = h.run(scenario="DF-S01")
    args = json.loads(log.read_text().splitlines()[0])
    expect(args.get("introspection_file") == "/tmp/myco-todo-state.json",
           f"create passes introspection_file: {args.get('introspection_file')!r}")
    expect(args.get("introspection_file", "").startswith("/"),
           "the path is absolute, as the runtime requires")

    print(f"\n{'FAILED' if FAILS else 'PASSED'}: {len(FAILS)} failure(s)")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())