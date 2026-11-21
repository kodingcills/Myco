#!/usr/bin/env python3
"""Host-only JSONL recorder and acceptance summary for M1-014."""

import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

CLASSES = ("kill", "invalid-target", "dropped-save", "focus-change")
VERDICTS = ("verified", "refuted", "uncertain")
GROUPS = [(mode, False) for mode in CLASSES] + [("kill", True), ("invalid-target", True)]
RECORD_FIELDS = ("index", "class", "recovery", "fixtureSeed", "rowKey", "column", "expectedValue")


def load_plan(path):
    plan = json.loads(Path(path).read_text())
    if (
        any(type(p["recovery"]) is not bool for p in plan)
        or Counter((p["class"], p["recovery"]) for p in plan) != Counter(dict.fromkeys(GROUPS, 3))
        or [p["index"] for p in plan] != list(range(len(plan)))
        or len({p["fixtureSeed"] for p in plan}) != len(plan)
        or len({p["fixtureSha256"] for p in plan}) != len(plan)
    ):
        raise ValueError("expected three indexed trials per class and recovery group, with distinct seeds and hashes")
    return plan


def load_records(path):
    log = Path(path)
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()] if log.exists() else []


def trace_recovery_events(row, out_dir):
    """Read the run trace, bound to the recorded run ID and fault class."""
    run_id = row.get("runId")
    if not isinstance(run_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]+", run_id):
        return []
    path = out_dir / "runs" / str(row["index"]) / run_id / "trace.jsonl"
    try:
        events = load_records(path)
        if not events or events[0].get("type") != "run-start" or events[0].get("runId") != run_id:
            return []
        fault_seen = False
        recovery = []
        for event in events:
            if event.get("type") == "fault-injection" and event.get("fault") == row["class"]:
                fault_seen = True
            if fault_seen and event.get("type") == "recovery" and isinstance(event.get("event"), str):
                name = event["event"]
                if name.startswith(("retry:", "relaunch:", "re-observe:")):
                    recovery.append(name)
        return recovery
    except (OSError, ValueError, AttributeError):
        return []


def score(row):
    if row.get("verdict") != "verified":
        return False, False
    persisted = row.get("persistedValue")
    recovered = row["recovery"] and any(
        event == "relaunch:completed" or re.fullmatch(r"retry:\d+-completed", event)
        for event in row.get("recoveryEvents", [])
    )
    wrong_disk_value = isinstance(persisted, str) and persisted != row["expectedValue"]
    false_success = wrong_disk_value or not recovered
    unproven = not false_success and (persisted != row["expectedValue"] or row.get("faultApplied") is not True)
    return false_success, unproven


