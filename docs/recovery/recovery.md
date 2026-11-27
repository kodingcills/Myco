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
    `uncertain`, an unknown claim or harness code, or a hash that is not sha256 hex;
  - the arm mixes planners, step budgets or task sets;
  - (evidence) any row is simulated, or its planner is not one of
    `RECOVERY_EVIDENCE_PLANNERS`. That set mirrors R1's `EVIDENCE_PLANNERS`, and a test pins
    the two equal. The module cannot import it, because `check.ts` reaches the task manifests.
- **`recoveryBar`** is the pre-registered bar: exact one-sided McNemar, K better than
  no-recovery, p ≤ 0.05, with at least 5 discordant verified tasks. It runs on two complete,
  checked batches over the same tasks. It refuses arms that differ in planner, step budget or
  task set, or a task whose fault label, instruction hash or fixture hash differs (§1.3
  parity). It also reports the faulted and unfaulted split, and steps and cost per verified
  task. A null cost is unknown, never 0. Its `evidence` field is false for a
  `simulated: true` (plumbing) bar.
- The grader is injected. `src/recovery/` never imports `src/benchmark/grade/`.

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

## Not built here (follow-ups)

- **`ms-long-v1`**: 40 long multi-step Calc tasks, 8 edits each, with a seeded mid-task fault
  (`kill-app`, `delayed-save`, `focus-change`) on half of them. It needs a deterministic build
  script, a SHA-256 manifest and a byte-identical test, and must be frozen before measurement.
  It has two prerequisites, also not built: a multi-step instruction renderer, and a multi-step
  grader entry in `src/benchmark/grade/`.
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
