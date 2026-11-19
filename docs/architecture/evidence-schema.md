# Evidence Schema (M1-012 / TIF-16, ADR-0007)

This document defines every field of the machine-readable evidence Myco emits.
Schemas live in [schemas/](/Users/tofuinparis/.t3/worktrees/Myco/t3-3af56167-94e7d88ce3d06b8c/schemas/):
[trace-events.ts](/Users/tofuinparis/.t3/worktrees/Myco/t3-3af56167-94e7d88ce3d06b8c/schemas/trace-events.ts),
[result-record.ts](/Users/tofuinparis/.t3/worktrees/Myco/t3-3af56167-94e7d88ce3d06b8c/schemas/result-record.ts),
[ledger-row.ts](/Users/tofuinparis/.t3/worktrees/Myco/t3-3af56167-94e7d88ce3d06b8c/schemas/ledger-row.ts).
Validation is hand-rolled ([validate.ts](/Users/tofuinparis/.t3/worktrees/Myco/t3-3af56167-94e7d88ce3d06b8c/schemas/validate.ts), draft-07 subset; no new runtime dependency) and wired into the evidence writer: an invalid artifact throws `InvalidEvidenceError` and fails the run. CI validates a sample eval's artifacts via [validate-artifacts.ts](/Users/tofuinparis/.t3/worktrees/Myco/t3-3af56167-94e7d88ce3d06b8c/schemas/validate-artifacts.ts).

## Directory layout

```
runs/
  <evalId>/ledger.jsonl          # conformance ledger, one row per line
  <runId>/trace.jsonl            # one event per line
  <runId>/result.json            # RunRecord
```

`<evalId>` identifies one evaluation run; `<runId>` one trial. The eval summary reports `successRate` (host-side ground-truth satisfaction over trials) and `checkPassRate` (per-check pass fraction over all scored verdicts) separately, per ADR-0007.

## result.json — RunRecord

| Field | Type | Required | Description |
|---|---|---|---|
| `runId` | string | yes | UUID identifying this trial's run. |
| `taskId` | string | yes | Task family id, e.g. `fake-set-cell`. |
| `taskParams` | object | yes | Trial parameters (intent inputs). |
| `startedAt` | string | yes | ISO-8601 start timestamp. |
| `steps` | EvidenceStep[] | yes | Executed steps in order (see below). |
| `guardFailure` | GuardFailure | no | Present iff the runner aborted on a guard. |
| `verdict` | ScoredVerdict | yes | Final verdict with per-check scores (see below). |
| `unresolvedState` | string | no | Present iff the run ended `uncertain`; names the ambiguity. |

### EvidenceStep

| Field | Type | Required | Description |
|---|---|---|---|
| `step` | integer ≥ 0 | yes | Zero-based step index in the program. |
| `action` | ActionRecord | yes | Closed action union, serialized (ADR-0004). |
| `preconditionResults` | PredicateResult[] | yes | Each guard evaluated before the action. |
| `postconditionResults` | PredicateResult[] | yes | Each guard evaluated after the action. |
| `stateVersionBefore` | integer ≥ 0 | yes | Monotonic state version observed pre-step (ADR-0006). |
| `stateVersionAfter` | integer ≥ 0 | yes | Version after the action landed. |

### PredicateResult

| Field | Type | Required | Description |
|---|---|---|---|
| `predicateName` | string | yes | Closed-language predicate name. |
| `passed` | boolean | yes | Guard outcome. |
| `observed` | string | yes | What the state actually showed. |

### GuardFailure

| Field | Type | Required | Description |
|---|---|---|---|
| `step` | integer | yes | Failing step (-1 = outside any step, e.g. dead adapter). |
| `phase` | `precondition` \| `postcondition` | yes | Guard phase that failed. |
| `predicateName` | string | yes | Failing guard. |
| `observed` | string | yes | Observed state / error. |
| `reason` | string | yes | Structured abort reason. |

### ScoredVerdict (ADR-0007, OSWorld 2.0 partial_scores)

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | `verified` \| `refuted` \| `uncertain` | yes | Three-valued verdict (ADR-0002); `uncertain` = could not look. |
| `checks` | CheckVerdict[] (≥1) | yes | Per-check results. |
| `score` | number [0,1] | yes | Weighted partial score; 1.0 iff `verified` with all checks passing. |
| `reasons` | string[] | yes | Human-readable verdict reasons. |

