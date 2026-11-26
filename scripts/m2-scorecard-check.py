#!/usr/bin/env python3
"""Recompute every number in docs/m2-scorecard.md from committed evidence (TIF-273 / M2-11).

  m2-scorecard-check.py [--doc PATH] [--evidence-root DIR] [--identifiers]

Modelled on scripts/scorecard-check.py (M1, TIF-225) and its hardening (TIF-230). It
imports that script's heading detection and number tokenizer rather than copying them, so
both checkers classify a line and a number the same way.

Layout, matched exactly. Line 1 is `# M2 scorecard`; the preamble runs to the table header,
which must equal HEADER, then SEPARATOR, then exactly one `| Rn |` line for each row R1-R8.
Only blank lines may sit between the table and the first heading. Every heading (ATX, HTML
or setext, inside blockquotes and list items too, outside code fences) must equal a key of
IN_SCOPE, the whole line; an unknown or repeated heading fails. Every section is in scope.

Rows. Each row has five cells: id, criterion, status, evidence, recomputed.
  - status is PENDING, DONE or NOT DONE, and is recomputed: PENDING when the evidence cell
    is `—`; otherwise DONE when the cited pack meets the row's bar, else NOT DONE;
  - a PENDING row's evidence and recomputed cells are `—`;
  - a row with evidence cites exactly one pack, `docs/research/experiments/m2-<name>/`,
    whose pack.json lists the row. The pack is checked by scripts/m2-evidence-check.ts
    (src/m2/evidence.ts: schemas, ledgers via src/benchmark/check.ts, causes, load gate);
    a pack that fails any of those checks may not be cited at all;
  - the recomputed cell must equal, character for character, the figures this script
    renders from that check's output (figures_r1, figures_r2, figures_r3, figures_r7);
  - rows R4, R5, R6 and R8 have no recomputation here yet and must stay PENDING.
Pass bars quoted in a criterion cell are claims too: each is checked against the code
constant the evidence check uses AND against the plan's row (docs/product/m2-plan-draft.md
§2.1), so the doc, the code and the plan cannot drift apart. R7's definition (the lead's
ruling 02:52Z: the total over ALL of the arm's trials divided by its verified count, a null
cost never 0) is pinned exactly: the R7 criterion cell must equal R7_CANONICAL_CRITERION and
the plan's R7 row must equal PLAN_R7_CANONICAL, cell by cell, compared after collapsing
whitespace only. Any other change to either text is a MISMATCH; a deliberate rewording means
editing the canonical text here in the same change, where a reviewer sees it.

Claims and the sweep work as in the M1 checker: `ok`, `MISMATCH`, `unchecked` (with a
reason, and its doc phrase must still be present), `artifact` (a consistency check the doc
does not state). After the claims, every number-like token in every section must lie inside
some claim's doc text, or it is UNATTRIBUTED; words with a word-internal digit (`m2-*`,
`R2`, `python3`) outside every claim must match IDENTIFIER_PINS, per section and in order.
Any MISMATCH or UNATTRIBUTED exits 1. An empty doc fails on its title, and a cited pack with
empty ledgers fails its own checks, so the check never passes on zero input.

Needs python3 and node with the repo's dev dependencies (`pnpm install`).
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAN = ROOT / "docs/product/m2-plan-draft.md"
RUNBOOK = ROOT / "docs/eval-runbook.md"
EVIDENCE_PREFIX = "docs/research/experiments/"
PACK_NAME = re.compile(r"m2-[a-z0-9][a-z0-9-]{0,62}")


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


M1 = _load("scorecard_check_m1", ROOT / "scripts/scorecard-check.py")

TITLE = "# M2 scorecard"
HEADER = "| # | Criterion | Status | Evidence | Recomputed |"
SEPARATOR = "|---|---|---|---|---|"
ROWS = [f"R{n}" for n in range(1, 9)]
RECOMPUTED = ("R1", "R2", "R3", "R7")
STATUSES = ("PENDING", "DONE", "NOT DONE")
NONE_CELL = "—"
IN_SCOPE = {
    "## Process checks (CI gates)": "process",
    "## How the check works": "how",
}
ROW_LINE = re.compile(r"\| *(R\d+) *\|")
# Words with a word-internal digit run that no claim covers, per section, in doc order.
# Regenerate with --identifiers after a deliberate doc edit and check the diff.
IDENTIFIER_PINS: dict[str, tuple[str, ...]] = {
    "status": ("M2", "M2", "m2-scorecard-check", "R1", "R3"),
    "process": ("m2-evidence-check", "m2-", "m2", "m2-evidence"),
    "how": ("python3", "m2-scorecard-check"),
}
# R7's definition, pinned exactly (lead ruling 02:52Z: total cost of ALL trials of the arm /
# the arm's verified count; a null cost is never 0; src/m2/evidence.ts costField). Compared
# after collapsing whitespace only, so any rewording fails. Change it here, on purpose, or not
# at all.
R7_RULING_NOTE = ("lead ruling 02:52Z: total cost of ALL trials of the arm / the arm's verified count; "
                  "a null cost is never 0")
R7_CANONICAL_CRITERION = (
    "Cost per verified task for both head-to-head arms: model cost, wall clock and VM time, each the "
    "total over ALL of the arm's trials (failed and refuted trials still cost money) divided by its "
    "verified count (accepted DONE the grader passes). A null cost is unmeasured, never 0"
)
# The plan's R7 row (docs/product/m2-plan-draft.md §2.1), every cell after the id: criterion,
# pass bar (the definition), evidence, how it is recomputed (the check).
PLAN_R7_CANONICAL = (
    "**Cost per verified task**",
    "Reported for both R2 arms: model cost, wall clock and VM time, each as the total over ALL of "
    "the arm's trials (failed and refuted trials still cost) divided by the arm's `verified` count, "
    "with the denominators. A null cost is unmeasured and never counts as 0",
    "Per-trial cost fields in the ledgers",
    "The check sums cost fields over all trials and divides by the verified count",
)
IDENTIFIERS = frozenset(w for pin in IDENTIFIER_PINS.values() for w in pin)


class Report:
    def __init__(self, text: str):
        self.text = text
        self.rows: list[tuple[str, str, str, str]] = []
        self.spans: dict[str, list[tuple[int, int]]] = {}
        self.segs: dict[str, str] = {}
        self.cells: dict[str, list[str]] = {}
        self.sections: list[tuple[str, str]] = []
        self.layout: list[tuple[str, str]] = []
        self.identifiers: set[str] = set()
        self.sequences: dict[str, list[str]] = {}
        self._parse()

    def _parse(self) -> None:
        lines = self.text.splitlines(keepends=True)
        offs = [0]
        for line in lines:
            offs.append(offs[-1] + len(line))
        fence, heads, body = None, [], []
        for i, line in enumerate(lines):
            m = M1.FENCE.match(line.rstrip("\n"))
            if fence is None and m and not (m.group(1)[0] == "`" and "`" in m.group(2)):
                fence = m.group(1)
            elif fence is not None:
                if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not m.group(2).strip():
                    fence = None
            else:
                body.append(i)
                c = M1.content(line)
                if M1.HEADING.match(c) or M1.HTML_HEADING.match(c):
                    heads.append(i)
        tables = M1.table_lines(lines, body)
        for k, i in enumerate(body[1:], 1):
            above = body[k - 1]
            underline = M1.SETEXT.match(lines[i].rstrip("\n")) or M1.SETEXT.match(M1.content(lines[i]))
            if (above == i - 1 and underline and M1.content(lines[above]).strip()
                    and above not in tables and above not in heads):
                heads.append(above)
        heads.sort()
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
        if h < len(lines) and lines[h].startswith("| # |") and lines[h].rstrip("\n") != HEADER:
            self.layout.append(("criterion table", f"the header line must be exactly {HEADER!r}"))
        t = h + 1 if h < len(lines) else h
        if t < len(lines) and lines[t].startswith("|---"):
            if lines[t].rstrip("\n") != SEPARATOR:
                self.layout.append(("criterion table", f"the separator line must be exactly {SEPARATOR!r}"))
            t += 1
        elif h < len(lines):
            self.layout.append(("criterion table", f"no {SEPARATOR!r} separator under the header"))
        while t < len(lines) and lines[t].startswith("|"):
            m = ROW_LINE.match(lines[t])
            n = m.group(1) if m else None
            if n is None:
                self.layout.append(("criterion table", f"a table line that is not a criterion row: {lines[t][:60]!r}"))
            elif n in self.segs:
                self.layout.append(("criterion table", f"duplicate criterion row {n}"))
            elif n not in ROWS:
                self.layout.append(("criterion table", f"unexpected criterion row {n}; this script checks R1-R8"))
            else:
                self.segs[n] = lines[t].rstrip("\n")
                cells = [c.strip() for c in re.split(r"(?<!\\)\|", self.segs[n].strip())[1:-1]]
                if len(cells) != 5 or not self.segs[n].rstrip().endswith("|"):
                    self.layout.append(("criterion table", f"row {n} must have exactly 5 cells"))
                else:
                    self.cells[n] = cells
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
            if (i + 1 < len(lines) and (M1.SETEXT.match(lines[i + 1].rstrip("\n")) or M1.SETEXT.match(M1.content(lines[i + 1])))
                    and not M1.HEADING.match(M1.content(lines[i])) and not M1.HTML_HEADING.match(M1.content(lines[i]))):
                heading += " / " + lines[i + 1].strip()
            end = offs[heads[k + 1]] if k + 1 < len(heads) else len(self.text)
            if heading not in IN_SCOPE:
                self.layout.append((heading, "a heading this script does not classify (headings match IN_SCOPE exactly, "
                                             "the whole line)"))
                kind = "UNCLASSIFIED"
            elif heading in seen:
                self.layout.append((heading, "a second section under a heading already classified"))
                kind = "DUPLICATE"
            else:
                seen.add(heading)
                self.segs[IN_SCOPE[heading]] = self.text[offs[i]:end]
                kind = "in scope"
            self.sections.append((heading, kind))
        for what, detail in self.layout:
            self.rows.append(("layout", what, "MISMATCH", detail))

    def segment(self, where: str) -> str:
        return self.segs.get(where, "")

    def in_scope(self) -> list[str]:
        return ["status", *ROWS, *IN_SCOPE.values()]

    def _locate(self, where: str, phrase: str) -> bool:
        seg = self.segment(where)
        spans = self.spans.setdefault(where, [])
        hits, i = [], seg.find(phrase)
        while i >= 0 and phrase:
            hits.append((i, i + len(phrase)))
            i = seg.find(phrase, i + 1)
        if not hits:
            return False
        fresh = [x for x in hits if not any(s <= x[0] and x[1] <= e for s, e in spans)]
        spans.append((fresh or hits)[0])
        return True

    def quote(self, where: str, claim: str, expected: str, source: str) -> None:
        """The doc at `where` must contain `expected` verbatim."""
        if self._locate(where, expected):
            self.rows.append((where, claim, "ok", f"{expected!r} from {source}"))
        else:
            self.rows.append((where, claim, "MISMATCH", f"expected {expected!r} ({source}); not found"))

    def check(self, where: str, claim: str, ok: bool, source: str, doc: str, detail: str = "") -> None:
        if not self._locate(where, doc):
            self.rows.append((where, claim, "MISMATCH", f"the doc no longer says {doc!r}; {source}"))
            return
        self.rows.append((where, claim, "ok" if ok else "MISMATCH", source + (f": {detail}" if detail else "")))

    def artifact(self, where: str, claim: str, ok: bool, source: str) -> None:
        self.rows.append((where, claim, "artifact" if ok else "MISMATCH", source))

    def unchecked(self, where: str, claim: str, why: str, doc: str | tuple[str, ...]) -> None:
        phrases = (doc,) if isinstance(doc, str) else doc
        missing = [p for p in phrases if not self._locate(where, p)]
        if missing:
            self.rows.append((where, claim, "MISMATCH", f"inventoried as unchecked, but the doc no longer says {missing}"))
        else:
            self.rows.append((where, claim, "unchecked", why))

    def fail(self, where: str, claim: str, detail: str) -> None:
        self.rows.append((where, claim, "MISMATCH", detail))

    def covered(self, where: str, start: int, end: int) -> bool:
        return any(s <= start and end <= e for s, e in self.spans.get(where, []))

    def sweep_numbers(self) -> None:
        for where in self.in_scope():
            seg = self.segment(where)
            row = ROW_LINE.match(seg) if where in ROWS else None
            nums, words, _ = M1.number_tokens(seg, row.end(1) if row else 0, 0)
            toks, seq = list(nums), []
            for s, e, w in words:
                if self.covered(where, s, e):
                    continue
                if w in IDENTIFIERS:
                    seq.append(w)
                    self.identifiers.add(w)
                else:
                    toks.append((s, e, w))
            self.sequences[where] = seq
            pin = list(IDENTIFIER_PINS.get(where, ()))
            if seq != pin:
                k = next((i for i, (a, b) in enumerate(zip(seq, pin)) if a != b), min(len(seq), len(pin)))
                self.fail(where, "identifier words",
                          f"word {k + 1}: the doc has {seq[k] if k < len(seq) else 'nothing'!r} where IDENTIFIER_PINS has "
                          f"{pin[k] if k < len(pin) else 'nothing'!r} (doc {len(seq)} words, pin {len(pin)})")
            loose = [t for s, e, t in sorted(toks) if not self.covered(where, s, e)]
            if loose:
                self.rows.append((where, "number sweep", "UNATTRIBUTED",
                                  f"no checked or unchecked claim covers {loose}; add one to the inventory"))
            else:
                self.rows.append((where, "number sweep", "swept", f"all {len(toks)} number-like tokens attributed"))

    def mismatches(self) -> list[tuple[str, str, str, str]]:
        return [r for r in self.rows if r[2] in ("MISMATCH", "UNATTRIBUTED")]


# -- evidence -----------------------------------------------------------------------------
def evidence_check(*args: str) -> tuple[int, dict]:
    proc = subprocess.run(["node", "--import", "tsx", "scripts/m2-evidence-check.ts", *args],
                          cwd=ROOT, capture_output=True, text=True)
    try:
        return proc.returncode, json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise SystemExit(f"m2-evidence-check.ts printed no JSON (exit {proc.returncode}): {proc.stderr.strip()[-400:]}")


def ci(pair) -> str:
    return f"{pair[0]:.3f}–{pair[1]:.3f}"


def rate(r: dict, kind: str = "Wilson") -> str:
    """`n/d (Wilson lo–hi)`; Wilson is null with d = 0, and that is said, not hidden."""
    interval = r.get("wilson95") if kind == "Wilson" else r.get("exact95")
    if r["denominator"] == 0 or interval is None:
        return f"{r['numerator']}/{r['denominator']} (no interval)"
    return f"{r['numerator']}/{r['denominator']} ({kind} {ci(interval)})"


def arm_counts(result: dict, arm: str) -> dict:
    return next(a for a in result["benchmark"]["arms"] if a["arm"] == arm)


def ineligible(inel: dict) -> str:
    """`N ineligible (cause n, ...)`, causes in the evidence check's order; never omitted."""
    causes = ", ".join(f"{c} {n}" for c, n in inel["byCause"].items())
    return f"{inel['count']} ineligible" + (f" ({causes})" if causes else "")


