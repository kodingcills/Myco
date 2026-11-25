#!/usr/bin/env python3
"""Recompute the numbers in docs/m1-scorecard.md's in-scope sections from committed artifacts.

  scorecard-check.py [--doc PATH] [--inventory-md] [--no-subchecks]

Row 8 step 8 of the reproducibility test plan, as re-scoped by the lead (2026-11-25):
a script recomputes the numbers in the scorecard from committed artifacts and fails on
any mismatch. Prose byte-identity is not required; the numbers are.

Scope. Every line of the doc is classified (code fences are skipped when looking for
headings). Line 1 is the title `# M1 scorecard`; everything from there to the `| # |`
table header is the preamble (swept). The criterion table must hold exactly one
`| N |` line for each row 1-8, in any order; a duplicate, unexpected or non-row table
line fails, and so does a `| N |` line anywhere else. Between the table and the first
heading only blank lines are allowed. Every heading of any level (`#`, `##`, `###`,
...) starts a section that runs to the next heading, and must match exactly one entry
below; an unknown heading or a second section under a known one fails. The
classification is printed.
  in scope     the preamble and status line, criterion rows 1-8, "M1 sign-off", "Open a
               trial in the viewer", "Evidence durability", "Row 7 slots", "Decision: arm-002 is not
               the baseline", "Second reason arm-002 is superseded", "The C1
               baseline's characteristic failure mode" (with its resume command) and
               "Open risk: guest-side fixture convert";
  sub-checks   "Trial traces": its links and run ids are held by the two link checkers
               below, not by the number sweep;
  out of scope the reproducibility test plan and "Reliability row, regenerate".
               OUT_OF_SCOPE names each with its reason, and the output lists them.

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
sections must lie inside the doc text of some claim, checked or unchecked. Any token
no claim covers is printed as UNATTRIBUTED and exits 1. Tokens:
  - the references `TIF-N`, `#N`, `PR #N`, `§N.N`, `FN`, `GN`, short hex commit ids,
    dates and clock times, matched whole. References are not auto-attributed: each one
    in the doc is named, with its context, by an explicit claim (check_references and
    the per-row inventories), so a new, removed or renumbered reference fails;
  - every other digit run whose preceding character (ignoring a `$`) is not a letter,
    digit, `_` or `-`. What follows does not matter: `31.` at a sentence end, `31.5`,
    `1,080`, `3.7e-9`, `$31`, `31s`, `31x`, `31KiB`, `31st` are all numbers. After a
    `-` the digits count when everything before them in the word is digits and
    hyphens, so both ends of `31-40` count;
  - a word whose digits are preceded inside it by a letter, `-` or `_` (`m1-013`,
    `ARM64`, `r6`, `trial-0`, `n31`, `rerun-31`) is an identifier only if it is in
    IDENTIFIERS, the exhaustive list of such words in the committed doc; any other
    such word is itself a token, so `n31` or `rerun-31` cannot carry a figure past
    the sweep. `--identifiers` prints the words skipped and the list.
Not swept, by design: an enumerator `(N) ` at a clause start (line start, or after
`. `, `: `, `; `, `| `) numbered 1, 2, 3, ... in order within its segment (row 7's
gap list); any other `(7)` is a number. Also not swept: the `| N |` row number, and
spelled-out numbers (`seven`, `nine`), which appear too often in plain prose to sweep
without noise. Spelled-out figures are still checked wherever a claim quotes them
(e.g. row 5's "Four", "three", "seven").

Recomputation reuses the existing tools rather than re-deriving them:
  - scripts/m1-scorecard.py         score() and wilson(): rows 1, 3, 8 and the slots;
  - scripts/row7-compare.py         compare --check, run in process against --doc, as a
                                    second reader of row 7; this script also quotes each
                                    of those figures itself, so the sweep covers them;
  - scripts/m1-corrupt-suite-ledger.ts   the conformance-ledger audit (rows 4, 6, 8);
  - scripts/m1-corrupt-suite-record.py --final   re-run on a copy of the row 8
                                    corrupted pack, which must rebuild ledger.jsonl and
                                    summary.json byte-identical;
  - c1-arm-002/accounting.json and report.json: the two arm-002 sections and the
                                    slots' retraction; c1-arm-003/r2-void for r2's trials;
  - research/experiments/m1-013-convert-timeout.md: the open-risk timings;
  - m1-row8-step1/operator-report-{3,4}.md: row 8's plan-step-1 cold-operator figures;
  - c1-arm-001/spike-trial-0.json: the spike trial's committed spend;
  - src/baseline/planner.ts and src/integration/validate-live.ts: code symbols a row names;
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
STEP1 = EXP / "m1-row8-step1"
TOOLCHAIN = ROOT / "docs/env/vm-toolchain"
RUNS = EXP / "m1-runs"
ARM2 = EXP / "c1-arm-002"
SPIKE = EXP / "c1-arm-001/spike-trial-0.json"
VISION = ROOT / "docs/product/vision.md"

WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine"}

# Sections, keyed by a prefix of their heading. In-scope sections are swept; the rest
# are listed in the output with the reason they are not.
IN_SCOPE = {
    "## M1 sign-off": "signoff",
    "## Open a trial in the viewer": "viewer",
    "## Evidence durability": "durability",
    "## Row 7 slots": "slots",
    "## Decision: arm-002 is not the baseline": "arm002-decision",
    "## Second reason arm-002 is superseded": "arm002-truncation",
    "### The C1 baseline's characteristic failure mode": "save-dialog",
    "## Open risk: guest-side fixture convert": "open-risk",
}
SUBCHECKED = {
    "## Trial traces": "per-trial links and run ids; held by check-scorecard-links.py and "
                       "scorecard-viewer-links.py --check, not by the number sweep",
}
OUT_OF_SCOPE = {
    "## Reproducibility test plan": "the plan's pass conditions (20/20, 30 rows, step numbers, the 3–4 h estimate) "
                                    "are specifications, not results from an artifact",
    "## Reliability row, regenerate": "how to run m1-scorecard.py and its counting rules (the denominator 30, Wilson 95%), "
                                      "restated from the script's header; the regenerated numbers themselves are checked "
                                      "in rows 1 and 3 and under durability",
}
TITLE = "# M1 scorecard"
ROWS = [str(n) for n in range(1, 9)]
HEADING = re.compile(r"#{1,6} ")
ROW_LINE = re.compile(r"\| *(\d+) *\|")
IDENTIFIER_WORDS = (
    # names of arms, runs, sweeps, milestones, files, tools and the model
    "ARM64", "Arm-002", "Arm-003", "C1", "C2", "c1-arm-001", "DF-S01", "M1", "M1-013", "M1-014", "M1-016", "ROW7-BUDGET-DECIDED",
    "S6-PASS", "WinSta0", "arm-002", "arm-003", "arm-003d", "c1-arm-002", "c1-arm-003", "c1-arm-003-design",
    "c1-arm-003d", "c1-baseline", "c1-parity", "c1-r6", "c1-trial", "c1ChargedMicros", "claude-sonnet-5-5",
    "cua-c1-base", "m1-013", "m1-013-convert-timeout", "m1-013-sweep-v3", "m1-014", "m1-014-combined-audit",
    "m1-corrupt-suite-record", "m1-row8", "m1-row8-corrupt", "m1-row8-step1", "m1-row8-sweep2", "m1-runs", "m1-scorecard", "python3",
    "r2", "r3", "r6", "row-7", "row-8", "row7-compare", "sha256", "spike-trial-0", "trial-0", "v2", "v3",
)


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


# Number-like tokens. References, commit ids, dates and clock times are matched whole
# and masked first; then every remaining digit run is classified by number_tokens().
SPECIAL = re.compile(
    r"TIF-\d+|(?:PR )?#\d+|§\d+(?:\.\d+)*|\b[FG]\d+\b"
    r"|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,40}\b"
    r"|\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}Z?"
)
NUMBER = re.compile(r"\d+(?:,\d{3})*(?:\.\d+)*(?:e-\d+)?")
WORD_CHAR = re.compile(r"[A-Za-z0-9_\-]")
RANGE_PREFIX = re.compile(r"(?:\d+-)+")
# A genuine enumerator: `(N) ` at a clause start (line start, or after `. `, `: `, `; `,
# `| `), numbered 1, 2, 3, ... in order within its segment.
ENUMERATOR = re.compile(r"(?:^|(?<=[.:;|] ))\((\d{1,2})\)(?= )", re.M)
# Every word in the swept segments whose digits are preceded, inside the word, by a
# letter or `-` (or `_`). These are names, not figures, and are skipped; any other such
# word (say `n31` or `rerun-31`) is a token the sweep requires a claim for. Exhaustive
# for the committed doc: test/scorecard-check.test.ts holds it to the doc both ways.
IDENTIFIERS = frozenset(IDENTIFIER_WORDS)


def number_tokens(seg: str, skip: int = 0) -> tuple[list[tuple[int, int, str]], set[str]]:
    """(tokens, identifier words skipped) for one segment of the doc.

    A digit run counts as a number when the character before it (ignoring a `$`) is not
    a letter, digit, `_` or `-`; what follows does not matter, so `31.` at a sentence end,
    `31.5`, `31s`, `31x`, `31KiB` and `31st` all count. After a `-` it counts only when
    everything before it in the word is digits and hyphens, so both ends of `31-40`
    count. Otherwise it is inside a word (`m1-013`, `ARM64`, `r6`, `trial-0`): the word
    is skipped if it is in IDENTIFIERS and is itself a token if not. Enumerators (above)
    and anything before `skip` (a criterion row's `| N |`) are not tokens.
    """
    chars = list(seg)

    def mask(s: int, e: int) -> None:
        chars[s:e] = " " * (e - s)

    expected = 1
    for m in ENUMERATOR.finditer(seg):
        if int(m.group(1)) == expected:
            mask(m.start(), m.end())
            expected += 1
    out: list[tuple[int, int, str]] = []
    for m in SPECIAL.finditer("".join(chars)):
        out.append((m.start(), m.end(), m.group(0)))
        mask(m.start(), m.end())
    text = "".join(chars)
    idents: set[str] = set()
    words: set[int] = set()
    for m in NUMBER.finditer(text):
        s = m.start()
        p = s - 1 if s > 0 and text[s - 1] != "$" else s - 2
        before = text[p] if p >= 0 else " "
        w0 = s
        while w0 > 0 and WORD_CHAR.match(text[w0 - 1]):
            w0 -= 1
        internal = before.isalnum() or before == "_" or (before == "-" and not RANGE_PREFIX.fullmatch(text[w0:s]))
        if not internal:
            out.append((s, m.end(), m.group(0)))
            continue
        w1 = m.end()
        while w1 < len(text) and WORD_CHAR.match(text[w1]):
            w1 += 1
        if w0 in words:
            continue
        words.add(w0)
        if text[w0:w1] in IDENTIFIERS:
            idents.add(text[w0:w1])
        else:
            out.append((w0, w1, text[w0:w1]))
    return sorted(t for t in out if t[0] >= skip), idents


class Report:
    def __init__(self, doc_text: str):
        self.text = doc_text
        self.rows: list[tuple[str, str, str, str]] = []  # (where, claim, status, detail)
        self.spans: dict[str, list[tuple[int, int]]] = {}
        self.segs: dict[str, str] = {}
        self.sections: list[tuple[str, str]] = []  # (heading, class)
        self.layout: list[tuple[str, str]] = []  # (what, detail): each one is a MISMATCH
        self.identifiers: set[str] = set()
        self._parse()

    # -- where claims live -------------------------------------------------------------
    def _parse(self) -> None:
        """Classify every line of the doc: the title and preamble, the criterion table
        (one line per row 1-8), and one section per heading (any level, outside code
        fences). Anything else -- an unknown or duplicate heading, an unexpected or
        duplicate row, text between the table and the first heading -- is a layout
        MISMATCH."""
        lines = self.text.splitlines(keepends=True)
        offs = [0]
        for line in lines:
            offs.append(offs[-1] + len(line))
        fence, heads, body = False, [], []
        for i, line in enumerate(lines):
            if line.startswith("```"):
                fence = not fence
            elif not fence:
                body.append(i)
                if HEADING.match(line):
                    heads.append(i)
        if not lines or lines[0].rstrip("\n") != TITLE:
            self.layout.append(("title", f"the first line must be {TITLE!r}"))
        elif heads and heads[0] == 0:
            heads.pop(0)
        h = next((i for i in body if lines[i].startswith("| # |")), None)
        if h is None:
            self.layout.append(("criterion table", "no `| # |` table header"))
            h = heads[0] if heads else len(lines)
        if any(i < h for i in heads):
            self.layout.append(("criterion table", "a heading comes before the criterion table"))
        self.segs["status"] = self.text[: offs[h]]
        t = h + 1 if h < len(lines) else h
        if t < len(lines) and lines[t].startswith("|---"):
            t += 1
        while t < len(lines) and lines[t].startswith("|"):
            m = ROW_LINE.match(lines[t])
            n = m.group(1) if m else None
            if n is None:
                self.layout.append(("criterion table", f"a table line that is not a criterion row: {lines[t][:60]!r}"))
            elif n in self.segs:
                self.layout.append(("criterion table", f"duplicate criterion row {n}"))
            elif n not in ROWS:
                self.layout.append(("criterion table", f"unexpected criterion row {n}; this script checks rows 1-8"))
            else:
                self.segs[n] = lines[t].rstrip("\n")
            t += 1
        table_end = t
        for n in ROWS:
            if n not in self.segs:
                self.layout.append(("criterion table", f"criterion row {n} is missing"))
        first = next((i for i in heads if i >= table_end), len(lines))
        for i in range(table_end, first):
            if lines[i].strip():
                self.layout.append(("between table and sections", f"unclassified text: {lines[i].strip()[:60]!r}"))
        for i in body:
            if not h <= i < table_end and ROW_LINE.match(lines[i]):
                self.layout.append(("criterion table", f"a criterion row outside the criterion table: {lines[i][:40]!r}"))
        seen: set[str] = set()
        for k, i in enumerate(heads):
            heading = lines[i].rstrip("\n")
            end = offs[heads[k + 1]] if k + 1 < len(heads) else len(self.text)
            key, kind = next(((key, c) for table, c in ((IN_SCOPE, "in scope"), (SUBCHECKED, "sub-checks"),
                                                        (OUT_OF_SCOPE, "out of scope"))
                              for key in table if heading.startswith(key)), (None, "UNCLASSIFIED"))
            if key is None:
                self.layout.append((heading, "a heading this script does not classify; add it to IN_SCOPE, SUBCHECKED or OUT_OF_SCOPE"))
            elif key in seen:
                self.layout.append((heading, "a second section under a heading already classified"))
                kind = "DUPLICATE"
            else:
                seen.add(key)
                if key in IN_SCOPE:
                    self.segs[IN_SCOPE[key]] = self.text[offs[i]:end]
            self.sections.append((heading, kind))

    def segment(self, where: str) -> str:
        return self.segs.get(where, "")

    def in_scope(self) -> list[str]:
        return ["status", *ROWS, *IN_SCOPE.values()]

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

    def refs(self, where: str, why: str, doc: tuple[str, ...]) -> None:
        """References to issues, PRs and runbook sections, each named with its context."""
        self.unchecked(where, "references: " + ", ".join(doc), why, doc)

    def skipped(self, where: str, claim: str, why: str) -> None:
        self.rows.append((where, claim, "skipped", why))

    def mismatches(self) -> list[tuple[str, str, str, str]]:
        return [r for r in self.rows if r[2] in ("MISMATCH", "UNATTRIBUTED")]

    # -- coverage ----------------------------------------------------------------------
    def tokens(self, where: str) -> list[tuple[int, int, str]]:
        toks, idents = number_tokens(self.segment(where), len(f"| {where} |") if where.isdigit() else 0)
        self.identifiers |= idents
        return toks

    def covered(self, where: str, start: int, end: int) -> bool:
        return any(s <= start and end <= e for s, e in self.spans.get(where, []))

    def sweep_numbers(self) -> None:
        for where in self.in_scope():
            toks = self.tokens(where)
            loose = [t for s, e, t in toks if not self.covered(where, s, e)]
            if loose:
                self.rows.append((where, "number sweep", "UNATTRIBUTED",
                                  f"no checked or unchecked claim covers {loose}; add one to the inventory"))
            else:
                self.rows.append((where, "number sweep", "swept", f"all {len(toks)} number-like tokens attributed"))

    def classify_sections(self) -> list[tuple[str, str]]:
        """(heading, class) for every section; every layout problem is a MISMATCH."""
        for what, detail in self.layout:
            self.rows.append(("layout", what, "MISMATCH", detail))
        return self.sections


def check_status(r: Report) -> None:
    done = [n for n in ROWS if re.match(rf"\| {n} \|[^|]*\| \*\*DONE", r.segment(n))]
    r.quote("status", "rows DONE", "All {} rows are DONE", len(done) if len(done) == len(ROWS) else f"{len(done)} of {len(ROWS)}",
            source="the Status column of criterion rows 1-8, each starting **DONE")
    r.check("status", "row 8 is DONE given the VM bundle", "DONE (given the VM bundle)" in r.segment("8"),
            "row 8's Status column", doc="Row 8 is DONE given the VM bundle")
    r.unchecked("status", "As of 2026-11-25", "the doc's own date, not a figure from an artifact", "As of 2026-11-25")


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
    r.quote("slots", "Wilson 95%", "**{}–{}** (Myco v3: {}–{})", f"{lo:.3f}", f"{hi:.3f}", f"{vlo:.3f}", f"{vhi:.3f}",
            source="m1-scorecard.wilson")
    r.quote("slots", "spend", "**${}** r6 + ${} prior = **${} of ${}**", f"{micros / 1e6:.4f}", f"{prior_micros / 1e6:.4f}",
            f"{(micros + prior_micros) / 1e6:.4f}", cap_s, source=bsrc)

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
    r.unchecked("8", "lead ruling B date; test-plan step numbers 1–8, 1, 8 and 2–7",
                "a ruling's date and the test plan's own step numbers (this doc's table), not figures from an artifact",
                doc=("test-plan steps 1–8 met", "2026-11-25", "**Plan step 1, a cold operator", "**Plan step 8, as re-scoped:**",
                     "**Steps 2–7, earlier segmented runs:**", "outside row 8's test plan"))
    r.unchecked("8", "plan step 8: scorecard-check.py exits 0",
                "a statement about this script; this run's own exit status is the check", doc="from committed artifacts and exits 0")
    check_row_8_step1(r, row)

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


def check_row_8_step1(r: Report, row: str) -> None:
    """Plan step 1: the two cold-operator reports committed in m1-row8-step1/."""
    first = (STEP1 / "operator-report-3.md").read_text() if (STEP1 / "operator-report-3.md").is_file() else ""
    rerun = (STEP1 / "operator-report-4.md").read_text() if (STEP1 / "operator-report-4.md").is_file() else ""
    r.check("8", "the step-1 pack holds both operator reports", bool(first and rerun),
            "m1-row8-step1/operator-report-3.md and operator-report-4.md", doc="(`docs/research/experiments/m1-row8-step1/`)")
    steps = {m.group(1): m.group(2) for m in re.finditer(r"^### (Step \w+) — (.*?)(?=^### |^## )", rerun, re.M | re.S)}
    reset, deploy, desk, gen, card = (steps.get(k, "") for k in ("Step 1a", "Step 1", "Step 2", "Step 3", "Step 4"))
    src = "m1-row8-step1/operator-report-4.md"
    r.quote("8", "re-run §3.1 reset", "§3.1 reset ({} s, `ready on '{}'`)", grab(r"wall (\d+) s", reset),
            grab(r"Result: exit 0, `reset-trial-vm: ready on '([^']+)'`", reset), source=src + " Step 1a wall and result")
    r.quote("8", "re-run §4 deploy", "§4 deploy ({} s, `verified {} files` + `DEPLOY OK`)", grab(r"wall (\d+) s", deploy),
            grab(r"Result: exit 0\. `==> verified (\d+) files on the guest", deploy) if "`DEPLOY OK`" in deploy else "?",
            source=src + " Step 1 wall, exit 0, the verified line and DEPLOY OK")
    r.quote("8", "re-run §5 desktop proof", '§5 desktop proof (`"session_id":{}`, `"{}"`, exit {})',
            grab(r'stdout `\{"session_id":(\d+),', desk), grab(r'"window_station":"(\w+)"', desk),
            grab(r"Result: exit (\d+), stdout", desk), source=src + " Step 2 result")
    rows_n = grab(r"stdout a JSON array of (\d+) rows, all `\"status\": \"verified\"`", gen)
    listed = len(re.findall(r"^  - \w+ `[^`]+` — cell \w+ \(EMP-\d+\) persisted", gen, re.M))
    r.quote("8", "re-run §6 subset", "a §6 subset (`--limit {}`: {}/{} verified, exit {}, {} s)",
            grab(r"--limit (\d+) --runs-dir", gen), rows_n if rows_n == str(listed) else "?", listed,
            grab(r"Result: exit (\d+); stdout", gen), grab(r"wall (\d+) s", gen),
            source=src + " Step 3 command, result line, the rows listed, wall")
    r.quote("8", "re-run scorecard check", "then ran `scripts/scorecard-check.py` (exit {})", grab(r"Result: exit (\d+)\. Last two lines", card),
            source=src + " Step 4 result")
    js = sorted(int(n) for n in re.findall(r"^- \*\*J(\d+) ", rerun, re.M))
    ok_j = bool(js) and js == list(range(1, js[-1] + 1))
    stale = [n for n in js if re.search(rf"^- \*\*J{n} .*validate-live.*TIF-223", rerun, re.M)]
    r.quote("8", "re-run findings and the one ruled here",
            "Its findings J{}–J{} were runbook gaps the operator decided from the repo, fixed in a separate runbook PR, "
            "except J{} (this row's stale `validate-live` gap)",
            js[0] if ok_j else "?", js[-1] if ok_j else "?", stale[0] if len(stale) == 1 else "?",
            source=src + " J-findings (contiguous from J1); the one naming validate-live and TIF-223")
    vl = (ROOT / "src/integration/validate-live.ts").read_text()
    r.check("8", "J10 settled: the stale TIF-223 gap is gone and validate-live fails on zero run dirs",
            "ALL OK on 0 files" not in row and "runDirs.length === 0" in vl,
            "row 8 no longer says 'ALL OK on 0 files'; src/integration/validate-live.ts guards runDirs.length === 0 (#433)",
            doc="removed here")
    table = dict(re.findall(r"^\| ([^|]+?) \| ([A-Z]+(?: [A-Z]+)*)\b", first, re.M))
    passed = [k for k in ("§1 preconditions + setup", "§2 sanity", "§3.1 cold reset", "§4 deploy") if table.get(k) == "PASS"]
    eight = [k for k in table if k.startswith("§8") and table[k] == "PASS"]
    blocked = table.get("token fetch") == "BLOCKED" and table.get("§5 desktop proof") == "FAIL" and table.get("§6 subset (--limit 4)") == "NOT RUN"
    r.check("8", "first cold run: §1, §2, §3.1, §4, §8 passed; §5, §6 blocked by the token fetch",
            len(passed) == 4 and len(eight) == 3 and blocked, "m1-row8-step1/operator-report-3.md final table",
            doc="passed §1, §2, §3.1, §4 and §8 but was blocked at §5 and §6 by the token fetch",
            detail=f"passed {passed + eight}, blocked {blocked}")
    hs = sorted(int(n) for n in re.findall(r"^\*\*H(\d+) \(", first, re.M))
    ok_h = bool(hs) and hs == list(range(1, hs[-1] + 1))
    blocking = re.findall(r"^\*\*H(\d+) \(BLOCKING", first, re.M)
    h5 = blocking[0] if len(blocking) == 1 else "?"
    r.quote("8", "first run's blocking finding", "by the token fetch (H{}, fixed by TIF-228, #436)", h5,
            source="m1-row8-step1/operator-report-3.md, the one BLOCKING H-finding")
    r.quote("8", "first run's other findings", "its other findings, H{}–H{} except H{}, were fixed in #435 (TIF-227)",
            hs[0] if ok_h else "?", hs[-1] if ok_h else "?", h5, source="m1-row8-step1/operator-report-3.md H-findings (contiguous from H1)")


REF_WHY = "references to issues, PRs and runbook sections; pointers, not figures, and this script does not resolve them"


def check_references(r: Report) -> None:
    """Every issue, PR and runbook-section reference in the swept segments, each named
    with enough context that removing, renumbering or moving it is a MISMATCH. A
    reference no claim names is UNATTRIBUTED like any other token."""
    r.refs("4", REF_WHY, ("**Audited, not restated** (TIF-139)",))
    r.refs("6", REF_WHY, ("**Derived from committed logs, not quoted** (TIF-139)", "mapping (runbook §8.3)"))
    r.refs("7", REF_WHY, ("never `mycoVerdict` (TIF-207)",))
    r.refs("8", REF_WHY, (
        "on a fresh clone of main at #436", "on a fresh clone at #433", "By ruling, §7.3 and §7.4 were not re-run",
        "`scripts/scorecard-check.py` (TIF-225, #434)", "live outside the repo (§10)",
        "given the VM bundle (§10)", "the deploy/§5/§7.4 run", "§5 was blocked by the secret guard until TIF-209 (#425)",
        "the first §7.3 sweep was abandoned", "fixed by TIF-216 (#427)", "the §7.4 operator's §1.2 `pnpm test`",
        "**§3.1 reset → §4 deploy → §5 desktop proof:**", "the TIF-209 `session_info` CLI", "**§6 generator proof:**",
        "**§7.3 sweep:**", "(`docs/research/experiments/m1-row8-sweep2/`, #430)", "**§7.4 corrupted suite:**",
        "**§8 evidence:**", "now on main: TIF-216 (#427), TIF-219 (#428), TIF-220 (#429), TIF-209 (#425), "
        "TIF-223 (#433), TIF-228 (#436), and the runbook fixes in #432 (TIF-217) and #435 (TIF-227)",
        "§7.5 (the paid C1 baseline", "the §8.3 ledger for the §7.3 sweep",
    ))
    r.refs("slots", REF_WHY, ("filled by arm-003 r6 (TIF-90)",))
    r.refs("arm002-truncation", REF_WHY, ("truncation defect (#340)", "run with the fix (#340)", "PR #340 (`fix(TIF-164):"))


def check_arm002(r: Report) -> None:
    """The two arm-002 sections, recomputed from c1-arm-002/accounting.json and report.json."""
    row7_rows = {x["index"]: x for x in json.loads(R6.read_text())["rows"]}
    cap_s = grab(r"approved \$(\d+\.\d\d) ceiling", BUDGET_NOTE.read_text())
    acc = json.loads((ARM2 / "accounting.json").read_text())["c1"]
    report = json.loads((ARM2 / "report.json").read_text())
    rows = {int(k): v["row"] for k, v in acc.items() if "row" in v}
    src = "c1-arm-002/accounting.json"
    acts = Counter(a["tool"] for x in rows.values() for a in x["transcript"]["actions"])
    tally = Counter(x["verdict"] for x in rows.values())
    modified = [x for x in rows.values() if x["verdictReason"] == "modified"]

    def typed(x: dict) -> list[dict]:
        return [a["arguments"] for a in x["transcript"]["actions"] if a["tool"] == "type_text"]

    exact = [x for x in modified if any(t["text"].strip() == x["expected"] for t in typed(x))]
    cellref = [x for x in modified if x not in exact and typed(x)
               and all(re.fullmatch(r"[A-Z]{1,3}\d+", t["text"].strip()) for t in typed(x))]
    at = Counter((t["x"], t["y"]) for x in cellref for t in typed(x))
    (mx, my), most = at.most_common(1)[0] if at else ((0, 0), 0)
    first = typed(min(cellref, key=lambda x: x["index"]))[0]["text"].strip() if cellref else "?"
    odd = exact[0] if len(exact) == 1 else None
    odd_at = next((a for a in typed(odd) if a["text"].strip() == odd["expected"]), {"x": "?", "y": "?"}) if odd else {"x": "?", "y": "?"}
    rest = [f"`({x},{y})`" for (x, y), _ in sorted(at.items(), key=lambda kv: (-kv[1], -kv[0][0], kv[0][1])) if (x, y) != (mx, my)]
    otherwise = ", ".join(rest[:-1]) + " or " + rest[-1] if len(rest) > 1 else (rest[0] if rest else "?")

    d = "arm002-decision"
    r.unchecked(d, "decision date; criterion 7", "the decision's date and a pointer to the criterion, not figures",
                doc=("(2026-11-23)", "against\ncriterion 7"))
    planner = (ROOT / "src/baseline/planner.ts").read_text().splitlines()
    m_prompt = re.search(r"const PROMPT = \[(.*?)\];", "\n".join(planner), re.S)
    prompt = m_prompt.group(1) if m_prompt else ""
    r.check(d, "the system prompt symbol holds 'Save and close it.'", "Save and close it." in prompt,
            "src/baseline/planner.ts: the PROMPT constant contains 'Save and close it.'",
            doc='"Save and close it" (`PROMPT` in `src/baseline/planner.ts`)')
    r.quote(d, "actions by tool", "**{} `press_key` calls\nacross {} actions** (`click` {}, `type_text` {}), and `modified` was {} of {}\nrefutations",
            acts["press_key"], sum(acts.values()), acts["click"], acts["type_text"], len(modified), tally["refuted"],
            source=src + " transcript.actions[].tool, verdictReason")
    r.quote(d, "what the modified rows typed",
            "**Only {} of those {} typed the expected value** — the other {} typed a\ncell reference such as `'{}\\n'`, "
            "mostly into the Name Box at `({},{})` and otherwise\nat {}. Index {} is the one row that typed the expected value,\n"
            "at `({},{})`.",
            len(exact), len(modified), len(cellref), first, mx, my, otherwise, odd["index"] if odd else "?", odd_at["x"], odd_at["y"],
            source=src + " type_text arguments on the modified rows (text == expected, or a cell reference; the cell-reference "
                   "coordinates, most common first; the first such row's text; where the one exact row typed it)")
    r.artifact(d, "'mostly' at the Name Box", most * 2 > sum(at.values()),
               src, f"{most} of {sum(at.values())} cell-reference type_text calls at ({mx},{my})")
    unclaimed = [x for x in modified if not x["transcript"]["claims"] and not x["budgetExhausted"]]
    r.quote(d, "modified rows ended without a claim", "All {} terminated on\n`planner-no-action` with empty `claims`", len(unclaimed),
            source=src + ": empty transcript.claims and budgetExhausted false (the row does not name planner-no-action)")
    r.quote(d, "value never entered", "for {} of {} the right value\nwas never entered", len(modified) - len(exact), len(modified),
            source=src + " type_text vs expected")

    t = "arm002-truncation"
    calls = [(x["index"], u["completion"]) for x in rows.values() for u in x["usage"]]
    ceiling = max(c for _, c in calls)
    hits = [i for i, c in calls if c == ceiling]
    below = max(((c, i) for i, c in calls if c < ceiling), default=(0, -1))
    r.quote(t, "the ceiling in the title", "the {}-token truncation defect", ceiling,
            source=src + " the largest completion over all calls (the run's cap; " + str(len(hits)) + " calls end on it)")
    r.unchecked(t, "ruling date", "the ruling's date, not a figure", doc="**Ruled 2026-11-23 by the outer loop.**")
    r.quote(t, "MAX_OUTPUT at arm-002", "capped at `MAX_OUTPUT = {}`", ceiling,
            source=src + " the largest completion (MAX_OUTPUT itself is not recorded; src/baseline/planner.ts now says 1024)")
    r.quote(t, "calls, rows, largest non-truncated, ceiling hits",
            "({} calls, {} rows)\nthe largest **non-truncated** completion is **{} tokens** (row {}), and **{} calls\n"
            "across {} distinct rows landed on exactly {}**",
            len(calls), len(rows), below[0], below[1], len(hits), len(set(hits)), ceiling, source=src + " usage[].completion")
    hit_rows = {i: rows[i] for i in set(hits)}
    steps = {x["steps"] for x in hit_rows.values()}
    r.check(t, "256-hit rows with 3, 7, 14, 20 and 28 steps", {3, 7, 14, 20, 28} <= steps,
            src + " steps of the rows with a ceiling hit", doc=("**Almost every 256-hit", "rows with 3, 7, 14, 20 and 28\n  steps"),
            detail=f"steps {sorted(steps)}")
    long = [x for x in hit_rows.values() if x["steps"] == 28]
    r.check(t, "the 28-step row's 256 is its final call", bool(long) and all(
        x["usage"][-1]["completion"] == ceiling and len(x["transcript"]["actions"]) == 28 for x in long),
        src + " the 28-step row: last usage completion and action count", doc="after 28 successful actions")
    comps = {i: [u["completion"] for u in x["usage"]] for i, x in rows.items()}
    sig = sorted(i for i, x in rows.items() if x["steps"] == 1 and comps[i][-1] == ceiling)
    zero = sorted(i for i, x in rows.items() if x["steps"] == 0 and comps[i] == [ceiling])
    r.quote(t, "rows with the truncation signature and the zero-step shape",
            "- **Rows {} have the truncation signature** (1 step, final completion at the\n  ceiling: {}), and **rows {} have "
            "the zero-step shape**\n  (no step, one completion `[{}]`)",
            " and ".join(map(str, sig)), " and ".join(f"`{comps[i]}`" for i in sig), " and ".join(map(str, zero)), ceiling,
            source=src + " steps and usage[].completion: 1 step ending at the ceiling, or 0 steps with the one completion at it")
    short = sorted(i for i, x in rows.items() if x["steps"] <= 1)
    r.artifact(t, "every row of at most one step is one of those four", short == sorted(sig + zero), src + " steps",
               f"rows with steps <= 1: {short}")
    r2 = sorted(int(p.stem) for p in (EXP / "c1-arm-003/r2-void").glob("[0-9]*.json")
                if (lambda x: x.get("steps") == 0 and x.get("usage") and x["usage"][-1]["completion"] == 256
                    and x.get("verdictReason") == "persisted-mismatch")(json.loads(p.read_text())))
    r.quote(t, "r2 trials stopped by truncation", "stopped arm-003d r2 at trials {}", " and ".join(map(str, r2)),
            source="c1-arm-003/r2-void/N.json: zero steps, one completion at 256, persisted-mismatch")
    r2_shape = all([u["completion"] for u in json.loads((EXP / f"c1-arm-003/r2-void/{i}.json").read_text())["usage"]] == [ceiling]
                   for i in r2)
    r.artifact(t, "r2's stopped trials have the zero-step shape", bool(r2) and r2_shape,
               "c1-arm-003/r2-void/N.json usage[].completion == [ceiling] on each stopped trial")
    r.quote(t, "headline figures", "headline figures — {} refuted, `modified` {} of {} —", tally["refuted"], len(modified), len(rows),
            source=src + " verdict, verdictReason")
    r.unchecked(t, "row 7 cross-references", "pointers to the criterion row, not figures",
                doc=("Its run **r6** is the one\nrow 7 compares", "30/30 scored; see row 7)"))
    r.quote(t, "new ceiling and headroom", "raises the ceiling to {} with ~{}x headroom over the largest\nobserved completion",
            grab(r"export const MAX_OUTPUT = (\d+);", "\n".join(planner)), round(int(grab(r"export const MAX_OUTPUT = (\d+);", "\n".join(planner), default="0")) / below[0]) if below[0] else "?",
            source="src/baseline/planner.ts MAX_OUTPUT, and it over arm-002's largest non-truncated completion")
    r.unchecked(t, "r6 completion date", "the run's date, not a figure", doc="completed as run r6 on 2026-11-24")
    scored = sum(x["verdict"] in ("verified", "refuted") for x in row7_rows.values())
    r.quote(t, "r6 scored rows and trials", "{}/{} scored; see row 7) re-ran {} trials", scored, len(row7_rows), len(row7_rows),
            source="c1-arm-003/r6/ledger-extract.json rows (verdict verified or refuted)")
    r.quote(t, "cap", "a **${} cap on total committed\nspend**", cap_s, source="ROW7-BUDGET-DECIDED.md approved ceiling")
    arm2 = f"{report['c1ChargedMicros'] / 1e6:.6f}"
    r.quote(t, "arm-002 booked spend", "arm-002 booked ${}", arm2, source="c1-arm-002/report.json c1ChargedMicros")
    spike_cost = json.loads(SPIKE.read_text())["cost"] if SPIKE.is_file() else None
    r.quote(t, "spike trial's committed spend", "spend is ${} (`docs/research/experiments/c1-arm-001/spike-trial-0.json`)",
            f"{spike_cost:.6f}" if spike_cost is not None else "?", source="c1-arm-001/spike-trial-0.json cost")
    r.unchecked(t, "spike booked $0.076800; total $1.632162 at arm-002's close",
                "from the uncommitted booking ledger, unverifiable: the spike's booking ledger (c1-spike) was never committed "
                "and is gone from the host, and the committed spike spend differs from the booked figure, so neither the "
                "booked spike nor the total can be recomputed",
                doc=("From the uncommitted booking\nledger, unverifiable: the spike booked $0.076800",
                     "for **$1.632162** at arm-002's close"))

    # The slots section's retraction quotes the same rows.
    r.quote("slots", "arm-002 retraction", '{} rows "typed\nthe correct value and never saved" ({} of {} did)',
            len(modified), len(exact), len(modified), source=src + " modified rows, type_text == expected")


def check_open_risk(r: Report, v3: dict) -> None:
    note = (EXP / "m1-013-convert-timeout.md").read_text()
    o = "open-risk"
    nsrc = "research/experiments/m1-013-convert-timeout.md"
    uncertain = re.findall(r"^\| (\d+) \| `[^`]+` \| Uncertain, fixture conversion timeout \|", note, re.M)
    r.quote(o, "sweep v2 uncertain indices", "Sweep v2 indices {} ended `uncertain`", " and ".join(uncertain), source=nsrc + " sweep v2 table")
    r.quote(o, "v2 deadline", "exceeded {} seconds", grab(r"(\d+)-second fixture\s+conversion timeout", note), source=nsrc + " opening paragraph")
    probe = [float(s) for s in re.findall(r"^\| `[^`]+` \| (?:Yes|No) \| ([\d.]+) s \|", note, re.M)]
    r.quote(o, "slowest cold-start probe", "produced its workbook at {} seconds", f"{max(probe):.1f}" if probe else "?",
            source=nsrc + " diagnostic table, the slowest sample")
    r.quote(o, "approved deadline", "the approved {}-second deadline", grab(r"explicit \*\*(\d+)-second\*\* workbook-arrival", note),
            source=nsrc + " restart plan")
    conv = sum("convert" in (f.get("reason") or "") for f in v3["failures"])
    r.quote(o, "v3 conversion timeouts", "recorded\n{} fixture conversion timeouts", "zero" if conv == 0 else str(conv),
            source="m1-scorecard.score(m1-013-sweep-v3/trials.jsonl) failures whose reason names convert")


def check_signoff(r: Report, doc: Path, scorecard, row7, v3: dict) -> None:
    """The M1 sign-off record: each re-check figure recomputed with the same tools rows
    3-8 use; the run's own provenance (SHA, CI runs, dates, this script's count) is unchecked."""
    s = "signoff"
    r.unchecked(s, "sign-off signer, delegator and dates",
                "who signed, on whose delegation, and when: the lead's own record of the sign-off and of the delegation, "
                "not figures from an artifact; pinned so a changed signer, delegator or date fails",
                doc=("M1 signed off 2026-11-25 by Grok Bot (outer-loop engineering lead) on Tiffany McCormick's delegation of 2026-11-23",))
    r.unchecked(s, "re-check commit and CI runs",
                "the main SHA the lead re-checked and the GitHub Actions run ids for it; true by construction of that run, "
                "and no committed artifact records them",
                doc=("at main `8fd92e0d`", "runs 45618797722 for `1c519bca`", "45619706264 for `8fd92e0d`"))
    r.unchecked(s, "scorecard-check.py: 134 ok, 0 mismatch, 0 unattributed",
                "this script's own summary, self-referential: 134 is the count at sign-off, before this record was added "
                "(the record adds claims, so the live ok count is higher); this run's own exit status is the check",
                doc="`scripts/scorecard-check.py`: 134 ok, 0 mismatch, 0 unattributed.")

    src = "m1-scorecard.score(m1-013-sweep-v3/trials.jsonl)"
    lo, hi = v3["wilson95"]
    r.quote(s, "v3 verified and Wilson", "`m1-013-sweep-v3/trials.jsonl`: {}/{} verified, Wilson {}–{}",
            v3["verified"], v3["denominator"], f"{lo:.3f}", f"{hi:.3f}", source=src + " verified, denominator, wilson95")
    v3_json = json.dumps(v3, indent=2) + "\n"
    r.check(s, "v3 output byte-identical to final-scorecard.json", v3_json.encode() == (V3 / "final-scorecard.json").read_bytes(),
            "json.dumps(" + src + ", indent=2) vs m1-013-sweep-v3/final-scorecard.json bytes",
            doc="verified, Wilson 0.833–0.994, byte-identical to `final-scorecard.json`")
    s2 = scorecard.score(SWEEP2 / "trials.jsonl")
    src2 = "m1-scorecard.score(m1-row8-sweep2/trials.jsonl)"
    r.quote(s, "sweep2 verified", "`m1-row8-sweep2/trials.jsonl`: {}/{}, byte-identical", s2["verified"], s2["denominator"], source=src2)
    r.check(s, "sweep2 output byte-identical to final-scorecard.md",
            (scorecard.markdown(s2) + "\n").encode() == (SWEEP2 / "final-scorecard.md").read_bytes(),
            "m1-scorecard.markdown(" + src2 + ") vs m1-row8-sweep2/final-scorecard.md bytes",
            doc="byte-identical to `final-scorecard.md`")

    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        rc = row7.compare(True, doc)
    text = out.getvalue()
    myco_only = grab(r"Myco-only (\d+), baseline-only \d+", text)
    base_only = grab(r"Myco-only \d+, baseline-only (\d+)", text)
    p = row7.sign_test_two_sided(int(myco_only), int(base_only)) if myco_only.isdigit() and base_only.isdigit() else None
    figures = grab(r"CHECK OK: row 7 quotes all (\d+) computed figures", text) if rc == 0 else "?"
    r.quote(s, "row7-compare: discordant pairs, p, figures",
            "Myco-only {} vs baseline-only {}, p = {}, all {} figures OK", myco_only, base_only,
            f"{p:.2e}".replace("e-0", "e-") if p is not None else "?", figures,
            source="row7-compare.compare(check=True) on --doc: its discordant line, sign_test_two_sided, its CHECK OK figure count")

    summary = json.loads((AUDIT / "summary.json").read_text())
    counted = [x for x in summary["recoveryResults"] if x["countsTowardCoverage"]]
    rec = {c: [x for x in counted if x["class"] == c] for c in ("kill", "invalid-target")}
    ver = {c: sum(x["verdict"] == "verified" for x in xs) for c, xs in rec.items()}
    r.quote(s, "m1-014 summary and recovery",
            "{} recorded, {} with a verdict ({} verified / {} refuted / {} uncertain), falseSuccesses {}, unprovenVerified {}; "
            "recovery verified {}/{} after a kill and {}/{} after an invalid target",
            summary["total"], summary["withVerdict"], summary["verified"], summary["refuted"], summary["uncertain"],
            summary["falseSuccesses"], summary["unprovenVerified"], ver["kill"], len(rec["kill"]),
            ver["invalid-target"], len(rec["invalid-target"]),
            source="m1-014-combined-audit/summary.json (held to ledger.jsonl under row 4) and its recoveryResults (countsTowardCoverage)")

    logs = [V3, AUDIT, CORRUPT, SWEEP2]
    lines = [sum(1 for line in (d / "schema-validation.log").read_text().splitlines() if line.strip()) for d in logs]
    bad = sum(schema_log(d / "schema-validation.log")[2] for d in logs)
    r.quote(s, "schema-validation logs", "schema-validation logs: {} ({} lines)", "ALL OK" if bad == 0 else f"{bad} lines not ALL OK",
            ", ".join(map(str, lines)), source="non-empty lines of the m1-013, m1-014, m1-row8-corrupt and m1-row8-sweep2 "
                                               "schema-validation.log files, each a validate-live line ending ALL OK")


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
    ap.add_argument("--identifiers", action="store_true",
                    help="print, as JSON, the identifier words the sweep skipped in the doc and the allowlist, then exit")
    args = ap.parse_args(argv)
    doc = args.doc.resolve()
    scorecard = load_module("m1_scorecard", ROOT / "scripts/m1-scorecard.py")
    row7 = load_module("row7_compare", ROOT / "scripts/row7-compare.py")
    r = Report(doc.read_text(encoding="utf-8"))
    if args.identifiers:
        for where in r.in_scope():
            r.tokens(where)
        print(json.dumps({"skipped": sorted(r.identifiers), "allowlist": sorted(IDENTIFIERS)}))
        return 0
    sections = r.classify_sections()
    check_status(r)
    v3 = check_rows_1_to_3(r, scorecard)
    check_rows_4_to_6(r)
    check_row_7(r, doc, scorecard, row7, v3)
    check_durability(r, v3, scorecard)
    check_row_8(r, scorecard)
    check_arm002(r)
    check_open_risk(r, v3)
    check_signoff(r, doc, scorecard, row7, v3)
    check_references(r)
    if not args.no_subchecks:
        subchecks(r, doc)
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
          f"{counts['swept']} sections swept clean, {len(r.identifiers)} identifier words skipped; "
          f"{out_n} sections out of scope")
    if bad:
        for where, claim, status, detail in bad:
            print(f"{status} {label(where)}: {claim}: {detail}", file=sys.stderr)
        return 1
    print("SCORECARD CHECK OK: every number in the in-scope sections matches its committed artifact or is listed as unchecked")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
