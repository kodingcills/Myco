# Task set byoa-ledger-v1

Frozen reader-experiment task set for capability track T (bring your own app):
`docs/product/capability-t-byoa.md`, `docs/product/capability-spec-2.md` §T. Graded by the
independent grader entry `ledger-csv/1` (`src/benchmark/grade/ledger.ts`).

- `tasks.jsonl`: one task per line. `intent` is "set `column` of the row whose id is `id`
  to `value`"; `instruction` is the exact text the agent receives, from one template for both
  kinds. `kind` (`satisfiable` or `invalid-target`) is never shown to the agent.
- `fixtures/<sha256>.csv`: the pristine ledger each task hands the guest as
  `ledger.csv`, named by its SHA-256.
- `manifest.json`: SHA-256 of every other file. Pre-register the set by the digest of this
  manifest.

72 tasks: 12 fixtures of 5 to 40 rows; 60 satisfiable edits (5 per fixture, on distinct rows;
the columns date, payee, amount and category 15 each) and 12 invalid-target tasks (1 per
fixture; the id is not in the fixture). Build seed: `byoa-ledger-v1/build`.

Regenerate or check with `npx tsx scripts/byoa-ledger-taskset.ts [--check]`. Published sets
never change; a change is a new version. No trial has run on this set; nothing here is
evidence.