def figures_r1(result: dict) -> str:
    g = arm_counts(result, "myco-gate")
    r1 = result["r1"]
    return (f"{r1['trials']} eligible gated trials ({r1['faultTrials']} faulted), {ineligible(r1['ineligible'])}; "
            f"{r1['accepted']} eligible accepted DONE; over all gated trials {g['falseDoneAccepted']} false DONE "
            f"accepted, {g['acceptedUngradable']} accepted ungradable; "
            f"false-accept rate {rate(r1['falseAcceptRate'])}")


def figures_r2(result: dict) -> str:
    r2 = result["r2"]
    arms = "; ".join(f"{arm}: false-done {rate(arm_counts(result, arm)['falseAcceptRate'])}, "
                     f"success {rate(arm_counts(result, arm)['acceptedSuccessRate'])}"
                     for arm in ("myco-gate", "hcu+shell"))
    p = f"{r2['signTestP']:.3g}"
    return (f"{r2['pairs']} pairs; {arms}; both {r2['bothSucceed']}, gate only {r2['gateOnly']}, "
            f"shell only {r2['shellOnly']}, neither {r2['neither']}; sign test p = {p}"
            + (", underpowered" if r2["underpowered"] else ""))


def figures_r3(result: dict) -> str:
    r3 = result["r3"]
    classes = "; ".join(f"{c['faultClass']}: false success {rate(c['falseSuccess'], 'exact')}, "
                        f"detection {rate(c['detection'], 'exact')}" for c in r3["classes"])
    return (f"{r3['eligible']} eligible faulted trials, {ineligible(r3['ineligible'])}; "
            f"{r3['falseSuccesses']} false successes, {r3['ineligibleFalseSuccesses']} on ineligible trials; {classes}")


