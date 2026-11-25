#!/usr/bin/env python3
"""Recompute the numbers in docs/m1-scorecard.md's in-scope sections from committed artifacts.

  scorecard-check.py [--doc PATH] [--inventory-md] [--no-subchecks]

Row 8 step 8 of the reproducibility test plan, as re-scoped by the lead (2026-11-25):
a script recomputes the numbers in the scorecard from committed artifacts and fails on
any mismatch. Prose byte-identity is not required; the numbers are.

Scope. Every `##` and `###` section of the doc is classified, and the classification is
printed. A section the script does not know fails the check, so a new section cannot
slip in unclassified.
  in scope     the preamble and the status line, criterion rows 1-8, "Open a trial in
               the viewer", "Evidence durability", "Row 7 slots", and "The C1
               baseline's characteristic failure mode" (including its resume command);
  sub-checks   "Trial traces": its links and run ids are held by the two link checkers
               below, not by the number sweep;
  out of scope the reproducibility test plan, the arm-002 decision, the 256-token
               defect section (but not its save-dialog subsection), "Reliability row,
               regenerate" and the open-risk section. OUT_OF_SCOPE names each one with
               its reason, and the output lists them.

Claims. Every claim in scope is one of these kinds, and every kind is printed:

  ok           the doc's own text at the named place was compared against a value
               recomputed from a committed artifact (or a code constant), and matched;
  MISMATCH     the doc does not quote the recomputed value, or a phrase the inventory
               names is no longer in the doc. Exit 1;
  unchecked    the number cannot be recomputed from anything committed. The reason is
               printed, and the doc phrase it covers must still be present;
  artifact     a consistency check between committed artifacts that the doc does not
               state itself (e.g. summary.json agrees with ledger.jsonl). It never
               counts as an `ok` for a doc claim; a failure exits 1;
  skipped      the artifact pack a row cites is not in the tree. The reason is printed.
  swept        one per in-scope section: the number sweep below found no uncovered token.

The number sweep. After the claims run, every number-like token in the in-scope
sections must lie inside the doc text of some claim: digits (including decimals,
ratios, `1,080`, `3.7e-9`), dates, clock times, short hex commit ids, and the
references `#N`, `PR #N`, `TIF-N`, `§N.N`, `FN`, `GN`. Any token no claim covers is
printed as UNATTRIBUTED and exits 1. Not swept, by design: digits inside identifiers
and paths (`m1-013`, `c1-arm-003`, `ARM64`, `r6`, `trial-0`), list markers like
`(1) `, the `| N |` row number, and spelled-out numbers (`seven`, `nine`), which
appear too often in plain prose to sweep without noise. Spelled-out figures are still
checked wherever a claim quotes them (e.g. row 5's "Four", "three", "seven").

Recomputation reuses the existing tools rather than re-deriving them:
  - scripts/m1-scorecard.py         score() and wilson(): rows 1, 3, 8 and the slots;
  - scripts/row7-compare.py         compare --check, run in process against --doc, as a
                                    second reader of row 7; this script also quotes each
                                    of those figures itself, so the sweep covers them;
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
SAVE_NOTE = EXP / "c1-arm-003d/SAVE-DIALOG-LOOP.md"
SWEEP2 = EXP / "m1-row8-sweep2"
CORRUPT = EXP / "m1-row8-corrupt"
ROW8 = EXP / "m1-row8"
TOOLCHAIN = ROOT / "docs/env/vm-toolchain"
RUNS = EXP / "m1-runs"
VISION = ROOT / "docs/product/vision.md"

WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine"}

# Sections, keyed by a prefix of their heading. In-scope sections are swept; the rest
# are listed in the output with the reason they are not.
IN_SCOPE = {
    "## Open a trial in the viewer": "viewer",
    "## Evidence durability": "durability",
    "## Row 7 slots": "slots",
    "### The C1 baseline's characteristic failure mode": "save-dialog",
}
SUBCHECKED = {
    "## Trial traces": "per-trial links and run ids; held by check-scorecard-links.py and "
                       "scorecard-viewer-links.py --check, not by the number sweep",
}
OUT_OF_SCOPE = {
    "## Reproducibility test plan": "the plan's pass conditions (20/20, 30 rows, step numbers, the 3–4 h estimate) "
                                    "are specifications, not results from an artifact",
    "## Decision: arm-002 is not the baseline": "a record about arm-002, which is not scored; its counts come from "
                                                "c1-arm-002/accounting.json, which this script does not parse",
    "## Second reason arm-002 is superseded": "arm-002's 256-token defect and arm-003 spend history; arm-002 is not scored "
                                             "and its call counts are not recomputed here (its save-dialog subsection is in scope)",
    "## Reliability row, regenerate": "how to run m1-scorecard.py and its counting rules, restated from the script's header; "
                                      "the regenerated numbers themselves are checked in rows 1 and 3 and under durability",
    "## Open risk: guest-side fixture convert": "sweep v2 conversion timings and a cold-start probe; no committed pack holds them",
}


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def word(n: int, cap: bool = False) -> str:
    w = WORDS.get(n, str(n))
    return w.capitalize() if cap else w


def ranges(ns: list[int]) -> str:
    """[0, 1, 3, 5, 6, 7, 8, 9, 10] -> '0, 1, 3, 5–10' (runs of three or more collapse)."""
    out, run = [], []
    for n in sorted(ns) + [None]:
        if run and (n is None or n != run[-1] + 1):
            out.extend([f"{run[0]}–{run[-1]}"] if len(run) >= 3 else map(str, run))
            run = []
        if n is not None:
            run.append(n)
    return ", ".join(out)


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


def grab(pattern: str, text: str, group: int = 1, default: str = "?") -> str:
    m = re.search(pattern, text)
    return m.group(group) if m else default


# Number-like tokens the sweep requires a claim for. Order matters: references, dates
# and times are matched whole before the bare-number alternative can split them.
TOKEN = re.compile(
    r"TIF-\d+|(?:PR )?#\d+|§\d+(?:\.\d+)*|\b[FG]\d+\b"
    r"|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,40}\b"
    r"|\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}Z?"
    r"|(?<![\w.\-])\$?\d{1,3}(?:,\d{3})+(?![\w.]|-\d)"
    r"|(?<![\w.\-])\$?\d+(?:\.\d+)*(?:e-\d+)?(?![\w.]|-\d)"
)
REF = re.compile(r"^(?:TIF-\d+|(?:PR )?#\d+|§\d+(?:\.\d+)*)$")
LIST_MARKER = re.compile(r"\(\d\)(?= )")


class Report:
    def __init__(self, doc_text: str):
        self.text = doc_text
        self.rows: list[tuple[str, str, str, str]] = []  # (where, claim, status, detail)
        self.spans: dict[str, list[tuple[int, int]]] = {}
        self.sections = self._sections()

    # -- where claims live -------------------------------------------------------------
    def _sections(self) -> list[tuple[str, int, int]]:
        """(heading, start, end) for every ## and ### section, in order."""
        starts = [m.start() + 1 for m in re.finditer(r"\n#{2,3} ", self.text)]
        ends = starts[1:] + [len(self.text)]
        return [(self.text[s:self.text.find("\n", s)], s, e) for s, e in zip(starts, ends)]

    def segment(self, where: str) -> str:
        if where.isdigit():
            return next((l for l in self.text.splitlines() if l.startswith(f"| {where} |")), "")
        if where == "status":
            end = self.text.find("\n| # |")
            return self.text[: end if end > 0 else 0]
        prefix = next(k for k, v in IN_SCOPE.items() if v == where)
        return next((self.text[s:e] for h, s, e in self.sections if h.startswith(prefix)), "")

    def in_scope(self) -> list[str]:
        return ["status", *map(str, range(1, 9)), *IN_SCOPE.values()]

    def _locate(self, where: str, phrase: str) -> bool:
        """Attribute the first occurrence of `phrase` not already attributed."""
        seg = self.segment(where)
        spans = self.spans.setdefault(where, [])
        hits, i = [], seg.find(phrase)
        while i >= 0 and phrase:
            hits.append((i, i + len(phrase)))
            i = seg.find(phrase, i + 1)
        if not hits:
            return False
        fresh = [h for h in hits if not any(s <= h[0] and h[1] <= e for s, e in spans)]
        spans.append((fresh or hits)[0])
        return True

    # -- claim kinds -------------------------------------------------------------------
    def quote(self, where: str, claim: str, template: str, *values, source: str) -> None:
        """The doc at `where` must contain template.format(*values) verbatim."""
        expected = template.format(*values)
        if self._locate(where, expected):
            self.rows.append((where, claim, "ok", f"{expected!r} from {source}"))
            return
        seg = self.segment(where)
        pattern = r"(\S+?)".join(re.escape(part) for part in template.split("{}"))
        if template.endswith("{}"):
            pattern = pattern[: -len(r"(\S+?)")] + r"(\S+)" if pattern.endswith(r"(\S+?)") else pattern
        found = re.search(pattern, seg) if "{}" in template else None
        found_text = repr(found.group(0)) if found else "the phrase is not present"
        self.rows.append((where, claim, "MISMATCH", f"expected {expected!r} ({source}); found {found_text}"))

    def check(self, where: str, claim: str, ok: bool, source: str, doc: str | tuple[str, ...], detail: str = "") -> None:
        """An artifact-side assertion the doc states in prose; `doc` is that prose, verbatim."""
        phrases = (doc,) if isinstance(doc, str) else doc
        missing = [p for p in phrases if not self._locate(where, p)]
        if missing:
            self.rows.append((where, claim, "MISMATCH", f"the doc no longer says {missing}; {source}"))
            return
        self.rows.append((where, claim, "ok" if ok else "MISMATCH", f"{source}{': ' + detail if detail else ''}"))

    def artifact(self, where: str, claim: str, ok: bool, source: str, detail: str = "") -> None:
        """Consistency between committed artifacts; the doc does not state it."""
        self.rows.append((where, claim, "artifact" if ok else "MISMATCH", f"{source}{': ' + detail if detail else ''}"))

    def tool(self, where: str, claim: str, rc: int, detail: str) -> None:
        """A sub-check that reads the doc itself."""
        self.rows.append((where, claim, "ok" if rc == 0 else "MISMATCH", detail))

    def unchecked(self, where: str, claim: str, why: str, doc: str | tuple[str, ...]) -> None:
        phrases = (doc,) if isinstance(doc, str) else doc
        missing = [p for p in phrases if not self._locate(where, p)]
        if missing:
            self.rows.append((where, claim, "MISMATCH",
                              f"inventoried as unchecked, but the doc no longer says {missing}; update the inventory"))
            return
        self.rows.append((where, claim, "unchecked", why))

    def skipped(self, where: str, claim: str, why: str) -> None:
        self.rows.append((where, claim, "skipped", why))

    def mismatches(self) -> list[tuple[str, str, str, str]]:
        return [r for r in self.rows if r[2] in ("MISMATCH", "UNATTRIBUTED")]

    # -- coverage ----------------------------------------------------------------------
    def tokens(self, where: str) -> list[tuple[int, int, str]]:
        seg = LIST_MARKER.sub(lambda m: " " * len(m.group(0)), self.segment(where))
        skip = len(f"| {where} |") if where.isdigit() else 0
        return [(m.start(), m.end(), m.group(0)) for m in TOKEN.finditer(seg) if m.start() >= skip]

    def covered(self, where: str, start: int, end: int) -> bool:
        return any(s <= start and end <= e for s, e in self.spans.get(where, []))

    def sweep_references(self) -> None:
        """Issue, PR and runbook-section references are pointers, not figures."""
        for where in self.in_scope():
            refs = [t for s, e, t in self.tokens(where) if REF.match(t) and not self.covered(where, s, e)]
            for t in refs:
                self._locate(where, t)
            if refs:
                self.unchecked(where, ", ".join(dict.fromkeys(refs)),
                               "references to issues, PRs and runbook sections; pointers, not figures, and this "
                               "script does not resolve them", ())

    def sweep_numbers(self) -> None:
        for where in self.in_scope():
            loose = [t for s, e, t in self.tokens(where) if not self.covered(where, s, e)]
            if loose:
                self.rows.append((where, "number sweep", "UNATTRIBUTED",
                                  f"no checked or unchecked claim covers {loose}; add one to the inventory"))
            else:
                self.rows.append((where, "number sweep", "swept", f"all {len(self.tokens(where))} number-like tokens attributed"))

    def classify_sections(self) -> list[tuple[str, str]]:
        """(heading, class) for every section; an unknown heading is a MISMATCH."""
        out = []
        for heading, _, _ in self.sections:
            kind = next((c for table, c in ((IN_SCOPE, "in scope"), (SUBCHECKED, "sub-checks"), (OUT_OF_SCOPE, "out of scope"))
                         if any(heading.startswith(k) for k in table)), None)
            if kind is None:
                self.rows.append(("sections", heading, "MISMATCH",
                                  "a section this script does not classify; add it to IN_SCOPE, SUBCHECKED or OUT_OF_SCOPE"))
                kind = "UNCLASSIFIED"
            out.append((heading, kind))
        return out


