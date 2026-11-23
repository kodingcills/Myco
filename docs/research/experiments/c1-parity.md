# C1 baseline: instruction and fixture parity with the Myco arm

**Question.** M1 criterion 7 requires the screenshot baseline to be compared "on
identical tasks, initial states, and model settings". Does C1 actually get the
same tasks and fixtures as the Myco M1-013 arm, or only tasks that look similar?

**Answer: identical on every recorded dimension.** One dimension is not recorded
by either arm, and that gap is stated below rather than glossed.

## Method

Everything here is computed from recorded artifacts, not from reading the code:

- Myco arm: `/tmp/m1-013/sweep-v3/` — `params.json`, `trials.jsonl`, and
  `runs/<index>/<runId>/result.json`.
- C1 arm: the frozen manifest `src/baseline/sweep-v3.json`, plus live rows in
  `/tmp/baseline/c1-arm2/accounting.json`.

## Result

| Dimension | Evidence | Result |
|---|---|---|
| Task parameters (seed, record, column, value) | `params.json[i]` vs `sweep-v3.json rows[i].params` | **30/30 identical, 0 mismatches** |
| Trial identity | `trials.jsonl[i].runId` vs `manifest rows[i].runId` | **30/30 identical, 0 mismatches** |
| Fixture identity | `fingerprints.json[seed]` vs each row's `fixtureSeed` | **6/6 seeds; each maps to one pinned hash** |
| Myco's recorded result, byte for byte | `sha256(runs/<i>/<runId>/result.json)` vs `manifest rows[i].resultSha256` | **30/30 verified** |
| Model setting | `deviations` records `planner:claude-sonnet-5-5`; Myco's arm used the same model | Same model string |
| Initial state | Both reset to the `cua-c1-base` snapshot | Same snapshot |
| **Rendered instruction sentence** | each row's `instruction` field, both arms | **RECORDED BY BOTH, byte-identical test pinned** |

The third row is the strongest evidence, and it is worth being precise about why.
`resultSha256` in the C1 manifest is **not** a fixture hash — it is the SHA-256 of
Myco's own `result.json` for that `runId`. All 30 reproduce exactly. The C1 arm
therefore carries Myco's recorded trial identities *and* a byte-exact reference to
what Myco produced, so the two arms cannot silently drift apart.

The instruction sentence is built by one shared function,
`taskText()` in `src/tasks/task-text.ts`:

```ts
return `Set the cell at record ${params.rowKey}, column ${params.column}, to ${JSON.stringify(params.newValue)}, and save the file.`;
```

**This section is superseded by TIF-104 and TIF-85.** As written it said neither arm
persisted the rendered string, which was true when the doc was drafted and is not
true now:

- `taskText()` is the single construction site, imported by both arms
  (`c1-trial.ts` and `integration/trial.ts`).
- Both arms **record it on every row** as `instruction`.
- `test/baseline/instruction-parity.test.ts` and `task-parity.test.ts` pin that
  both call sites use it and that the save requirement is in the text.

So instruction parity is now **observed** — a field diff between two artifacts —
rather than inferred from identical inputs. The old text has been left visible in
this note only in summary; the correction is the paragraph above.

## What this does and does not establish

**Establishes:** the paired arms cover the same 30 tasks, the same fixtures, the
same initial snapshot and the same model, and C1's manifest is bound byte-for-byte
to Myco's recorded results.

**Does not establish, and must be said in the criterion-7 write-up:** that the two
arms sent byte-identical *text* to their planners. The Myco arm's prompt is not in
its artifacts; the C1 arm's is a one-line template applied to identical params.

**Recommendation.** Zero-cost and worth doing before row 7 is marked DONE: have
each arm record the rendered instruction in its row (a single `instruction` field).
Then parity is observed rather than inferred, and a future reviewer can check it
without reading source. Until then, row 7's evidence should say *"identical
parameters, fixtures and identities; instruction text identical by construction
from a single template site"*.

## Retracted: the manifest hash does bind (the earlier alarm was a false one)

An earlier version of this note reported a discrepancy: the ledger records
`manifestSha256: bb256a9b…` while `shasum -a 256 src/baseline/sweep-v3.json` gives
`4d651ba1…`.

**That comparison was wrong, and the hash is correct.** `sweep.ts:23` computes it
over the **parsed** object, not the file bytes:

```ts
const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
```

So the right check is `sha256(JSON.stringify(import(manifest)))`, not `shasum` on
the file — and that reproduces `bb256a9b…` exactly. Verified:

```
JSON.stringify(manifest): bb256a9b2b28ee929c94352887a3d4bc402f4a14181a2a41a16e82bf76351995
recorded                : bb256a9b2b28ee929c94352887a3d4bc402f4a14181a2a41a16e82bf76351995
match? true
```

**Consequence: the arm ledger does bind to the manifest in the repo.** A
reproducibility check must hash the parsed object; hashing the file is what fails,
and it would fail for any correctly-recorded run.

Worth keeping as the record of a near-miss: the alarm came from a plausible-looking
check that measured something adjacent to the claim. `sweep.ts:63` enforces the
same comparison at run time (`ledger.manifestSha256 !== manifestSha256` throws
"v3 manifest mismatch"), so the guard was working the whole time.