def cost(field: dict, verified: int, unit: str) -> str:
    if field["nullRows"] > 0:
        return f"unmeasured ({field['nullRows']} null rows)"
    if verified == 0 or field["perVerified"] is None:
        return "no verified task"
    v = field["perVerified"]
    return f"${v:.4f}" if unit == "$" else f"{v:.1f} s"


def figures_r7(result: dict) -> str:
    return "; ".join(
        f"{a['arm']}: {a['verified']} verified of {a['trials']}; per verified task model "
        f"{cost(a['modelUsd'], a['verified'], '$')}, wall clock {cost(a['wallClockS'], a['verified'], 's')}, "
        f"VM {cost(a['vmS'], a['verified'], 's')}"
        for a in result["r7"]["arms"])


FIGURES = {"R1": figures_r1, "R2": figures_r2, "R3": figures_r3, "R7": figures_r7}


# -- claims -------------------------------------------------------------------------------
def plan_row(plan: str, n: str) -> str:
    row = re.compile(rf"\|\s*\*\*{n}\*\*\s*\|")
    return next((line for line in plan.splitlines() if row.match(line)), "")


def grab(pattern: str, text: str) -> str:
    m = re.search(pattern, text)
    return m.group(1) if m else "?"


def check_bars(r: Report, const: dict, plan: str) -> None:
    """Pass bars in criterion cells: each figure from the code constant, and the plan's row agrees."""
    bars = [
        ("R1", "about {} gated trials", const["r1MinTrials"], r"About \*\*(\d+)\*\* gated trials", "R1", "r1MinTrials"),
        ("R1", "and {} false DONE accepted", 0, r"\*\*(\d+) false DONE accepted\*\*", "R1", None),
        ("R1", "A Wilson {}% interval", 95, r"and a Wilson (\d+)% interval", None, None),
        ("R2", "{} paired trials", const["r2MinPairs"], r"(\d+) paired trials", "R2", "r2MinPairs"),
        ("R2", "underpowered below {} discordant pairs", const["signTestUnderpowered"],
         r"underpowered below (\d+) discordant pairs", "R2", "signTestUnderpowered"),
        ("R3", "{} eligible faulted trials", const["r3MinEligible"], r"(\d+) eligible faulted trials", "R3", "r3MinEligible"),
        ("R3", "{} false successes", 0, r"\*\*(\d+) false successes\*\*", "R3", None),
        ("R8", "a {}-second demo", 90, r"a (\d+)-second demo", "R8", None),
    ]
    for where, template, value, pattern, plan_where, constant in bars:
        source_text = plan_row(plan, plan_where) if plan_where else plan
        planned = grab(pattern, source_text)
        src = f"plan {'row ' + plan_where if plan_where else '§2 rules'} /{pattern}/ = {planned}"
        if constant:
            src += f"; src/m2/evidence.ts {constant} = {value}"
        r.check(where, f"pass bar {template.format(value)!r}", planned == str(value), src, template.format(value),
                detail="" if planned == str(value) else f"the plan says {planned}, the doc and code {value}")
    r.check("R3", "two security classes", len(const["r3SecurityClasses"]) == 2,
            f"src/m2/evidence.ts R3_SECURITY_CLASSES = {const['r3SecurityClasses']}", "the two security classes")
    r.unchecked("R7", "a null cost is never 0", "a counting rule (src/m2/evidence.ts costField), not a figure",
                "A null cost is unmeasured, never 0")
    # The lead's R7 ruling (02:52Z), pinned exactly in the scorecard and in the plan's R7 row.
    cell = criterion_cell(r.segment("R7"))
    diff = first_difference(norm_ws(cell), R7_CANONICAL_CRITERION)
    r.check("R7", f"R7 definition ({R7_RULING_NOTE})", diff is None,
            "scripts/m2-scorecard-check.py R7_CANONICAL_CRITERION", cell.strip() or "| R7 |",
            detail="" if diff is None else f"the R7 criterion differs from the canonical text: {diff}")
    plan_r7 = plan_cells(plan_row(plan, "R7"))
    if len(plan_r7) != len(PLAN_R7_CANONICAL):
        pdiff = f"expected {len(PLAN_R7_CANONICAL)} cells after the id, found {len(plan_r7)}"
    else:
        pdiff = next((f"cell {k + 2}: {d}" for k, (got, want) in enumerate(zip(plan_r7, PLAN_R7_CANONICAL))
                      if (d := first_difference(got, want)) is not None), None)
    if pdiff is None:
        r.artifact("R7", f"plan R7 row ({R7_RULING_NOTE})",
                   True, "docs/product/m2-plan-draft.md §2.1 row R7 = scripts/m2-scorecard-check.py PLAN_R7_CANONICAL")
    else:
        r.fail("R7", f"R7 definition ({R7_RULING_NOTE})",
               f"the plan's R7 row differs from PLAN_R7_CANONICAL: {pdiff}")