def check_status(r: Report) -> None:
    r.unchecked("status", "As of 2026-11-25; rows 1–7 done; row 8 plan steps 2–7 have evidence, steps 1 and 8 not met",
                "the doc's own date and a summary of the Status column and the test plan's step numbers, not figures from an artifact",
                ("As of 2026-11-25", "Rows 1–7 are done", "Row 8 is partial", "every test-plan step 2–7", "plan steps 1 and 8"))


def check_rows_1_to_3(r: Report, scorecard) -> dict:
    v3 = scorecard.score(V3 / "trials.jsonl")
    trials = {t["index"]: t for t in jsonl(V3 / "trials.jsonl")}
    refuted = [f["index"] for f in v3["failures"] if f["status"] == "refuted"]
    src = "m1-scorecard.score(m1-013-sweep-v3/trials.jsonl)"
    vision = VISION.read_text()

    # Row 1
    r.quote("1", "tasks run", "ran all {} `calc-record-edit` tasks", v3["recorded"], source=src)
    r.quote("1", "verified / refuted", "({} verified, {} refuted by an infrastructure guard", v3["verified"], len(refuted), source=src)
    guard_ok = bool(refuted)
    for i in refuted:
        result = json.loads(next((RUNS / "m1-013" / f"trial-{i}").glob("result.json")).read_text())
        guard = result.get("guardFailure") or {}
        guard_ok &= guard.get("phase") == "precondition" and result.get("steps") == []
    r.check("1", "the refute is a guard failure before any UI action", guard_ok,
            f"m1-runs/m1-013/trial-{refuted}/result.json guardFailure.phase == precondition, steps == []",
            doc="guard failure before any UI action")
    r.unchecked("1", "LibreOffice Calc 26.8.3, Windows 11 ARM64", "environment versions are not recorded in the committed sweep artifacts",
                doc="LibreOffice Calc 26.8.3 native ARM64 in Windows 11 ARM64")

    # Row 2
    r.unchecked("2", "PR #11, log 21, PR #56", "references to review records and a run log, not counts derived from an artifact",
                doc=("PR #11", "(log 21)", "PR #56"))

    # Row 3
    r.quote("3", "criterion threshold", "≥ {} of {} varied normal trials",
            grab(r"At least (\d+) of \d+ varied normal", vision), grab(r"At least \d+ of (\d+) varied normal", vision),
            source="docs/product/vision.md acceptance criteria")
    r.artifact("3", "vision threshold == m1-scorecard.py TARGET_PASS/TARGET_N",
               f"At least {scorecard.TARGET_PASS} of {scorecard.TARGET_N} varied normal" in vision,
               "vision.md criterion vs scripts/m1-scorecard.py TARGET_PASS, TARGET_N")
    commit = (V3 / "COMMIT").read_text()
    r.quote("3", "docs commit", "Sweep v3 at `{}`", grab(r"docs-pr-at-run-time: ([0-9a-f]{7})", commit),
            source="m1-013-sweep-v3/COMMIT docs-pr-at-run-time")
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
    r.check("3", "the six listed files are present", not missing, "m1-013-sweep-v3/",
            doc=", ".join(f"`{f}`" for f in listed) + " — all present in the tree", detail=f"missing {missing}" if missing else "")
    r.quote("3", "regenerated count", "regenerates **{}/{} verified**", v3["verified"], v3["denominator"], source=src)
    guards = set()
    for i in refuted:
        result = json.loads((RUNS / "m1-013" / f"trial-{i}" / "result.json").read_text())
        guards.add((result.get("guardFailure") or {}).get("predicateName", "?"))
    r.quote("3", "the refute's index and guard", "one refute (index {}) was a different guard (`{}`)",
            ",".join(map(str, refuted)), ",".join(sorted(guards)), source="trials.jsonl failures + trial result.json guardFailure.predicateName")
    r.unchecked("3", "TIF-216: 15 s vs the configured 60 s", "a code-behaviour note about run-live (fixed in #427), not a count from an artifact",
                doc=("TIF-216", "time out at 15 s, not the configured 60 s"))
    r.unchecked("3", "row 3 stands as recorded", "a cross-reference to this row, not a figure", doc="row 3 stands as recorded")
    return v3


