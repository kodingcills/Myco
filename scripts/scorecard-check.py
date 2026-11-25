#!/usr/bin/env python3
"""Recompute every number in docs/m1-scorecard.md from committed artifacts and diff it.

  scorecard-check.py [--doc PATH] [--inventory-md] [--no-subchecks]

Row 8 step 8 of the reproducibility test plan, as re-scoped by the lead (2026-11-25):
a script recomputes every number in the scorecard from committed artifacts and fails
on any mismatch. Prose byte-identity is not required; the numbers are.

How it works. Every claim is one of four kinds, and every kind is printed, so a reader
sees coverage rather than having to trust it:

  ok           the number was recomputed from a committed artifact and the doc quotes
               exactly that value at the named place (a row line, the row 7 slot table,
               or a named section);
  MISMATCH     the doc does not quote the recomputed value. The row, the expected
               phrase and what the doc says instead are printed. Exit 1;
  unchecked    the number cannot be recomputed from anything committed. The reason is
               printed. It is never silently dropped;
  skipped      the artifact pack the row cites is not in the tree (e.g. a pack whose PR
               has not merged). The reason is printed.

Recomputation reuses the existing tools rather than re-deriving them:
  - scripts/m1-scorecard.py         score() and wilson(): rows 1, 3, 8 and the slots;
  - scripts/row7-compare.py         compare --check: row 7's 11 figures, run in process
                                    against --doc; this script adds the rest of row 7;
  - scripts/m1-corrupt-suite-ledger.ts   the conformance-ledger audit (rows 4, 6, 8);
  - scripts/m1-corrupt-suite-record.py --final   re-run on a copy of the row 8
                                    corrupted pack, which must rebuild ledger.jsonl and
                                    summary.json byte-identical;
  - the committed schema-validation.log files: row 6 and row 8 sums.

Sub-checks run as part of it unless --no-subchecks: scripts/check-scorecard-links.py
(on --doc) and scripts/scorecard-viewer-links.py --check (on the repo's scorecard; it
has no path argument). Any sub-check failure also exits 1.

Needs python3 and, for the ledger audit and recorder, node with the repo's dev
dependencies installed (`pnpm install`).
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXP = ROOT / "docs/research/experiments"
V3 = EXP / "m1-013-sweep-v3"
AUDIT = EXP / "m1-014-combined-audit"
R6 = EXP / "c1-arm-003/r6/ledger-extract.json"
BUDGET_NOTE = EXP / "c1-arm-003d/ROW7-BUDGET-DECIDED.md"
SWEEP2 = EXP / "m1-row8-sweep2"
CORRUPT = EXP / "m1-row8-corrupt"
TOOLCHAIN = ROOT / "docs/env/vm-toolchain"
RUNS = EXP / "m1-runs"

WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine"}


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def word(n: int, cap: bool = False) -> str:
    w = WORDS.get(n, str(n))
    return w.capitalize() if cap else w


def jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def kib(directory: Path) -> str:
    return f"{sum(f.stat().st_size for f in directory.iterdir() if f.is_file()) / 1024:.1f}"


def schema_log(path: Path) -> tuple[int, int, int]:
    """(results, trace events, lines not ALL OK), summed over a validate-live log."""
    results = events = bad = 0
    for line in path.read_text().splitlines():
        m = re.match(r"validated (\d+) result\.json \+ (\d+) trace events in .*: (.*)$", line)
        if not m:
            if line.strip():
                bad += 1
            continue
        results += int(m.group(1))
        events += int(m.group(2))
        bad += m.group(3) != "ALL OK"
    return results, events, bad


def ledger_audit(path: Path) -> dict:
    out = subprocess.run(
        ["node", "--import", "tsx", "scripts/m1-corrupt-suite-ledger.ts", str(path)],
        cwd=ROOT, check=True, text=True, capture_output=True,
    )
    return json.loads(out.stdout)


class Report:
    def __init__(self, doc_text: str):
        self.text = doc_text
        self.rows: list[tuple[str, str, str, str]] = []  # (where, claim, status, detail)

    # -- where claims live -------------------------------------------------------------
    def segment(self, where: str) -> str:
        if where.isdigit():
            return next((l for l in self.text.splitlines() if l.startswith(f"| {where} |")), "")
        heading = {
            "slots": "## Row 7 slots",
            "durability": "## Evidence durability",
            "viewer": "## Open a trial in the viewer",
            "save-dialog": "### The C1 baseline's characteristic failure mode",
        }[where]
        start = self.text.find(heading)
        if start < 0:
            return ""
        end = self.text.find("\n## ", start + len(heading))
        nxt = self.text.find("\n### ", start + len(heading))
        ends = [e for e in (end, nxt) if e > 0]
        return self.text[start : min(ends) if ends else len(self.text)]

    # -- claim kinds -------------------------------------------------------------------
    def quote(self, where: str, claim: str, template: str, *values, source: str) -> None:
        """The doc at `where` must contain template.format(*values) verbatim."""
        expected = template.format(*values)
        seg = self.segment(where)
        if expected in seg:
            self.rows.append((where, claim, "ok", f"{expected!r} from {source}"))
            return
        pattern = r"(\S+?)".join(re.escape(part) for part in template.split("{}"))
        found = re.search(pattern, seg) if "{}" in template else None
        found_text = repr(found.group(0)) if found else "the phrase is not present"
        self.rows.append((where, claim, "MISMATCH", f"expected {expected!r} ({source}); found {found_text}"))

    def fact(self, where: str, claim: str, ok: bool, source: str, detail: str = "") -> None:
        """An artifact-side assertion the doc states in prose (e.g. 'every line ALL OK')."""
        status = "ok" if ok else "MISMATCH"
        self.rows.append((where, claim, status, f"{source}{': ' + detail if detail else ''}"))

    def unchecked(self, where: str, claim: str, why: str) -> None:
        self.rows.append((where, claim, "unchecked", why))

    def skipped(self, where: str, claim: str, why: str) -> None:
        self.rows.append((where, claim, "skipped", why))

    def mismatches(self) -> list[tuple[str, str, str, str]]:
        return [r for r in self.rows if r[1] and r[2] == "MISMATCH"]


def check_rows_1_to_3(r: Report, scorecard) -> dict:
    v3 = scorecard.score(V3 / "trials.jsonl")
    trials = {t["index"]: t for t in jsonl(V3 / "trials.jsonl")}
    refuted = [f["index"] for f in v3["failures"] if f["status"] == "refuted"]
    src = "m1-scorecard.score(m1-013-sweep-v3/trials.jsonl)"

    # Row 1
    r.quote("1", "tasks run", "ran all {} `calc-record-edit` tasks", v3["recorded"], source=src)
    r.quote("1", "verified / refuted", "({} verified, {} refuted by an infrastructure guard", v3["verified"], len(refuted), source=src)
    guard_ok = True
    for i in refuted:
        result = json.loads(next((RUNS / "m1-013" / f"trial-{i}").glob("result.json")).read_text())
        guard = result.get("guardFailure") or {}
        guard_ok &= guard.get("phase") == "precondition" and result.get("steps") == []
    r.fact("1", "the refute is a guard failure before any UI action", guard_ok and bool(refuted),
           f"m1-runs/m1-013/trial-{refuted}/result.json guardFailure.phase == precondition, steps == []")
    r.unchecked("1", "LibreOffice Calc 26.8.3, Windows 11 ARM64", "environment versions are not recorded in the committed sweep artifacts")

    # Row 2
    r.unchecked("2", "PR #11, log 21, PR #56", "references to review records and a run log, not counts derived from an artifact")

    # Row 3
    commit = (V3 / "COMMIT").read_text()
    r.fact("3", "`aa96974`", "aa96974" in commit and "`aa96974`" in r.segment("3"), "m1-013-sweep-v3/COMMIT names aa96974")
    r.quote("3", "verified and refuted", "recorded {} verified and {} refuted", v3["verified"], word(len(refuted)), source=src)
    params = json.loads((V3 / "params.json").read_text())
    matched = sum(
        1 for i, p in enumerate(params)
        if i in trials and (trials[i]["fixtureSeed"], trials[i]["rowKey"], trials[i]["column"], trials[i]["typed"])
        == (p["fixtureSeed"], p["rowKey"], p["column"], p["newValue"])
    )
    r.quote("3", "records matching params.json", "All {} records matched the pinned `params.json`", matched,
            source="trials.jsonl (seed, rowKey, column, typed) == params.json[index]")
    prints = json.loads((V3 / "fingerprints.json").read_text())
    hashes_ok = all(t.get("fixtureSha256") == prints.get(t["fixtureSeed"]) for t in trials.values())
    hashes = len({t["fixtureSha256"] for t in trials.values()}) if hashes_ok else -1
    r.quote("3", "fixture hashes matching fingerprints", "the {} fixture hashes matched the pinned fingerprints", word(hashes),
            source="distinct trials.jsonl fixtureSha256, each == fingerprints.json[seed]")
    r.quote("3", "pack size", "({} KiB actual", kib(V3), source="sum of file sizes in m1-013-sweep-v3/")
    listed = ("trials.jsonl", "params.json", "fingerprints.json", "ledger.jsonl", "final-scorecard.json", "schema-validation.log")
    missing = [f for f in listed if not (V3 / f).is_file()]
    r.fact("3", "the six listed files are present", not missing, "m1-013-sweep-v3/", f"missing {missing}" if missing else "")
    r.quote("3", "regenerated count", "regenerates **{}/{} verified**", v3["verified"], v3["denominator"], source=src)
    guards = set()
    for i in refuted:
        guards.add(json.loads((RUNS / "m1-013" / f"trial-{i}" / "result.json").read_text())["guardFailure"]["predicateName"])
    r.quote("3", "the refute's index and guard", "one refute (index {}) was a different guard (`{}`)",
            ",".join(map(str, refuted)), ",".join(sorted(guards)), source="trials.jsonl failures + trial result.json guardFailure.predicateName")
    r.unchecked("3", "TIF-216: 15 s vs the configured 60 s", "a code-behaviour note about run-live (fixed in #427), not a count from an artifact")
    return v3


def check_rows_4_to_6(r: Report) -> None:
    ledger = jsonl(AUDIT / "ledger.jsonl")
    summary = json.loads((AUDIT / "summary.json").read_text())
    runs: dict[tuple, dict] = {}
    for row in ledger:
        key = (row["evalId"], row["trialIndex"], row["runId"])
        m = re.match(r"recovery=(true|false)", row.get("detail") or "")
        run = runs.setdefault(key, {"class": row["corruptionClass"], "recovery": m and m.group(1) == "true", "oracles": set()})
        run["oracles"].add(row["oracle"])
    verdict = Counter()
    groups = Counter()
    for run in runs.values():
        oracle = next(iter(run["oracles"])) if len(run["oracles"]) == 1 else "mixed"
        if oracle.startswith("verifier:"):
            v = oracle.split(":", 1)[1].split("+", 1)[0]
            verdict[v] += 1
            groups[(run["class"], run["recovery"])] += 1
    with_verdict = sum(verdict.values())
    src = "m1-014-combined-audit/ledger.jsonl, per run"
    # The committed recorder output must agree with the ledger it was written beside.
    agree = (
        summary["total"] == len(runs) and summary["withVerdict"] == with_verdict
        and all(summary[k] == verdict[k] for k in ("verified", "refuted", "uncertain"))
        and all(g["eligible"] == groups[(g["class"], g["recovery"])] for g in summary["groups"])
    )
    r.fact("4", "summary.json agrees with ledger.jsonl", agree, "m1-014-combined-audit summary.json totals and groups vs the ledger")
    audit = ledger_audit(AUDIT / "ledger.jsonl")
    r.fact("4", "falseSuccesses cross-check", audit["failure"] == summary["falseSuccesses"],
           "m1-corrupt-suite-ledger.ts failure rows == summary.json falseSuccesses")
    r.quote(
        "4", "recorded / verdict / verified / refuted / uncertain / falseSuccesses / unprovenVerified",
        "of {} recorded, **{} carried a verdict — {} `verified`, {} `refuted`, {} `uncertain`, `falseSuccesses: {}`, `unprovenVerified: {}`**",
        len(runs), with_verdict, verdict["verified"], verdict["refuted"], verdict["uncertain"],
        summary["falseSuccesses"], summary["unprovenVerified"], source=src + " + summary.json",
    )
    r.quote("4", "verified rows", "The {} verified rows are the point", verdict["verified"], source=src)
    r.quote(
        "4", "groups (eligible per class)",
        "Groups: kill {}, invalid-target {}, dropped-save {}, focus-change {}, kill+recovery {}, invalid-target+recovery {}.",
        groups[("kill", False)], groups[("invalid-target", False)], groups[("dropped-save", False)],
        groups[("focus-change", False)], groups[("kill", True)], groups[("invalid-target", True)], source=src,
    )
    gaps = len(runs) - with_verdict
    r.fact("4", "ineligible count", gaps == len(summary["ineligible"]), "ledger gap runs == len(summary.json ineligible)")
    r.quote("4", "non-landing faults", "The {} non-landing faults are listed under `ineligible`", len(summary["ineligible"]), source="summary.json ineligible")
    r.fact("4", "evidence commit 3eaa23c / PR #269", "3eaa23c" in (V3 / "COMMIT").read_text() and "PR #269" in (V3 / "COMMIT").read_text(),
           "m1-013-sweep-v3/COMMIT records 'evidence committed by 3eaa23c (... PR #269)'")
    r.unchecked("4", "audit run PR #79 (`6c4524e`)", "a commit reference; CI's shallow clone cannot resolve it and no committed file records it")

    # Row 5
    counted = [x for x in summary["recoveryResults"] if x["countsTowardCoverage"]]
    relaunch = sum(1 for x in counted if x["class"] == "kill" and x["verdict"] == "verified" and "relaunch:completed" in x["recoveryEvents"])
    retry1 = sum(1 for x in counted if x["class"] == "invalid-target" and x["verdict"] == "verified" and "retry:1-completed" in x["recoveryEvents"])
    rec = {(g["class"]): g["eligible"] for g in summary["groups"] if g["recovery"]}
    rsrc = "m1-014-combined-audit/summary.json recoveryResults (countsTowardCoverage)"
    r.quote("5", "kill relaunches / invalid-target first retries",
            "{} kill trials completed a relaunch and {} invalid-target trials completed the first retry",
            word(relaunch, cap=True), word(retry1), source=rsrc)
    r.quote("5", "recovery groups", "the `kill+recovery` {} and `invalid-target+recovery` {} groups", rec["kill"], rec["invalid-target"],
            source="summary.json groups (recovery: true).eligible")
    verified_rec = [x for x in counted if x["verdict"] == "verified"]
    r.quote("5", "recovered trials verified", "All {} recovered trials verified", word(len(verified_rec)), source=rsrc)
    r.fact("5", "with trace evidence", all(x["recoveryEvents"] and x["persistedValue"] == x["expectedValue"] for x in verified_rec),
           rsrc + ": recoveryEvents (read from each trace) non-empty and persistedValue == expectedValue")

    # Row 6
    v3r, v3e, v3bad = schema_log(V3 / "schema-validation.log")
    aur, aue, aubad = schema_log(AUDIT / "schema-validation.log")
    lsrc = "sum of both committed schema-validation.log files"
    r.quote("6", "results / traces", "**{} results** ({} from m1-013 + {} from m1-014) and **{} trace events** ({} + {})",
            v3r + aur, v3r, aur, v3e + aue, v3e, aue, source=lsrc)
    r.fact("6", "every line ALL OK", v3bad + aubad == 0, lsrc, f"{v3bad + aubad} lines not ALL OK")
    v3_ledger = ledger_audit(V3 / "ledger.jsonl")
    r.quote("6", "corrupted ledger entries", "emitted a {}-entry ledger", audit["rows"], source="m1-corrupt-suite-ledger.ts on m1-014 ledger.jsonl")
    r.quote("6", "v3 ledger entries", "produced {} entries", v3_ledger["rows"], source="m1-corrupt-suite-ledger.ts on m1-013 ledger.jsonl")
    r.fact("6", "both have zero unaccounted entries", audit["unaccounted"] == 0 and v3_ledger["unaccounted"] == 0,
           "m1-corrupt-suite-ledger.ts unaccounted on both ledgers", f"m1-014 {audit['unaccounted']}, m1-013 {v3_ledger['unaccounted']}")
    r.unchecked("6", "`pnpm schema-validate` 5-trial sample", "a CI step's configuration, not an evaluation figure; CI runs that check itself")


def check_row_7(r: Report, doc: Path, scorecard, row7, v3: dict) -> None:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = row7.compare(True, doc)
    r.fact("7", "row7-compare --check: 11 figures", rc == 0,
           "v3 29/1, r6 0/30, step-budget 29 / modified 1, Myco-only 29 / baseline-only 0, p, 27 of the 29, rows 13 and 21, "
           "falseSuccess 0/30 + 0 audited, asymmetry on all 30, r6 $ spend, ledger sha256 prefix",
           err.getvalue().strip())
    ext = json.loads(R6.read_text())
    rows = {x["index"]: x for x in ext["rows"]}
    v3t = {t["index"]: t for t in jsonl(V3 / "trials.jsonl")}
    src = "c1-arm-003/r6/ledger-extract.json"
    ident = ext["identity"]
    r.quote("7", "model", "Screenshot agent (`{}`", ident["model"], source=src + " identity.model")
    r.quote("7", "snapshot", "snapshot `{}`", ident["snapshot"], source=src + " identity.snapshot")
    budgets = {x["stepBudget"] for x in rows.values()}
    r.quote("7", "step budget", "{}-step budget", "/".join(map(str, sorted(budgets))), source=src + " rows[].stepBudget")
    planner = (ROOT / "src/baseline/planner.ts").read_text()
    m = re.search(r"export const MAX_OUTPUT = (\d+);", planner)
    r.quote("7", "max output tokens", "{} max output tokens", m.group(1) if m else "?",
            source="src/baseline/planner.ts MAX_OUTPUT (the code constant; r6 rows do not record it)")
    r.fact("7", "same instruction incl. 'and save the file'", all("and save the file" in x["instruction"] for x in rows.values()),
           src + " rows[].instruction")
    both = sorted(i for i in range(30) if v3t[i]["status"] != "verified" and rows[i]["verdict"] != "verified")
    r.quote("7", "both refuted", "both refuted **{}** (index {})", len(both), ",".join(map(str, both)), source="v3 trials.jsonl x r6 extract")
    v3_refuted = [f["index"] for f in v3["failures"]]
    r.quote("7", "Myco v3 refute index", "index {} is the UNO-startup guard timeout", ",".join(map(str, v3_refuted)), source="m1-scorecard.score failures")
    discordant = sum(1 for i in range(30) if (v3t[i]["status"] == "verified") != (rows[i]["verdict"] == "verified"))
    r.quote("7", "discordant pairs", "sign test on the {} discordant pairs", discordant, source="v3 trials.jsonl x r6 extract")
    budget_rows = [x for x in rows.values() if x["verdictReason"] == "step-budget"]
    save_loop = {x["index"] for x in budget_rows if x["typedExpected"] and x["ctrlS"] > 0}
    ruled = [0, 1, 3, 5, 6, 7, 8, 9, 10]
    r.fact("7", "the 9 ruled rows (0, 1, 3, 5–10) show the save-loop pattern",
           set(ruled) <= save_loop and "was made on 9 rows (0, 1, 3, 5–10)" in r.segment("7"),
           src + ": typedExpected and ctrlS > 0 on each ruled row")
    r.unchecked("7", "that the note ruled on exactly those 9 rows (#381, 05:31Z)", "the ruling lives in SAVE-DIALOG-LOOP.md prose; only the pattern on each row is checked")
    r.quote("7", "unruled rows with the pattern", "the other {} of the {} show the same pattern", len(save_loop) - len(ruled), len(save_loop),
            source="save-loop rows minus the ruled rows")
    other = sorted(x["index"] for x in budget_rows if x["index"] not in save_loop)
    r.fact("7", "rows 13 and 21: no key, all 30 actions", all(rows[i]["pressKey"] == 0 and rows[i]["actions"] == 30 and not rows[i]["typedExpected"] for i in other),
           src + ": pressKey == 0, actions == 30, typedExpected false")
    r.unchecked("7", "rows 13 and 21 actions are clicks and Name-Box entries", "the extract keeps action counts, not each action's target")
    modified = [x for x in rows.values() if x["verdictReason"] == "modified"]
    mod = modified[0] if len(modified) == 1 else None
    r.quote("7", "the modified row", "Row {} (`modified`) typed the value, claimed `{}` after {} actions",
            mod["index"] if mod else "?", ",".join(mod["claims"]) if mod else "?", mod["actions"] if mod else "?", source=src)
    r.fact("7", "the modified row typed the value", bool(mod and mod["typedExpected"] and mod["ctrlS"] == 0), src + ": typedExpected, ctrlS == 0")
    acc = ident.get("acceptances") or [{}]
    r.quote("7", "acceptance start", "diagnosed agent cause from trial {}", acc[0].get("fromTrial", "?"), source=src + " identity.acceptances[0].fromTrial")
    r.quote("7", "ledger sha256 suffix", "…{}`)", ext["sourceSha256"][-6:], source=src + " sourceSha256")
    for path, line, needle, label in (
        ("src/baseline/index.ts", 84, "falseSuccess", "`src/baseline/index.ts:84`"),
        ("src/baseline/c1-trial.ts", 63, "step-budget-asymmetry", "`src/baseline/c1-trial.ts:63`"),
        ("src/baseline/c1-trial.ts", 17, "STEP_BUDGET", "`c1-trial.ts:17`"),
    ):
        text = (ROOT / path).read_text().splitlines()
        ok = len(text) >= line and needle in text[line - 1] and label in r.segment("7")
        r.fact("7", f"code ref {label}", ok, f"{path} line {line} contains {needle!r}")
    micros = sum(x["micros"] for x in rows.values())
    note = BUDGET_NOTE.read_text()
    prior = re.search(r"prior committed\s+([\d,]+) u\$", note)
    prior_micros = int(prior.group(1).replace(",", "")) if prior else 0
    cap = re.search(r"approved \$(\d+\.\d\d) ceiling", note)
    cap_s = cap.group(1) if cap else "?"
    bsrc = "r6 micros + ROW7-BUDGET-DECIDED.md 'prior committed' and cap"
    r.quote("7", "spend", "+ ${} prior (`c1-arm-003d/ROW7-BUDGET-DECIDED.md`) = **${} of the ${} cap**",
            f"{prior_micros / 1e6:.4f}", f"{(micros + prior_micros) / 1e6:.4f}", cap_s, source=bsrc)
    refuted = sum(1 for x in rows.values() if x["verdict"] != "verified")
    r.quote("7", "gap: budget exhaustion", "{} of the {} baseline failures are budget exhaustion", len(budget_rows), refuted, source=src)
    r.quote("7", "gap: C2 rows", "C2 was not run ({} rows)", ext["c2Rows"], source=src + " c2Rows")
    r.unchecked("7", "gap (2), (3): no per-row fixture hash; transcripts carry no frames", "statements about what the ledger lacks; the extract drops those fields either way")

    # Slots
    tally = Counter(x["verdict"] for x in rows.values())
    reason = Counter(x["verdictReason"] for x in rows.values())
    r.quote("slots", "baseline pass rate", "**{}/{} verified** ({} refuted: `step-budget` {}, `modified` {})",
            tally.get("verified", 0), len(rows), tally["refuted"], reason["step-budget"], reason["modified"], source=src)
    myco_only = sum(1 for i in range(30) if v3t[i]["status"] == "verified" and rows[i]["verdict"] != "verified")
    base_only = sum(1 for i in range(30) if v3t[i]["status"] != "verified" and rows[i]["verdict"] == "verified")
    p = row7.sign_test_two_sided(myco_only, base_only)
    r.quote("slots", "paired table + sign test", "**b = {}** (Myco only), **c = {}** (baseline only), both refuted {}, **p = {}** two-sided",
            myco_only, base_only, len(both), f"{p:.1e}".replace("e-0", "e-"), source="row7-compare sign_test_two_sided")
    lo, hi = scorecard.wilson(tally.get("verified", 0), len(rows))
    vlo, vhi = scorecard.wilson(v3["verified"], v3["recorded"])
    r.quote("slots", "Wilson 95%", "**{}–{}** (Myco v3: {}–{})", f"{max(lo, 0):.3f}", f"{hi:.3f}", f"{vlo:.3f}", f"{vhi:.3f}",
            source="m1-scorecard.wilson")
    r.quote("slots", "spend", "**${}** r6 + ${} prior = **${} of ${}**", f"{micros / 1e6:.4f}", f"{prior_micros / 1e6:.4f}",
            f"{(micros + prior_micros) / 1e6:.4f}", cap_s, source=bsrc)

    # Save-dialog table (the section quotes r6's first 9 rows)
    nine = [rows[i] for i in ruled]
    r.quote("save-dialog", "typed the correct value", "| rows that typed the **correct value** into the **correct cell** | **{} of {}** |",
            sum(x["typedExpected"] for x in nine), len(nine), source=src + " typedExpected (value only; the cell is not in the extract)")
    r.quote("save-dialog", "attempted a save", "| rows that attempted a save | **{} of {}** |", sum(x["ctrlS"] > 0 for x in nine), len(nine), source=src + " ctrlS")
    r.quote("save-dialog", "completed a save", "| rows that completed a save | **{} of {}** |", sum(x["verdict"] == "verified" for x in nine), len(nine),
            source=src + " verdict == verified (no row persisted the value)")
    r.quote("save-dialog", "Ctrl+S presses", "followed by `Escape` | **{} of {} (", "61", sum(x["ctrlS"] for x in nine), source=src + " sum of ctrlS; 61 as quoted")
    r.unchecked("save-dialog", "61 Ctrl+S immediately followed by Escape (80%)", "needs the action order; the extract keeps per-row counts only")
    r.quote("save-dialog", "row 9 pure case", "`click → Ctrl+S → Escape` repeated {} times", word(rows[9]["ctrlS"]) if rows[9]["ctrlS"] == rows[9]["escape"] else "?",
            source=src + " row 9 ctrlS == escape")


def check_durability(r: Report, v3: dict, scorecard) -> None:
    r.quote("durability", "v3 pack size", "| `docs/research/experiments/m1-013-sweep-v3/` | **{} KiB** |", kib(V3), source="sum of file sizes")
    r.quote("durability", "m1-014 pack size", "| `docs/research/experiments/m1-014-combined-audit/` | **{} KiB** |", kib(AUDIT), source="sum of file sizes")
    r.quote("durability", "v3 rows", "| {} rows: `trials.jsonl`", v3["recorded"], source="m1-scorecard.score")
    summary = json.loads((AUDIT / "summary.json").read_text())
    r.quote("durability", "m1-014 eligible", "| {} eligible corrupted trials:", summary["withVerdict"], source="m1-014 summary.json withVerdict")
    head = scorecard.markdown(v3).splitlines()[0].strip("*").rstrip(".")
    r.quote("durability", "reliability regenerated", "**{}**, Wilson 95% {}–{}", head.replace("Reliability: ", ""),
            f"{v3['wilson95'][0]:.2f}", f"{v3['wilson95'][1]:.2f}", source="m1-scorecard.markdown + wilson95")
    trials = sum(1 for _ in RUNS.glob("*/trial-*/result.json"))
    r.quote("viewer", "committed trials", "All {} trials cost", trials, source="m1-runs/*/trial-*/result.json")
    r.unchecked("viewer", "504 KB", "disk usage (du), which depends on the filesystem's block size; the byte total differs")


def check_row_8(r: Report, scorecard) -> None:
    row = r.segment("8")
    files = sum(1 for f in TOOLCHAIN.rglob("*") if f.is_file())
    if "#206)" in row:
        r.quote("8", "toolchain files", "({} files, #206)", files, source="files under docs/env/vm-toolchain/")
    else:
        r.skipped("8", "toolchain files", f"row 8 no longer quotes the toolchain file count (the tree has {files})")
    named = ["build-all.sh", "build-win-iso.sh", "build-seed-iso.sh", "create-vm.sh", "convert-disk-virtio.sh", "vm.sh",
             "reset.sh", "wait-ssh.sh", "vssh", "shutdown.sh", "set-cd.sh", "guest", "seed"]
    absent = [n for n in named if f"`{n}" in row and not (TOOLCHAIN / n).exists()]
    r.fact("8", "named toolchain files exist", not absent, "docs/env/vm-toolchain/", f"absent {absent}" if absent else "")
    refs = sorted(set(re.findall(r"(?:PR )?#\d+|TIF-\d+|§\d+(?:\.\d+)?", row)))
    if refs:
        r.unchecked("8", ", ".join(refs), "references to PRs, issues and runbook sections, not counts from an artifact")
    # Figures row 8 states about operator sessions; listed only when the row states them.
    for trigger, claim, why in (
        ("F1–F21", "findings F1–F21 and G-findings up to G38", "host-only operator reports, not committed"),
        ("of the six operator sessions", "three of the six operator sessions used a fresh clone",
         "operator-session provenance from the host-only reports; no committed artifact records it"),
        ("abandoned at 11 rows", "first §7.3 sweep: 11 rows (7 verified, 3 refuted, 1 uncertain), at most 26/30 reachable, 3 of 4 misses from the 15 s bug",
         "the abandoned sweep's ledger is deliberately not committed (m1-row8-sweep2/README.md says none of its rows are in that ledger)"),
        ("43 of 1,", "§1.2 `pnpm test` failed 43 of 1,080 on 5 s timeouts under host load 13–15 (G23)",
         "the operator's host-side test run, not committed"),
    ):
        if trigger in row:
            r.unchecked("8", claim, why)

    if "m1-row8-sweep2" not in row:
        r.skipped("8", "§7.3 sweep figures", "row 8 does not cite m1-row8-sweep2, so it quotes none of its numbers")
    elif not SWEEP2.is_dir():
        r.skipped("8", "§7.3 sweep figures", "row 8 cites m1-row8-sweep2 but the pack is not in the tree")
    else:
        s2 = scorecard.score(SWEEP2 / "trials.jsonl")
        src = "m1-scorecard.score(m1-row8-sweep2/trials.jsonl)"
        r.quote("8", "sweep verified", "**{}/{} verified**", s2["verified"], s2["denominator"], source=src)
        trials = {t["index"]: t for t in jsonl(SWEEP2 / "trials.jsonl")}
        params = json.loads((SWEEP2 / "params.json").read_text())
        # A row is pinned when its index has a params.json entry and every task field the
        # record carries equals that entry. A record that failed before the trial started
        # (deploy-failed) carries no task fields; it is counted, and named in the source.
        fields = (("fixtureSeed", "fixtureSeed"), ("rowKey", "rowKey"), ("column", "column"), ("typed", "newValue"))
        bare = sorted(i for i, t in trials.items() if not any(k in t for k, _ in fields))
        pinned = sum(1 for i, t in trials.items() if i < len(params)
                     and all(t[k] == params[i][pk] for k, pk in fields if k in t))
        r.quote("8", "pinned rows", "{} pinned rows", pinned,
                source=f"trials.jsonl task fields == params.json[index]; records with no task fields: {bare}")
        conv = [f["index"] for f in s2["failures"] if "convert" in f["reason"]]
        dep = [f["index"] for f in s2["failures"] if f["status"] == "deploy-failed"]
        r.quote("8", "harness-fault trials", "trial {} convert deadline and trial {} deploy-failed",
                ",".join(map(str, conv)), ",".join(map(str, dep)), source=src + " failures")
        if CORRUPT.is_dir():
            cr, ce, cbad = schema_log(CORRUPT / "schema-validation.log")
            sr, se, sbad = schema_log(SWEEP2 / "schema-validation.log")
            r.quote("8", "per-index validate-live sums", "per-index `validate-live` {} + {} and {} + {} trace events, all OK", cr, ce, sr, se,
                    source="both row-8 schema-validation.log files")
            r.fact("8", "validate-live all OK", cbad + sbad == 0, "both row-8 schema-validation.log files", f"{cbad + sbad} lines not ALL OK")
    if "m1-row8-corrupt" not in row:
        r.skipped("8", "§7.4 corrupted-suite figures", "row 8 does not cite m1-row8-corrupt, so it quotes none of its numbers")
        return
    if not CORRUPT.is_dir():
        r.skipped("8", "§7.4 corrupted-suite figures", "row 8 cites m1-row8-corrupt but the pack is not in the tree (PR #431 not merged)")
        return
    committed = json.loads((CORRUPT / "summary.json").read_text())
    eval_id = jsonl(CORRUPT / "ledger.jsonl")[0]["evalId"]
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / eval_id
        shutil.copytree(CORRUPT, copy)
        proc = subprocess.run([sys.executable, str(ROOT / "scripts/m1-corrupt-suite-record.py"), "--final",
                               str(copy / "params.json"), str(copy / "trials.jsonl")], cwd=ROOT, capture_output=True, text=True)
        same = all((copy / f).read_bytes() == (CORRUPT / f).read_bytes() for f in ("ledger.jsonl", "summary.json"))
        summary = json.loads((copy / "summary.json").read_text()) if (copy / "summary.json").is_file() else committed
    r.fact("8", "recorder --final rebuilds ledger + summary byte-identical", proc.returncode == 0 and same,
           "m1-corrupt-suite-record.py --final on a copy of m1-row8-corrupt/", proc.stderr.strip()[-300:] if proc.returncode else "")
    eligible = sum(g["eligible"] for g in summary["groups"])
    src = "m1-corrupt-suite-record.py --final summary"
    r.quote("8", "corrupted-suite figures",
            "{}/{} recorded and eligible, {} verified / {} refuted / {} uncertain, **{} false successes**, {} unproven, ledger {} rows with {} unaccounted",
            summary["total"], eligible, summary["verified"], summary["refuted"], summary["uncertain"], summary["falseSuccesses"],
            summary["unprovenVerified"] + summary["unprovenRecovery"], summary["ledger"]["rows"], summary["ledger"]["unaccounted"], source=src)
    r.fact("8", "every recovery trial verified", all(x["verdict"] == "verified" for x in summary["recoveryResults"]), src + " recoveryResults")
    log = (CORRUPT / "deploy-check.log").read_text() if (CORRUPT / "deploy-check.log").is_file() else ""
    m = re.search(r"verified (\d+) files on the guest", log)
    r.quote("8", "deploy copy", "`verified {} files on the guest`", m.group(1) if m else "?", source="m1-row8-corrupt/deploy-check.log")
    r.fact("8", "`DEPLOY OK`", "DEPLOY OK" in log, "m1-row8-corrupt/deploy-check.log")
    r.unchecked("8", "reset 250 s, deploy 201 s; session_info session_id 1 / WinSta0 / exit 0",
                "stated in the pack README from the operator's session; no committed log records the timings or the session_info output")
    r.unchecked("8", "§6 20/20, exit 0, 2026-11-24 11:42–11:59Z", "the row itself says this is in the host-only operator report, not committed")


def subchecks(r: Report, doc: Path) -> None:
    for name, cmd in (
        ("check-scorecard-links.py", [sys.executable, "scripts/check-scorecard-links.py", str(doc)]),
        ("scorecard-viewer-links.py --check", [sys.executable, "scripts/scorecard-viewer-links.py", "--check"]),
    ):
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        tail = (proc.stdout + proc.stderr).strip().splitlines()
        r.fact("links", name, proc.returncode == 0, "exit " + str(proc.returncode), tail[-1] if tail and proc.returncode else "")


def main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--doc", type=Path, default=ROOT / "docs/m1-scorecard.md")
    ap.add_argument("--inventory-md", action="store_true", help="print the coverage inventory as a markdown table")
    ap.add_argument("--no-subchecks", action="store_true", help="skip the two link checkers")
    args = ap.parse_args(argv)
    doc = args.doc.resolve()
    scorecard = load_module("m1_scorecard", ROOT / "scripts/m1-scorecard.py")
    row7 = load_module("row7_compare", ROOT / "scripts/row7-compare.py")
    r = Report(doc.read_text(encoding="utf-8"))
    v3 = check_rows_1_to_3(r, scorecard)
    check_rows_4_to_6(r)
    check_row_7(r, doc, scorecard, row7, v3)
    check_durability(r, v3, scorecard)
    check_row_8(r, scorecard)
    if not args.no_subchecks:
        subchecks(r, doc)

    if args.inventory_md:
        print("| Where | Claim | Status | Source / reason |")
        print("|---|---|---|---|")
        for where, claim, status, detail in r.rows:
            label = f"row {where}" if where.isdigit() else where
            cell = detail.replace("|", r"\|")
            print(f"| {label} | {claim} | {status} | {cell} |")
    else:
        for where, claim, status, detail in r.rows:
            label = f"row {where}" if where.isdigit() else where
            print(f"{status:<9}  {label:<12} {claim} — {detail}")
    counts = Counter(status for _, _, status, _ in r.rows)
    bad = r.mismatches()
    print(f"\n{counts['ok']} ok, {len(bad)} mismatch, {counts['unchecked']} not machine-checked, {counts['skipped']} skipped")
    if bad:
        for where, claim, _, detail in bad:
            label = f"row {where}" if where.isdigit() else where
            print(f"MISMATCH {label}: {claim}: {detail}", file=sys.stderr)
        return 1
    print("SCORECARD CHECK OK: every machine-checkable number matches its committed artifact")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
