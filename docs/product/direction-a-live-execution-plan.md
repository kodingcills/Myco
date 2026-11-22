# Direction A Live Execution Plan: Verified Desktop for Coding Agents on RT-020

- **Workstream:** MVP Discovery (MVD-001 / Linear TIF-53)
- **Status:** **Ready for Execution** (pending Runtime RT-020 proof verification and Coordinator VM slot grant)
- **Target Desktop:** Linux X11 Desktop (`RT-020`), 1440×900 display
- **Target Application:** Dogfood `myco-todo` (`dogfood/apps/myco-todo/myco_todo.py`)
- **Companion Documents:**
  - [MVP Discovery Plan](mvp-discovery-plan.md)
  - [MVD Pre-Registration & Wedge Status](mvd-preregistration.md)
  - [Task Package: todo-save.yaml](../../tasks/todo-save.yaml)
  - [GUI Specification](../../docs/design/gui-spec.md)
  - [Evaluation Runbook](../../docs/eval-runbook.md)

---

## 1. Executive Summary & Objective

Direction A proves that Myco provides **verified desktop testing for coding agents**: driving a real GUI, observing state transitions, and deriving a ground-truth verdict from persisted host-side state rather than relying on the agent's self-report or deceptive UI status strings.

The primary proof is the **false-success trap (DF-S02)**:
1. A user gives a coding agent a task: *"In myco-todo, add these four items [including BUG-prefixed items], save, and confirm persistence."*
2. The agent drives the real GUI. The status bar displays **"saved 4 item(s)"**.
3. A transcript-based or screenshot-only tool marks the run **SUCCESS**.
4. Myco's host-side oracle reads the persisted store (`~/.local/share/myco-todo/store.json`): two items were silently dropped by the seeded bug.
5. Myco returns **REFUTED** (False Success Caught), naming the missing items and pinpointing the exact failure in the durable evidence archive (`.mycotrace`).

---

## 2. Hard Prerequisites & Pre-Flight Gates

No live execution may commence until all four gates are signed off:

| Gate | Requirement | Responsible Workstream | Status / Verification Command |
| :--- | :--- | :--- | :--- |
| **G1: RT-011** | First end-to-end path verified (`create → observe → act → evidence → reset → destroy`) | Runtime | Confirmed passing in runtime CI/check |
| **G2: RT-015** | Host-side guest file read operational (`REQ-08`) | Runtime | `vssh 'cat ~/.local/share/myco-todo/store.json'` or host bridge read |
| **G3: RT-016** | Process control & signal dispatch operational (`REQ-09`) | Runtime | Process kill/relaunch verified clean |
| **G4: Coordinator GO** | Dedicated host execution window granted | M1 Coordinator | Explicit start/stop window recorded in coordination log |

> [!CAUTION]
> **Host Safety Rule:** Under no circumstances should host processes outside the VM be touched. Specifically, personal Google Chrome sessions (e.g. PID 69583) must never be inspected, signaled, or attached to.

---

## 3. Environment Topology

```
+-----------------------------------------------------------------------------------+
| macOS Development Host (No personal sessions touched)                              |
|                                                                                   |
|  +--------------------+        +--------------------+      +--------------------+ |
|  | Myco CLI / Agent   |  --->  | Host-Side Oracle   |  <-- | v0 Myco Viewer     | |
|  | `myco test`        |        | (Foundry Evaluator)|      | (Offline Trace)    | |
|  +--------------------+        +--------------------+      +--------------------+ |
|            |                             ^                                        |
|            | SSH / Agent Bridge          | Read-Only Persisted Store Mount        |
|            v                             |                                        |
|  +------------------------------------------------------------------------------+ |
|  | UTM / QEMU Guest VM: `myco-rt020` (Linux X11, Display :0, 1440x900)          | |
|  |                                                                              | |
|  |   - X11 Window Manager + Dogfood App: `myco-todo`                            | |
|  |   - GUI Elements: Edit[name=new-item], Button[name=add], List[name=items]   | |
|  |   - Persisted Store: `~/.local/share/myco-todo/store.json`                   | |
|  +------------------------------------------------------------------------------+ |
+-----------------------------------------------------------------------------------+
```

---

## 4. Task Specifications & Test Matrix

