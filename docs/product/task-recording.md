# Task recording to automation (capability track R)

A person shows Myco a task once. Myco turns that demonstration into a workflow it can
repeat, with an oracle that checks every repeat. The oracle is labelled **derived**: it
has lower trust than a built-in oracle, and its results never count as R1 evidence.

This is an M2 capability track (Tier 2). Myco should give desktop agents new abilities,
not only check their work, and the baseline arms are how we measure the gain. This page
covers what runs on Linux with no VM. The Windows path needs the VM and is queued
separately (see "Not in this change").

```
human demonstration ──recorder──▶ recording (app-level actions + document before/after)
recording ──compiler──▶ workflow (parameterized, keyed steps) + derived oracle (allowlisted assertions)
workflow + bindings + fresh fixture ──replay──▶ saved document
saved document ──▶ gate (derived family; runs only after the R5 self-test passed) and independent grader
```

Code: `src/recording/`. Linux Calc driver: `scripts/linux/calc_recorder.py`. CLI:
`scripts/myco-record.ts`. Tests: `test/recording/`.

## Try it ($0, no model, no VM)

```sh
pnpm install --frozen-lockfile
pnpm myco-record demo --out /tmp/myco-record-demo          # hermetic scripted human
pnpm myco-record demo --out /tmp/myco-record-demo --calc   # real headless LibreOffice Calc
```

The demo records a scripted human editing one cell and saving. It compiles the recording
and replays the workflow on a fresh fixture, built from a different seed with other row
data and another row count. It replays twice: once honestly, and once with an actuator that
skips the save:

```
PASS  honest     gate VERIFIED (derived-workflow, derived) | grader pass | agree true
PASS  skip-save  gate REFUTED (derived-workflow, derived) | grader fail | agree true
```

It exits 0 only if both replays get the expected outcome. Every artifact it writes is
marked `simulated: true`.

To record a real demonstration on a Linux desktop (prerequisites as in
[linux-path.md](linux-path.md)):

```sh
pnpm myco-record record --doc ./sheet.csv --out ./recording.json   # asks you to type RECORD
pnpm myco-record compile --recording ./recording.json --out ./wf
pnpm myco-record replay --compiled ./wf --fixture ./fresh.csv --evidence ./evidence \
  --run-id run-1 --bind record=EMP-0003 --bind name="New Name" [--calc]
```

## The pieces

### Recorder (`recorder.ts`, `linux-calc.ts`, `calc_recorder.py`)

- **App-level actions first.** On Linux, Calc's own UNO listeners report what happened.
  An `XModifyListener` diffs the sheet after each change and reports cell edits by
  reference and value. An `XDocumentEventListener` reports saves. Calc loads every column
  as text, so the saved CSV round-trips byte for byte, apart from the edits.
- **GUI events as fallback.** A GUI event keeps only its kind (`key` or `click`) and the
  cell that had focus. The compiler accepts a change that only GUI events explain, and
  marks the step `gui-fallback`.
- **Before and after state.** The recorder reads the document from disk twice: when
  recording starts (`before`) and when it stops (`after`, the saved file). It never takes
  the state from the screen.

### Compiler (`compile.ts`)

The compiler checks two sources against each other: the before/after documents and the
action log. Every changed cell must be explained by the log. The last app-level edit
before the last save must hold exactly the saved value. A cell with no app-level edit
passes only if a GUI event touched it. The compiler refuses the whole recording, with a
code, in any of these cases:

| Code | Refused because |
|---|---|
| `NOT_OPERATOR_STARTED` | no operator consent, or the indicator was not shown |
| `RECORDING_REDACTED` | a value was redacted at capture, or a secret or host path is found on re-scan |
| `NO_SAVE`, `UNSAVED_TRAILING_EDITS` | nothing was persisted, or edits came after the last save |
| `NO_EDITS` | the saved document equals the original |
| `UNEXPLAINED_CHANGE`, `LOG_CONTRADICTS_DOCUMENT` | the log and the saved file disagree |
| `HEADER_CHANGED`, `KEY_CHANGED`, `STRUCTURE_CHANGED`, `CLEARED_CELL` | the change is not a keyed cell edit |
| `VALUE_NOT_REPLAYABLE` | the value is the wrong kind for its column, or Calc's input path would rewrite it |

The workflow addresses cells by record key and column header, never by A1 position. That
lets it replay on a fresh fixture where the rows sit elsewhere. Each distinct record
becomes a `record` parameter, and each edited value becomes a `value` parameter. A
parameter keeps the value the person demonstrated as its default. Binding refuses:
unknown names, values that are empty or unsafe in CSV, values of the wrong kind or that
Calc would rewrite, secret-shaped or host-path values, and two steps that land on one cell.

