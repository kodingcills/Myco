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
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "scripts" / "df005-runner.py"
FAILS: list[str] = []

STUB_TEMPLATE = r'''#!/usr/bin/env python3
import json, sys
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
            res = text({"ok": True, "state_version": 1, "screenshot": "/x.png",
                        "a11y_tree": {"nodes": [{"name": "sanity-entry", "ref": "r1"}]}})
        elif n == "act":
            res = text({"ok": True, "outcome": {"kind": "delivered_verified"}})
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
import json, sys
print(json.dumps({{"items": [{{"text": t}} for t in {json.dumps(items)}]}}))
'''


def unreadable_store() -> str:
    return "#!/usr/bin/env python3\nimport sys\nsys.exit(1)\n"


class Harness:
    """A stub MCP server plus an optional scripted guest readback."""

    def __init__(self, store_items: list[str] | None = None, unreadable: bool = False):
        self.dir = Path(tempfile.mkdtemp(prefix="df005-t-"))
        self.stub = self.dir / "stub.py"
        self.stub.write_text(STUB_TEMPLATE)
        self.env: dict[str, str] = {}
        if unreadable:
            rb = self.dir / "readback.py"
            rb.write_text(unreadable_store())
            self.env = {"MYCO_DF005_ASSUME_GUEST": "1",
                        "MYCO_DF005_READBACK_CMD": f"{sys.executable} {rb}"}
        elif store_items is not None:
            rb = self.dir / "readback.py"
            rb.write_text(fake_guest_store(store_items))
            self.env = {"MYCO_DF005_ASSUME_GUEST": "1",
                        "MYCO_DF005_READBACK_CMD": f"{sys.executable} {rb}"}

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

    print("9. artifacts from a graded run validate against M1-012")
    code, d = Harness(store_items=["buy milk", "call mom", "write report"]).run(scenario="DF-S01")
    v = validate_artifacts(d)
    expect(v == "", f"schema validation: {v or 'valid'}")

    print("10. mutation: removing the no-guest gate must fail this suite")
    src = RUNNER.read_text()
    gate = 'if offline and not assume_guest:'
    assert gate in src, "guest gate not found; update this mutation to the current shape"
    broken = src.replace(gate, "if False and not assume_guest:", 1)
    expect(broken != src, "mutation applied")
    RUNNER.write_text(broken)
    try:
        # With the offline gate disabled the guest probe is the only thing left,
        # and it must still refuse: a stub is not a guest.
        code, d = Harness().run(scenario="DF-S01")
        state = ledger(d)["run-df-s01-1"]["state"]
    finally:
        RUNNER.write_text(src)
    expect(state == "gap", f"guest probe alone still yields gap (got {state})")

    print(f"\n{'FAILED' if FAILS else 'PASSED'}: {len(FAILS)} failure(s)")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())