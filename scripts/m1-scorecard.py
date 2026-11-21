#!/usr/bin/env python3
"""M1 scorecard, reliability row: computed from a sweep's trials.jsonl, never hand-tallied.

  m1-scorecard.py TRIALS_JSONL [--json]

Counting rules (acceptance row 3 needs >= 27/30 verified):
  - Denominator = every index 0-29 the sweep was meant to run. An index with no record counts
    as NOT RUN, and the sweep is reported incomplete; a missing record never shrinks the
    denominator.
  - Only status "verified" counts as a pass. refuted / uncertain are verdicts that failed.
    harness-error, reset-failed, deploy-failed, token-failed, param-error and seed-mismatch
    produced no trustworthy verdict and are also not passes; they are listed separately so a
    reader can see how much is infrastructure.
  - A record carrying no fixture hash is flagged: it predates the seed check (PR #53) and cannot
    count toward a single-fixture-proof claim.
The numeric threshold is a count only. The operator must confirm a completed sweep
and a passing seed check before using it as acceptance evidence.
"""

import json
import math
import sys
from collections import Counter
from pathlib import Path

TARGET_N, TARGET_PASS = 30, 27
VERDICTS = ("verified", "refuted", "uncertain")
NON_VERDICTS = (
    "harness-error", "reset-failed", "deploy-failed", "token-failed",
    "param-error", "seed-mismatch",
)


def wilson(k, n, z=1.96):
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def score(path):
    recs = {}
    with Path(path).open(encoding="utf-8") as records:
        for line_number, line in enumerate(records, 1):
            if not line.strip():
                continue
            record = json.loads(line)
            if not isinstance(record, dict):
                raise ValueError(f"line {line_number}: expected a trial record")
            index = record.get("index")
            if type(index) is not int or not 0 <= index < TARGET_N:
                raise ValueError(f"line {line_number}: invalid trial index {index!r}")
            if index in recs:
                raise ValueError(f"line {line_number}: duplicate trial index {index}")
            if record.get("status") not in VERDICTS + NON_VERDICTS:
                raise ValueError(f"line {line_number}: invalid status {record.get('status')!r}")
            recs[index] = record
    status = Counter(recs[i].get("status") for i in recs)
    verified = status.get("verified", 0)
    missing = [i for i in range(TARGET_N) if i not in recs]
    no_hash = sorted(i for i, r in recs.items() if not r.get("fixtureSha256"))
    interval = wilson(verified, len(recs))
    failures = [
        {"index": i, "status": r.get("status"), "seed": r.get("fixtureSeed"), "reason": (r.get("reason") or "")[:160]}
        for i, r in sorted(recs.items())
        if r.get("status") != "verified"
    ]
    return {
        "denominator": TARGET_N,
        "recorded": len(recs),
        "notRun": missing,
        "complete": not missing,
        "verified": verified,
        "byStatus": dict(sorted(status.items(), key=lambda kv: str(kv[0]))),
        "nonVerdict": sum(v for k, v in status.items() if k not in VERDICTS),
        "meetsThreshold": not missing and verified >= TARGET_PASS,
        "stillReachable": verified + len(missing) >= TARGET_PASS,
        "wilson95": [round(bound, 3) for bound in interval] if interval else None,
        "seeds": dict(Counter(r.get("fixtureSeed") for r in recs.values() if r.get("status") == "verified")),
        "columns": dict(Counter(r.get("column") for r in recs.values() if r.get("status") == "verified")),
        "recordsWithoutFixtureHash": no_hash,
        "failures": failures,
    }


def markdown(s):
    if not s["complete"]:
        reachability = "reachable" if s["stillReachable"] else "unreachable"
        verdict = f"INCOMPLETE (threshold {reachability})"
    else:
        verdict = "MEETS NUMERIC THRESHOLD" if s["meetsThreshold"] else "FAILS ≥27/30"
    interval = s["wilson95"]
    out = [
        f"**Reliability: {s['verified']}/{s['denominator']} verified, {verdict}.**",
        (
            f"Wilson 95% interval over {s['recorded']} recorded trials: "
            f"{interval[0]:.2f}–{interval[1]:.2f}."
            if interval else "Wilson 95% interval unavailable with zero recorded trials."
        ),
        "",
        "| Status | Count |",
        "|---|---|",
        *[f"| {k} | {v} |" for k, v in s["byStatus"].items()],
        f"| not run | {len(s['notRun'])} |",
        "",
        f"Verified by seed: {s['seeds']}. Verified by column: {s['columns']}.",
    ]
    if s["recordsWithoutFixtureHash"]:
        out.append(f"Records without a fixture hash (pre-seed-check): {s['recordsWithoutFixtureHash']}.")
    if s["failures"]:
        out += ["", "| Index | Seed | Status | Reason |", "|---|---|---|---|"]
        out += [f"| {f['index']} | {f['seed']} | {f['status']} | {f['reason']} |" for f in s["failures"]]
    return "\n".join(out)


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--json"):
        sys.exit("usage: m1-scorecard.py TRIALS_JSONL [--json]")
    try:
        result = score(sys.argv[1])
    except (OSError, ValueError) as error:
        sys.exit(f"m1-scorecard: {error}")
    print(json.dumps(result, indent=2) if "--json" in sys.argv else markdown(result))
