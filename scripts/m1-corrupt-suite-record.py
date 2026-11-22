#!/usr/bin/env python3
"""Host-only JSONL recorder and acceptance summary for M1-014."""

import argparse
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


def load_plan(path, *, allow_supplement=False):
    plan = json.loads(Path(path).read_text())
    groups = Counter((p["class"], p["recovery"]) for p in plan)
    full_suite = groups == Counter(dict.fromkeys(GROUPS, 3))
    supplement = (
        allow_supplement and groups and groups.keys() <= set(GROUPS)
        and all(p["fixtureSeed"].startswith("m1-014s-") for p in plan)
    )
    if (
        any(type(p["recovery"]) is not bool for p in plan)
        or not (full_suite or supplement)
        or [p["index"] for p in plan] != list(range(len(plan)))
        or len({p["fixtureSeed"] for p in plan}) != len(plan)
        or len({p["fixtureSha256"] for p in plan}) != len(plan)
    ):
        raise ValueError("expected a valid suite layout with indexed trials and distinct seeds and hashes")
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
    verified = row.get("verdict") == "verified"
    persisted = row.get("persistedValue")
    readable = isinstance(persisted, str)
    matches = readable and persisted == row["expectedValue"]
    recovered = any(
        event == "relaunch:completed" or re.fullmatch(r"retry:\d+-completed", event)
        for event in row.get("recoveryEvents", [])
    )
    return {
        "falseSuccess": verified and readable and not matches,
        "unprovenVerified": verified and not readable,
        "unprovenRecovery": verified and matches and row["recovery"] and row.get("faultApplied") is True and not recovered,
    }


def reclassification_reason(row):
    if row["falseSuccess"]:
        return "verified disk value differs from host ground truth"
    if row["unprovenVerified"]:
        return "verified disk value is unreadable"
    if row["unprovenRecovery"]:
        return "verified disk value matches, but recovery completion lacks trace evidence"
    if row.get("verdict") != "verified":
        return "verdict is not verified"
    if row.get("faultApplied") is not True:
        return "verified disk value matches and fault did not land"
    return "verified disk value matches host ground truth"


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
        timings=report.get("timings"),
        guardPredicate=guard.get("predicateName") if isinstance(guard, dict) else None,
        persistedValue=persisted if isinstance(persisted, str) else None,
        persistedReadError=audit.get("persistedReadError"),
        actionKinds=[action for action in actions if isinstance(action, str) and action] if isinstance(actions, list) else [],
        faultApplied=audit.get("mode") == trial["class"] and audit.get("applied") is True,
    )
    row["recoveryEvents"] = trace_recovery_events(row, out_dir)
    row.update(score(row))
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


def ledger_rows(eval_id, row):
    verdict = row.get("verdict")
    guard = row.get("guardPredicate")
    if row["falseSuccess"]:
        state, oracle = "failure", "ground-truth:false"
    elif row["unprovenVerified"]:
        state, oracle = "failure", "ground-truth:unreadable"
    elif row["unprovenRecovery"]:
        state, oracle = "gap", "recovery:missing-proof"
    elif not row["countsTowardCoverage"]:
        state = "gap"
        oracle = (
            "recovery:no-attempt-evidence"
            if row["recovery"] and row["status"] in VERDICTS and not row["recoveryEvents"]
            else f"driver:{row['status']}"
        )
    elif verdict == "verified":
        state = "pass"
        oracle = "verifier:verified+ground-truth" + ("+recovery" if row["recovery"] else "")
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


def audit_batch(plan, rows, source, counts, problems, *, allow_missing_reports):
    expected = {p["index"]: p for p in plan}
    seen = set()
    for stored in rows:
        row = dict(stored)
        index = row.get("index")
        trial = expected.get(index)
        if trial is None or index in seen:
            problems.append(f"{source}: duplicate or unexpected trial index {index}")
            continue
        seen.add(index)
        if any(row.get(k) != trial[k] for k in RECORD_FIELDS):
            problems.append(f"{source}: trial {index}: record does not match suite manifest")
            continue
        mode_counts = counts[(trial["class"], trial["recovery"])]
        row["recoveryEvents"] = trace_recovery_events(row, source)
        row.update(score(row))
        if "falseSuccess" in stored and stored["falseSuccess"] != row["falseSuccess"]:
            before, after = json.dumps(stored["falseSuccess"]), json.dumps(row["falseSuccess"])
            print(f"RECLASSIFIED index {index}: stored {before} → recomputed {after} ({reclassification_reason(row)}) [{source}]")
        mode_counts["recorded"] += 1
        mode_counts["falseSuccesses"] += row["falseSuccess"]
        mode_counts["unprovenVerified"] += row["unprovenVerified"]
        mode_counts["unprovenRecovery"] += row["unprovenRecovery"]
        fixture_matches = row.get("status") != "seed-mismatch" and row.get("fixtureSha256") == trial["fixtureSha256"]
        eligible = (
            fixture_matches
            and row.get("status") in VERDICTS
            and row["status"] == row.get("verdict")
            and row.get("faultApplied") is True
            and (not trial["recovery"] or bool(row["recoveryEvents"]))
            and not row["unprovenRecovery"]
        )
        no_report = (
            row.get("status") in ("reset-failed", "deploy-failed", "token-failed", "harness-error")
            and row.get("verdict") is None
            and row.get("fixtureSha256") is None
        )
        if not fixture_matches and not (allow_missing_reports and no_report):
            problems.append(f"{source}: trial {index}: missing or mismatched fixture hash")
        if eligible:
            mode_counts[row["verdict"]] += 1
        row.update(
            storedFalseSuccess=stored.get("falseSuccess"),
            storedRecoveryEvents=stored.get("recoveryEvents"),
            countsTowardCoverage=eligible,
        )
        yield row


