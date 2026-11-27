# Recursive orchestration task set orch-v1

Frozen task set for capability track V (recursive orchestration;
`docs/product/capability-spec-2.md` §2 V, `docs/orchestrate/recursive-orchestration.md`).
Licensed Apache-2.0, like the rest of this repository.

60 multi-part tasks: tasks 1-20 have 2 parts, 21-40 have 3, 41-60 have 4. Each part is
one `calc-record-edit` edit on its own CSV file (`part-<k>.csv`), gated per part
(`persistedFormat: "csv"`). An agent receives only the task's `instruction`; the
decomposition into workers is the planner's job.

- `tasks.jsonl`: one task per line (schema `myco.orchestrate.task/1`): the instruction, and per
  part the gate entry (family, state file, spec and its digest), the intent, the column types
  and the fixture.
- `fixtures/<sha256>.csv`: the pristine sheet each part hands the guest, named by its SHA-256.
- `manifest.json`: SHA-256 of every other file. The task set is pre-registered by the digest
  of this manifest (`docs/product/capability-prereg/v-v1/prereg.json`).

A task is verified only when every part is: in the `V` arm, every part's gate verdict is
`verified` and the independent grader passes every part; in `H` and `C1`, the grader passes
every part. Regenerate or check with `npx tsx scripts/orch-taskset.ts [--check]`. Published
sets never change; a change is a new version.
