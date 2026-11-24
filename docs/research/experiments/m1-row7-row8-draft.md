# Scorecard draft — rows 7 and 8

**DRAFT. Not the scorecard.** `docs/m1-scorecard.md` remains the authoritative table. This file
exists so the two open rows can be *finished* quickly when their evidence lands, with the
placeholders visible rather than half-filled.

Written 2026-11-24 while r6 (the live C1 baseline resume) holds the VM. Every number below is
either **derived from a committed artifact** or marked **PENDING** — nothing is estimated into a
shape that could later be mistaken for a measured value.

---

## Row 7 — Baseline: screenshot agent on identical tasks, initial states and model settings

**Status: PENDING arm-003.** Not DONE, and deliberately not filled in.

### What is settled and must not be re-derived

| | value | source |
|---|---|---|
| arm-002 is **not** the baseline | decision recorded | `docs/research/experiments/c1-arm-002/FINAL.md` |
| arm-002 instruction parity | **violated** — Myco's arm saves explicitly (`isSave: true`), arm-002's task line omitted the save | `src/tasks/calc-record-edit.ts`, `src/baseline/c1-trial.ts:46` |
| arm-002 ran under a defective config | `MAX_OUTPUT = 256`; 22 calls across 22 rows landed on exactly 256 | `docs/m1-scorecard.md`, TIF-164/#340 |
| arm-002 must **not** be re-run | recorded as superseded, not re-measured | same |
| canonical C1 baseline | **arm-003d**, with the #340 fix | `docs/m1-scorecard.md` |
| task/fixture/identity parity | **30/30** params, runIds, 6/6 fixture hashes, 30/30 `resultSha256` byte-exact | `docs/research/experiments/c1-parity.md` |
| spend booked | **$1.632162** at arm-002's close (spike $0.076800 + arm-002 $1.555362) | `report.json.c1ChargedMicros` |

### The slots, and what fills each

| Slot | Value | Source when ready |
|---|---|---|
| Baseline pass rate | **_PENDING arm-003_** | its `accounting.json` via `scripts/c1-scorecard-adapter.py` |
| Paired table + exact sign test (b, c, p) | **_PENDING arm-003_** | per-trial pairing against the M1-013 rows |
| Wilson 95% on the baseline rate | **_PENDING arm-003_** | `scripts/m1-scorecard.py` |
| Spend | **PENDING** — see live figure below | `report.json.c1ChargedMicros` |

### Live state of the arm that will fill them (read-only, 2026-11-24 10:2xZ)

**r6 resumed and is running now.** From its ledger, read-only:

```
scored: 22 of 30
omissions: {planner-failed: 7}
```

**These numbers will move and must not be carried into the scorecard until the arm exits.** They
are recorded here only so the next reader can tell a live ledger from a final one. A resume is in
flight (`--resume --adopt-identity --accept-scored-cause refuted:step-budget`).

**Prior r6 stop, for the record:** PARTIAL at 19 scored / 11 omitted (1 `trial-interrupted`,
10 `planner-failed`), stopped by a **harness** fault — one `max_tokens=1024` truncation — not by
the spend cap. From `report.json` at that stop (`c1ChargedMicros: 2765970`), headroom was
**$6.234030 of $9.00**.

> An earlier revision of this draft said "$1.7533 of $9.00". **No artifact supports that figure.**
> It came from a rounded prose aside elsewhere in the repo ("with only $1.75 of cap left") and was
> restated here to four decimals, which turned a hedge into a precise-looking measurement. Caught by
> a verifier round before merge. It is the exact defect class this document exists to prevent, and
> it is left visible rather than quietly deleted.

### The 30-row pair is required, not optional

Row 7's acceptance criterion is a **per-trial paired table plus the exact sign test (b, c, p)**,
and an explicit **"underpowered at n=30"** statement whenever discordant trials < 6. A pass rate
alone does not satisfy it. Nothing here may be quoted as a comparison until the Myco side comes
from an M1-013 sweep the Coordinator has declared final.