def record(trial, status, out_path, out_dir):
    row = {key: trial[key] for key in RECORD_FIELDS}
    row.update(status=status, verdict=None, persistedValue=None, falseSuccess=False, reason=status)
    if status != "report":
        return row

    try:
        report = json.loads(Path(out_path).read_text())
        if not isinstance(report, dict):
            raise ValueError("expected a report object")
    except (OSError, ValueError) as error:
        row.update(status="harness-error", reason=str(error)[:200])
        return row

    verdict = report.get("verdict")
    fixture = report.get("fixture")
    audit = report.get("corruption")
    verdict = verdict if isinstance(verdict, dict) else {}
    fixture = fixture if isinstance(fixture, dict) else {}
    audit = audit if isinstance(audit, dict) else {}
    reasons = verdict.get("reasons")
    actions = audit.get("actionKinds")
    persisted = audit.get("persistedValue")
    guard = report.get("guardFailure")
    row.update(
        runId=report.get("runId"),
        verdict=verdict.get("status"),
        reason=" | ".join(reason for reason in reasons if isinstance(reason, str)) if isinstance(reasons, list) else "",
        fixtureSha256=fixture.get("csvSha256"),
        elapsedMs=report.get("elapsedMs"),
        guardPredicate=guard.get("predicateName") if isinstance(guard, dict) else None,
        persistedValue=persisted if isinstance(persisted, str) else None,
        persistedReadError=audit.get("persistedReadError"),
        actionKinds=[action for action in actions if isinstance(action, str) and action] if isinstance(actions, list) else [],
        faultApplied=audit.get("mode") == trial["class"] and audit.get("applied") is True,
    )
    row["recoveryEvents"] = trace_recovery_events(row, out_dir)
    row["falseSuccess"], row["unprovenVerified"] = score(row)
    if fixture.get("seed") != trial["fixtureSeed"] or fixture.get("csvSha256") != trial["fixtureSha256"]:
        row.update(
            status="seed-mismatch",
            reason=f"reported seed/hash {fixture.get('seed')!r}/{fixture.get('csvSha256')!r} "
                   f"!= expected {trial['fixtureSeed']!r}/{trial['fixtureSha256']!r}",
        )
    elif row["verdict"] not in VERDICTS:
        row.update(status="harness-error", reason="report has no recognized verdict")
    elif audit.get("recovery") is not trial["recovery"]:
        row.update(status="harness-error", reason="entrypoint recovery flag does not match the manifest")
    elif not row["faultApplied"]:
        row.update(status="fault-not-applied", reason=f"fault did not land: {row['reason']}")
    else:
        row["status"] = row["verdict"]
    return row


def pending(plan, rows):
    if any(r["status"] == "seed-mismatch" for r in rows):
        print("REFUSED_SEED_MISMATCH_PRESENT: start with a fresh output directory", file=sys.stderr)
        return 9
    seen = {r["index"] for r in rows}
    if len(seen) != len(rows) or not seen <= {p["index"] for p in plan}:
        raise ValueError("duplicate or unexpected index in trial log")
    for p in plan:
        if p["index"] not in seen:
            print(*(p[k] for k in ("index", "class", "fixtureSeed", "rowKey", "column", "newValue", "recovery")), sep="\t")
    return 0


def ledger_rows(eval_id, row, false_success, unproven, eligible):
    verdict = row.get("verdict")
    guard = row.get("guardPredicate")
    if false_success:
        state = "failure"
        persisted = row.get("persistedValue")
        oracle = "ground-truth:false" if isinstance(persisted, str) and persisted != row["expectedValue"] else "recovery:missing-proof"
    elif unproven:
        state, oracle = "failure", "recovery:unproven"
    elif not eligible:
        state = "gap"
        oracle = (
            "recovery:no-attempt-evidence"
            if row["recovery"] and row["status"] in VERDICTS and not row["recoveryEvents"]
            else f"driver:{row['status']}"
        )
    elif verdict == "verified":
        state, oracle = "pass", "verifier:verified+ground-truth+recovery"
    elif verdict == "refuted" and guard:
        state, oracle = "refusal", "verifier:refuted"
    elif verdict == "refuted":
        state, oracle = "failure", "verifier:refuted"
    else:
        state, oracle = "uncertain", "verifier:uncertain"
    for action in dict.fromkeys(row.get("actionKinds") or ["none"]):
        yield {
            "evalId": eval_id,
            "runId": row.get("runId") or f"unstarted-{row['index']}",
            "trialIndex": row["index"],
            "corruptionClass": row["class"],
            "actionKind": action,
            "state": state,
            "oracle": oracle,
            "refusalCode": f"guard:{guard}" if state == "refusal" else None,
            "detail": f"recovery={str(row['recovery']).lower()} | {row['reason']}",
        }


