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
  (`src/benchmark/check.ts`). The primary metric, `grade`, is the grader's verdict on the final
  captured document.
- **`checkRecoveryPack`** refuses a pack when:
  - its attempt count does not match the harness's;
  - a row's arm config, contrast or attempt budget does not fit its arm;
  - a trial appears twice;
  - (evidence) any row is simulated.
- **`recoveryBar`** is the pre-registered bar: exact one-sided McNemar, K better than
  no-recovery, p ≤ 0.05, with at least 5 discordant tasks. It runs on two complete, checked
  batches over the same tasks, with the same fault labels. It also reports the faulted and
  unfaulted split, and steps and cost per verified task. A null cost is unknown, never 0.
- The grader is injected. `src/recovery/` never imports `src/benchmark/grade/`.

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
| K14 | Grader independence | `batch.test.ts` K14 |

## Not built here (follow-ups)

- **`ms-long-v1`**: 40 long multi-step Calc tasks, 8 edits each, with a seeded mid-task fault
  (`kill-app`, `delayed-save`, `focus-change`) on half of them. It needs a deterministic build
  script, a SHA-256 manifest and a byte-identical test, and must be frozen before measurement.
  It has two prerequisites, also not built: a multi-step instruction renderer, and a multi-step
  grader entry in `src/benchmark/grade/`.
- **Serving the tools over MCP**: a stdio `myco-recovery` server bound to one trial, wired into
  the K arm's launch plan and surface audit.
- **The VM step**: a `GuestDocument` that reads and writes the trial's guest document over the
  VM transport, plus the live K and no-recovery runs. This queues for the local VM owner, under
  the VM lock.
- **Attempt-ledger adapter**: wiring `AttemptLog` to `src/m2/attempt-ledger.ts`. That needs the
  K arms added to the ledger's arm type.