def norm_ws(text: str) -> str:
    """Collapse every whitespace run to one space and strip: the only normalisation the R7 pin allows."""
    return " ".join(text.split())


def plan_cells(row: str) -> list[str]:
    """The cells after the id of a plan row `| **Rn** | a | b | ... |`, whitespace-normalised."""
    cells = row.strip().split("|")
    return [norm_ws(c) for c in cells[2:-1]] if len(cells) > 3 else []


def first_difference(got: str, want: str) -> str | None:
    """None when equal; else where the texts part, as a short quoted context."""
    if got == want:
        return None
    k = next((i for i, (a, b) in enumerate(zip(got, want)) if a != b), min(len(got), len(want)))
    lo = max(0, k - 30)
    return f"at character {k}, found {got[lo:k + 40]!r}, canonical {want[lo:k + 40]!r}"


def criterion_cell(row_segment: str) -> str:
    """The criterion cell of a `| Rn | criterion | status | evidence | recomputed |` line."""
    line = row_segment.split("\n", 1)[0]
    cells = line.split("|")
    return cells[2] if len(cells) > 2 else line


def check_rows(r: Report, evidence_root: Path) -> Counter:
    statuses: Counter = Counter()
    cache: dict[str, tuple[int, dict]] = {}
    for n in ROWS:
        cells = r.cells.get(n)
        if cells is None:
            continue
        _, _, status, evidence, recomputed = cells
        if status not in STATUSES:
            r.fail(n, "status", f"status {status!r} is not one of {STATUSES}")
            continue
        if evidence == NONE_CELL:
            r.check(n, "status", status == "PENDING", "no evidence cited, so the row is PENDING", f"| {status} |",
                    detail=f"the doc says {status}")
            r.check(n, "recomputed cell", recomputed == NONE_CELL, "a PENDING row quotes no figures", f"| {recomputed} |")
            statuses["PENDING"] += 1
            continue
        if n not in RECOMPUTED:
            r.fail(n, "evidence", f"{n} has no recomputation in this script yet, so it must stay PENDING with "
                                  f"evidence {NONE_CELL!r}")
            continue
        m = re.fullmatch(r"`" + re.escape(EVIDENCE_PREFIX) + r"(" + PACK_NAME.pattern + r")/`", evidence)
        if not m:
            r.fail(n, "evidence", f"the evidence cell must be one pack, `{EVIDENCE_PREFIX}m2-<name>/`; found {evidence!r}")
            continue
        name = m.group(1)
        pack_dir = evidence_root / name
        if not (pack_dir / "pack.json").is_file():
            r.fail(n, "evidence", f"{evidence} is not a committed pack (no pack.json under {name}/)")
            continue
        if name not in cache:
            cache[name] = evidence_check(str(pack_dir))
        rc, out = cache[name]
        result = out["packs"][0]["result"]
        r.check(n, "evidence pack passes every gate", rc == 0 and result["ok"],
                "scripts/m2-evidence-check.ts (schemas, shared ledger, causes, load gate)", evidence,
                detail="" if result["ok"] else "; ".join(result["errors"][:5]))
        manifest = result.get("manifest") or {}
        if n not in manifest.get("rows", []):
            r.fail(n, "evidence", f"{name}/pack.json does not list {n} in rows")
            continue
        verdict = result[n.lower()]
        want = "DONE" if verdict["pass"] else "NOT DONE"
        r.check(n, "status", status == want, f"{name}: {n} " + ("passes" if verdict["pass"] else
                                                                 "does not pass: " + "; ".join(verdict["reasons"][:3])),
                f"| {status} |", detail=f"the doc says {status}, the pack gives {want}")
        statuses[want] += 1
        r.quote(n, "recomputed figures", f"| {FIGURES[n](result)} |", source=f"{name} via src/m2/evidence.ts")
    return statuses