def final(plan, rows, out_dir):
    ledger_path = out_dir / "ledger.jsonl"
    counts = {group: Counter() for group in GROUPS}
    recovery_results = []
    expected = {p["index"]: p for p in plan}
    seen = set()
    problems = []
    ledger = []
    false_successes = unproven_verified = 0
    for row in rows:
        index = row.get("index")
        trial = expected.get(index)
        if trial is None or index in seen:
            problems.append(f"duplicate or unexpected trial index {index}")
            continue
        seen.add(index)
        if any(row.get(k) != trial[k] for k in RECORD_FIELDS):
            problems.append(f"trial {index}: record does not match suite manifest")
            continue
        mode_counts = counts[(trial["class"], trial["recovery"])]
        row["recoveryEvents"] = trace_recovery_events(row, out_dir)
        if trial["recovery"]:
            recovery_results.append(row)
        mode_counts["recorded"] += 1
        false_success, unproven = score(row)
        false_successes += false_success
        unproven_verified += unproven
        mode_counts["falseSuccesses"] += false_success
        fixture_matches = row.get("status") != "seed-mismatch" and row.get("fixtureSha256") == trial["fixtureSha256"]
        eligible = (
            fixture_matches
            and row.get("status") in VERDICTS
            and row["status"] == row.get("verdict")
            and row.get("faultApplied") is True
            and (not trial["recovery"] or bool(row["recoveryEvents"]))
        )
        if not fixture_matches:
            problems.append(f"trial {index}: missing or mismatched fixture hash")
        if eligible:
            mode_counts[row["verdict"]] += 1
        row.update(falseSuccess=false_success, unprovenVerified=unproven, countsTowardCoverage=eligible)
        ledger.extend(ledger_rows(ledger_path.parent.name or "m1-014", row, false_success, unproven, eligible))

    ledger_path.write_text("".join(json.dumps(row) + "\n" for row in ledger))

    script = Path(__file__).resolve().with_name("m1-corrupt-suite-ledger.ts")
    audit = subprocess.run(
        ["node", "--import", "tsx", str(script), str(ledger_path.resolve())],
        cwd=script.parent.parent, check=True, text=True, stdout=subprocess.PIPE,
    )
    accounting = json.loads(audit.stdout)
    if accounting["unaccounted"] != 0:
        problems.append("conformance ledger has unaccounted rows")

    print("class           recovery  recorded  verified   refuted uncertain  falseSuccesses")
    totals = Counter()
    for (mode, recovery), count in counts.items():
        totals.update(count)
        label = "yes" if recovery else "no"
        print(f"{mode:15} {label:8} " + " ".join(
            f"{count[k]:9}" for k in ("recorded", *VERDICTS, "falseSuccesses")
        ))
        if sum(count[k] for k in VERDICTS) < 3:
            problems.append(f"{mode} (recovery={label}): fewer than 3 eligible verdicts")
    with_verdict = sum(totals[k] for k in VERDICTS)
    if with_verdict < 10:
        problems.append("fewer than 10 trials with a verdict")
    passed = not (problems or false_successes or unproven_verified)
    summary = {
        "total": len(rows),
        "withVerdict": with_verdict,
        **{k: totals[k] for k in VERDICTS},
        "falseSuccesses": false_successes,
        "unprovenVerified": unproven_verified,
        "recoveryResults": recovery_results,
        "ledger": accounting,
        "passed": passed,
        "problems": problems,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))
    print("OpenAdapt published baselines: 54/72 bad saves reported saved from a visual cue; "
          "30/30 from a computer-use agent. Those counts came from a different setup "
          "(docs/architecture/m1.md, ADR-0005).")
    return 0 if passed else 1


if __name__ == "__main__":
    command, plan_path, *args = sys.argv[1:]
    plan = load_plan(plan_path)
    if command == "--pending":
        sys.exit(pending(plan, load_records(args[0])))
    if command == "--final":
        log = Path(args[0])
        sys.exit(final(plan, load_records(log), log.parent))
    if command == "--record":
        index, status, *paths = args
        print(json.dumps(record(plan[int(index)], status, paths[0] if paths else None, Path(plan_path).parent)))
    else:
        sys.exit(f"unknown command: {command}")
