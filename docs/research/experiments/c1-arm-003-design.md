# Arm-003 design: byte-identical task text

**Status: planned, queued after M1-016.** Arm-002 is a *recorded run*, not the baseline.

## Why arm-003 exists

Arm-002 does not satisfy M1 criterion 7 ("baseline on identical tasks … model
settings") because the two arms were **not told the same thing**. This is a defect
in the comparison, not in the model.

**The task family's canonical intent** (`src/tasks/intent.ts:22`, and
`docs/architecture/m1.md`):

> set the cell at record `rowKey`, column `column`, to `newValue`, **and save the file**.

**What Myco's arm received:** that intent — including the save requirement.
**What the C1 arm's task line received** (`src/baseline/c1-trial.ts:46`):

> `Set the ${column} cell for record ${rowKey} to ${JSON.stringify(newValue)}.`

No save. Simultaneously, C1's *system* prompt says *"Save and close it"*
(`src/baseline/planner.ts:78`). So the baseline agent was told to save in one place
and given a task that never mentioned saving in another.

## The evidence, and why it is not a targeting failure

From the recorded rows (`/tmp/baseline/c1-arm2/accounting.json`), independently
re-derived:

| Observation | Value |
|---|---|
| Actions across all rows | 375 — `click` 357, `type_text` 18 |
| **`press_key` calls** | **0.** No row ever attempted Ctrl+S |
| Refutations reasoning `modified` | 12 — typed the value, left the document unsaved |
| Clicks in a 10-px band at y=146 | 296 of 308 — the **Name Box**, one UI element, not a spread of cell attempts |

`modified` means the document was open with unsaved changes (`c1-judge.ts:32`).
Had the agent clicked a *neighbouring* cell it would have saved the wrong value and
produced `persisted-mismatch`. Twelve rows typed the correct value and stopped. That
is a **task-completion** difference induced by the instruction, not a grounding
failure — and a screenshot baseline scored under a weaker instruction cannot be used
to argue the approach is weak.

The owner's independent analysis reaches the same conclusion from the same rows:
`docs/research/experiments/c1-arm-002/FAILURE-ANALYSIS.md`.

## Design

| Property | Value | Rationale |
|---|---|---|
| Task text | **the canonical intent string, byte-identical to Myco's** | the point of the arm |
| Source | one shared constant both arms import | so it cannot drift again |
| Trades compared | seed, rowKey, column, newValue | unchanged; parity already proven 30/30 |
| Planner | `claude-sonnet-5-5`, same fail-closed wrapper | same model and settings |
| Snapshot | `cua-c1-base` | same initial state |
| Trials | 30 | same denominator |
| Spend | counted against **all committed spend**, cap **$9.00** | see below |
| Deviation | `task-text:canonical` recorded on every row | makes the change visible in the artifact |

**Instruction-parity is recorded, not assumed.** Each row gains an `instruction`
field holding the rendered string, so a reviewer checks parity by diffing two
fields instead of reading source. This is the fix for the gap identified in
`docs/research/experiments/c1-parity.md`, and it applies to both arms.

## Spend accounting

Committed to date, measured from the ledgers:

| Source | Cost |
|---|---|
| `c1-spike/0.json` | $0.0768 |
| `c1-arm/accounting.json` (aborted, 0 rows) | $0.0000 |
| `c1-arm2/accounting.json` (finished) | **$1.56 charged** ($1.18 actually spent across the 29 scored rows; $0.38 is row 9's reservation, never spent but booked) |
| **Total committed** | **$1.56 charged** — the figure that counts against the cap (the $1.11 and $1.63 figures were mid-run snapshots) |

Arm-003 runs to a **$9.00 cap on total committed spend**, and arm-002's final cost
counts toward it. At arm-002's measured rate the remaining headroom is comfortable;
the cap binds before worst case, which is the intended fail-closed behaviour.

## Arm-002 disposition

- **Kept** as a recorded run under `docs/research/experiments/c1-arm-002/`, with its
  analysis. Its rows are valid artifacts; they are simply not the baseline.
- **Not scored as the criterion-7 baseline.** Row 7 stays IN PROGRESS.
- Its numbers may be reported as a *secondary* observation — a screenshot agent
  under a save-less instruction — clearly labelled, never as the comparison.