def check_rows_4_to_6(r: Report) -> None:
    ledger = jsonl(AUDIT / "ledger.jsonl")
    summary = json.loads((AUDIT / "summary.json").read_text())
    vision = VISION.read_text()
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
    r.quote("4", "criterion threshold", "{} false successes across ≥ {} corrupted",
            grab(r"(\d+) false-success reports across", vision), grab(r"across at least (\d+) deliberately corrupted", vision),
            source="docs/product/vision.md acceptance criteria")
    # The committed recorder output must agree with the ledger it was written beside.
    agree = (
        summary["total"] == len(runs) and summary["withVerdict"] == with_verdict
        and all(summary[k] == verdict[k] for k in ("verified", "refuted", "uncertain"))
        and all(g["eligible"] == groups[(g["class"], g["recovery"])] for g in summary["groups"])
    )
    r.artifact("4", "summary.json agrees with ledger.jsonl", agree, "m1-014-combined-audit summary.json totals and groups vs the ledger")
    audit = ledger_audit(AUDIT / "ledger.jsonl")
    r.artifact("4", "falseSuccesses cross-check", audit["failure"] == summary["falseSuccesses"],
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
    r.artifact("4", "ineligible count", gaps == len(summary["ineligible"]), "ledger gap runs == len(summary.json ineligible)")
    r.quote("4", "non-landing faults", "The {} non-landing faults are listed under `ineligible`", len(summary["ineligible"]), source="summary.json ineligible")
    commit = (V3 / "COMMIT").read_text()
    m = re.search(r"evidence committed by ([0-9a-f]{7}) \(.*PR #(\d+)\)", commit)
    r.quote("4", "evidence commit and PR", "evidence committed by #{} (`{}`)", m.group(2) if m else "?", m.group(1) if m else "?",
            source="m1-013-sweep-v3/COMMIT 'evidence committed by <sha> (... PR #<n>)'; that commit added both packs")
    r.unchecked("4", "audit run PR #79 (`6c4524e`)",
                "a commit reference that appears only in coordination and backlog docs (docs/coordination/, docs/backlog/m1.md), "
                "in no artifact pack; CI's shallow clone cannot resolve the commit",
                doc="Audit **run** is PR #79 (`6c4524e`)")

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
    r.check("5", "with trace evidence", all(x["recoveryEvents"] and x["persistedValue"] == x["expectedValue"] for x in verified_rec),
            rsrc + ": recoveryEvents (read from each trace) non-empty and persistedValue == expectedValue",
            doc="against the expected persisted value with trace evidence")

    # Row 6
    v3r, v3e, v3bad = schema_log(V3 / "schema-validation.log")
    aur, aue, aubad = schema_log(AUDIT / "schema-validation.log")
    lsrc = "sum of both committed schema-validation.log files"
    r.quote("6", "results / traces", "**{} results** ({} from m1-013 + {} from m1-014) and **{} trace events** ({} + {})",
            v3r + aur, v3r, aur, v3e + aue, v3e, aue, source=lsrc)
    r.quote("6", "results / traces, second mention", "the source of the {}/{} figures", v3r + aur, v3e + aue, source=lsrc)
    r.check("6", "every line ALL OK", v3bad + aubad == 0, lsrc, doc="every line `ALL OK`", detail=f"{v3bad + aubad} lines not ALL OK")
    v3_ledger = ledger_audit(V3 / "ledger.jsonl")
    r.quote("6", "corrupted ledger entries", "emitted a {}-entry ledger", audit["rows"], source="m1-corrupt-suite-ledger.ts on m1-014 ledger.jsonl")
    r.quote("6", "v3 ledger entries", "produced {} entries", v3_ledger["rows"], source="m1-corrupt-suite-ledger.ts on m1-013 ledger.jsonl")
    r.check("6", "both have zero unaccounted entries", audit["unaccounted"] == 0 and v3_ledger["unaccounted"] == 0,
            "m1-corrupt-suite-ledger.ts unaccounted on both ledgers", doc="both have zero unaccounted entries",
            detail=f"m1-014 {audit['unaccounted']}, m1-013 {v3_ledger['unaccounted']}")
    r.unchecked("6", "`pnpm schema-validate` 5-trial sample", "a CI step's configuration, not an evaluation figure; CI runs that check itself",
                doc="5-trial `FakeSpreadsheetApp` sample")


def check_row_7(r: Report, doc: Path, scorecard, row7, v3: dict) -> None:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = row7.compare(True, doc)
    r.tool("7", "row7-compare --check (second reader of row 7)", rc,
           "scripts/row7-compare.py compare --check on --doc" + (": " + err.getvalue().strip() if rc else ""))
    ext = json.loads(R6.read_text())
    rows = {x["index"]: x for x in ext["rows"]}
    v3t = {t["index"]: t for t in jsonl(V3 / "trials.jsonl")}
    src = "c1-arm-003/r6/ledger-extract.json"
    pair = "v3 trials.jsonl x r6 extract"
    ident = ext["identity"]
    tally = Counter(x["verdict"] for x in rows.values())
    reason = Counter(x["verdictReason"] for x in rows.values())
    v3_tally = Counter(t["status"] for t in v3t.values())
    myco_only = sum(1 for i in range(30) if v3t[i]["status"] == "verified" and rows[i]["verdict"] != "verified")
    base_only = sum(1 for i in range(30) if v3t[i]["status"] != "verified" and rows[i]["verdict"] == "verified")
    both = sorted(i for i in range(30) if v3t[i]["status"] != "verified" and rows[i]["verdict"] != "verified")
    p = row7.sign_test_two_sided(myco_only, base_only)
    p_text = f"{p:.1e}".replace("e-0", "e-")

    paired = sum(1 for i in rows if i in v3t)
    r.quote("7", "paired tasks", "the same {} tasks paired by index", paired, source=pair + ", indices present in both")
    r.quote("7", "Myco v3 tally", "Myco v3: **{} verified, {} refuted**", v3_tally["verified"], len(v3t) - v3_tally["verified"],
            source="m1-013-sweep-v3/trials.jsonl status")
    v3_refuted = [f["index"] for f in v3["failures"]]
    r.quote("7", "Myco v3 refute index", "index {} is the UNO-startup guard timeout", ",".join(map(str, v3_refuted)), source="m1-scorecard.score failures")
    r.quote("7", "model", "Screenshot agent (`{}`", ident["model"], source=src + " identity.model")
    planner = (ROOT / "src/baseline/planner.ts").read_text()
    r.quote("7", "max output tokens", "{} max output tokens", grab(r"export const MAX_OUTPUT = (\d+);", planner),
            source="src/baseline/planner.ts MAX_OUTPUT (the code constant; r6 rows do not record it)")
    budgets = {x["stepBudget"] for x in rows.values()}
    r.quote("7", "step budget", "{}-step budget", "/".join(map(str, sorted(budgets))), source=src + " rows[].stepBudget")
    r.quote("7", "snapshot", "snapshot `{}`", ident["snapshot"], source=src + " identity.snapshot")
    r.check("7", "same instruction incl. 'and save the file'", all("and save the file" in x["instruction"] for x in rows.values()),
            src + " rows[].instruction", doc='the same instruction including *"and save the file"*')
    r.quote("7", "baseline tally", "**{} verified, {} refuted** on the graded field", tally.get("verified", 0), tally["refuted"], source=src + " verdict")
    r.quote("7", "baseline reasons", "**`step-budget` {}, `modified` {}**", reason["step-budget"], reason["modified"], source=src + " verdictReason")
    r.quote("7", "paired split", "Myco-only success **{}**, baseline-only **{}**, both refuted **{}** (index {})",
            myco_only, base_only, len(both), ",".join(map(str, both)), source=pair)
    r.quote("7", "discordant pairs and p", "sign test on the {} discordant pairs **p = {}**", myco_only + base_only, p_text,
            source="row7-compare sign_test_two_sided")
    budget_rows = [x for x in rows.values() if x["verdictReason"] == "step-budget"]
    save_loop = {x["index"] for x in budget_rows if x["typedExpected"] and x["ctrlS"] > 0}
    r.quote("7", "step-budget rows (heading)", "What the {} step-budget rows did", len(budget_rows), source=src)
    r.quote("7", "save-loop rows", "**{} of the {}** typed the expected value", len(save_loop), len(budget_rows),
            source=src + ": typedExpected and ctrlS > 0")
    note = SAVE_NOTE.read_text()
    ruled = sorted(int(n) for n in re.findall(r"row\s+(\d+): ctrl\+s", note))
    r.unchecked("7", "SAVE-DIALOG-LOOP.md's PR and timestamp", "provenance of the note (its PR number and posting time), not a figure",
                doc="(#381, 05:31Z)")
    r.quote("7", "the rows the note ruled on", "was made on {} rows ({})", len(ruled), ranges(ruled),
            source="c1-arm-003d/SAVE-DIALOG-LOOP.md per-row counts block")
    r.artifact("7", "the ruled rows show the save-loop pattern", bool(ruled) and set(ruled) <= save_loop,
               src + ": typedExpected and ctrlS > 0 on each row SAVE-DIALOG-LOOP.md lists")
    r.quote("7", "unruled rows with the pattern", "the other {} of the {} show the same pattern", len(save_loop - set(ruled)), len(save_loop),
            source="save-loop rows minus the ruled rows")
    other = sorted(x["index"] for x in budget_rows if x["index"] not in save_loop)
    r.quote("7", "the other step-budget rows", "The other two, **rows {}**", " and ".join(map(str, other)), source=src)
    acts = {rows[i]["actions"] for i in other}
    r.check("7", "rows 13 and 21: never typed the value, no key", all(rows[i]["pressKey"] == 0 and not rows[i]["typedExpected"] for i in other),
            src + ": pressKey == 0, typedExpected false", doc="never typed the value and pressed no key")
    r.quote("7", "rows 13 and 21: action count", "all {} actions are clicks", acts.pop() if len(acts) == 1 else "?", source=src + " actions")
    r.unchecked("7", "rows 13 and 21 actions are clicks and Name-Box entries", "the extract keeps action counts, not each action's target",
                doc="Name-Box entries of a cell address")
    modified = [x for x in rows.values() if x["verdictReason"] == "modified"]
    mod = modified[0] if len(modified) == 1 else None
    r.quote("7", "the modified row", "Row {} (`modified`) typed the value, claimed `{}` after {} actions",
            mod["index"] if mod else "?", ",".join(mod["claims"]) if mod else "?", mod["actions"] if mod else "?", source=src)
    r.check("7", "the modified row typed the value and did not save", bool(mod and mod["typedExpected"] and mod["ctrlS"] == 0),
            src + ": typedExpected, ctrlS == 0", doc="left the file unsaved")
    acc = ident.get("acceptances") or [{}]
    r.quote("7", "acceptance start", "diagnosed agent cause from trial {}", acc[0].get("fromTrial", "?"), source=src + " identity.acceptances[0].fromTrial")
    false_n = sum(bool(x["falseSuccess"]) for x in rows.values())
    audited = sum(bool(x["audited"]) for x in rows.values())
    r.quote("7", "falseSuccess and audited", "falseSuccess {}/{}, but {} of {} audited", false_n, len(rows), audited, len(rows),
            source=src + " falseSuccess, audited")
    r.quote("7", "ledger sha256", "(sha256 `{}…{}`)", ext["sourceSha256"][:8], ext["sourceSha256"][-6:], source=src + " sourceSha256")
    for path, line, needle, label in (
        ("src/baseline/index.ts", 84, "falseSuccess", "`src/baseline/index.ts:84`"),
        ("src/baseline/c1-trial.ts", 63, "step-budget-asymmetry", "`src/baseline/c1-trial.ts:63`"),
        ("src/baseline/c1-trial.ts", 17, "STEP_BUDGET", "`c1-trial.ts:17`"),
    ):
        text = (ROOT / path).read_text().splitlines()
        r.check("7", f"code ref {label}", len(text) >= line and needle in text[line - 1], f"{path} line {line} contains {needle!r}", doc=label)
    micros = sum(x["micros"] for x in rows.values())
    budget = BUDGET_NOTE.read_text()
    prior_micros = int(grab(r"prior committed\s+([\d,]+) u\$", budget, default="0").replace(",", ""))
    cap_s = grab(r"approved \$(\d+\.\d\d) ceiling", budget)
    bsrc = "r6 micros + ROW7-BUDGET-DECIDED.md 'prior committed' and cap"
    r.quote("7", "spend", "**${} scored in r6** + ${} prior (`c1-arm-003d/ROW7-BUDGET-DECIDED.md`) = **${} of the ${} cap**",
            f"{micros / 1e6:.4f}", f"{prior_micros / 1e6:.4f}", f"{(micros + prior_micros) / 1e6:.4f}", cap_s, source=bsrc)
    asym = sum("step-budget-asymmetry" in x["deviations"] for x in rows.values())
    r.quote("7", "gap: asymmetry rows", "`step-budget-asymmetry` on all {} rows", asym, source=src + " deviations")
    trial = (ROOT / "src/baseline/c1-trial.ts").read_text()
    r.quote("7", "gap: planner steps", "gets {} planner steps", grab(r"export const STEP_BUDGET = (\d+);", trial),
            source="src/baseline/c1-trial.ts STEP_BUDGET")
    r.quote("7", "gap: budget exhaustion", "{} of the {} baseline failures are budget exhaustion", len(budget_rows), tally["refuted"], source=src)
    r.quote("7", "gap: C2 rows", "C2 was not run ({} rows)", ext["c2Rows"], source=src + " c2Rows")
    r.unchecked("7", "gap (2), (3): no per-row fixture hash; transcripts carry no frames", "statements about what the ledger lacks; the extract drops those fields either way",
                doc=("r6 rows record no per-row fixture hash", "The transcripts carry no frames"))

    # Slots
    r.unchecked("slots", "section heading: row 7, TIF-90", "the section title's cross-reference, not a figure", doc=("## Row 7 slots", "criterion 7 evidence", "the reasons in row 7"))
    r.unchecked("slots", "Wilson 95% (the interval's level)", "the confidence level m1-scorecard.wilson uses, a label not a result", doc="Wilson 95% on")
    r.quote("slots", "baseline pass rate", "**{}/{} verified** ({} refuted: `step-budget` {}, `modified` {})",
            tally.get("verified", 0), len(rows), tally["refuted"], reason["step-budget"], reason["modified"], source=src)
    r.quote("slots", "paired table + sign test", "**b = {}** (Myco only), **c = {}** (baseline only), both refuted {}, **p = {}** two-sided",
            myco_only, base_only, len(both), p_text, source="row7-compare sign_test_two_sided")
    lo, hi = scorecard.wilson(tally.get("verified", 0), len(rows))
    vlo, vhi = scorecard.wilson(v3["verified"], v3["recorded"])
    r.quote("slots", "Wilson 95%", "**{}–{}** (Myco v3: {}–{})", f"{max(lo, 0):.3f}", f"{hi:.3f}", f"{vlo:.3f}", f"{vhi:.3f}",
            source="m1-scorecard.wilson")
    r.quote("slots", "spend", "**${}** r6 + ${} prior = **${} of ${}**", f"{micros / 1e6:.4f}", f"{prior_micros / 1e6:.4f}",
            f"{(micros + prior_micros) / 1e6:.4f}", cap_s, source=bsrc)
    r.unchecked("slots", "arm-002 retraction: 16 rows, 1 of 16 did", "a retraction about arm-002 (not scored); the count is from "
                "c1-arm-002/accounting.json, which this script does not parse", doc='16 rows "typed\nthe correct value and never saved" (1 of 16 did)')

    # Save-dialog section (r6's first 9 rows, and the resume command)
    sd = "save-dialog"
    nine = [rows[i] for i in ruled]
    r.unchecked(sd, "diagnosis date and PRs", "the note's date and PR references, not figures",
                doc=("Diagnosed 2026-11-24", "(#381)", "#382"))
    r.quote(sd, "rows the diagnosis covered", "on r6's first {} scored rows**", grab(r"Counts across the (\d+) scored rows", note),
            source="SAVE-DIALOG-LOOP.md 'Counts across the N scored rows'")
    r.artifact(sd, "the note's count == the rows it lists", grab(r"Counts across the (\d+) scored rows", note) == str(len(ruled)),
               "SAVE-DIALOG-LOOP.md count vs its per-row block")
    r.quote(sd, "rows, step-budget rows with the pattern", "Across all {} rows, {} of the\n{} step-budget failures show the pattern; rows {} do not",
            len(rows), len(save_loop), len(budget_rows), " and ".join(map(str, other)), source=src)
    r.unchecked(sd, "(row 7) cross-reference", "a pointer to the criterion row, not a figure", doc="do not (row 7)")
    r.quote(sd, "typed the correct value", "| rows that typed the **correct value** into the **correct cell** | **{} of {}** |",
            sum(x["typedExpected"] for x in nine), len(nine), source=src + " typedExpected (value only; the cell is not in the extract)")
    r.quote(sd, "attempted a save", "| rows that attempted a save | **{} of {}** |", sum(x["ctrlS"] > 0 for x in nine), len(nine), source=src + " ctrlS")
    r.quote(sd, "completed a save", "| rows that completed a save | **{} of {}** |", sum(x["verdict"] == "verified" for x in nine), len(nine),
            source=src + " verdict == verified (no row persisted the value)")
    presses = sum(x["ctrlS"] for x in nine)
    r.quote(sd, "Ctrl+S presses and share", "followed by `Escape` | **{} of {} ({}%)**", "61", presses, round(61 * 100 / presses) if presses else "?",
            source=src + " sum of ctrlS; 61 as quoted (unchecked below); the share is 61 / that sum")
    r.unchecked(sd, "61 Ctrl+S immediately followed by Escape", "needs the action order; the extract keeps per-row counts only", doc="**61 of")
    pure = grab(r"Row (\d+) is the cleanest evidence", note)
    pure_row = rows.get(int(pure)) if pure.isdigit() else None
    r.quote(sd, "the pure case", "Row {} is the pure case — `click → Ctrl+S → Escape` repeated {} times", pure,
            word(pure_row["ctrlS"]) if pure_row and pure_row["ctrlS"] == pure_row["escape"] else "?",
            source="SAVE-DIALOG-LOOP.md 'Row N is the cleanest evidence' + " + src + " ctrlS == escape on that row")
    r.quote(sd, "edit lands", "the edit lands in\n{}/{} rows", sum(x["typedExpected"] for x in nine), len(nine), source=src + " typedExpected")
    sweep_ts = (ROOT / "src/baseline/sweep.ts").read_text()
    r.quote(sd, "abort threshold", "anything unaccepted still aborts at {}", grab(r"if \(consecutive >= (\d+)", sweep_ts),
            source="src/baseline/sweep.ts abort-early rule")
    cap_micros = int(round(float(cap_s) * 1e6)) if cap_s != "?" else 0
    r.quote(sd, "resume command spend env", "MYCO_PRIOR_SPEND_MICROS={} MYCO_ARM_LIMIT_MICROS={}", prior_micros, cap_micros - prior_micros,
            source="ROW7-BUDGET-DECIDED.md prior committed micros, and the cap minus it")


def check_durability(r: Report, v3: dict, scorecard) -> None:
    r.unchecked("durability", "section date (M1-016, 2026-11-23); rows 1–6 once cited /tmp", "the doc's own history, not figures from an artifact",
                doc=("2026-11-23", "Rows 1–6 previously cited"))
    r.quote("durability", "v3 pack size", "| `docs/research/experiments/m1-013-sweep-v3/` | **{} KiB** |", kib(V3), source="sum of file sizes")
    r.quote("durability", "m1-014 pack size", "| `docs/research/experiments/m1-014-combined-audit/` | **{} KiB** |", kib(AUDIT), source="sum of file sizes")
    r.quote("durability", "v3 rows", "| {} rows: `trials.jsonl`", v3["recorded"], source="m1-scorecard.score")
    summary = json.loads((AUDIT / "summary.json").read_text())
    r.quote("durability", "m1-014 eligible", "| {} eligible corrupted trials:", summary["withVerdict"], source="m1-014 summary.json withVerdict")
    head = scorecard.markdown(v3).splitlines()[0].strip("*").rstrip(".")
    r.quote("durability", "reliability regenerated", "**{}**, Wilson 95% {}–{}", head.replace("Reliability: ", ""),
            f"{v3['wilson95'][0]:.2f}", f"{v3['wilson95'][1]:.2f}", source="m1-scorecard.markdown + wilson95")

    pairs = [d for d in RUNS.glob("*/trial-*") if (d / "result.json").is_file()]
    r.quote("viewer", "committed trials", "All {} trials cost", len(pairs), source="m1-runs/*/trial-*/result.json")
    r.unchecked("viewer", "504 KB", "disk usage (du), which depends on the filesystem's block size; the byte total differs", doc="504 KB")
    sizes = [sum(f.stat().st_size for f in d.iterdir() if f.name in ("result.json", "trace.jsonl")) for d in pairs]
    mean = sum(sizes) / len(sizes) / 1024 if sizes else 0
    r.unchecked("viewer", "~8 MB of PNGs, ~8 KB per result + trace",
                f"approximations ('~'); screenshots are not committed, and the committed pairs average {mean:.1f} KiB",
                doc=("~8 MB", "~8 KB"))


def check_row_8(r: Report, scorecard) -> None:
    row = r.segment("8")
    files = sum(1 for f in TOOLCHAIN.rglob("*") if f.is_file())
    if "#206)" in row:
        r.quote("8", "toolchain files", "({} files, #206)", files, source="files under docs/env/vm-toolchain/")
    else:
        r.skipped("8", "toolchain files", f"row 8 no longer quotes the toolchain file count (the tree has {files})")
    named = ["build-all.sh", "build-win-iso.sh", "build-seed-iso.sh", "create-vm.sh", "convert-disk-virtio.sh", "vm.sh",
             "reset.sh", "wait-ssh.sh", "vssh", "shutdown.sh", "set-cd.sh", "guest", "seed"]
    quoted = [n for n in named if f"`{n}" in row]
    absent = [n for n in quoted if not (TOOLCHAIN / n).exists()]
    if quoted:
        r.check("8", "named toolchain files exist", not absent, "docs/env/vm-toolchain/", doc=tuple(f"`{n}" for n in quoted),
                detail=f"absent {absent}" if absent else "")
    r.unchecked("8", "lead ruling B date, plan steps 2–7, 1 and 8",
                "a ruling's date and the test plan's own step numbers (this doc's table), not figures from an artifact",
                doc=("every test-plan step 2–7", "plan steps 1 and 8", "2026-11-25", "**Plan step 1**", "**Plan step 8**", "outside row 8's test plan"))

    # Operator findings and sessions.
    report = (ROW8 / "OPERATOR-REPORT.md").read_text() if (ROW8 / "OPERATOR-REPORT.md").is_file() else ""
    in_report = sorted({int(n) for n in re.findall(r"\bF(\d+)\b", report)})
    contiguous = bool(in_report) and in_report == list(range(1, in_report[-1] + 1))
    r.artifact("8", "the committed operator report's findings", contiguous,
               "m1-row8/OPERATOR-REPORT.md", f"F1–F{in_report[-1]}, contiguous" if contiguous else f"found {in_report}")
    last = f"F{in_report[-1]}" if in_report else "none"
    r.unchecked("8", "findings F1–F21 and G-findings up to G38",
                f"the committed m1-row8/OPERATOR-REPORT.md records findings up to {last} only; the later F-findings and "
                "the G-findings are in later host-only operator reports, so the upper bounds F21 and G38 cannot be recomputed",
                doc=("F1–F21", "G38"))
    next_run = (ROW8 / "NEXT-RUN.md").read_text() if (ROW8 / "NEXT-RUN.md").is_file() else ""
    r.quote("8", "the §6 finding for skipping §3 and §4", "without the §3 reset and §4 deploy that §6 asks for first ({})",
            grab(r"skips §3 reset and §4 deploy.*?\((F\d+)\)", next_run), source="m1-row8/NEXT-RUN.md, the finding it gives for skipping §3/§4")
    corrupt_readme = (CORRUPT / "README.md").read_text() if (CORRUPT / "README.md").is_file() else ""
    g = re.search(r"findings G(\d+)–G(\d+)", corrupt_readme)
    r.check("8", "G23 is a §7.4 operator finding", bool(g and int(g.group(1)) <= 23 <= int(g.group(2))),
            "m1-row8-corrupt/README.md: the §7.4 operator's findings are " + (f"G{g.group(1)}–G{g.group(2)}" if g else "not listed"),
            doc="under host load 13–15 (G23)")
    r.unchecked("8", "G35: no §8.3 derivation rule outside sweep v3", "the G-finding is in a host-only operator report, not committed", doc="(G35)")
    # Unconditional: when the row stops saying one of these, the entry reports a MISMATCH
    # ("no longer says"), so a reworded figure cannot silently leave the inventory.
    for claim, why, doc in (
        ("three of the six operator sessions used a fresh clone",
         "operator-session provenance from the host-only reports; no committed artifact records it", "Three of the six operator sessions"),
        ("first §7.3 sweep: 11 rows (7 verified, 3 refuted, 1 uncertain), at most 26/30 reachable, 3 of 4 misses from the 15 s bug",
         "the abandoned sweep's ledger is deliberately not committed (m1-row8-sweep2/README.md says none of its rows are in that ledger)",
         ("abandoned at 11 rows (7 verified, 3 refuted, 1 uncertain, at most 26/30 reachable)",
          "three of its four misses tracing to the 15 s timeout bug")),
        ("§1.2 `pnpm test` failed 43 of 1,080 on 5 s timeouts under host load 13–15",
         "the operator's host-side test run, not committed", "failed 43 of 1,080 on 5 s timeouts under host load 13–15"),
    ):
        r.unchecked("8", claim, why, doc=doc)
    r.unchecked("8", "validate-live falsely reports ALL OK on 0 files (TIF-223)",
                "a statement about validate-live's behaviour, not a figure; stale since #433 fixed TIF-223 (the row still says it)",
                doc="ALL OK on 0 files")

    # §6 generator proof: the fresh operator's run is host-only; the committed one is S6-PASS.
    r.unchecked("8", "§6 fresh operator: 2026-11-24 11:42–11:59Z, 20/20 verified, exit 0",
                "the row itself says this is in the host-only operator report, not committed",
                doc="2026-11-24 11:42–11:59Z gave 20/20 verified, exit 0")
    s6 = ROW8 / "s6-evidence/rows.json"
    if s6.is_file():
        s6_rows = json.loads(s6.read_text())
        r.quote("8", "the committed earlier §6 run", "is an earlier {}/{} by the coordinator",
                sum(x["status"] == "verified" for x in s6_rows), len(s6_rows), source="m1-row8/s6-evidence/rows.json status (S6-PASS.md's run)")
    else:
        r.skipped("8", "the committed earlier §6 run", "m1-row8/s6-evidence/rows.json is not in the tree")

    if "m1-row8-sweep2" not in row:
        r.skipped("8", "§7.3 sweep figures", "row 8 does not cite m1-row8-sweep2, so it quotes none of its numbers")
    elif not SWEEP2.is_dir():
        r.skipped("8", "§7.3 sweep figures", "row 8 cites m1-row8-sweep2 but the pack is not in the tree")
    else:
        s2 = scorecard.score(SWEEP2 / "trials.jsonl")
        src = "m1-scorecard.score(m1-row8-sweep2/trials.jsonl)"
        r.quote("8", "sweep verified", "**{}/{} verified**", s2["verified"], s2["denominator"], source=src)
        r.quote("8", "sweep verified, second mention", "the {}/{} sweep", s2["verified"], s2["denominator"], source=src)
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
            r.artifact("8", "validate-live all OK", cbad + sbad == 0, "both row-8 schema-validation.log files", f"{cbad + sbad} lines not ALL OK")
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
    r.check("8", "recorder --final rebuilds ledger + summary byte-identical", proc.returncode == 0 and same,
            "m1-corrupt-suite-record.py --final on a copy of m1-row8-corrupt/",
            doc="`m1-corrupt-suite-record.py --final` rebuilt the ledger and summary byte-identical",
            detail=proc.stderr.strip()[-300:] if proc.returncode else "")
    eligible = sum(g["eligible"] for g in summary["groups"])
    src = "m1-corrupt-suite-record.py --final summary"
    r.quote("8", "corrupted-suite figures",
            "{}/{} recorded and eligible, {} verified / {} refuted / {} uncertain, **{} false successes**, {} unproven, ledger {} rows with {} unaccounted",
            summary["total"], eligible, summary["verified"], summary["refuted"], summary["uncertain"], summary["falseSuccesses"],
            summary["unprovenVerified"] + summary["unprovenRecovery"], summary["ledger"]["rows"], summary["ledger"]["unaccounted"], source=src)
    r.check("8", "every recovery trial verified", all(x["verdict"] == "verified" for x in summary["recoveryResults"]), src + " recoveryResults",
            doc="every recovery trial verified")
    log = (CORRUPT / "deploy-check.log").read_text() if (CORRUPT / "deploy-check.log").is_file() else ""
    r.quote("8", "deploy copy", "`verified {} files on the guest`", grab(r"verified (\d+) files on the guest", log), source="m1-row8-corrupt/deploy-check.log")
    r.check("8", "`DEPLOY OK`", "DEPLOY OK" in log, "m1-row8-corrupt/deploy-check.log", doc="`DEPLOY OK`")
    r.unchecked("8", "reset 250 s, deploy 201 s; session_info session_id 1 / WinSta0 / exit 0",
                "stated in the pack README from the operator's session; no committed log records the timings or the session_info output",
                doc=("reset 250 s, deploy 201 s", "`session_id 1`, `WinSta0`, exit 0"))


def subchecks(r: Report, doc: Path) -> None:
    for name, cmd in (
        ("check-scorecard-links.py", [sys.executable, "scripts/check-scorecard-links.py", str(doc)]),
        ("scorecard-viewer-links.py --check", [sys.executable, "scripts/scorecard-viewer-links.py", "--check"]),
    ):
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        tail = (proc.stdout + proc.stderr).strip().splitlines()
        r.tool("links", name, proc.returncode, "exit " + str(proc.returncode) + (": " + tail[-1] if tail and proc.returncode else ""))


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
    sections = r.classify_sections()
    check_status(r)
    v3 = check_rows_1_to_3(r, scorecard)
    check_rows_4_to_6(r)
    check_row_7(r, doc, scorecard, row7, v3)
    check_durability(r, v3, scorecard)
    check_row_8(r, scorecard)
    if not args.no_subchecks:
        subchecks(r, doc)
    r.sweep_references()
    r.sweep_numbers()

    def label(where: str) -> str:
        return f"row {where}" if where.isdigit() else where

    if args.inventory_md:
        print("| Where | Claim | Status | Source / reason |")
        print("|---|---|---|---|")
        for where, claim, status, detail in r.rows:
            print(f"| {label(where)} | {claim} | {status} | {detail.replace('|', chr(92) + '|')} |")
    else:
        for where, claim, status, detail in r.rows:
            print(f"{status:<12}  {label(where):<12} {claim} — {detail}")
    print("\nSections:")
    for heading, kind in sections:
        reason = next((v for k, v in {**SUBCHECKED, **OUT_OF_SCOPE}.items() if heading.startswith(k)), "")
        print(f"  {kind:<13} {heading}" + (f" — {reason}" if reason else ""))
    print("  in scope      (preamble, status line and criterion rows 1–8)")
    counts = Counter(status for _, _, status, _ in r.rows)
    bad = r.mismatches()
    out_n = sum(1 for _, k in sections if k == "out of scope")
    print(f"\n{counts['ok']} ok, {counts['MISMATCH']} mismatch, {counts['UNATTRIBUTED']} unattributed, "
          f"{counts['unchecked']} not machine-checked, {counts['artifact']} artifact-consistency, {counts['skipped']} skipped, "
          f"{counts['swept']} sections swept clean; "
          f"{out_n} sections out of scope")
    if bad:
        for where, claim, status, detail in bad:
            print(f"{status} {label(where)}: {claim}: {detail}", file=sys.stderr)
        return 1
    print("SCORECARD CHECK OK: every number in the in-scope sections matches its committed artifact or is listed as unchecked")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