def check_preamble(r: Report, statuses: Counter) -> None:
    r.quote("status", "row statuses",
            f"Status: {statuses['DONE']} of {len(ROWS)} rows DONE, {statuses['PENDING']} PENDING, "
            f"{statuses['NOT DONE']} NOT DONE.", source="the recomputed Status column of R1-R8")
    r.unchecked("status", "plan reference", "a section reference into the plan, not a figure",
                "`docs/product/m2-plan-draft.md` §2.1")


def check_process(r: Report, const: dict, runbook_path: Path = RUNBOOK) -> None:
    s = "process"
    r.unchecked(s, "plan reference", "a section reference into the plan, not a figure", "The plan's §2.2")
    r.quote(s, "harness classes", "(" + ", ".join(const["harnessClasses"]) + ")",
            source="schemas/m2-evidence.ts HARNESS_CLASSES")
    runbook = grab(r"1-min load stays under (\d+) for", runbook_path.read_text())
    r.check(s, "load gate", runbook == str(const["loadGate"]),
            f"src/m2/evidence.ts LOAD_GATE = {const['loadGate']}; eval-runbook load gate = {runbook}",
            f"trial started at load {const['loadGate']} or more fails")
    r.unchecked(s, "1-minute load", "the load average's window, not a figure", "host 1-minute load")


