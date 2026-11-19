# Myco — core runtime

Make existing desktop software reliably executable by AI agents: verified operations, recoverable execution, reusable procedural knowledge.

This repo contains the **M1 core runtime skeleton** plus a **fake-app test double** so the whole execute → verify → evidence loop runs and is tested on macOS/Linux today, before the real Windows UIA adapter exists.

## Layout

- `src/core/state.ts` — versioned, typed `AppState` snapshots (nodes + app facts), JSON (de)serialization
- `src/core/adapter.ts` — `AppAdapter` interface (`observe` / `act` / `capabilities`), closed `Action` union, `StaleRefError`
- `src/core/program.ts`, `src/core/runner.ts` — guarded action programs; pre/postconditions evaluated around every action, aborts with a structured `GuardFailure`
- `src/core/verify.ts`, `src/core/filepersist.ts` — `Verifier` interface reading ONLY persisted state; CSV reader as `PersistedState`
- `src/core/evidence.ts` — `RunRecord` schema, JSONL trace + result writer under `runs/<runId>/`
- `src/core/eval.ts` — eval harness: task families, pluggable `FaultInjector`s, false-success detection against independent ground truth
- `src/fake/` — in-memory fake spreadsheet with a scripted `AppAdapter`, deliberate failure modes (crash-on-demand, invalid refs, delayed saves, focus steal) and fault injectors

Key invariant: **`ActResult` never claims goal success; the runner never decides task success.** Only the verifier, reading the persisted file, can produce a `verified` verdict — and the eval harness independently computes ground truth to catch verifier false positives.

## Setup

Node 24. npm works out of the box (`pnpm install` also works; CI installs pnpm).

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

## Testing the false-success requirement

`test/eval.test.ts` runs trials where the app is killed before save, the save is delayed, focus is stolen, or the target ref is invalid — and asserts **0 false successes** (a `verified` verdict with unsatisfied ground truth is counted and must be 0). A lying-verifier test proves the harness would catch a verifier that rubber-stamps runs.
