# Myco Dogfood backlog

Canonical in-repo backlog for the dogfood workstream. The outer loop mirrors
this into Linear project "Myco Dogfood" (team TIF). Ids are stable; never
renumber. `blocked_by` lists markdown ids; `RT-first-path` means the Myco
Desktop Runtime (Rust) workstream's first end-to-end path (create, observe,
act, evidence, reset, destroy) — see docs/coordination/dogfood-state.md.
Owner roles: `dogfood-owner` (this thread), `runtime` (Rust runtime
workstream), `agent-under-test` (cheaperinference/glm-5.3), `verifier`
(cheaperinference/kimi-k3), `outer-loop`.

---

### DF-001 (TIF-23) Sample app: myco-todo with seeded persistence bug
- **status:** done (2026-11-19, this branch; repaired 2026-11-22 via PR #89)
- **owner:** dogfood-owner
- **blocked_by:** none
- **description:** Tiny Tkinter GUI todo app under `dogfood/apps/myco-todo/`, Linux-first, JSON-persisted store, seeded bug: `BUG`-prefixed items silently dropped at save while UI reports success. Repaired via PR #89 to fix lazy `import tkinter as tk` NameError with `global tk`, atomic state publication, and headless `test_myco_todo.py`. Verified in guest during RT-020 live run.
- **acceptance:** `--self-test` passes headless; save/load logic verified against edge cases (case-insensitive prefix, empty store); README documents the bug contract; GUI startup and window visibility verified.

### DF-002 (TIF-24) Dogfood scenarios DF-S01..DF-S05
- **status:** done (2026-11-19, this branch)
- **owner:** dogfood-owner
- **blocked_by:** DF-001
- **description:** Five scenarios under `dogfood/scenarios/`: install-launch-save, find-seeded-bug, fix-seeded-bug, crash-recovery, adversarial-inputs. Each states task prompt, required runtime capabilities (REQ-ids), an independent host-side success oracle, and its false-success trap.
- **acceptance:** every oracle is computable without consulting the agent's claims; every scenario names its REQ-ids from docs/coordination/dogfood-state.md.

### DF-003 (TIF-25) Scoring + Linear issue format
- **status:** done (2026-11-19, this branch)
- **owner:** dogfood-owner
- **blocked_by:** DF-002
- **description:** `dogfood/scoring.md`: run buckets (success / false-success / refusal / uncertain / gap), time-cost recording, missing-capability attribution by REQ-id, and the exact DF backlog-entry format for capability failures. Reuses M1-012 evidence schemas; no new schema invented.
- **acceptance:** a failed run can be transcribed into a backlog entry using only the format in scoring.md; buckets map onto the M1-012 ledger state derivation table.

### DF-004 (TIF-26) Runtime capability requirements posted
- **status:** done (2026-11-19, this branch)
- **owner:** dogfood-owner
- **blocked_by:** DF-002
- **description:** REQ-01..REQ-12 posted to docs/coordination/dogfood-state.md as requirements for the Myco Desktop Runtime (Rust) owner, each traced to the scenarios that exercise it.
- **acceptance:** every scenario's required capabilities resolve to a REQ-id; coordinator + runtime owner can read the table without further context.

### DF-005 (TIF-27) Phase 1: run DF-S01..DF-S05 through the real runtime
- **status:** ready (unblocked 2026-11-22 by RT-020; queued for VM slot)
- **owner:** dogfood-owner (execution), agent-under-test, verifier
- **blocked_by:** none (RT-first-path complete)
- **description:** For each scenario: provision a desktop via the runtime, run cheaperinference/glm-5.3 as the agent under test on the scenario task, grade with the scenario's oracle plus cheaperinference/kimi-k3 as independent verifier of the agent's report, emit M1-012 evidence (trace.jsonl, result.json, ledger.jsonl), score per dogfood/scoring.md.
- **acceptance:** 5 scenarios × ≥3 runs each scored with schema-valid evidence; false-success count reported separately; median time cost per scenario reported; all gaps attributed to REQ-ids.

### DF-006 (TIF-28) File Phase 1 capability failures and re-run after fixes
- **status:** blocked
- **owner:** dogfood-owner
- **blocked_by:** DF-005
- **description:** Each capability failure from DF-005 becomes a DF-0NN entry here (format in dogfood/scoring.md) with reproduction evidence, mirrored by the outer loop to Linear and handed to the runtime workstream. After runtime fixes land, re-run the affected scenarios to demonstrate improvement.
- **acceptance:** every gap/uncertain run from DF-005 has either a DF issue with reproduction or a documented agent-judgment classification; re-run results recorded per scenario showing bucket movement.

---

## Phase 1 capability-failure entries

(Appended below this line as DF-007+ when Phase 1 runs surface them, using the
format in dogfood/scoring.md §"Turning a failed capability into a Linear
issue".)