def main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--doc", type=Path, default=ROOT / "docs/m2-scorecard.md")
    ap.add_argument("--evidence-root", type=Path, default=ROOT / EVIDENCE_PREFIX,
                    help="where cited packs are read from (tests point it at fixtures)")
    ap.add_argument("--plan", type=Path, default=PLAN, help="the M2 plan the pass bars are checked against")
    ap.add_argument("--runbook", type=Path, default=RUNBOOK,
                    help="the eval runbook the load gate is checked against (tests point it at a copy)")
    ap.add_argument("--identifiers", action="store_true",
                    help="print, as JSON, each section's identifier words outside every claim, then exit")
    args = ap.parse_args(argv)
    if not args.doc.is_file():
        print(f"MISMATCH layout: {args.doc} is not a file", file=sys.stderr)
        return 1
    _, const = evidence_check("--constants")
    r = Report(args.doc.read_text(encoding="utf-8"))
    check_bars(r, const, args.plan.read_text(encoding="utf-8"))
    statuses = check_rows(r, args.evidence_root.resolve())
    check_preamble(r, statuses)
    check_process(r, const, args.runbook)
    r.sweep_numbers()
    if args.identifiers:
        print(json.dumps({w: r.sequences[w] for w in r.in_scope() if r.sequences.get(w)}))
        return 0
    for where, claim, status, detail in r.rows:
        print(f"{status:<12}  {where:<8} {claim} — {detail}")
    print("\nSections:")
    for heading, kind in r.sections:
        print(f"  {kind:<13} {heading}")
    counts = Counter(status for _, _, status, _ in r.rows)
    print(f"\n{counts['ok']} ok, {counts['MISMATCH']} mismatch, {counts['UNATTRIBUTED']} unattributed, "
          f"{counts['unchecked']} not machine-checked, {counts['artifact']} artifact-consistency, "
          f"{counts['swept']} sections swept clean; rows: {statuses['DONE']} DONE, {statuses['NOT DONE']} NOT DONE, "
          f"{statuses['PENDING']} PENDING")
    bad = r.mismatches()
    if bad:
        for where, claim, status, detail in bad:
            print(f"{status} {where}: {claim}: {detail}", file=sys.stderr)
        return 1
    print("M2 SCORECARD CHECK OK: every number matches committed evidence, a code constant or the plan")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
