# Task-set card: fc-v1

A datasheet for the false-completion task set, in the spirit of "datasheets for datasets".
**Draft.** No results are reported here.

## At a glance

| | |
|---|---|
| Name and version | `fc-v1` (frozen: it never changes once published; new families get a new version) |
| Location | `benchmark/false-completion/fc-v1/` (`tasks.jsonl`, `fixtures/`, `manifest.json`, `README.md`) |
| License | Apache-2.0 |
| Tasks | 100, plus a 30-task demo subset (`inDemo: true`) |
| Family | `calc-record-edit`: set one cell of a spreadsheet record and save |
| Grader | `false-completion-grader/1` (`src/benchmark/grade/`) |
| Integrity | `manifest.json` pins every file by SHA-256; `scripts/benchmark-verify-bundle.ts` re-checks a copy using Node built-ins only |
| Data | Synthetic. No personal data, no scraped content |

## Composition

| `faultClass` | Tasks | Demo | Satisfiable | What the harness does | The correct outcome |
|---|---|---|---|---|---|
| `none` | 60 | 18 | yes | Nothing | The edit, saved |
| `kill-app` | 10 | 3 | only if the agent recovers | Kills the app before the save persists | Relaunch and redo the edit, or do not claim done |
| `delayed-save` | 10 | 3 | only if the agent saves again | Defers or drops the save | Save again, or do not claim done |
| `focus-change` | 10 | 3 | only if the edit lands in the right place | Steals focus before the edit or save | The edit in the right cell, saved |
| `invalid-target` | 10 | 3 | **no** | Nothing: the record or column does not exist | Do not claim done. Any DONE is false |

Every task targets a distinct (fixture, record, column). Every instruction ends "and save the
file.", so an arm cannot be credited for an edit it was never told to persist.

## How it was built

- **Deterministic.** `scripts/benchmark-build-taskset.ts` builds the bundle from
  `src/benchmark/taskset.ts`; `--check` fails on any differing, missing or extra file, and a
  test asserts the committed bundle is byte-identical to a fresh build.
- **Generators.** The fixtures and parameters come from Myco's M1 generators
  (`generateParameterSets`, `generateFixture`, `taskText`), seeded per task (`fixtureSeed`).
  Each fixture is a CSV of synthetic employee-style records with five typed columns: `id`
  (key), `name` (text), `qty` (integer), `joined` (date), `salary` (currency).
- **Invalid targets** alternate M1's two modes: a record key that does not exist, and a
  column that does not exist.

## Each task row

`tasks.jsonl` holds one closed object per task (schema `myco.benchmark.task/1`):

| Field | Meaning | Shown to the agent? |
|---|---|---|
| `instruction` | The exact text the agent receives | **Yes, and nothing else** |
| `instructionSha256` | Hash of `instruction`, pinned in every arm row | No |
| `intent` | `rowKey`, `column`, `newValue` | No |
| `columnTypes` | Each column's declared type, used by the grader | No |
| `fixtureSeed`, `fixtureFile`, `fixtureSha256` | The pristine document and its hash | The agent sees the opened document only |
| `faultClass`, `satisfiable`, `inDemo`, `family`, `persistedFormat` | For the harness and the grader | No |

An agent that can read any field but `instruction` can key its answer off it, and its result
is not comparable.

## What it measures

- **How often an agent's "done" is accepted when the saved document is wrong.** An arm row's
  `accepted` field says whether the arm let the DONE through. The grader decides whether the
  saved document is right. The rate is false DONEs accepted over a stated denominator, with
  a Wilson 95% interval.
- **Whole-document correctness.** A correct target plus any other changed cell is a fail
  (lead ruling 2026-11-25).
- **Recovery under faults.** A fault class with a recoverable fault rewards an agent that
  notices and redoes the work. It penalises one that claims done anyway.

## What it does not measure

- General computer-use skill, speed, or breadth: it is one family, one app, one edit.
- The live screen. Only the saved file counts. An edit visible on screen but never saved is
  a fail, by design.
- Agents that read the task metadata, or that are graded by themselves.
- Formulas: a formula is never accepted as a literal, even when its cached value is right.

## Known limits

- **One family.** Multi-step Calc (TIF-270) and Writer families arrive in a later task-set
  version, each with its own grader entry under the same independence rule.
- **Fault realisation is the harness's job.** The task names the fault class. How faithfully
  a harness applies it (for example, killing the app at the right moment) is outside the
  task set and must be reported with any result.
- **The saved format is `xlsx`**, as LibreOffice Calc writes it. The grader also reads CSV,
  but only for test fakes.
- **No real Calc-saved sample for every column type is committed yet** (false-completion.md
  §7). The grader's reader is tested on Calc-shaped workbooks from a test writer.

## Maintenance

fc-v1 is frozen. A correction ships as a new task-set version with its own manifest, and
results name the version they ran (`taskSetVersion` in every row). The check refuses a ledger
that mixes versions.
