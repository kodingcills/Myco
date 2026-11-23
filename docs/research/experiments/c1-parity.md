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
| **Rendered instruction sentence** | — | **NOT RECORDED BY EITHER ARM** |

The third row is the strongest evidence, and it is worth being precise about why.
`resultSha256` in the C1 manifest is **not** a fixture hash — it is the SHA-256 of
Myco's own `result.json` for that `runId`. All 30 reproduce exactly. The C1 arm
therefore carries Myco's recorded trial identities *and* a byte-exact reference to
what Myco produced, so the two arms cannot silently drift apart.

The instruction sentence is constructed at `src/baseline/c1-trial.ts:46`:

```ts
const instruction = `Set the ${column} cell for record ${rowKey} to ${JSON.stringify(newValue)}.`;
```

Both arms pass the same `taskParams` (proven above), and this is the only
instruction-construction site in the repo. But **neither arm persists the rendered
string**, so parity is an inference from identical inputs, not an observation of
identical prompts.

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

## Separate finding: the manifest hash does not bind

`report.json` and `accounting.json` for arm-002 record
`manifestSha256: bb256a9b…`, while `src/baseline/sweep-v3.json` in the repo hashes
to `4d651ba1…`. The manifest is unchanged by the PRs that landed today, so this is
a pre-existing discrepancy, not drift from this work.

Consequence: **the arm ledger does not currently bind to the manifest in the repo.**
A future reproducibility claim that checks the recorded hash against the checked-in
file will fail. Not fixed here — it needs the arm's owner to say which manifest
produced the run before any hash is rewritten.
