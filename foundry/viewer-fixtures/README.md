# Viewer fixtures

Synthetic run folders (gui-spec §6.1 folder form) for the run viewer's acceptance tests and
§8 perf budgets. They describe an imaginary `myco-todo` session; they are **not** Foundry task
fixtures and contain no oracle or hidden-split material.

| Folder | Display verdict (§6.2) | Notes |
|---|---|---|
| `verified/` | Verified | 12 steps, all checks `true` |
| `recovered/` | Recovered | `fault-injection` + `guard-failure` + `recovery`, then verified |
| `false-success/` | Failed › False success | ledger `oracle: ground-truth:false`; `trace.extended.jsonl` adds §6.4 `claim` events (UI says "Saved 2 items", persisted store lacks "call mom") |
| `unknown/` | Unknown | one check `passed: null` (`could not look`), `unresolvedState` set |

`trace.jsonl` is strictly valid against `schemas/trace-events.ts`. `claim` is not in that closed
schema yet, so claims live only in `trace.extended.jsonl`; without it the Comparator must show
`claimed (derived)`.

Perf runs (1,000 and 10,000 steps) are generated, not committed:

    npx tsx scripts/gen-viewer-fixtures.ts --perf <dir>

Regenerate the committed runs: `npx tsx scripts/gen-viewer-fixtures.ts`. Output is deterministic.
