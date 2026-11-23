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
| `c1-arm2/accounting.json` (finished) | **$1.555362 charged** ($1.178562 actually spent across the 29 scored rows; $0.376800 is row 9's reservation, never spent but booked) |
| **Total committed** | read from `report.json.c1ChargedMicros` and the spike: **$1.632162** today (spike $0.076800 + arm-002 $1.555362). Recompute it from those two files rather than trusting this cell — the pre-existing "≈$1.11" (and its $1.0344 input) were mid-run snapshots |

Arm-003 runs to a **$9.00 cap on total committed spend**, and arm-002's final cost
counts toward it. At arm-002's measured rate the remaining headroom is comfortable;
the cap binds before worst case, which is the intended fail-closed behaviour.

## Arm-002 disposition

- **Kept** as a recorded run under `docs/research/experiments/c1-arm-002/`, with its
  analysis. Its rows are valid artifacts; they are simply not the baseline.
- **Not scored as the criterion-7 baseline.** Row 7 stays IN PROGRESS.
- Its numbers may be reported as a *secondary* observation — a screenshot agent
  under a save-less instruction — clearly labelled, never as the comparison.
## Part of TIF-90 — executable spec

The sections above are the design. This section is what to run, and how to tell
whether it worked. It exists so arm-003 can start the moment TIF-104 and TIF-85
land, without re-deriving the plan under time pressure.

### Pre-conditions (all must hold before the first trial)

| Gate | Check | Why |
|---|---|---|
| TIF-85 landed | `taskText()` returns a sentence containing "and save the file" | the arm is pointless without it |
| TIF-104 landed | `gh pr view 237` is merged | upstream blocker |
| Instruction parity pinned | `test/baseline/task-parity.test.ts` green | the defect this arm exists to fix |
| Guest clean | no `soffice.bin`, `:8765` free | a leftover contaminates trial 1 |
| VM lock free | `flock -n` on `/tmp/myco-win11.vm.lock` acquires | single-owner rule |
| Cap headroom | committed spend ≤ **$9.00** including arm-002 | fail-closed |

Wall-clock and load are **not** gates (standing rule: load alone never holds a
run; power is recorded, never enforced).

### Acceptance criteria

1. **30 trials attempted.** Report the denominator as `scored / omitted / reserved`,
   never as "30".
2. **Every row carries an `instruction` field** and it is byte-identical across all
   30 trials. A diff between any two rows' `instruction` must be empty. This is the
   parity claim, checked from the artifact rather than from source.

   **This criterion is currently unenforced, and must be made enforceable before
   the arm runs.** As of `144ed80` the producer exists (`c1-trial.ts:103` sets
   `instruction: taskText(...)`) but the field is **optional** in both the row type
   (`src/baseline/index.ts:165`) and the `isBaselineRow` validator, and **0 of 30**
   arm-002 rows actually carry it. So an earlier revision of this document claimed
   the field was "emitted on every row" on the strength of the producer alone —
   that was wrong: nothing enforces it and no artifact demonstrates it. Arm-003
   would satisfy the claim only because `runC1Trial` happens to be the sole
   producer. Making the field required and validated is the pre-condition that
   turns this from an assertion into a check.
3. **Spend ≤ $9.00 committed**, counting every ledger status plus the spike. Report
   `scored + omitted + reserved`, not scored alone — an omitted trial made real API
   calls before it died.
4. **`falseSuccess` is reported as observed, not as a bound.** Arm-002 has
   `audited: false` on every row (`c1-trial.ts:91` — the ref earlier in this
   document said :88, which was stale), so "0 false successes" there is unaudited and
   supports no bound. Arm-003 must audit the `verified` rows (the audit only runs
   on `verified`, `c1-trial.ts:91`) or state plainly that it did not.
5. **The comparison is stated as a comparison.** Arm-003 vs arm-002 differs in the
   task text; that is the independent variable and must be named in the write-up.

### Pre-mortem — the four ways this arm fails

| Failure | Signature | Response |
|---|---|---|
| **`driver-unreachable` recurs** | `sessionIdentityMatches:false` on trial 0–2 | stop, do not burn the arm; the 45 s budget did not fix the root cause |
| **Click band unchanged** | still ~99% of clicks at y≈146 after the save fix | the save text was not the whole story; TIF-97 is the real defect and the arm should be re-scoped, not re-run blindly |
| **`modified` persists** | rows still typed-and-unsaved despite "and save the file" | the planner is not reading the task line; check the prompt assembly before spending more |
| **Spend outruns the cap** | committed > $4.00 mid-arm | report immediately with the per-trial rate; do not let the cap bind silently |

### What would make this arm unnecessary

If TIF-97 (Name-Box clustering) is confirmed as a **grounding** defect rather than
a strategy choice, no task text fixes it — the cost of arm-003 is then better spent
on the coordinate channel. That decision belongs to the Coordinator, and the
pre-mortem row above is how they will know.
