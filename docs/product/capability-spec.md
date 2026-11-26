# Capability spec: what Myco adds to desktop agents (I-M)

**Status: spec, pre-measurement.** Nothing here has been run, and no result is claimed. Every
bar below is a proposal for the lead to ratify. Once ratified and frozen (§3), a bar changes
only by a new version.

**Why this exists (Tiffany, 2026-11-26 10:29 ET):** "Myco must ADD capabilities to desktop
agents, not only check and verify. The whole point of the baseline is to measure how Myco
improves agents over it."

The gate (`myco.gate/v1`, `docs/gate/api.md`) answers "is this done?". This spec covers five
things Myco should add so the agent gets more tasks done, and says how each is measured
against the existing baseline arms before anyone builds it. It follows the vision's list of
what current tools leave unsolved (`docs/product/vision.md`): true app state, recovery,
learning, parallelism, and executing intent as code.

| | Capability | Bar in one line |
|---|---|---|
| **I** | Structured state access | Higher verified rate and fewer steps than screenshot-only |
| **J** | Fastest reliable action path | Lower time and steps per verified task, no drop in verified rate |
| **K** | Recovery | Higher completion on long multi-step tasks than no-recovery |
| **L** | Safe parallelism | Throughput scales with N, zero cross-trial contamination |
| **M** | Learning from verified outcomes | Higher verified rate on repeat/similar tasks than cold runs; refuted runs never stored |

---

## 1. Rules shared by every capability

### 1.1 The grader decides; the gate does not

- **The primary metric of every track is graded by the independent grader**
  (`src/benchmark/grade/`, `false-completion-grader/1` or its successor entry for a new family).
  The grader shares no code with the gate (import-graph test), reads only the captured
  persisted bytes against the pinned pristine fixture and intent, and never sees a claim or a
  verdict (`docs/benchmark/public/grading-protocol.md` §§1-4).
- **The gate's verdict is never the measurement.** Where a capability uses the gate at runtime
  (K's corrections, M's store rule), the gate is part of the treatment, and the grader still
  grades the outcome.
