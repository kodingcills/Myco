# Cross-app task set xa-v1

Frozen task set for the `cross-app-steps` gate family (capability track P): PDF -> Calc ->
Writer, three steps, a checkpoint per step. See `docs/gate/cross-app.md`.

- `tasks.jsonl`: one task per line (spec, digests, instruction, evidence layout).
- `fixtures/<sha256>.csv|.txt|.pdf`: the pristine sheet, the report template and the source
  notice each task hands the guest, named by their SHA-256.
- `manifest.json`: SHA-256 of every other file. Pre-register the set by the digest of this
  manifest.

Regenerate or check with `npx tsx scripts/cross-app-taskset.ts [--check]`. Published sets never
change; a change is a new version.
