# Track J, j-v1: run runbook

**Status: queued. Nothing here has run. No trial runs until the lead gives GO for track J.**
The steps marked **VM** are for the local VM owner, under the VM lock; the cloud builder does
not do them.

## What exists (non-VM, on `main` once this lands)

| Piece | Where |
|---|---|
| Pre-registration and its hash | `prereg.json`, `README.md` (this directory) |
| Seeded ABBA schedule (360 trials at k = 2) | `jV1Schedule`, `src/actions/j-v1-analysis.ts` |
| J-arm row adapter (fast-path row + harness counts) | `jTrialFromFastPathRow`, `src/actions/j-v1-harness.ts` |
| Pack writer, frozen-commit check, run loop, finalize | `src/actions/j-v1-pack.ts` |

The pack is one directory: `pack.json` (header: pre-registration hash, frozen-in commit,
analysis SHA-256, trial count, schedule SHA-256), `rows.jsonl` (one row per trial, schedule
order), `halted.json` (only if the run halted) and `analysis.json` (written once by finalize).

- The frozen-in commit is the commit on `main` that froze j-v1: the merge of #636,
  `7307655da6cfd03d177da056943695b951a7557d`. `openJV1Pack` and `finalizeJV1Pack` check with
  git that it is on the main ref and that its `prereg.json` hashes to the recorded hash. The
  clone they run in needs that history (not a depth-1 clone).
- The writer takes a row only if it is the next scheduled trial. A trial runner that throws,
  or returns a row for another trial, halts the pack. A halted pack takes no more rows and
  cannot be finalized; the track goes back to the lead. Nothing is re-run (retry budget 0).
- An interrupted run resumes by opening the same pack directory with the same commit: rows
  already written must be a schedule prefix, and a torn last line is refused, not repaired.
  If that happens, stop and report to the lead.

## What the run still needs before GO (not built here)

1. **Baseline row adapter**: an Ultra `hcu+shell` trial record to a
   `myco.capability.j-v1.trial/1` row, with its per-trial tool-call count. It waits for the
   Ultra `hcu+shell` harness on `main` (critical path; not edited by track J).
2. **The `hcu+shell+J` launch plan and its audit**: the baseline surface plus exactly the two
   `myco-cap` tools (`FAST_PATH_ARM_SPEC.blocker`, fast-path.md §4).
3. **A `runTrial` for each arm** that returns one row per scheduled trial, a harness fault as a
   row (`harnessFault`), never a throw, except when the harness itself cannot continue.
4. **One command** that opens the pack, calls `runJV1` with the two runners, then
   `finalizeJV1Pack`.

## Queued for the local VM owner (VM)

These need the Windows VM and are not done by the cloud builder.

1. **Guest-side routes** (fast-path.md §6): widen the guest agent's `uno_eval` from read-only
   to a write scoped to the trial document, and route the GUI fallback through the HCU
   channel. The guest-side router re-checks resolved paths after each call, as `hcu+shell`
   does (`checkResolvedAccesses`).
2. **Isolation check with J's tools**: run the TIF-266 isolation test with `myco-cap` in the
   launch, before any graded trial (prereg guardrail 2).
3. **Plumbing trial, simulated**: one scheduled trial per arm with a scripted planner into a
   throwaway pack, to check reset, deploy, capture and grading end to end. Its rows are
   `simulated: true`; finalize must report `not-shown` with `SIMULATED`. Delete that pack; it
   is never evidence.
4. **Time one Ultra trial per arm** and report it to the coordinator. The VM-hours estimate in
   `prereg.json` (37.5 h at 375 s per trial) assumes M1's trial time; the Ultra time is not
   measured yet.
5. **Only after the lead's GO**: the graded run, 360 trials, in one pack, from the commit above.