### Derived oracle (`derived-oracle.ts`)

The derived oracle is data. It is built from three allowlisted assertion types:

- `header-equals-fixture`: the header row is the fixture's header row;
- `cell-equals`: the cell for a given record and column holds the bound value;
- `others-equal-fixture`: every other cell equals the fixture's cell. This catches
  collateral damage.

One fixed function, `evaluateDerived`, interprets these types. A closed-shape check
refuses any other type and any extra field. Neither the recording nor the agent supplies
code to the oracle, so the oracle cannot run it. A test pins this: the track R modules
contain no `eval`, no `Function`, no dynamic `import()`, no `node:vm` and no process
launch. The oracle reads the persisted CSV and the sealed fixture, and nothing else.
Its reasons name cells, never values.

**R5 comes before verification.** `certifyDerivedOracle` runs the oracle mutation
self-test (`src/oracle-selftest/run.ts`) on the replay's own fixture, with cases built
from the workflow's intended edits. It claims seven classes: edit-missing, wrong-value,
wrong-target, collateral, truncated, corrupt-byte and missing-file. Every case in every
claimed class must be caught, and every control document must verify. Only a passing
oracle is recorded as certified, in a process-local set that no JSON can write to.
The gate family `derived-workflow` refuses an uncertified oracle twice:

1. at registry build, where `checkSpec` returns an error, so the gate never starts;
2. at decision time, where `decide` throws, so the gate returns `uncertain`
   ORACLE_ERROR.

The family also refuses a sealed fixture other than the certified one. Some oracles fail
the self-test: one without `others-equal-fixture` (collateral damage would verify), one for
a no-op edit, and one that does not target the fixture. Replay then stops with
`SELFTEST_FAILED`, and no gate is built.

### Replay (`replay.ts`)

Replay runs these steps in order:

1. Bind the parameters.
2. Check that the fresh fixture's header matches the workflow's header.
3. Certify the oracle (R5).
4. The actuator edits a working copy. It never sees the evidence root.
5. Capture per trial: after the actuator returns, copy the saved bytes to
   `<evidence>/<runId>/doc.csv`, next to the sealed `fixture.csv`.
6. Run one gate, bound to this trial. The agent-facing request is unchanged: `taskId`,
   `runId`, `claim` (myco.gate/v1).
7. The independent grader (`src/benchmark/grade/`) grades the same bytes.

The grader takes one intent. So it grades a single-edit workflow, and reports a
multi-edit workflow as `not-applicable`, which never counts as a pass. Each report
(`myco.workflow-replay/1`) carries these constants: `trust: "derived"`, a `DERIVED` label
and `r1Evidence: false`.

## Security model

| Threat | Control | Test |
|---|---|---|
| An agent starts a recording | `startRecording` requires `startedBy: "operator"`. The CLI `record` needs an interactive terminal and a typed `RECORD`. No gate or MCP field reaches the recorder | `recorder.test.ts`, `cli.test.ts` |
| A recording runs unseen | The indicator is required and shows a banner at start (before any capture) and at stop. If the indicator throws, recording does not start. Human mode opens a visible Calc window | `recorder.test.ts` |
| A recording captures window titles, key text, clipboard or coordinates | Allowlist per event type. Everything else is dropped and counted (`droppedFields`) | planted-marker tests |
| A recording captures a secret or host path | Every kept string is scanned (key prefixes, private-key blocks, `KEY=` assignments, bearer headers, high-entropy tokens, home, temp and volume paths, drive and UNC paths, `file://`, `~/`, plus operator markers). A hit is redacted: only its JSON path and kind are kept. `stop` and `serializeRecording` re-scan everything and throw. The document is stored as `document.csv`, never as a path | planted-marker tests, unit and real Calc |
| A secret typed into the document is replayed | The compiler refuses a recording with any redaction (`RECORDING_REDACTED`). Binding refuses secret-shaped values. A refused replay report withholds its binding values | `compile.test.ts`, `e2e.test.ts` |
| Recorded or agent code runs in the oracle | Data-only assertions, a closed allowlist, one fixed interpreter, and a source pin with no eval or launch | `derived-oracle.test.ts` |
| A weak derived oracle produces a false VERIFIED | R5 certification is required, and checked at both registry build and decision time | `derived-oracle.test.ts`, `e2e.test.ts` |
| Derived results get counted as R1 evidence | The report says `r1Evidence: false`. A derived task set is unknown to `taskset-binding.ts`, which refuses it unchanged. A derived row filed under fc-v1 is refused because its task is not in fc-v1 | `e2e.test.ts` |

