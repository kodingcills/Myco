# Measuring structured state access (capability track I)

This page covers how the structured-state arm will be measured against the baselines. It
covers what is wired now, and what is assumed until the capability spec lands. No trial
has been run. This PR builds the wiring only.

## Source of truth: the capability spec

The pre-registered bars live in `docs/product/capability-spec.md` (the parallel docs PR,
branch `claude/myco-capability-spec-f7ce2g`, not merged when this page was written). When
it lands, its §2 "I. Structured state access" and §1 shared rules replace the assumed bar
below. This page records only how the wiring maps onto that spec.

### Assumed bar, for the spec to adopt or replace

This follows the spec draft's track I section. It is restated here so the bar is fixed
before any trial runs.

- **Arms.** Primary: `structured-state` (C1's screenshot-only surface plus the four
  `myco-state` tools, the spec's `C1+I`) against `screenshot-only` (C1). Reported, but not
  part of the bar: `hcu+shell` (and, later, `hcu+shell+I`).
- **Task set.** fc-v1, all 100 tasks, k = 1 run per task per arm. The bar is computed on the
  90 satisfiable tasks. The 10 invalid-target tasks are a guardrail.
- **Primary metric.** Verified rate. A task counts as verified when the agent claimed done
  AND the independent grader (`src/benchmark/grade/`) graded the captured document `pass`.
  The gate's verdict is never the measurement, and neither is anything a state tool
  reported.
- **Bar, tested in a fixed sequence at alpha 0.05:**
  1. Exact one-sided McNemar on verified, `structured-state` better than `screenshot-only`,
     p <= 0.05 with at least 5 discordant tasks.
  2. Only if 1 is shown: steps per verified task (total steps over ALL trials / verified
     tasks). The one-sided 95% upper bound of the paired-bootstrap ratio
     `structured-state` / `screenshot-only` must be below 1.0 (10,000 resamples,
     pre-registered seed).
- **Guardrails.** False DONEs on the invalid-target tasks are no higher than the baseline's.
  No recorded state-tool output contains a host path, a digest, or any withheld string; any
  hit voids the run.
- **"Not shown"** is reported as such, with the numbers. It is never rounded to a win.

## Parity the wiring enforces now

| Requirement | Where |
|---|---|
| Each arm's tool list is exactly the baseline's plus its named channel | `CAPABILITY_ARM_TOOLS`, `auditCapabilityArmLaunch` (exact allowlist), `test/state/state-arms.test.ts` |
| Strict MCP config, one pinned `--mcp-config`, `--tools ""`, `dontAsk`, every tool classified | the TIF-274 launch audit (`src/integrity/launch.ts`), run by `auditCapabilityArmLaunch` |
| `myco-state` bound to the trial (run id, issued pipe, no other env keys) | `stateBindingViolations` in `src/integrity/launch.ts` |
| A state read spends the same step budget (one tool call is one step) | `CapabilityArmRow.steps`, with `stateToolCalls` recorded beside it |
| Same task, instruction, model, budget and gate in every arm | the plan takes one `instruction`; the rows carry `taskId` and `plannerModelId` |

## Rows: never R1 evidence

Each trial of these arms writes a `myco.capability.arm-row/1` row
(`capabilityArmRow`, `src/state/arms.ts`):

- `evidenceClass: "capability-measurement"` and `r1Evidence: false`;
- `simulated: true` for any scripted or mock agent; a simulated row is never evidence;
- `grade` is filled in by the independent grader, never by the gate or a state tool;
- `cost.estimatedModelUsd` is a token-derived ESTIMATE at frozen rates, never billed USD.
  It is `null` when unmeasured, never 0, and `cost.basis` says so in the row itself.

The benchmark check (`checkBenchmark`, `src/benchmark/check.ts`) refuses these rows. The R1
gated harness (`runGatedTrial`) refuses a plan that starts `myco-state`. R1's evidence
rules (`src/benchmark/taskset-binding.ts`) are unchanged.

## What the $0 end-to-end test shows, and what it does not

`test/linux/state-e2e.test.ts` drives a scripted client (no model) through the real
`myco-state` server against a real live headless Calc. The client finds the target from the
app's own state (the header row and the key column), reads the cell, edits it, reads it
back, and saves. The gate then verifies from the captured file. A second case edits without
saving: the live state shows the edit, and the gate refutes.

It shows that the wiring works end to end and that live state is not proof. It is not a
measurement: there is one scripted policy, no model and no baseline arm. It produces no
capability row.

## Not done yet

- A live harness that runs a model in each arm and writes the rows. It needs a transport
  that starts Claude Code with the audited plan, as `GatedTrialTransport` does for the gate.
- A Windows `windows-uia` backend. The VM work is local, single-owner and under the lock.
- The spec's `state_fields`, `state_text` and element refs in `state_tree`. The Calc path
  needs only cells, sheets, save state and a tree summary.
