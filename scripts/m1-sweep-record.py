#!/usr/bin/env python3
"""M1-013 sweep: turn one run-live report into a JSONL record, with the seed check.

  m1-sweep-record.py IDX SEED ROWKEY COLUMN VALUE TRIAL_OUT FINGERPRINTS  -> one JSON line
  m1-sweep-record.py --final TRIALS_JSONL FINGERPRINTS                    -> exit 0/1

Per trial: the report's `fixture.seed` must equal the requested seed and its
`fixture.csvSha256` must equal FINGERPRINTS[seed]. If not, status becomes
"seed-mismatch" (the sweep aborts on it). A report that cannot be parsed stays
"harness-error": there is no fixture identity to check.

Final: any "seed-mismatch" record fails the sweep outright (it can survive a
resume with a matching hash, so the mapping check alone cannot catch it).
Every record carrying a fixture hash must map seeds to hashes one to
one, and every seed in FINGERPRINTS must appear (as many distinct hashes as
sweep seeds).
"""

import json
import sys


def record(argv):
    idx, seed, rk, cl, nv, out_path, fp_path = argv
    expected = json.load(open(fp_path)).get(seed)
    rec = {"index": int(idx), "fixtureSeed": seed, "rowKey": rk, "column": cl, "typed": nv}
    try:
        d = json.load(open(out_path))
        if not isinstance(d, dict):
            raise ValueError(f"report is {type(d).__name__}, not an object")
    except Exception as e:  # noqa: BLE001 - any unreadable report is a harness error
        rec.update(status="harness-error", reason=str(e)[:200])
        return rec
    verdict = d.get("verdict") or {}
    fx = d.get("fixture") or {}
    rec.update(
        runId=d.get("runId"),
        status=verdict.get("status"),
        reason=(verdict.get("reasons") or [""])[0],
        completed=d.get("completed"),
        elapsedMs=d.get("elapsedMs"),
        fixtureSha256=fx.get("csvSha256"),
        fixtureRows=fx.get("dataRows"),
    )
    conv = d.get("fixtureConvert")
    if isinstance(conv, dict):
        rec.update(
            convertMs=conv.get("durationMs"),
            convertDeadlineMs=conv.get("deadlineMs"),
            convertOutcome=conv.get("outcome"),
        )
    problems = []
    if expected is None:
        problems.append(f"no expected fingerprint for seed {seed!r}")
    if fx.get("seed") != seed:
        problems.append(f"report fixture seed {fx.get('seed')!r} != requested {seed!r}")
    if fx.get("csvSha256") != expected:
        problems.append(f"fixture sha {fx.get('csvSha256')!r} != expected {expected!r}")
    if problems:
        rec["trialStatus"] = rec["status"]
        rec["status"] = "seed-mismatch"
        rec["reason"] = "; ".join(problems)
    return rec


def final(log_path, fp_path):
    expected = json.load(open(fp_path))
    seed_to_hash, hash_to_seed, bad = {}, {}, []
    for line in open(log_path):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        if r.get("status") == "seed-mismatch":
            bad.append(f"index {r.get('index')}: recorded seed-mismatch disqualifies this sweep")
        h, s = r.get("fixtureSha256"), r.get("fixtureSeed")
        if not h:
            continue
        if expected.get(s) != h:
            bad.append(f"index {r.get('index')}: hash does not match seed {s!r}")
        if seed_to_hash.setdefault(s, h) != h:
            bad.append(f"seed {s!r} seen with two hashes")
        if hash_to_seed.setdefault(h, s) != s:
            bad.append(f"hash {h[:12]} seen for seeds {hash_to_seed[h]!r} and {s!r}")
    missing = sorted(set(expected) - set(seed_to_hash))
    if missing:
        bad.append(f"no hash-bearing trial for seeds {missing}")
    print(
        "SEED_CHECK "
        + json.dumps(
            {"distinctSeeds": len(seed_to_hash), "distinctHashes": len(hash_to_seed), "problems": bad}
        )
    )
    return 0 if not bad and len(seed_to_hash) == len(hash_to_seed) == len(expected) else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["--final"]:
        sys.exit(final(sys.argv[2], sys.argv[3]))
    print(json.dumps(record(sys.argv[1:])))
