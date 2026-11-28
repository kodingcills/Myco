# K. Recovery (capability track K)

Spec: `docs/product/capability-spec.md`, "K. Recovery". Code: `src/recovery/`. Tests:
`test/recovery/`. Built and tested without a VM. Nothing here runs a trial or measures anything.

## What it is

The agent can recover inside a long task: take a checkpoint of its own document, roll back to
it or to the document it was handed, and act on the gate's corrections (#514's channel, and no
other). It extends #514's harness loop (`src/gate/multistep.ts`) and reuses its
`retryCheckpoint`: the retry still restores the gate's last verified checkpoint, harness-driven.

## The agent-facing surface

Served as `mcp__myco-recovery__<tool>` (`RECOVERY_SERVER_CLASS`, reach `guest`). Only the K arm's
surface audit classifies it; the default R1 audit refuses it as unclassified.

| Tool | Arguments | Reply |
|---|---|---|
| `checkpoint_take` | none | `{ ok: true, id }`, an opaque random id (`ckpt_` + 32 hex) |
| `checkpoint_restore` | `{ id }` | `{ ok: true }` |
| `snapshot_restore_start` | none | `{ ok: true }` |

Any refusal is `{ ok: false, code }`, with a code from `RECOVERY_CODES`. No message, path or
hash ever reaches the agent.

## Rules, and where each is enforced

- **Rollback restores only a state the agent produced or was handed.** The tools can write only
  two kinds of bytes: the handed document (copied when the tools are built) and bytes that
  `checkpoint_take` read from the agent's own guest document. Checkpoints live in the harness's
  memory, never in the guest. An id is looked up in one `RecoveryTools` instance, and each
  attempt of each trial gets a fresh instance, so an id from another trial, from another
  attempt, or a guessed id is `CHECKPOINT_UNKNOWN`.
- **The agent cannot change its own verdict.** The tools write the guest document and nothing
  else. When the agent stops, the harness closes the tools (any later call is `TOOLS_CLOSED`).
  It then captures the document on the host and asks the gate, which is bound to the trial
  (`myco.gate/v1`, `taskId`/`runId`/`claim` only, unchanged). The verdict is the gate's result
  for the last attempt. The only thing the agent contributes to it is its claim string.
- **The harness checks the gate's answer before believing it, and fails closed.** The attempt
  becomes `uncertain`, with a code and no retry, when:
  - the result names another task or run (`GATE_BINDING_MISMATCH`);
  - `accepted` and `verdict` disagree (`GATE_RESULT_INCONSISTENT`);
  - the document the gate read is not this attempt's fresh host capture, or an accepted result
    rests on no document (`EVIDENCE_NOT_FRESH`). This is the check that stops another trial's
    evidence from being re-used;
  - the no-recovery arm received corrections (`ARM_CORRECTIONS_MISMATCH`);
  - a harness step threw (`RESTORE_FAILED`, `AGENT_RUN_FAILED`, `CAPTURE_FAILED`,
    `GATE_CALL_FAILED`). These are logged as harness faults.
- **No second chance that hides the first.** Every attempt is kept, in order, with its outcome,
  steps, time, cost and recovery-tool log, and is appended to the attempt log as it runs. That
  includes failed attempts, rolled-back ones and harness-faulted ones.
- **The retry buys no extra turns.** There is one `StepMeter` per trial, shared by both
  attempts. Each agent action takes a step, and so does each tool call, refused or not. The
  retry runs only if steps are left, and gets only those. The proposed budget is 80, the same
  for both arms.

## Arms

| Arm | Recovery tools | Gate corrections | `retryBudget` |
|---|---|---|---|
| `K` | on | on | 1 |
| `no-recovery` | off | off | 0 |

Both arms call the gate at the end of every attempt. `ARM_CONFIG` is frozen. A run cannot pick
another combination.

## Batch, rows, pack check, bar