def final(batches, out_dir, *, combined=False, supplement=False):
    ledger_path = out_dir / "ledger.jsonl"
    counts = {group: Counter() for group in GROUPS}
    recovery_results = []
    unproven_recovery_results = []
    ineligible = []
    problems = []
    ledger = []
    total = 0
    for source, plan, rows in batches:
        total += len(rows)
        if supplement and len(rows) != len(plan):
            problems.append("supplemental batch has unrecorded trials")
        eval_id = str(source) if combined else out_dir.name or "m1-014"
        for row in audit_batch(plan, rows, source, counts, problems, allow_missing_reports=combined or supplement):
            if combined:
                row["sourceDir"] = str(source)
            if row["recovery"]:
                recovery_results.append(row)
            if row["unprovenRecovery"]:
                unproven_recovery_results.append(row)
            if not row["countsTowardCoverage"]:
                ineligible.append(row)
            ledger.extend(ledger_rows(eval_id, row))

    ledger_path.write_text("".join(json.dumps(row) + "\n" for row in ledger))

    script = Path(__file__).resolve().with_name("m1-corrupt-suite-ledger.ts")
    audit = subprocess.run(
        ["node", "--import", "tsx", str(script), str(ledger_path.resolve())],
        cwd=script.parent.parent, check=True, text=True, stdout=subprocess.PIPE,
    )
    accounting = json.loads(audit.stdout)
    if accounting["unaccounted"] != 0:
        problems.append("conformance ledger has unaccounted rows")

    print("class           recovery  recorded  eligible  verified   refuted uncertain  falseSuccesses  unprovenRecovery")
    totals = Counter()
    group_results = []
    for (mode, recovery), count in counts.items():
        totals.update(count)
        label = "yes" if recovery else "no"
        eligible = sum(count[k] for k in VERDICTS)
        group_results.append({
            "class": mode,
            "recovery": recovery,
            "eligible": eligible,
            **{k: count[k] for k in ("recorded", *VERDICTS, "falseSuccesses", "unprovenRecovery")},
        })
        print(f"{mode:15} {label:8} {count['recorded']:9} {eligible:9} " + " ".join(
            f"{count[k]:9}" for k in VERDICTS
        ) + f" {count['falseSuccesses']:15} {count['unprovenRecovery']:17}")
        if not supplement and eligible < 3:
            problems.append(f"{mode} (recovery={label}): fewer than 3 eligible verdicts")
    with_verdict = sum(totals[k] for k in VERDICTS)
    if not supplement and with_verdict < 10:
        problems.append("fewer than 10 trials with a verdict")
    passed = not (problems or totals["falseSuccesses"] or totals["unprovenVerified"])
    summary = {
        "total": total,
        "withVerdict": with_verdict,
        **{k: totals[k] for k in VERDICTS},
        "falseSuccesses": totals["falseSuccesses"],
        "unprovenVerified": totals["unprovenVerified"],
        "unprovenRecovery": totals["unprovenRecovery"],
        "unprovenRecoveryResults": unproven_recovery_results,
        "groups": group_results,
        "ineligible": ineligible,
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


def final_combined(argv):
    parser = argparse.ArgumentParser(prog=f"{Path(sys.argv[0]).name} --final-combined")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("directories", type=Path, nargs="+")
    args = parser.parse_args(argv)
    if len(args.directories) < 2:
        parser.error("at least two input directories are required")
    out = args.out.resolve()
    batches = []
    seeds = {}
    for directory in args.directories:
        source = directory.resolve()
        if out == source:
            raise ValueError("combined output must differ from the input directories")
        plan = load_plan(source / "params.json", allow_supplement=True)
        for trial in plan:
            seed = trial["fixtureSeed"]
            if seed in seeds:
                raise ValueError(f"duplicate fixture seed {seed!r} in {seeds[seed]} and {source}")
            seeds[seed] = source
        log = source / "trials.jsonl"
        if not log.is_file():
            raise ValueError(f"missing trial log: {log}")
        batches.append((source, plan, load_records(log)))
    out.mkdir(parents=True, exist_ok=True)
    return final(batches, out, combined=True)


def main(argv):
    command, *args = argv
    if command == "--final-combined":
        return final_combined(args)
    plan_path, *args = args
    plan = load_plan(plan_path, allow_supplement=command != "--final")
    if command == "--pending":
        return pending(plan, load_records(args[0]))
    if command in ("--final", "--final-supplement"):
        log = Path(args[0])
        return final([(log.parent, plan, load_records(log))], log.parent, supplement=command == "--final-supplement")
    if command == "--record":
        index, status, *paths = args
        print(json.dumps(record(plan[int(index)], status, paths[0] if paths else None, Path(plan_path).parent)))
        return 0
    raise ValueError(f"unknown command: {command}")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError) as error:
        sys.exit(str(error))
