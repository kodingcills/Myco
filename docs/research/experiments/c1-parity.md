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
