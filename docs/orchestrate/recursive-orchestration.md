# Recursive orchestration (capability track V)

Status: M2 capability track V, Tier 2. Code: `src/orchestrate/`. Tests: `test/orchestrate/`
($0: scripted planners, scripted mock desktop workers, the real vault and sealed gate).
Measurement is **not** part of this change (see "Measurement bar proposal" below).

## What it adds

A planner agent breaks a goal into sub-tasks and hands each to a desktop worker agent.
Myco runs every worker as its own gated trial and **verifies the worker's result before the
planner can use it**. The planner can also hand a sub-goal to a sub-planner, which spawns its
own workers under the same limits (recursion).

```
operator (host)                         planner (agent)
  Orchestrator ── PlannerHandle ───────▶ submit({ taskId, note? })
    │                                    submit({ kind: "planner", goal })
    │  admit (every limit, host-side, synchronous)
    │  provision isolated trial (track L interface)
    │  runGatedTrial: launch audit → seal → sealed gate bound to this run
    │                 → worker runs → stop → capture → gate.check
    │  optional independent grader
    │  ledger row (MAC-chained)
    └──▶ Report { status, verdict, gateCodes, codes } ──▶ planner
```

A worker's report has `status: "done"` only when:

1. the gate decided the trial from the sealed host capture, with `verdict: "verified"`,
   `accepted: true` and `ORACLE_PASS`; and
2. when the operator configured an independent grader, the grader said `pass`; and
3. the verdict row was written to the orchestrator ledger; and
4. the run was not halted (kill switch, wall budget, ledger failure) while it was in flight.

Every other outcome reaches the planner as what it is: `refuted`, `uncertain`, `unverified`
(no verdict: launch audit refused, worker crashed, isolation failed, ledger failed),
`refused` (a limit or a malformed submission) or `killed`. A sub-planner's report is `done`
only when it has at least one child and every child is `done`.

A planner's handle **closes when its planner returns** (or is cut off by a halt). Its
children are then final: a submission through a kept handle is refused `PLANNER_ENDED` (or
`RUN_NOT_ACTIVE` once the run is over) and starts nothing, so no trial runs outside the
recorded tree. Spawn before you return.

## Limits (mandatory, host-side, fail closed)

`OrchestratorLimits` (`src/orchestrate/limits.ts`, `myco.orchestrate.limits/v1`). Every field is
required and must be a positive integer; unknown fields are refused. There is no "unlimited".

| Limit | Meaning | Refusal code |
|---|---|---|
| `maxTotalTokens` | All tokens in the run (workers and planners) | `BUDGET_TOKENS` |
| `maxTokensPerWorker` | Reserved for each worker at spawn; a live transport must cap the worker at it (V-live, not in this change) | `BUDGET_TOKENS` |
| `maxEstimatedCostMicroUsd` | Estimated cost ceiling (micro-USD, a token-derived ESTIMATE, never billed USD) | `BUDGET_COST` |
| `estimateMicroUsdPerM{Input,Output}Tokens` | Operator prices for the estimate | (n/a) |
| `maxWallMs` | Wall clock from `run()`; at the deadline the run halts and in-flight workers are aborted | `BUDGET_WALL` |
| `maxDepth` | Deepest node (root planner 0, its workers 1) | `DEPTH_CAP` |
| `maxConcurrentDesktops` | Worker trials live at once | `CONCURRENCY_CAP` |
| `maxSpawnsPerPlanner` | Workers and sub-planners one planner may spawn ("max workers per planner") | `PLANNER_SPAWN_CAP` |
| `maxTotalSpawns` | Spawns in the whole run (the storm cap) | `TOTAL_SPAWN_CAP` |

Budget rules:

- **Reservation.** A worker spawn is admitted only if used + reserved + `maxTokensPerWorker`
  stays within `maxTotalTokens` (and likewise for the cost estimate, reserving every token at the
  dearer price). The total therefore holds with every desktop busy.
- **Unmetered is not free.** Usage comes from the host's meter (`WorkerTransport.usage()`,
  `Orchestrator.chargePlanner`), never from the worker's claim. A `null` or malformed usage
  (including a negative count, which would otherwise credit the budget), or a trial that never
  reached the meter, makes the run's estimated cost `null` (never 0) and refuses every later
  spawn (`BUDGET_UNMETERED`).
- Concurrency is refused, not queued: a planner may resubmit after a worker finishes.

### Kill switch