- **Any gate miss halts the K run.** A gate miss is an attempt that the gate verified (after
  the harness's checks) and that the injected grader grades `fail` or `ungradable`. A grader
  that throws, or that returns anything else, counts as `ungradable`. `runRecoveryBatch` stops
  at the first miss and reports that trial and attempt. Nothing after it runs. A halted batch is
  never summarized (`recoveryBar` refuses it).
- **Rows** are `myco.recovery.arm-row/1`, with `evidence: "never-r1"` and
  `contrast: "K-vs-nothing"`. K rows record `gate.corrections: "on"`, so a K row relabelled
  `myco-gate` is still refused as R1 evidence by `correctionsOnError`
  (`src/benchmark/check.ts`). Each row also records the final attempt's `claim` (`done`,
  `not-done` or `no-claim`), `accepted`, `harnessCodes`, and the trial's `instructionSha256`
  and `fixtureSha256`. `grade` is the grader's verdict on the final captured document.
- **A verified task (the primary metric).** Both arms' rows are gated rows (spec §1.1). A row
  is a verified task only when the claim is `done`, the row is accepted (the gate said
  `verified` and the harness's checks passed), it has no harness code, and the grader said
  `pass` (`isVerifiedRow`). Any other grader `pass` is reported as "correct, not verified"
  (`kCorrectNotVerified`, `noneCorrectNotVerified`) and never counted. That covers an
  uncertain, refuted, refused, fail-closed or harness-faulted attempt, and one with no done
  claim.
- **`checkRecoveryPack`** refuses a pack when:
  - its attempt count does not match the harness's;
  - a row's arm config, contrast or attempt budget does not fit its arm;
  - a trial appears twice;
  - a row disagrees with itself: accepted without a clean `verified`, harness codes without
    `uncertain`, an unknown claim or harness code, a `grade` other than `pass`, `fail` or
    `ungradable` (#601 N5), a `faultKind` that does not match `faulted` (null exactly when
    unfaulted, otherwise one of `kill-app`, `delayed-save`, `focus-change`; #601 F6), or a
    hash that is not sha256 hex;
  - the arm mixes planners, step budgets or task sets;
  - (evidence) any row is simulated, or its planner is not one of
    `RECOVERY_EVIDENCE_PLANNERS`. That set mirrors R1's `EVIDENCE_PLANNERS`, and a test pins
    the two equal. The module cannot import it, because `check.ts` reaches the task manifests.
    Evidence mode is the default (#601 N6): only an explicit `evidence: false` accepts
    simulated rows.
- **`recoveryBar`** is the pre-registered bar: exact one-sided McNemar, K better than
  no-recovery, p ≤ 0.05, with at least 5 discordant verified tasks. It runs on two complete,
  checked batches over the same tasks. It refuses arms that differ in planner, step budget or
  task set, or a task whose fault flag, fault kind, instruction hash or fixture hash differs
  (§1.3 parity). It also reports the faulted and unfaulted split, and steps and cost per
  verified task. A null cost is unknown, never 0. Its `evidence` field is false for a
  `simulated: true` (plumbing) bar.
- The grader is injected. `src/recovery/` never imports `src/benchmark/grade/`. The grader a
  K run injects is the multi-step entry below.

## Instruction renderer and grader entry (spec §5: K's measurement dependencies)

- **Instruction**: `multiStepTaskText(steps)` (`src/tasks/multi-step-text.ts`,
  `multi-step-text/1`, import-free). One line per step, `Step k: set the cell at record R,
  column C, to "V".`, between "Make these n edits ... Change no other cell." and "Save the file
  after the last step." It states nothing else about the document (no fixture value, cell
  address or seed). It refuses 2-10 steps exceeded, a record or column that is not one
  printable line without `"` or `,`, a value with a Unicode line separator, and a repeated
  record and column. `docs/gate/api.md` (Corrections) requires the instruction to state every
  field a `calc-multi-step` correction reveals; `test/tasks/multi-step-text.test.ts` pins it
  against corrections the gate itself builds (`documentCorrections`), for both
  `target_value_mismatch` and `target_unchanged`.
- **Grader**: `gradeMultiStep(input)` (`src/benchmark/grade/multi-step.ts`,
  `multi-step-grader/1`). Inputs: the pristine fixture bytes (SHA-256 pinned), the final
  persisted document (CSV or xlsx), the steps and the column types. Never a claim, verdict,
  checkpoint or correction. `pass` needs every step's target to hold its new value (typed, as
  the false-completion grader compares) and every other cell pristine, with no content on other
  sheets. A step naming no editable cell fails; could-not-look and ambiguous intents (two steps
  on one cell, a duplicate key or header, a missing column type) are `ungradable`. `perStep`
  and `stepsSatisfied` report partial completion; `status` stays strict. Tests
  (`test/benchmark/multi-step-grade.test.ts`): it agrees with the false-completion grader on
  one-step tasks, and with the gate's `calc-multi-step` decision (pass iff verified) on 300
  seeded random CSV documents, while importing only `./grade.ts` and `./sheet.ts`
  (`test/benchmark/independence.test.ts` walks it with every grader module).

## Pre-registration and analysis (spec §3)

- **File**: `docs/product/capability-prereg/k-v1/prereg.json`. It holds the bar (the spec's K
  section pinned by SHA-256, plus the test, side, alpha, discordant minimum, secondaries and
  guardrails), the arms, the task set (`ms-long-v1`, its size, edits, faulted half, fault
  kinds, manifest path and SHA-256), three seeds (assignment, bootstrap, task build), the step
  budget, the model id (the trial run's pilot model), the instruction renderer and grader
  entry by SHA-256, and the analysis script and modules by SHA-256.
- **Pre-registration hash**: SHA-256 of the file's canonical JSON (keys sorted, no
  whitespace) without its own `preregistrationHash` member, which stores it
  (`preregHash`, `src/recovery/prereg.ts`).
- **Lead rulings, 06:21Z (relayed on #647).** `leadRulings` records both, each naming the
  fields it settles: the step budget is 80, the same for both arms; `ms-long-v1` is n = 90
  (45 faulted) under the J rule. `designation` is `"confirmatory"` at 90 and
  `"exploratory"` at the n = 40 fallback (`sizeRule`); no other pairing passes the check. The
  pinned spec section still says "40" and "proposed 80": `spec.amendedBy` states that the bar
  is that section as amended by `leadRulings`.
- **VM-hours estimate** (`vmHoursEstimate`, required, arithmetic checked): 90 tasks x 2 arms
  x k = 1 = 180 trials at 600 s each (cold reset 140 s + redeploy 100 s, measured on the M1
  VM, `docs/baseline/screenshot-agent.md`; plus 80 steps at 4.5 s, the planning rate of 135 s
  for a C1 trial of up to 30 steps, since no Ultra or K trial is measured) = **30 VM-hours**.
  If every trial ran to the pilot's 1800 s timeout: 102 VM-hours. At the n = 40 fallback:
  13.3 VM-hours. The pilot's 90 s spacing adds about 4.5 h of wall clock but no VM work.
- **Draft until the task set is built.** `status: "draft"`. Pending: the manifest SHA-256
  (null until `ms-long-v1` is built) and `sizeRule.applied`: before freezing, recompute the
  seconds per trial from the R1 pilot's measured `elapsedMs`, and the coordinator checks the
  estimate against the VM schedule of the R1 pilot, the `hcu+shell` head-to-head, the
  corrections A/B and the 90 s demo; if it would delay any of them, k-v1 switches to n = 40
  exploratory before freezing. `leadRulingPending` is empty. `checkKPrereg` reports `frozen`
  only with nothing pending, no lead ruling pending, `status: "frozen"` and a manifest SHA-256
  that matches the committed manifest. Any edit to the file, a pinned file or the spec's K
  section fails the check until the file is updated. The pins include the analysis's and
  the grader's transitive modules (`src/recovery/trial.ts`; `grade.ts`, `sheet.ts`, `zip.ts`).
- **Analysis**: `npx tsx scripts/k-recovery-analysis.ts --prereg <prereg.json> --k <pack>
  --none <pack> [--plumbing]` on two `myco.recovery.pack/1` files (one arm's batch, the
  pre-registration hash and the commit it was frozen in). It refuses: a pre-registration
  failing its check; a pack whose hash is not the pre-registration's, whose commit is not on
  main (an ancestor of `origin/main`), or whose commit does not hold a pre-registration with
  that hash (`git show`); a draft unless `--plumbing`; a simulated row under evidence and a
  real row under `--plumbing` (a row is real only when `simulated` is absent or exactly
  `false`, #652); a complete batch holding a gate miss; rows whose task set or step budget
  differ from it, and, for evidence, whose model, task count or faulted count differ. A halted
  batch is reported as halted (with `frozen`, `evidence: false`, `shown: false`). Otherwise it
  runs `recoveryBar` unchanged and reports `shown`: true only for evidence on a frozen,
  confirmatory pre-registration with no lead ruling pending and a passing bar. Otherwise
  `shown` and `bar.passes` are false and `notShown` names each reason (`PLUMBING`, `DRAFT`,
  `LEAD_RULING_PENDING`, `EXPLORATORY`, `UNDERPOWERED`, `P_ABOVE_ALPHA`); the statistics are
  reported unchanged. `LEAD_RULING_PENDING` exits 1 (#652).

## Separation from the gate (spec §1.2)

| Rule | Where it is pinned |
|---|---|
| 1. The gate request is unchanged | `boundary.test.ts`: `ORACLE_INPUT_FIELDS` and `GATE_REQUEST_SCHEMA` pinned by hash; a request with a recovery field is refused |
| 2. No oracle internals reach the agent | Replies are codes only (`tools.test.ts`); the tools read and write only the guest document |
| 3. The verdict cannot be influenced by a tool | Classified `guest` reach (`tools.test.ts` K8). `boundary.test.ts` runs the real gate on the same captured bytes with and without the tools having run, and gets identical results. The server-attached form, and R4 with the server added, wait for the MCP server (follow-up) |
| 4. Import boundary | `boundary.test.ts`: a transitive AST walk over every `src/recovery/` module, type-only imports included. From `src/gate/`, only `api.ts` and `multistep.ts` are allowed. Nothing under `src/benchmark/`, `src/tasks/intent.ts`, `src/tasks/fixture.ts` or any manifest is allowed. Canaries cover each forbidden kind |
| 5. Codes-only errors | `tools.test.ts`; `RECOVERY_CODES` |

The document size limit (`RECOVERY_DOCUMENT_LIMIT`) is defined in `tools.ts`, and a test pins
it equal to the gate's `STATE_FILE_LIMIT`.

## Acceptance map

| # | Spec item | Test |
|---|---|---|
| K1 | `checkpoint_take()` returns an opaque id; `checkpoint_restore({id})` | `tools.test.ts` K1 |
| K2 | `snapshot_restore_start()` restores the handed document | `tools.test.ts` K2; `trial.test.ts` K3 |
| K3 | Rollback never restores a state the agent did not produce or was not given | `tools.test.ts` K3; `trial.test.ts` K3 |
| K4 | One step budget (80) shared across attempts; the retry buys no extra turns | `tools.test.ts` K4; `trial.test.ts` K4 |
| K5 | A recovered run is re-verified by the gate on fresh host-captured evidence | `trial.test.ts` K5 |
| K6 | Recovery never changes the verdict; the verdict is the gate's alone | `trial.test.ts` K6 |
| K7 | Arms K and no-recovery; both call the gate every attempt; corrections only from the gate | `trial.test.ts` K7, K3 |
| K8 | The surface is classified for the K arm only | `tools.test.ts` K8 |
| K9 | Every attempt is in the ledger with its outcome, counted in steps, time and cost; the check refuses a mismatched attempt count | `trial.test.ts` K9, K3; `batch.test.ts` K9 |
| K10 | Fail closed: binding, consistency, freshness, arm and harness faults | `trial.test.ts` K10 |
| K11 | Any gate miss halts the K run | `batch.test.ts` K11 |
| K12 | K rows record `gate.corrections: "on"`; refused as R1 evidence even relabelled; never a corrections result | `batch.test.ts` K12, K9 |
| K13 | Exact one-sided McNemar, p ≤ 0.05, ≥ 5 discordant; secondary splits | `batch.test.ts` K13 |
| K14 | Grader independence | `batch.test.ts` K14; `boundary.test.ts` |
| K15 | Gated rows: only a done claim, gate-verified and grader `pass`, counts (§1.1) | `batch.test.ts` K15 |
| K16 | Simulated rows are never evidence (§3.5) | `batch.test.ts` K16, K9 |
| K17 | Parity within and between the arms (§1.3) | `batch.test.ts` K17 |
| §1.2 | Separation rules 1, 3 (in-process) and 4 | `boundary.test.ts` |
| K18 | Multi-step instruction states each step's number, record, column and value, and the save (api.md, Corrections) | `test/tasks/multi-step-text.test.ts` T1-T5 |
| K19 | Multi-step grader entry, independent of the gate, on the final captured document | `test/benchmark/multi-step-grade.test.ts` G1-G7; `test/benchmark/independence.test.ts` |
| K20 | §3 pre-registration: fields, hash over canonical JSON, the 06:21Z lead rulings recorded, VM-hours estimate, confirmatory/exploratory, draft until the task set is built | `prereg.test.ts` P1-P9 |
| K21 | The analysis refuses a pack whose hash or commit does not match or is off main, a draft for evidence, simulated rows for evidence and real rows for plumbing, and a gate miss; never "shown" while a lead ruling is pending, for plumbing, a draft or an exploratory pre-registration (#652) | `analysis.test.ts` A1-A9 |
| #601 | N5 grade check, N6 evidence default, F6 fault kind, S1, S2, `"DONE"` near-miss | `batch.test.ts` "#601 follow-ups", K15 |

## Not built here (follow-ups)

- **`ms-long-v1`**: 90 long multi-step Calc tasks (40 at the exploratory fallback), 8 edits each, with a seeded mid-task fault
  (`kill-app`, `delayed-save`, `focus-change`) on half of them. It needs a deterministic build
  script (seeded by the pre-registration's `seeds.taskBuild`, instructions from
  `multiStepTaskText`), a SHA-256 manifest and a byte-identical test, and must be frozen before
  measurement. Its manifest SHA-256 then goes into the pre-registration, which is frozen once
  the `sizeRule.applied` check is cleared.
- **The seeded ABBA schedule** from `seeds.assignment`, and the trial adapter that wires
  `gradeMultiStep` in as each trial's injected grader.
- **Serving the tools over MCP**: a stdio `myco-recovery` server bound to one trial, wired into
  the K arm's launch plan and surface audit. It must come with the server-attached form of
  §1.2.3 (the gate on the same bytes with and without the server attached), R4 with the server
  added, and a `close()` that drains in-flight tool calls.
- **Output ceiling and pacing parity** (§1.3): the rows do not record either yet. The bar
  checks the parity it can see (planner, step budget, task set, instruction and fixture).
- **The VM step**: a `GuestDocument` that reads and writes the trial's guest document over the
  VM transport, plus the live K and no-recovery runs. This queues for the local VM owner, under
  the VM lock.
- **Attempt-ledger adapter**: wiring `AttemptLog` to `src/m2/attempt-ledger.ts`. That needs the
  K arms added to the ledger's arm type.