---

## Row 8 — Reproducibility: another coding agent can reproduce the evaluation from the repo

**Status: PARTIAL — and the §6 gate has now PASSED.**

### What is settled

| | value | source |
|---|---|---|
| Runbook | `docs/eval-runbook.md`, all commands checked against the repo | PR #33 |
| Sweep driver | `scripts/m1-sweep.sh` | PR #53 |
| VM toolchain in the repo | **18 files** — 12 top-level files + 6 under `guest/` and `seed/`. `find docs/env/vm-toolchain -type f` gives 18; `ls -A` gives 14 top-level entries, which **already includes** the two directories | `docs/env/vm-toolchain/`, #206 — re-counted 2026-11-24 with `find -type f` |
| **§6 generator proof** | **20/20 verified, exit 0** — 08:34:06Z→08:49:46Z, zero refuted | `docs/research/experiments/m1-row8/S6-PASS.md` |
| Guest-clean precondition | §6.1 now excludes only `myco-admin`/`profiles`; a C1 run's `runs\20` is reported | #405 (`2833a941`) |
| Ownership check | read-only via `lsof`; a flock probe can make a real driver exit 10 | #405, #409 |

**The §6 PASS is the first complete generator proof on a quiet host.** Two earlier attempts on a
clean guest verified every row that reached the verifier (16 of 16, zero refutations) but never
completed — one lost its host process mid-trial-16, the other was cold-reset by a lock-holding
driver at trial 2. Those are **not** pooled with it.

### What row 8 still lacks

| Step | Pass condition | Status |
|---|---|---|
| 1. Read only the repo | reaches a runnable sequence without a question the repo could answer | **PARTIAL** — a fresh operator returned 15 findings, of which the substantive ones are fixed in #405; the identifiers run **F1–F14** (there is no F15 — the operator's count and its labels do not agree, and the labels are what a reader can follow) |
| 2. Preconditions (§1) | obtains the VM bundle, `ssh_config`, key, host scripts, GUI permission — nothing else | **PASS** (prior run) |
| 3. Reset → deploy → desktop proof | each step's stated output observed | **PASS** (prior run, exact match) |
| 4. Generator proof (§6) | 20/20 | **PASS** (`S6-PASS.md`) |
| 5. Sweep (§7.3) | 30 pinned rows matching the retained `params.json` | **_PENDING_** |
| 6. Corrupted suite (§7.4) | ledger with zero false successes | **_PENDING_** |
| 7. Evidence (§8) | `schema-validate` passes on every result and trace | **PASS for §6**; **_PENDING_ for §7** |
| 8. Scorecard | regenerates `docs/m1-scorecard.md` rows byte for byte | **_PENDING_** |

### Known-unsatisfiable today, and it must be carried into the result

`build-all.sh` has never been run end to end from the repo; the Windows ISO, offline payload,
seed ISO and the `clean-base` snapshots live outside it. **Row 8 can therefore pass only in the
"given the VM bundle" sense**, and the report must say so rather than implying a from-scratch
rebuild. This is stated in runbook §10.

### The outstanding run

A full fresh-operator rerun is armed: the same independent operator (§1–§5 already done at
`/private/tmp/row8-operator-wt`) continues **from §6** once **r6 releases the VM flock**
(~11:30–11:45Z expected). §6 must take the lock; §7 is not in its scope.

**Its §6 result must be reported separately from the 08:34Z PASS**, and neither may be quoted as
§7 evidence.

---

## Rules this draft exists to enforce

- No number is quoted unless it comes from a committed artifact, and every number names that
  artifact.
- Row 7 is not a comparison until the paired table and sign test exist; a rate alone is not rows 7's
  criterion.
- Row 8's §6 PASS does not make row 8 DONE — §7.3, §7.4 and the byte-for-byte scorecard
  regeneration are still open.
- `PENDING` is written as `PENDING`, never as a plausible-looking estimate.