### Trial 1: Happy Path Baseline (DF-S01)
- **Task Intent:** Add 4 normal items without prefix defects:
  1. `update the release notes`
  2. `write the incident summary`
  3. `verify database connection pool`
  4. `prepare deployment checklist`
- **Expected UI Status:** `"saved 4 item(s)"`
- **Expected Persisted State:** Exactly 4 items in `store.json`.
- **Expected Verdict:** **VERIFIED** (Score: 1.0, 4/4 checks passed).

### Trial 2: Seeded Bug False-Success Trap (DF-S02 / ef-t01)
- **Task Intent:** Add 4 items containing BUG-prefixed items:
  1. `bug: login page crashes on save`
  2. `BUG: token expires too early`
  3. `update the release notes`
  4. `write the incident summary`
- **Deceptive UI Status:** `"saved 4 item(s)"`
- **Actual Persisted State:** Only 2 items present in `store.json` (items starting with `bug:` / `BUG:` dropped).
- **Expected Verdict:** **REFUTED** (Score: 0.50, False Success: YES, 2/4 checks passed).

---

## 5. Step-by-Step Operator Runbook

### Step 1: Pre-Flight Local Check
Run from repository root:
```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm --filter viewer build
```
*Expected:* All 4 commands succeed with 0 errors.

### Step 2: Host VM Reset to Clean Snapshot
```bash
# Verify VM is running clean base
~/VMs/myco-rt020/scripts/vm.sh status
~/VMs/myco-rt020/scripts/reset.sh clean-base
~/VMs/myco-rt020/scripts/wait-ssh.sh 60
```

### Step 3: Execute Task Package on Live Desktop
Execute Direction A task package with live execution flag:
```bash
./bin/myco test tasks/todo-save.yaml --live --vm myco-rt020
```

### Step 4: Validate Generated Evidence Bundle
Verify that the output directory contains all required schema-compliant artifacts:
```bash
ls -la runs/direction-a-todo-save/
# Must contain:
# - trace.jsonl (valid against schemas/trace-events.ts)
# - trace.extended.jsonl
# - result.json (valid against schemas/result-record.ts)
# - ledger.jsonl (valid against schemas/ledger-row.ts)
# - manifest.json (valid against mycotrace/1 format)
# - artifacts/ (step-*.png frames at 1440x900)
# Archive: runs/direction-a-todo-save.mycotrace
```

### Step 5: Offline Inspection via v0 Myco Viewer
Open the newly generated `.mycotrace` archive in the Myco Viewer:
```bash
pnpm --filter viewer preview --trace runs/direction-a-todo-save.mycotrace
```
Verify:
1. **Verdict Bar:** Correctly displays `REFUTED · False success`, score `0.50`, and check counts `2/4`.
2. **Badge:** Does *not* show the `Simulated` badge (live run flag present).
3. **Proof Tab:** Shows `absent` rows highlighted with direct anchors to trace events.
4. **Why Tab:** Shows real 1440×900 screenshots with scrubber positioning matching event timestamps.
5. **Budgets:** In-browser verdict render ≤ 150 ms; renderer native memory ≤ 400 MB.

---

## 6. Pre-Declared Decision Rules & Pass/Fail Criteria

| Criterion | Target Metric | Action on Failure |
| :--- | :--- | :--- |
| **False-Success Trap** | Exactly 0 false successes on DF-S02 (oracle must report `refuted`) | If false success is missed, halt evaluation and fix oracle bridge. |
| **Happy Path Rate** | ≥ 90% `verified` over 10 consecutive trials on DF-S01 | If < 90%, record flake causes and repair flakiness. |
| **Time-to-First-Result** | ≤ 15 minutes setup-to-verdict from clean clone | If > 15 minutes, streamline bootstrap README and dependencies. |
| **Reproducibility** | Second independent agent (Claude Code / Codex) reproduces verdict | If irreproducible, isolate hidden environment assumptions. |

---

## 7. Rollback & Post-Run Protocol

1. Take down the live test session and clean temporary mounts.
2. Reset the VM to `clean-base` snapshot.
3. Attach generated `.mycotrace` archive and updated 1440×900 screenshots to Linear issue **TIF-53**.
4. Log trial results into `docs/foundry/baseline-report.ts` and update the discovery scorecard.