`Orchestrator.kill(detail)` (operator API) or an operator kill-switch file (`killSwitchFile`,
checked at every spawn and polled every `KILL_FILE_POLL_MS` = 100 ms while the run is active)
halts the run: every in-flight worker's `AbortSignal` fires, every later spawn is refused
`KILLED`, in-flight results come back `killed` (never `done`), and a `halt` row records the
code, the detail and the in-flight node ids. The halt is also a `limitsHit` entry (parent
`null`). A halt latches; nothing un-halts a run. `kill()` before `run()` halts at 0 ms, and its
`halt` row follows `run-start`.

A halt (kill switch, wall budget or ledger failure) ends the run **whenever it lands**: no
planner waits on a child past it, even when the child's transport never settles. A child still
running when the run ends is recorded `killed` with an `abandoned` row, before `run-end`, and
counts as unmetered (cost `null`). If it settles later it is handed back `killed` and writes
nothing. Stopping the agent and releasing its desktop on abort is the transport's job (the
trial's `release` runs when the transport settles); the live transport that guarantees it is
V-live.

## Security model

Who can write what:

| Thing | Who writes it | How the planner/worker is kept out |
|---|---|---|
| Limits | Operator config | Parsed once, deep-frozen, held in a private field. The planner gets a frozen **copy**. `loadLimitsFile` refuses a file inside (or containing) an agent-reachable root. |
| Run ids, workspaces | Orchestrator | Minted host-side (`<runId>-w<n>`); a submission carrying `runId` (or any field other than `kind`, `taskId`, `note`, `goal`) is refused `SUBMISSION_FIELD_REJECTED`. |
| Limit fields in a submission | nobody | Any field name that looks like a limit, budget, depth, concurrency, token, cost, wall, kill, quota, deadline or timeout is refused `LIMIT_WRITE_REJECTED` (countable tamper). |
| Verdicts | The gate (bound to one trial) | The worker's only gate is `createSealedGate` bound to its own run and receipt; naming another run is `ASSIGNMENT_MISMATCH` and reads nothing. Reports carry codes only: no reason text, no evidence bytes, no host paths. |
| Ledger | Orchestrator | MAC-chained (`src/integrity/ledger.ts`), key held by the operator, one ledger per run, refused when agent-reachable. A failed write halts the run and downgrades any `done`. |
| Kill switch | Operator | Method on the operator object; the file is refused when agent-reachable. |

Binding gate guarantees are unchanged: the agent-facing gate input stays `taskId`/`runId`/`claim`
(`myco.gate/v1`); the orchestrator adds **no** gate input. The planner's `note` goes to the
worker's assignment only, and the ledger records its sha256 and length in the worker's `spawn`
row (agent-authored text, so not the text); a sub-planner's `goal` is recorded the same way in
its `spawn` row. Neither reaches the gate or the oracle. Grader
independence holds: the orchestrator takes the grader as an operator callback and imports nothing
from `src/benchmark/grade`. Calc stays CSV-only. R1 evidence rules are untouched. An orchestration
run record has `countsAsEvidence: false`, and every ledger row carries its `provenance` (`mock` in
this change), so simulated rows never count as evidence.

### Isolation (track L interface)

`TrialIsolation` (`src/orchestrate/isolation.ts`) provisions one isolated trial per worker and
releases it after; a desktop counts against `maxConcurrentDesktops` from provision to release.
The orchestrator refuses (`ISOLATION_OVERLAP`) a workspace that is inside, contains or equals any
earlier trial's workspace, or that comes back with a different run id, and refuses
(`ISOLATION_UNCONTAINED`) a workspace that is not inside any of `isolation.agentRoots` (the
ledger and kill-file checks rely on those roots being accurate). The vault, the ledger and the
kill file must be disjoint from `isolation.agentRoots`: the orchestrator's constructor checks all
three (the vault through `VerdictVault.reachableFrom`, so a vault built with other roots is still
refused). The `tempDirIsolation` here is the local $0 stand-in (a fresh
0700 directory per trial); per-trial isolated desktops land with track L.

## Run record and ledger

`run()` returns a deep-frozen `RunRecord` (`myco.orchestrate.run/v1`): the limits, the spawn tree
(every node with parent, depth, task, run, status, verdict, gate codes, orchestrator codes, seal
digest; refused submissions are nodes too), `limitsHit`, `halt`, token totals and the estimated
cost (null when unmetered), the root report and the ledger head. The ledger holds `run-start`
(with the limits), `spawn` (with the note or goal digest), `refused`, `verdict`, `usage`,
`planner-end`, `halt`, `abandoned` and `run-end` rows. `run-end` is the last row: nothing is
appended after it (a late `chargePlanner`, a leaked handle or a late worker writes nothing).

