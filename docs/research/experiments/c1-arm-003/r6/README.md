# arm-003 r6: the graded-field ledger extract

`ledger-extract.json` holds r6's 30 graded rows: task (`fixtureSeed`, `rowKey`, `column`,
`newValue`), `verdict`, `verdictReason`, `falseSuccess`, `audited`, steps, per-row charged
micros and the harness `deviations`. It leaves out transcripts and usage, but keeps five fields
derived from each transcript: `typedExpected` (did any `type_text` enter the expected value),
`actions`, `pressKey`, `ctrlS`, `escape`, plus the agent's `claims`. Those fields carry the
save-dialog split in row 7 (27 of 29 step-budget rows typed the value and pressed Ctrl+S; rows
13 and 21 did neither). The full ledger stays on the host, because it is ~485 KB of
agent transcripts:

```
~/Projects/myco-runs/c1-r6/accounting.json   sha256 50f337cec96a1b4b76db4074f1f4bd7b86df552139fb75e61bf12089be3d63d0
```

Regenerate the extract from the ledger, byte for byte, and re-run the row-7 comparison:

```sh
python3 scripts/row7-compare.py extract ~/Projects/myco-runs/c1-r6/accounting.json
python3 scripts/row7-compare.py compare --check
```

The graded field is `row.verdict` / `row.verdictReason`, set by `judge()` in
`src/baseline/index.ts`. The extract never carries `mycoVerdict`, which is copied from the pinned
`sweep-v3.json` and grades nothing (TIF-207).
