# Dogfood scoring and issue filing

How a dogfood run is scored and how a failed capability becomes a Linear issue.
Reuse, don't reinvent: evidence artifacts are M1's schemas (`schemas/`,
docs/architecture/evidence-schema.md, ADR-0007) with dogfood-specific values
plugged into existing fields.

## Evidence per run (M1-012 schema, dogfood values)

```
runs/
  <evalId>/ledger.jsonl      # conformance ledger rows (schema: schemas/ledger-row.ts)
  <runId>/trace.jsonl        # trace events        (schema: schemas/trace-events.ts)
  <runId>/result.json        # RunRecord           (schema: schemas/result-record.ts)
```

- `taskId` = scenario id (`df-s01` … `df-s05`).
- `taskParams` = `{ scenario, storePath, agentModel, runtimeBuild }`.
- `verdict.checks` = one `CheckVerdict` per oracle assertion (e.g.
  `df-s02:persisted-set-matches`, `df-s02:agent-report-names-missing`), weights
  summing to 1.0. Oracle assertions are computed host-side from the guest's
  persisted file, never from the agent's transcript claims — the transcript is
  itself graded by the independent verifier model as a separate check.
- Ledger `oracle` field values: `verifier:verified+ground-truth`,
  `verifier:refuted`, `verifier:uncertain`, `ground-truth:false` (false success),
  exactly per the evidence-schema derivation table.

## Run scoring

Every run lands in exactly one bucket:

| bucket | condition |
|---|---|
| `success` | all oracle checks pass; ground truth satisfied |
| `false-success` | agent claimed success; host-side ground truth shows the intent not satisfied (ledger `oracle: ground-truth:false`, `state: failure`) |
| `refusal` | agent/runner aborted on a guard or refused the task (e.g. refused to kill a process in DF-S04); refusalCode set |
| `uncertain` | a check could not look (file unreadable, runtime op timeout); never collapsed into failure, never counted as pass |
| `gap` | runtime could not execute the scenario at all — a missing capability, not an agent failure. **Never counted as pass.** |

Plus, recorded per run regardless of bucket:

- **time cost:** wall-clock seconds from runtime `create` ack to verdict written
  (`startedAt` in result.json to eval completion), and per-phase breakdown from
  trace timestamps (provision, act, verify).
- **missing/flaky capability:** the REQ-id from
  `docs/coordination/dogfood-state.md` implicated by a `gap`/`uncertain`, or
  `none`. One run may implicate several; record all.

The headline metrics per eval: success rate over the 5 scenarios,
false-success count (target: 0), gap count by REQ-id (feeds the runtime team's
priority list), and median time cost per scenario.

## Turning a failed capability into a Linear issue

A **capability failure** = any run bucketed `gap`, or bucketed
`uncertain`/`refusal` where the cause is a runtime deficiency (not agent
judgment). Each becomes one entry in `docs/backlog/dogfood.md`, which the outer
loop mirrors to Linear project "Myco Dogfood" (team TIF).

Entry format (copy verbatim, fill fields):

```markdown
### DF-0NN (TIF-pending) <capability summary>
- **status:** open
- **owner:** runtime (escalation to Myco Desktop Runtime workstream)
- **blocked_by:** none | DF-0NN
- **description:** <what the runtime could not do, in terms of the REQ-id in
  docs/coordination/dogfood-state.md>
- **reproduction:** scenario <DF-S0N>, run <runId>; evidence at
  runs/<evalId>/<runId>/{trace.jsonl,result.json}; ledger row
  <evalId>/<trialIndex>. Exact failing step and observed error:
  <quote from trace.jsonl>.
- **acceptance:** scenario <DF-S0N> completes with bucket `success` on <N>
  consecutive runs; oracle check <name> passes; no `uncertain` verdicts from
  the implicated op.
```

Rules:

1. **One capability per issue.** Two scenarios failing on the same REQ-id share
   one issue; note both reproductions.
2. **Attach evidence, not narrative.** The `reproduction` field points at
   trace/result artifacts; anyone can re-run the scenario to confirm.
3. **Agent-judgment failures are not runtime issues.** A false success caused
   by the agent under test trusting the UI is a *finding about the agent*, not
   a DF issue — record it in the eval report instead.
4. **Ids are stable, never renumbered** (repo convention, docs/agents/issue-tracker.md).
5. The outer loop owns Linear; agents only edit `docs/backlog/dogfood.md`.
