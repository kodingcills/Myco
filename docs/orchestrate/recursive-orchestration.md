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

## Limits (mandatory, host-side, fail closed)

`OrchestratorLimits` (`src/orchestrate/limits.ts`, `myco.orchestrate.limits/v1`). Every field is
required and must be a positive integer; unknown fields are refused. There is no "unlimited".

| Limit | Meaning | Refusal code |
|---|---|---|
| `maxTotalTokens` | All tokens in the run (workers and planners) | `BUDGET_TOKENS` |
| `maxTokensPerWorker` | Reserved for each worker at spawn; the live transport caps the worker at it | `BUDGET_TOKENS` |
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
  `Orchestrator.chargePlanner`), never from the worker's claim. A `null` or malformed usage, or a
  trial that never reached the meter, makes the run's estimated cost `null` (never 0) and refuses
  every later spawn (`BUDGET_UNMETERED`).
- Concurrency is refused, not queued: a planner may resubmit after a worker finishes.

### Kill switch

`Orchestrator.kill(detail)` (operator API) or an operator kill-switch file (`killSwitchFile`,
checked at every spawn) halts the run: every in-flight worker's `AbortSignal` fires, every later
spawn is refused `KILLED`, in-flight results come back `killed` (never `done`), and a `halt` row
records the code, the detail and the in-flight node ids. A halt latches; nothing un-halts a run.

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
worker's assignment and the ledger only; it never reaches the gate or the oracle. Grader
independence holds: the orchestrator takes the grader as an operator callback and imports nothing
from `src/benchmark/grade`. Calc stays CSV-only. R1 evidence rules are untouched. An orchestration
run record has `countsAsEvidence: false`, and every ledger row carries its `provenance` (`mock` in
this change), so simulated rows never count as evidence.

### Isolation (track L interface)

`TrialIsolation` (`src/orchestrate/isolation.ts`) provisions one isolated trial per worker and
releases it after; a desktop counts against `maxConcurrentDesktops` from provision to release.
The orchestrator refuses (`ISOLATION_OVERLAP`) a workspace that is inside, contains or equals any
earlier trial's workspace, or that comes back with a different run id. The vault and the ledger
must be disjoint from `isolation.agentRoots` (the vault checks its own roots; the orchestrator
checks the ledger and kill file). The `tempDirIsolation` here is the local $0 stand-in (a fresh
0700 directory per trial); per-trial isolated desktops land with track L.

## Run record and ledger

`run()` returns a deep-frozen `RunRecord` (`myco.orchestrate.run/v1`): the limits, the spawn tree
(every node with parent, depth, task, run, status, verdict, gate codes, orchestrator codes, seal
digest; refused submissions are nodes too), `limitsHit`, `halt`, token totals and the estimated
cost (null when unmetered), the root report and the ledger head. The ledger holds `run-start`
(with the limits), `spawn`, `refused`, `verdict`, `usage`, `planner-end`, `halt` and `run-end`
rows.

## Measurement bar proposal (pre-registered, for docs/product/capability-spec.md)

Proposed for the capability spec to adopt; not run in this change (measurement needs the
integrity fixes in flight and the lead's GO, on Claude Ultra only).

- **Claim.** On multi-part desktop tasks, a planner + gated workers (arm V) finishes more tasks
  **verified** per unit of estimated cost than one agent alone.
- **Arms.** (C1) screenshot-only baseline; (H) hcu+shell baseline; (V) planner + workers through
  the orchestrator, workers using the hcu+shell tool surface. Same model, same task instances,
  same per-task total token budget for every arm (V's `maxTotalTokens` = the single-agent budget).
- **Tasks.** A pre-registered set of multi-part tasks, each a conjunction of 2-4 existing gated
  sub-tasks (todo and Calc-CSV families), fixed and hashed before the first run. Hidden from
  the planner: the decomposition is the planner's job.
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
  false-completion rate is not higher than either baseline's (one-sided exact test, alpha 0.05).
- **Stop rules.** Any false VERIFIED by the gate found by the grader halts the measurement.
  Trials faulted by the harness are re-run in place per TIF-274 and kept in the record.

## What is not in this change

- Live planner and worker agents, real desktops and any VM run (queued as a local,
  single-owner task under the VM lock).
- Measurement runs.
- Billing, accounts and hosting: none.