- **A verified task** in this spec is R7's success (`src/m2/evidence.ts`:
  `row.accepted && grade.status === "pass"`) applied to capability rows: the row is accepted
  and the grader graded the captured document `pass`. Today `expectedAccepted`
  (`src/benchmark/check.ts`) keys on the arm name, not on gate use: only `hcu+shell` is
  accepted on a done claim alone, and every other arm needs a gate `verified`. A gate-less
  capability row such as `C1+I` would therefore read as not accepted under today's code, so the
  schema change in §3 item 4 must also extend `expectedAccepted` so that gate-less capability
  arms are accepted on a done claim alone. The two cases it must then implement:
  - **Gate-less rows** (the §1.3 default, as in `hcu+shell`): accepted means the agent claimed
    done, so a verified task is a done claim that the grader graded `pass`.
  - **Gated rows** (both arms of K, M's learn phase, and any gate-present variant): accepted
    means the agent claimed done **and** the gate's verdict was `verified`, so a verified task
    is a done claim the gate verified and the grader graded `pass`. A grader `pass` that the
    gate refuted or left uncertain is not verified; it is reported as "correct, not accepted".
    The gate can only withhold a verified task, never grant one the grader did not pass.

  A `pass` without a done claim is "correct, not claimed" and is not verified. `ungradable` is
  never verified.
- **Per-trial persisted-bytes capture** is the harness's, after the agent stops, exactly as
  for the existing arms (grading protocol §2). No capability tool runs or sees the capture.

### 1.2 Capability tools stay separate from the gate

Every capability ships its agent-facing tools in a server that is not `myco-gate` (proposed
name: `myco-cap`, served to Claude Code as `mcp__myco-cap__<tool>`). These rules hold for every
tool in this spec, and each track's tests must pin them:

1. **The gate request is unchanged.** `myco.gate/v1` still takes only `taskId`, `runId` and
   `claim`. No capability adds a request field. Any future gate input needs its own explicitly
   scoped, reviewed change, as #514's corrections did. A track test asserts that
   `ORACLE_INPUT_FIELDS` and the request schema in `src/gate/api.ts` are byte-unchanged by the
   track.
2. **No oracle internals reach the agent.** A capability tool never returns expected values,
   the pristine fixture (its bytes, values or digest), the sealed digest, oracle source or
   spec beyond the instruction's fields, the task metadata fields the task-set card marks "not
   shown", host paths, or secrets. It reads only what the agent could already reach in the
   guest: the live app and the files under the session's guest read root.
3. **The gate's verdict cannot be influenced by a capability tool.** No capability tool writes
   to the evidence root, the sealed vault, the registry or the audit log. Each tool is
   classified in `src/integrity/surface.ts` (reach `guest` or `agent-local`, never a host-write
   reach), and the TIF-266 isolation test (R4) must still pass with the tool added. A track
   test runs the gate over the same captured bytes with and without the capability server
   attached and asserts identical results.
4. **Import boundary.** Capability modules import nothing from `src/gate/` oracle, registry,
   sealed or corrections code, `src/benchmark/grade/`, `src/tasks/intent.ts` (`groundTruth`),
   the fixture generator, or any manifest; a test enforces it the way
   `test/baseline/hcu-shell/import-boundary.test.ts` does.
5. **Agent-facing errors carry codes only**, as the gate's do.

### 1.3 Arms, parity and assignment

- **The comparison arms are the existing baseline tool surfaces:**
  - **`C1` (screenshot-only):** the C1 vocabulary (`click`, `type_text`, `press_key`, plus the
    screenshot each turn), defined in `src/baseline/c1.ts`; its step budget is
    `STEP_BUDGET` in `src/baseline/c1-trial.ts`.
  - **`hcu+shell`:** C1's GUI channel plus the read-only structured shell
    (`docs/research/m2-hcu-shell-arm.md`).
- **Same harness for both arms of a comparison.** All runs are on Claude Ultra (§4), so both
  arms of a comparison run in the same harness and model, and the capability arm's tool list
  is exactly the baseline arm's plus the named capability tools. A tool-surface parity test
  pins this. Historic C1 rows (r6, a Messages-API loop) are context only: they are never
  paired with a capability row, because the harness differs.
- **Prerequisite: an Ultra harness for the baseline arms.** On `main` today, C1 and
  `hcu+shell` are raw Messages-API loops (`docs/research/m2-hcu-shell-arm.md`). Neither runs
  on Ultra yet. No capability comparison can run until its baseline arm is ported to the Ultra
  (Claude Code) harness (§5, dependencies).
- **Same tasks, fixtures, instruction text, model id, step budget, output ceiling, pacing and
  retry budget** in both arms, recorded per row (`instructionSha256`, `fixtureSha256`,
  `plannerModelId`, step budget, output ceiling). The check already refuses mixed planners
  within an arm. Unless a track says otherwise: step budget 30 (C1's), no wall-clock budget,
  retry budget 0, one scored attempt per trial.
- **A step** is one agent tool call of any kind (GUI action, shell call, capability read or
  write). Capability tools spend the same budget, so they buy no extra turns.
- **Gate presence is the same in both arms.** Unless a track says otherwise, neither arm calls
  the gate, and a done claim counts as the arm's claim, as in `hcu+shell`.
- **Seeded, interleaved assignment.** The order of (task, arm) trials comes from a
  pre-registered seed. Arms alternate in ABBA blocks per task so drift over a session (host
  load, rate limits) falls on both arms.
- **No exclusions.** A harness fault stays in the denominator and is reported by cause
  (M2 plan §2). A topped-up re-run keeps the faulted attempt linked (#511), and every attempt
  stays in #518's append-only attempt ledger once it lands.

### 1.4 Metrics

| Metric | Definition | Role |
|---|---|---|
| Verified rate | verified tasks / trials (§1.1) | Primary for I, K, M; guardrail for J, L |
| Steps per verified task | total steps over ALL trials / verified tasks | Secondary (I); co-primary (J) |
| Wall time per verified task | total wall-clock over ALL trials / verified tasks | Co-primary (J); secondary elsewhere |
| Retries | harness retries and agent rollbacks per trial | Secondary |
| Cost per verified task | token-derived cost ESTIMATE over ALL trials (failed, refuted and superseded attempts included) / verified tasks | Secondary, R7's rule |
| False done | done claim, grade `fail` or `ungradable` | Guardrail for every track |

Cost is always a token-derived estimate at the repo's frozen rates, never billed USD (Ultra
bills $0). A null cost on any trial makes that arm's cost unmeasured: it is reported as null,
never 0. Every count states its denominator and a Wilson 95% interval.

### 1.5 Statistics

- **Unit:** the task, paired across arms.
- **Alpha is 0.05, one-sided, for every bar component in this spec.** The direction is
  pre-registered: the capability arm better than its baseline.
- **Binary outcomes:** exact one-sided McNemar test (a sign test on the discordant tasks),
  alpha 0.05. Only discordant tasks carry information. Critical values:

  | Discordant tasks d | Smallest count favouring the capability for p ≤ 0.05 | p |
  |---|---|---|
  | 4 | none | - |
  | 5 | 5 | 0.0313 |
  | 6 | 6 | 0.0156 |
  | 8 | 7 | 0.0352 |
  | 10 | 9 | 0.0107 |
  | 12 | 10 | 0.0193 |
  | 15 | 12 | 0.0176 |
  | 20 | 15 | 0.0207 |

- **Ratio metrics** (steps, time, cost per verified task): paired bootstrap over tasks, 10,000
  resamples, pre-registered seed; the bar compares the one-sided 95% upper bound of
  capability/baseline with 1.0.
- **"No drop" (non-inferiority) on a rate:** the one-sided 95% upper bound of
  (baseline rate − capability rate), Newcombe's paired score interval, is below 5 percentage
  points.
- **Several bar components are tested in a fixed sequence** at alpha 0.05 each: a later
  component is tested only if every earlier one is shown. This keeps the family-wise error at
  0.05 per track. Tracks are not pooled.
- **"Not shown"** means any of: p > 0.05; fewer than 5 discordant tasks ("underpowered at n",
  in those words, with the discordant count); a guardrail breached; a parity check failed; or
  the pack's pre-registration hash does not match (§3). "Not shown" is reported as such, with
  the numbers; it is never rounded to a win, and a rate difference is never reported without
  its test.
- **Why 5 here and 6 in R2.** R2 (`docs/m2-scorecard.md`) calls its head-to-head
  "underpowered below 6 discordant pairs" because its sign test is two-sided: at d = 5 the
  best two-sided p is 0.0625. This spec's tests are one-sided, where d = 5 can reach
  p = 0.0313. The two thresholds are consistent, not in conflict.
- **Power (computed, exact one-sided McNemar, alpha 0.05, at least 5 discordant).** "p10" is
  the share of tasks only the capability arm verifies, "p01" the share only the baseline
  verifies.

  | n | p10 / p01 | Power |
  |---|---|---|
  | 40 | 0.10 / 0.00 | 0.37 |
  | 40 | 0.15 / 0.05 | 0.26 |
  | 40 | 0.20 / 0.05 | 0.49 |
  | 40 | 0.25 / 0.05 | 0.69 |
  | 90 | 0.10 / 0.00 | 0.95 |
  | 90 | 0.15 / 0.05 | 0.63 |
  | 90 | 0.20 / 0.05 | 0.88 |

  At n = 40 (K, M) the bar is underpowered for net gains of about 10-15 points: a "not shown"
  there is not evidence of no effect, and is reported with this table. Raising n is an open
  question (§6).

---

## 2. The capabilities

### I. Structured state access

**What it is.** The agent reads real app state as typed data through MCP tools, instead of
guessing from pixels: cell values and types, form field values, document text, and the UI tree
with stable element refs. Sources are the app's object model or accessibility framework (UNO,
AT-SPI on Linux; UNO, UIA on Windows), through the existing guest agents (`uno_eval` is
already read-only; `observe` already returns an accessibility tree).

**What it is not.** Not a verifier: it reports what the live app holds now and never says
whether that is right. Not a write path (that is J). Not a read of the persisted file on the
host, the pristine fixture, or any diff against it.

**Agent-facing surface (proposed).**

| Tool | Returns |
|---|---|
| `state_cells({sheet?, range})` | Typed values of the open document's cells (value, kind, formula flag); capped size |
| `state_fields({window?})` | Labelled form fields and their current values |
| `state_text({range?})` | Text of the open document (Writer later) |
| `state_tree({depth?, filter?})` | UI tree with element refs; a stale ref is an explicit error code |

All are reads of the live guest app. They are subject to §1.2 in full.

**Arms.** Primary: `C1+I` vs `C1` (screenshot-only plus the four tools, against screenshot-only).
Secondary, reported, not part of the bar: `hcu+shell+I` vs `hcu+shell`.

**Task set.** fc-v1 (frozen, `benchmark/false-completion/fc-v1/`), all 100 tasks, k = 1 run
per task per arm. The bar is computed on the 90 satisfiable tasks; the 10 invalid-target
tasks are a guardrail.

**Primary metric.** Verified rate on the 90 satisfiable tasks, by the grader.

**Secondary.** Steps, wall time and cost per verified task; false done; per-fault-class
verified rate.

**Pre-registered bar (fixed sequence).**
1. Exact one-sided McNemar, `C1+I` better than `C1` on verified, p ≤ 0.05 with at least 5
   discordant tasks.
2. Only if 1 is shown: steps per verified task, bootstrap one-sided 95% upper bound of
   `C1+I`/`C1` below 1.0.

**Guardrails.** False DONEs on the 10 invalid-target tasks are no higher in `C1+I` than in
`C1`. No tool response contains a fixture value the task did not name, a host path, or a
digest (a per-row scan of recorded tool outputs; any hit is a breach and the run is void).

### J. Fastest reliable action path

**What it is.** The agent changes app state by the fastest route that works: the app's API
(for example UNO for Calc), a script, or a guest shell, with the GUI as the fallback. Every
action records which route it took and, on fallback, why.

**What it is not.** Not a way around the gate or the capture: every route runs in the guest
and is confined to the task's document directory and an arm-owned scratch directory. No
route reaches the host, the evidence root or the network. The read-only rule of the
`hcu+shell` arm (a shell write to the store counts as refuted, `mvd-preregistration.md` §4.1)
belongs to that arm and does not apply to J; J is a different arm, graded the same way.

**Agent-facing surface (proposed).** `act_api({op, args})` for a typed set of app operations
(set cell, save, save as), `act_script({lang, source})` run in the guest under the shell
boundary of `hcu+shell` widened to writes inside the document directory, and the existing GUI
actions. `route_log` is written by the harness, not the agent: per action
`{route: "api" | "script" | "shell" | "gui", fallbackFrom?, code}`.

**Arms.** Primary: `hcu+shell+J` vs `hcu+shell`. Secondary: vs `C1`.

**Task set.** fc-v1 satisfiable tasks (90), k = 1.

**Primary metric (co-primary).** Wall time per verified task and steps per verified task.

**Pre-registered bar (fixed sequence).**
1. Verified rate non-inferior: the upper bound of (`hcu+shell` − `hcu+shell+J`) is below 5
   points (§1.5).
2. Wall time per verified task: bootstrap upper bound of J/baseline below 1.0.
3. Steps per verified task: bootstrap upper bound of J/baseline below 1.0.

**Margin caveat.** At n = 90, true equality with 10% discordant tasks gives an expected
one-sided 95% upper bound of about 1.645 × √(0.10 / 90) ≈ 5.5 points, above the 5-point
margin. Step 1 may therefore fail with no real drop, and under the fixed sequence that blocks
steps 2 and 3. The margin is an open question (§6).

**Guardrails.** Every action has a route record; a trial with an unrecorded action is a
harness fault, counted. The TIF-266 isolation test passes with J's tools. Any route access
outside the boundary voids the trial as `uncertain`, as in `hcu+shell`.

### K. Recovery

**What it is.** The agent can recover inside a long task: take a checkpoint of its own
document state, roll back to a clean snapshot, and act on targeted corrections. It builds on
#514's agent-safe corrections and retry loop (`src/gate/multistep.ts`) and on the trial base
(#494).

**What it is not.** Not a second chance that hides the first. A rolled-back or failed attempt
stays in #518's attempt ledger, is counted in steps, time and cost, and is never deleted or
overwritten. Rollback never restores a state the agent did not produce or was not given: an
agent-invoked rollback restores either the document it was handed or a checkpoint it took
itself. Restoring to the gate's last verified checkpoint stays harness-driven, as in #514.

**Agent-facing surface (proposed).** `checkpoint_take()` returns an opaque id;
`checkpoint_restore({id})`; `snapshot_restore_start()` restores the document the agent was
handed. Corrections arrive through the existing #514 channel and nowhere else.

**Arms.** `K` (recovery tools, gate corrections on, `retryBudget` 1) vs no-recovery (the same
base surface, corrections off, `retryBudget` 0). The base surface is `C1+I` if I's bar is
shown, otherwise `C1`. Both arms get the same total step budget (proposed 80 for long tasks),
shared across attempts, so the retry buys no extra turns. Both arms call the gate at the end
of each attempt, so gate presence is equal, and both arms' rows are gated rows (§1.1).

**Relation to the ruled corrections A/B.** The corrections A/B on Ultra is already ruled
(Stage 0: 30 paired trials, plumbing only; Stage 1: fc-v1, 100 paired trials per arm, exact
sign test) and is on the critical path (§4). K does not replace it, does not re-measure the
corrections effect, and adopts its safeguards:
- **Any gate miss halts the K run.** A gate miss is a `verified` verdict on an attempt the
  grader grades `fail` or `ungradable`. On the first one, the harness stops the batch, the
  pack is reported as halted with that trial, and the track goes back to the lead.
- **K's contrast bundles recovery tools, corrections and `retryBudget` 1** against none of
  them. It answers "K vs nothing" only. A K result is never reported as a corrections result,
  and a corrections result is never reported as a K result.

**Task set (new).** `ms-long-v1`: 40 long multi-step Calc tasks from the `calc-multi-step`
family (TIF-270), 8 edits each, across fixtures, with a seeded mid-task fault (`kill-app`,
`delayed-save`, `focus-change`) on half of them. Built deterministically by a build script
with a SHA-256 manifest and a byte-identical test, like fc-v1, and frozen before measurement.
Prerequisites: a multi-step instruction renderer (`docs/gate/api.md`, corrections section) and
a multi-step grader entry in `src/benchmark/grade/` under the same independence rule.

**Primary metric.** Verified rate (completion) on the 40 tasks, by the grader on the final
captured document.

**Pre-registered bar.** Exact one-sided McNemar, K better than no-recovery, p ≤ 0.05 with at
least 5 discordant tasks. Secondary, reported: the same split by faulted and unfaulted tasks;
steps and cost per verified task.

**Guardrails.** Every attempt is in the attempt ledger with its outcome; the check refuses a
pack whose attempt count does not match the harness's. K rows record `gate.corrections: "on"`,
so even a row relabelled `myco-gate` is refused as R1 evidence by the existing check
(`correctionsOnError`, `src/benchmark/check.ts`).

### L. Safe parallelism

**What it is.** Run N isolated, disposable desktops at once, each bound to one trial, with
verified results. Linux path first (`docs/product/linux-path.md`), on the disposable-desktop
base the "Lightweight agent desktops" roadmap track evaluates.

**What it is not.** Not shared state between trials. Not live desktop forking (a later
capability). Not Windows: the Windows VM is single-owner under the VM lock (§4).

**Agent-facing surface.** None new. Parallelism is the harness's: each trial gets its own
desktop, its own gate bound to its `taskId`/`runId`, its own evidence root and its own
capture.

**Arms.** The same agent and surface (the best shown of I and J, else `C1`) at N = 1, the
baseline (sequential, as every existing arm runs), against N = 4. Same tasks, model, step
budget and retry budget; only concurrency differs.

**Task set.** fc-v1's 90 satisfiable tasks, run on the Linux path.

**Measurement, in two stages.**
1. **L-infra (no model, not agent evidence).** The Linux path's deterministic scripted agent
   runs fc-v1's satisfiable tasks at N = 1, 2, 4 and 8, with a unique canary value seeded into
   each desktop. Must show 0 contamination events over at least 200 trials before any model
   run. These rows are simulated and never count as evidence of agent capability.
2. **L-agent.** The arms above, k = 1 per task per N, paired by task.

**Primary metric.** Throughput: verified tasks per wall-clock hour over the whole batch,
including desktop start, reset and teardown.

**Pre-registered bar (fixed sequence).**
1. Zero contamination events across all L-agent trials (a single event fails the bar and
   voids the batch).
2. Verified rate at N = 4 non-inferior to N = 1 (margin 5 points, §1.5).
3. Throughput scaling: the one-sided 95% lower bound of throughput(N = 4) / throughput(N = 1)
   is at least 2.8 (scaling efficiency 0.7). The bound is a paired bootstrap over tasks,
   10,000 resamples, with a pre-registered seed (§1.5); the point estimate alone never meets
   the bar. **Per-trial time attribution:** each trial is attributed its desktop-occupancy
   time (start, reset, run, capture and teardown) divided by N, and batch wall-clock that no
   trial occupies (stragglers at a batch's end) is spread over that batch's trials in
   proportion to their attributed time, so the attributed times sum to the batch wall-clock. A
   resample's throughput is its verified tasks divided by the sum of its attributed times.

**Guardrails.** Contamination checks: each captured document is scanned for every other trial's canary;
every row's `fixtureSha256` is its task's; `runId`s and evidence roots are disjoint; each gate
answers only its own trial (`ASSIGNMENT_MISMATCH` for any other); no desktop's file system
or process list shows another trial's. If Ultra rate limits stop N = 4 from running, L is
reported "not measurable", not "failed", and the rate-limit events are recorded.

### M. Learning from verified outcomes

**What it is.** When a run is verified, Myco stores the procedure that produced it as a
reusable skill (parameterized actions with their pre- and postconditions, in the spirit of
`docs/research/findings/m2-04-procedure-learning.md`). Later runs retrieve skills by task
description.

**What it is not.** Not storage of any refuted, uncertain or unclaimed run. Not a cache of
answers: a skill holds actions and parameters taken from the instruction, never fixture
values, gate digests, oracle internals, host paths or secrets.

**Agent-facing surface (proposed).** `skill_search({query})` returns up to 3 skills (steps,
parameters, the app and version they were learned on). The agent cannot write the store;
only the harness writes it.

**Store rule.** The harness stores a skill only when the trial's gate verdict was `verified`
and accepted, after the capture. `refuted` and `uncertain` runs are never stored. The store is
append-only, and each skill keeps its source `trialKey` and gate verdict host-side, never
shown to the agent.

**Arms.** Skills-on (the store frozen after the learn phase, read-only during test) vs cold
(the same surface with an empty store), same test tasks, paired. Base surface: the best shown
of I, J, else `C1`.

**Task set (new).** `rep-v1`, frozen before measurement like fc-v1:
- learn split: 20 tasks (calc-record-edit and calc-multi-step);
- test split: 20 **repeat** tasks (same spec as a learn task, new run) and 20 **similar** tasks
  (same family, new fixture seed, record and column, never in the learn split).

The learn phase runs before the test phase, and its store is hashed and recorded in every
test pack. Test-phase runs never write the store.

**Gate use.** The learn phase calls the gate at the end of each trial, because the store rule
needs its verdict; learn rows are gated rows (§1.1) and are never part of the bar. In the test
phase neither arm calls the gate (the §1.3 default), so gate presence is equal and test rows
are gate-less.

**Primary metric.** Verified rate on the 40 test tasks, by the grader.

**Pre-registered bar.** Exact one-sided McNemar, skills-on better than cold, p ≤ 0.05 with at
least 5 discordant tasks. Repeat and similar are reported separately as secondary and are not
part of the bar.

**Guardrails.** Zero stored skills from a non-`verified` gate verdict (checked against the
gate audit log). Every stored skill's source trial is graded `pass` by the grader; a stored
skill whose source is `fail` or `ungradable` is a breach and the bar is not shown. A per-skill
scan finds no fixture value outside the instruction, no host path and no digest.

---

## 3. Pre-registration rule

1. **Frozen before measurement.** Before a track's first measurement run, one commit on
   `main` holds its pre-registration: the bar (the track's section here, as ratified), the
   task set version and its manifest SHA-256, the seeds (assignment, bootstrap, task build),
   the step budget, the model id, and the analysis script with its SHA-256. The proposed
   location is `docs/product/capability-prereg/<track>-v<k>/prereg.json`; its SHA-256 over
   canonical JSON is the **pre-registration hash**.
2. **Packs record the hash.** Every capability pack records the pre-registration hash and the
   commit it was frozen in. The analysis refuses a pack whose hash does not match a committed
   pre-registration.
3. **Changes after the first run** make a new version (`v<k+1>`). Runs under the old version
   stay committed and are reported under it; they are never re-analysed under the new bar.
4. **Experiment rows, not R1 evidence.** Capability-arm packs are experiment rows. They never
   count as R1 evidence unless the lead rules otherwise. Their `arm` values are not
   `myco-gate`, so the existing R1 path does not read them, and the R1 evidence rules
   (`src/benchmark/taskset-binding.ts`, `src/m2/evidence.ts`) are unchanged by this spec.
   `myco.benchmark.arm-row/1` allows only `myco-gate` and `hcu+shell` today, so each track
   adds its arm values (and the same-harness baseline arm it pairs with) as a reviewed schema
   change, and the check refuses those values under `--require-r1` and `--evidence`.
5. **Simulated rows never count.** A row whose planner is not a model id (scripted agents, dry
   runs, L-infra) is never evidence for a capability bar.

## 4. Measurement constraints

- **The critical path comes first (Tiffany, 2026-11-26 10:46 ET).** The order is: integrity
  fixes, then the trial run (R1, the `hcu+shell` head-to-head, the corrections A/B on Ultra),
  then the 90 s demo. Capability work never delays those steps and never takes VM time from
  them.
- **Claude Ultra only.** Every measured run uses the Claude Ultra plan: $0 Anthropic API, no
  Messages-API calls. Costs are token-derived estimates (§1.4).
- **No runs until GO.** No measurement run starts until the integrity fixes land (#518's
  attempt ledger, the xlsx replacement for #503, the #494 tests-only follow-up) and the lead
  gives GO for that track.
- **Codex is gated.** No Codex arm or Codex-run measurement without the lead's approval.
- **VM work is local and single-owner,** under the VM lock (`scripts/vm-session.sh`). Linux
  path first wherever the capability allows (L is Linux-only at first).
- **Gate guarantees are not weakened:** the gate stays bound to one trial, fails closed, keeps
  codes-only agent-facing reasons, and stays CSV-only for Calc until the xlsx replacement
  lands. Capability arms graded on fc-v1's `xlsx` documents use the grader, not the gate.
- **No public leaderboard.** Results stay in the repo's evidence packs.

## 5. Sequencing

1. **Build I-M now, in parallel.** Every capability (I-V; N-V and data capture are in the
   part-2 spec) is M2 scope (ruling of 2026-11-26 10:41 ET). Each track builds its tools and
   their separation tests and freezes its pre-registration now, alongside the other M2 tracks,
   without touching their files.
2. **Measure only after GO,** and never ahead of the critical path or with VM time it needs
   (§4).
3. **Each capability is its own Tier 2 track** with its own PR, a 3-round review cap, and its
   own pre-registration. A track that hits the cap stops and goes back to the lead.
4. **Dependencies:** every track's measurement needs its baseline arm (C1 or `hcu+shell`)
   ported to the Ultra (Claude Code) harness (§1.3). The capability tracks reuse the Ultra
   `hcu+shell` harness the trial run's head-to-head needs, and do not build a second one. C1
   has no Ultra harness, so I's primary arm (`C1+I` vs `C1`) cannot be measured until C1 is
   ported onto that same harness; the port never takes VM time from the trial run. K needs the
   multi-step instruction renderer and grader entry; L needs the disposable Linux desktop and
   L-infra's zero-contamination result; M's measurement uses the best shown base surface, so
   it is measured after I's (and J's, if shown). These order measurement, not building.

## 6. Open questions for the lead

- Whether the capability arms should also run a gate-present variant (the gate as part of the
  surface), as a separate experiment.
- The K step budget (80 proposed) and the `ms-long-v1` size (40 proposed).
- Whether the 5-point non-inferiority margin (J, L) is right for n = 90: with 10% discordant
  tasks and true equality, the expected upper bound is about 5.5 points (J, margin caveat).
- Whether to raise n for K and M: at n = 40 the power for a 10-15 point net gain is 0.26-0.49
  (§1.5, power table).