## The save step is NOT parity — a capability asymmetry (TIF-90)

**Found from arm-003c's first row, then investigated off-VM. This is a real
parity break, and it is not a policy applied to both arms.**

> **STATUS: FIXED in the C1 harness.** C1's save now routes to
> `src/baseline/c1-save.ts`, which performs the same operation M1's `save` helper
> does — send `{Ctrl}s`, then answer the *"Non-standard file format"* dialog by
> name-matching the `"Use Excel…"` button. Pre-mortem in
> `c1-save-parity-premortem.md`; `test/baseline/save-parity.test.ts` fails if the
> route is removed. The text below is the record of what was wrong and why it
> mattered.

Both arms are told to save. They do not save the same way, and the difference is
not a detail: **C1's save cannot succeed on a converted `.xlsx` even when the
planner does everything else right.**

### The two paths

| | M1 arm | C1 arm |
|---|---|---|
| Declared step | `{ kind: "keyPress", keys: "ctrl+s" }` (`calc-record-edit.ts:163`) | `press_key` with `key: "Ctrl+s"` (`planner.ts:82`) |
| Transport | **Myco agent ops** — `save`, `focus`, `keys` | **Cua `press_key`** |
| What Ctrl+S actually does | `#runHelper({ op: "save" })` (`calc-adapter.ts:436`) | sends a raw key combo |
| Format dialog | **handled** — the `save` op answers "Non-standard file format" (keep Excel format) | **none** |

The declared step and the executed step differ on the M1 side, deliberately:
`calc-adapter.ts:429` intercepts `ctrl+s` and calls the save helper instead, with
this comment in the source:

> Ctrl+S on a converted .xlsx raises the "Non-standard file format" dialog; the
> save op answers it (keep Excel format).

M1 therefore never sends a raw Ctrl+S. **C1's `press_key` has no equivalent** —
`grep press_key src/win/calc-adapter.ts` returns nothing, because M1 does not use
that route at all.

### The observed evidence

arm-003c row 0 is the first row in either arm where a save was attempted:

```
 0 type_text @(70,146)  text='B39\n'          ← Name Box navigation
 1 type_text @(160,262) text='REVISED-908578\n' ← the CORRECT cell, correct value
 2 press_key key='Ctrl+s'                     ← the save, refused
```

`deviations: [... "cua-action-refused"]`, verdict `refuted/modified`. The planner
did the sequence correctly and the save step was refused.

Counts across the two arms:

| | `press_key` | `cua-action-refused` |
|---|---|---|
| arm-002 | 0 | 0 |
| arm-003c | 1 | 1 |

arm-002 never attempted a save, so this asymmetry was invisible across all 29 of
its rows. It surfaced the first time a planner actually tried.

### Where the refusal comes from

Not the harness allowlist. `c1.ts:38` accepts `Ctrl+s` — the grammar is
`/^[a-z0-9+_-]{1,32}$/i` and the `i` flag permits mixed case. The refusal is the
guest's own response: `c1.ts:98` sets
`refused: result.isError === true || effect === "refused"`, and `c1-trial.ts:68`
records it and breaks the trial loop.

### Why this matters for the comparison

A baseline that cannot complete the job's final step is not measuring the same
job as an arm that can. Until the save paths are equivalent, **arm-003's refutation
rate is not comparable to M1's**, and the difference is attributable to the
harness rather than to the model.

Two ways to close it, both upstream of this doc:
1. Give the C1 path the same dialog handling — e.g. a `save` route in the guest
   that C1 may call, so both arms answer the format dialog.
2. Or have M1 send the raw combo too, so both fail equally. (Worse: it would
   deliberately break the arm that works.)

The first is the honest fix. Until it lands, any arm-003 number must be reported
with this caveat attached.

## Committed spend — the $1.96 vs $3.14 discrepancy, settled

Two figures were published for the same ledger and the difference was never
explained. Both were mine, at different times, and **$1.96 was wrong**.

| Source | Booked |
|---|---|
| **Surviving in the repo** | |
| spike (`c1-arm-001/spike-trial-0.json`) | $0.076808 |
| arm-001 | $0.000000 (all omitted; no reservation booked) |
| arm-002 (`c1-arm-002/accounting.json`) | $1.555362 |
| *subtotal* | *$1.632170* |
| **Wiped by the 04:38 kernel panic** (`/tmp`) | |
| arm-3 | $1.130400 |
| arm-3b | $0.376800 |
| arm-3c | $0.051318 |
| *subtotal* | *$1.558518* |
| **TOTAL COMMITTED** | **$3.190688** |
| **Headroom to the $9.00 cap** | **$5.809312** |

**Why $1.96 appeared:** it was `spike + arm-3 + arm-3b + arm-3c` — the three new
runs plus the spike, computed while looking at those runs. **arm-002's $1.555362
was omitted**, which is a 1.6× under-count of the true figure.

**Why the wiped entries still count:** the runner never charged them against the
cap, and their ledgers are gone, but the API calls were made and billed. Counting
them is the conservative direction, and `$3.190688` is the figure to quote.

**Rule this settles:** count committed spend from the artifacts that define it —
every ledger entry, scored, omitted and reserved — and reconcile *before* quoting,
not after two numbers have already been published.