Detection works on patterns. The recorder never reads the environment, a keychain or a
secrets file, so it cannot compare against real secret values. A pure lowercase-hex token
counts as a digest, not a key, because Myco records hold sha256 digests everywhere. A key
made only of hex digits with no known prefix would therefore pass. The controls are layered
for this reason: the compiler and binding refuse redacted and secret-shaped values, and
every record is re-scanned before it is written.

The gate guarantees are unchanged:

- The agent still supplies only `taskId`, `runId` and `claim`.
- One gate serves one trial.
- The grader shares no code with the gate. The derived family lives in `src/recording/`,
  and the replay harness registers it in its own family map. The gate's built-in
  `FAMILIES` are untouched.
- Calc stays CSV-only.

## Pre-registered measurement bar (proposal for docs/product/capability-spec.md)

`capability-spec.md` has not landed yet. This is track R's proposed bar for it to adopt.
Measurement runs are not part of this change. They need the integrity fixes (#518, the xlsx
replacement for #503, the #494 follow-up) and the lead's GO, and they run on Claude Ultra
only.

- **Question.** After one real demonstration, does an agent with Myco's recorded workflow
  complete more tasks of that family, as the independent grader judges them, than the
  baseline arms?
- **Arms (same planner model and task instructions):**
  - **C1, screenshot-only**;
  - **hcu+shell**;
  - **R (Myco recorded workflow).** The hcu+shell arm, plus one tool that replays the
    compiled workflow with bindings the agent chooses from the instruction. That tool is a
    new agent-facing input, and it must be scoped and reviewed before the run (see TO FILE).
- **Demonstration.** One real, operator-started demonstration per task family, with
  `simulated: false`. It is recorded once, before any trial, and its recording sha256 is
  published with the task set. Scripted-human recordings are never used.
- **Task set `fr-v1`** (frozen and published before the first trial). 30 single-edit Calc
  record-edit tasks, each on a fresh fixture whose seed was not used in the demonstration.
  The tasks cover all four column kinds and rows the demonstration did not touch.
  Single-edit only, because the independent grader takes one intent. Multi-edit needs a
  reviewed grader change first.
- **Endpoint.** For each trial: completed when the independent grader returns `pass` on the
  captured persisted bytes. The derived gate never decides the endpoint. Denominator: all
  trials, including refused, `ungradable` and harness-faulted ones. Harness-faulted trials
  are topped up per #511, with the faulted attempt kept.
- **Sample size and test.** 30 tasks × 3 arms × 1 trial each, paired by task and seed.
  - Primary test: R vs hcu+shell, exact two-sided sign test on the discordant pairs at
    α = 0.05.
  - Secondary test: R vs C1, the same test.
  - Each arm's rate is reported with a Wilson 95% interval.
  - Fewer than 6 discordant pairs means underpowered: no superiority claim either way
    (the `mvd-preregistration.md` rule).
  - n is fixed. No interim looks, no optional stopping.
- **Bar (all must hold):**
  1. The primary sign test favours R with p < 0.05.
  2. Zero derived-gate false accepts across every R trial: the gate accepted and the
     grader returned `fail` or `ungradable`. One false accept fails the bar, and the
     derived oracle goes back to review.
  3. Every R trial's derived oracle passed R5 before it verified. A trial that ran without
     certification fails the bar.
- **Reported, not gated.** R7 cost per verified task for each arm: the total token-derived
  ESTIMATE over ALL of the arm's trials, divided by its grader-verified count. A null cost
  is unmeasured, never 0. It is an estimate, never billed USD.
- **Never evidence.** Simulated rows. Any R row used for R1. The derived label is shown on
  every R row in reports.

## Not in this change

- **Windows path (VM).** Recording UIA events as semantic actions, and replaying through
  the guest. Queued as a local, single-owner task under the VM lock.
- **xlsx document state.** Waits for the xlsx replacement for #503. The gate stays CSV-only
  for Calc until then.
- **Grading multi-edit workflows.** The independent grader takes one intent.
- **Structural edits.** Inserted or deleted rows, more than one sheet, formulas: refused
  today, never guessed.
- **CI.** The real-Calc suite (`test/recording/linux-calc.test.ts`) is opt-in
  (`MYCO_LINUX_PATH=1`), like `test/linux/linux-path.test.ts`. Adding it to the
  `linux path` CI job is a separate change to `.github/workflows/ci.yml`.