## Pre-registration v-v1 (frozen, values pending a lead ruling)

The bar V is judged by is `docs/product/capability-spec-2.md` §2 V, frozen as
`docs/product/capability-prereg/v-v1/prereg.json` (Part 1 §3): the V section's digest, the
`orch-v1` task set (`benchmark/orchestration/orch-v1/`, 60 tasks of 2-4 gated Calc-CSV parts,
built by `src/orchestrate/orch-taskset.ts`) and its manifest SHA-256, seeds, step budget, model
id, the orchestrator limits every `V` tree runs under, and the analysis files with their
SHA-256. The analysis is `src/orchestrate/v-bar.ts` (the bar as code; fixed sequence: control
properties void the run, then exact one-sided McNemar `V` vs `H` with at least 5 discordant
tasks) and `src/orchestrate/v-prereg.ts` (loads the pre-registration and refuses any drift),
run by `npx tsx scripts/orch-v-bar.ts --pack <pack.json>`. Packs record the pre-registration
hash (SHA-256 over canonical JSON of the file) and the commit it was frozen in
(`preregCommit`). The values spec-2 §6 leaves to the lead are written as proposed and listed in
the file's `proposedPendingLeadRuling`; nothing there is ratified. The analysis reads that list,
`leadRulings` and `ratification.status`: while anything is pending or the file does not record
its ratification (a lead ruling with its posting time and source), the decision is never
`shown` (`LEAD_RULING_PENDING`), though the numbers are still reported. Ratifying after the
freeze is a v-v2. Every row also carries its tokens and desktop actions, checked against the
token and step budgets (parity, Part 1 §1.5; a failure is not shown), and each `V` tree records
its most tokens by one worker and any worker that ran on after the kill (both void the run). Where the proposal below differs (two-sided tests with Holm, `V` vs `C1` in the
decision, task success rather than verified per row kind), the spec and the pre-registration
govern.

## Measurement bar proposal (#534; superseded by the pre-registration above)

Proposed for the capability spec to adopt; not run in this change (measurement needs the
integrity fixes in flight and the lead's GO, on Claude Ultra only).

- **Claim.** On multi-part desktop tasks, a planner + gated workers (arm V) finishes more tasks
  **verified** per unit of estimated cost than one agent alone.
- **Arms.** (C1) screenshot-only baseline; (H) hcu+shell baseline; (V) planner + workers through
  the orchestrator, workers using the hcu+shell tool surface. Same model, same task instances,
  same per-task total token budget for every arm (V's `maxTotalTokens` = the single-agent budget).
- **Tasks.** A pre-registered set of 60 distinct multi-part tasks (20 with 2 parts, 20 with 3,
  20 with 4), each a conjunction of existing gated sub-tasks (todo and Calc-CSV families), fixed
  and hashed before the first run; one instance per task, so the 60 pairs are independent.
  Hidden from the planner: the decomposition is the planner's job.
- **Grading.** Every task graded by the independent grader (`src/benchmark/grade`) on the
  persisted end state, not by the gate and not by the planner. A task counts as success only when
  the grader passes every part.
- **Primary metric.** Task success rate (grader), V versus each baseline.
- **Secondary.** R7-style cost per verified task (total estimated cost of ALL trials / verified;
  null cost never 0), false-completion rate (the planner reports done, the grader fails), and
  limits-hit counts.
- **Sample size and test.** n = 60 task instances per arm, paired by instance. Primary test: exact
  McNemar test on paired success, V vs C1 and V vs H, two-sided, alpha 0.05 each with Holm
  correction. Sized for a 20-point improvement (e.g. 40 % to 60 %): if that shows up as about
  16 vs 4 discordant pairs, the exact test gives p ≈ 0.012. The spec should confirm power by
  simulation from the baseline arms' observed discordance before the first run and raise n if
  power is under 80 %. A smaller effect is reported as inconclusive, not as a gain.
- **Pass bar.** V beats both baselines on the primary metric under that test, **and** V's
  false-completion rate is not higher than either baseline's. False completion is a per-instance
  0/1 (the arm reported done and the grader failed), paired by instance, so the test is a
  one-sided exact McNemar test (H1: V's rate is higher), V vs C1 and V vs H, alpha 0.05 each;
  a significant result fails the bar.
- **Stop rules.** Any false VERIFIED by the gate found by the grader halts the measurement.
  Trials faulted by the harness are re-run in place per TIF-274 and kept in the record.

## What is not in this change

- Live planner and worker agents, real desktops and any VM run (queued as a local,
  single-owner task under the VM lock).
- Measurement runs.
- Billing, accounts and hosting: none.
