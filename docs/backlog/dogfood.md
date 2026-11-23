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
- **status:** blocked (2026-11-23) on the preflight/guest-boot deadlock - see
  `docs/research/experiments/df-s01-preflight-deadlock/BLOCKER.md`. The runner
  cannot start from a clean host: `preflight()` (df005-runner.py:1347) hard-fails
  when `guest-ssh` is unreachable, but the guest only comes up via `create()` ->
  `boot.sh` (backend-qemu lib.rs:616), which is downstream of that gate. Booting
  the guest first also fails, because `boot.sh` holds the host flock for the
  guest's lifetime. **Previously:** ready (unblocked 2026-11-22 by RT-020)
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

### DF-007 (TIF-120) Introspection channel is never enabled, so the global route has no target

- **status:** open — blocked on TIF-120 (Runtime)
- **owner:** runtime
- **blocked_by:** none
- **description:** `QemuConfig.introspection_file` defaults to `None`
  (`runtime/crates/myco-rt-backend-qemu/src/lib.rs:68`) and nothing in the
  DF-005 path sets it. It is **not settable through the MCP `create` tool**, so
  `MYCO_INTROSPECTION_FILE` is never passed to the guest agent, the app's
  published widget record never reaches the runner, and the global actuation
  route has no `entry_field` geometry to click. Tk registers zero AT-SPI nodes,
  so there is no ref route either: DF-S01 cannot pass until this is fixed.
- **reproduction:** eval `df-s01-live3-20261123-025219`, run `run-df-s01-1`,
  trial 1 of 3, 80.67s. Ledger row:
  `state=gap, oracle=verifier:uncertain, missing=REQ-01`; check reason:
  `no AT-SPI entry ref and no entry_field geometry in the introspection record,
  so there is no point to click`. Preflight passed 6/6 immediately before the
  run, including `introspection-env: MYCO_INTROSPECTION_FILE present in
  gui.env` — the variable exists in the guest's `gui.env`, but the runtime never
  passes it to the agent, so the two disagree.
- **acceptance:** `create` accepts an introspection path (or defaults to one the
  fixture publishes to); a DF-S01 trial then reaches the actuation step and its
  trace shows `clickAt` + `typeTextGlobal`; the run is graded from the persisted
  store rather than gapping on REQ-03/REQ-04.

### DF-008 (TIF-120) Provisioning omits the guest agent binary

- **status:** open — blocked on TIF-120 (Runtime)
- **owner:** runtime
- **blocked_by:** none
- **description:** `runtime/guest/provision.sh` produces the base image, overlay,
  keypair and seed, but not the `myco-rt-agent` binary. `create` then fails with
  `no agent binary on the host: build one with
  runtime/guest/build-agent-in-guest.sh`. The agent must be built **inside** the
  guest (it links `libxkbcommon`, so the musl cross-build from macOS fails), which
  means provisioning has an ordering dependency the script does not express:
  boot → build agent → shut down → run.
- **reproduction:** eval `df-s01-live2-20261123-025057`, all three trials,
  ~1.3s each. Ledger `detail`: `create failed: tool create error:
  {"code":-32000,"error":"backend error: protocol: no agent binary on the host:
  build one with runtime/guest/build-agent-in-guest.sh"}`. After running that
  script (57.7s, 7.4 MB binary) the same command reached the actuation step.
- **acceptance:** `provision.sh` either builds the agent or fails with that
  instruction; the runbook's provisioning sequence includes the build step and
  the boot/shutdown ordering it implies.

### DF-010 (TIF-pending) DF-005 runner follow-ups from TIF-158 verification
- **status:** open
- **owner:** dogfood-owner
- **blocked_by:** none
- **description:** Four non-behavioural follow-ups from the three TIF-158 (#299)
  verification rounds. None changes a verdict; all four make a future change
  harder to get wrong. Filed together because they share one file and one
  verifier round.
  1. **N1 — runbook path drift.** `docs/env/dogfood-runtime-runbook.md` taught
     `/home/myco/myco-todo/myco_todo.py` while the runner now deploys and
     launches `/tmp/myco_todo.py`. Fixed in PR #305 (Tier 0, doc-only).
  2. **N2 — a mutation dies by crashing, not by naming.** Making the write path
     absolute kills the offline suite via `KeyError: 'persisted-set-matches'` in
     test 9 rather than a named assertion. A `write_file path must be relative`
     check in test 24's block would fail cleanly.
  3. **N3 — writability is inferred, not measured.** `preflight` verifies the
     grant root exists but not that the agent may write there — the claim that
     failed twice. `stat -c '%a %U' /tmp` in preflight would measure it.
  4. **N4 — the outside-root guard is untested.** `deploy_fixture` refuses a path
     outside `GRANT_ROOT`, and no test feeds it one.
- **acceptance:** N2 fails with a named assertion when the write path is made
  absolute; N3's preflight reports the measured mode and owner of the grant root;
  N4 has a direct test that an outside-root path returns False; N1's runbook
  examples match the runner (PR #305).