### CheckVerdict

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Check name, e.g. `fake-set-cell:intent-check`. |
| `passed` | boolean \| null | yes | `null` = could not look (never collapsed to false). |
| `reason` | string | yes | Why this check got its outcome. |
| `partial_score` | { score: [0,1], weight: [0,1], description? } | yes | OSWorld 2.0 shape. Weights across checks sum to 1.0. |

M1-012 wraps each single-verifier verdict as one check with weight 1.0; the calc-record-edit family (M1-009) will emit one check per verification (UNO readback, persisted-file parse).

## trace.jsonl — TraceEvent (one line per event)

Every line is a JSON object with a discriminating `type`:

| `type` | Fields | Emitted when |
|---|---|---|
| `run-start` | `runId`, `taskId`, `startedAt` | First line of every run. |
| `observation` | `timestamp`, `stateVersion`, `nodeCount` | Each state observation. In M1-012 reconstructed per step from `stateVersionBefore` (per-observation fidelity lands with the real adapter, M1-006). |
| `action` | `timestamp`, `step`, `action` (ActionRecord) | Each action dispatched. |
| `guard-evaluation` | `timestamp`, `step`, `phase` (`pre`\|`post`), `results` (PredicateResult[]), `stateVersionBefore`, `stateVersionAfter` | Each guard phase evaluated. |
| `guard-failure` | `timestamp`, `step`, `phase` (`precondition`\|`postcondition`), `guard` (GuardFailure) | Runner aborts on a guard. |
| `fault-injection` | `timestamp`, `fault`, `detail` | FaultInjector arms (`beforeTrial`, `beforeSave`). |
| `recovery` | `timestamp`, `event`, `stateVersion` | Recovery events (ADR-0006); M1-012 emits `aborted-uncertain` when a run ends unresolved. Full recovery event stream lands with M1-011. |

All timestamps are ISO-8601. `ActionRecord` mirrors the closed ADR-0004 union: `kind` plus `ref`/`text`/`value`/`keys`/`timeoutMs` as applicable. `ActionRecord` is intentionally open (no `additionalProperties: false`): adapters may attach delivery metadata to recorded actions without breaking evidence validation; the `kind` discriminator stays authoritative.

## ledger.jsonl — LedgerRow (Cua action-support ledger format)

One row per `(evalId, runId, trialIndex, corruptionClass, actionKind)`:

| Field | Type | Required | Description |
|---|---|---|---|
| `evalId` | string | yes | Owning evaluation id. |
| `runId` | string | yes | Owning run id. |
| `trialIndex` | integer ≥ 0 | yes | Trial number within the eval. |
| `corruptionClass` | string | yes | Fault injector name; `none` for normal trials. |
| `actionKind` | string | yes | Action union kind exercised (ADR-0004), or `none` when the adapter died before the first action landed. |
| `state` | `pass` \| `refusal` \| `failure` \| `gap` \| `uncertain` | yes | Row outcome. **`gap` is never counted as a pass.** |
| `oracle` | string | yes | How the outcome was decided: `verifier:verified+ground-truth`, `verifier:refuted`, `verifier:uncertain`, or `ground-truth:false` (false success). |
| `refusalCode` | string \| null | yes | Explicit refusal code (guard predicate that refused), else `null`. |
| `detail` | string | no | Context, e.g. the FALSE SUCCESS marker. |

### State derivation

| state | condition |
|---|---|
| `pass` | verdict `verified` AND host-side ground truth satisfied — including when the program did not complete (the intent was still demonstrably met). |
| `refusal` | program did not complete and verdict `refuted` (runner refused; refusalCode set). |
| `failure` | verdict `refuted` with the program completing, or a false success (`ground-truth:false`). |
| `uncertain` | verdict `uncertain` (could not look; ADR-0002). |
| `gap` | Reserved; not currently emitted. Semantics if ever used: trial ended without a usable verdict (neither verified nor refuted nor uncertain). With the current single-verifier harness every incomplete-program trial lands in `refusal`, `failure`, or `uncertain`, so no reachable derivation exists; the ledger format reserves `gap` for future fault classes. Never counted as a pass. |

## Validator

[validate.ts](/Users/tofuinparis/.t3/worktrees/Myco/t3-3af56167-94e7d88ce3d06b8c/schemas/validate.ts) implements a draft-07 subset: `$ref` (local `$defs`), `type`, `enum`, `const`, `properties`, `required`, `additionalProperties: false`, `items`, `minItems`/`maxItems`, `minimum`/`maximum`, `pattern`, `minLength`/`maxLength`, `anyOf`, `oneOf`. Issues are `{ path, keyword, message }` with JSON-path locations. `undefined`-valued properties are treated as absent, matching JSON semantics.
