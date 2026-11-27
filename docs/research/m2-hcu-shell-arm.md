# M2-05: the `hcu+shell` head-to-head arm (TIF-268, scorecard row R2)

**Status: built and tested offline. Not run.** The arm runs end to end against fakes, with no VM
and no paid model. The live runs belong to M2-12 (TIF-274).

R2 compares Myco's gate with this arm: a coding agent that drives the same Calc task through
a GUI channel and can also check its own work with a shell
(`docs/product/m2-plan-draft.md` §2.1). It is the question MVP Discovery left open: "a competent
coding agent with HCU and shell access can read [the store] itself"
(`docs/product/mvd-preregistration.md` §4.1).

| Piece | Where |
|---|---|
| Trial loop, row type, grader rule, row validator | `src/baseline/hcu-shell/trial.ts` |
| Shell tool and its boundary | `src/baseline/hcu-shell/shell-tool.ts` |
| Planner prompt and reply parser | `src/baseline/hcu-shell/decision.ts` |
| Shared-ledger arm row and grade request (TIF-267) | `src/baseline/hcu-shell/ledger.ts` |
| Cost estimate (arithmetic only) | `scripts/m2-hcu-shell-cost.ts` |
| Tests: boundary, loop, prompt parity, import boundary, fake end-to-end | `test/baseline/hcu-shell/` |

## How a trial runs

`runHcuShellTrial` is the C1 trial loop (`src/baseline/c1-trial.ts`) with one more kind of
decision. On each turn the planner gets the prompt, the task sentence, the current
screenshot and its last three shell results. It returns one of three things: a claim
(`done` / `failure`), a pixel action (the C1 vocabulary: `click`, `type_text`, `press_key`),
or a shell request. GUI actions go to the GUI channel. Shell requests are checked against
the boundary, run in the guest, and then checked again against the paths the guest says the
call resolved to. When the loop ends, the independent judge reads the persisted document,
and the row records that observation. The verdict is `judge(observation)` and never the
agent's claim.

The row is the M1 C1 ledger row (`BaselineRow`) with `subArm: "hcu+shell"` and these extra fields:

| Field | Why |
|---|---|
| `observation` | The judge's raw observation, so a grader re-derives the verdict (`gradeHcuShellRow`) instead of trusting it |
| `claimedDone`, `falseDone` | R2's false-done rate: the agent said done and the grader refuted it (`null` when the grader was uncertain) |
| `fixtureSha256`, `instruction`, `outputCeiling` | R2's per-row parity evidence (L5: arm-002 instruction text, #340 truncation) |
| `snapshot`, `resetMs` | Which reset preceded the trial |
| `timeBudgetMs: null` | C1 has no wall-clock budget either; recorded so a later difference is a field diff |
| `shell.calls[]` | Every shell request as emitted, with status `complete` / `denied` / `incomplete` / `violation`, the code, and the resolved accesses |
| `shell.integrity` | `clean`, `violated` (a call escaped its boundary) or `unaudited` (the guest could not say what a call touched). Both of the last two make the row `uncertain` |
| `shell.storeChecked` | A complete call read the task document: the pre-registration's "checks every trial" measure |
| `shell.policy` | The boundary the trial ran under, so a grader can re-check every access |

`isHcuShellRow` is what a grader runs before scoring. It re-derives the verdict, `falseDone`,
`integrity` and `storeChecked` from the recorded calls, and it rebuilds the boundary from
`shell.policy` and re-checks every access. A row that says `clean` while one of its calls
read outside the boundary fails. `isBaselineRow` accepts these rows too, so existing C1
tooling can read them.

## Rows in the shared benchmark ledger (TIF-267)

The R2 grade is not this arm's judge. TIF-267's independent grader decides it
(`docs/benchmark/false-completion.md` §4, `schemas/benchmark-ledger.ts`, PR #474, merged into
this branch before it merges to main). The grader reads only the saved document's bytes
against the pinned pristine fixture and the intent. It never takes the agent's claim or
any verdict. The internal row above stays as the arm's own evidence. Three things connect it
to the benchmark:

1. **Capture.** `PreparedHcuShell.capturePersisted()` copies the saved document's bytes to the
   host after every trial, including one where the driver never came up. For Calc this is
   the `.xlsx` itself. The harness keeps the bytes, and the row records `persistedSha256` and
   `persistedFormat`. A failed or empty capture becomes `persistedSha256: null` plus the
   deviation `persisted-capture-failed`. The grader then returns `ungradable`, and an accepted
   DONE on such a row is counted as `acceptedUngradable`. That is loud by design: it blocks
   R1 for the gated arm and shows in R2 for this one. The capture is the harness's, never the
   arm's: the shell does not run it and the planner never sees it.
2. **Arm row.** `benchmarkArmRow(row, meta)` writes `myco.benchmark.arm-row/1`:
   - `arm: "hcu+shell"` and `gate: null`;
   - `claim`: `done`, `not-done` (the agent said failure) or `no-claim`;
   - `accepted = claim is done`, the rule the check recomputes;
   - `instructionSha256` of the exact task text, `fixtureSha256`, `outputCeiling` and
     `persistedSha256`;
   - `cause`: harness for a driver, integrity, capture or routing fault, otherwise agent for
     a non-accepted row;
   - `cost`: `modelUsd` is null for a stub planner (never 0), `wallClockS` is measured, and
     `vmS` is null.

   The arm row has no verdict field.
   `plannerModelId` comes from the arm's configuration, and a trial whose calls used a
   different model throws instead of writing a mislabelled row.
3. **Grade request.** `gradeRequest(row, …)` writes the line `scripts/benchmark-grade.ts`
   reads: the fixture file and hash, the captured file (null exactly when nothing was
   captured), the task's intent, and the column types. Paths must be relative, as the
   grader requires, so no host path reaches a row.

**Rows are keyed to the published task set fc-v1** (`benchmark/false-completion/fc-v1/`,
TIF-267 part 2). The live harness reads a task row from the bundle and passes it to
`armRowForTask` and `gradeRequestForTask`. These take `taskSetVersion`, `taskId`,
`faultClass`, the fixture file and the column types from the task, so no placeholder reaches
a row.

They also refuse a trial that did not run the task, before any row is written. The trial's
fixture hash, its instruction hash and its params must equal the task's `fixtureSha256`,
`instructionSha256` and intent. The published `make-requests` CLI pins the same hashes, so a
trial that ran the wrong fixture, instruction or params is caught twice.

A relabel of the task object itself (its `taskSetVersion`, `faultClass` or `taskId`) is
caught once, by `make-requests`, which checks the row against the bundle. The arm reads no
files, so it cannot check the task row against the bundle. Because no two fc-v1 tasks share a
(fixture, instruction) hash pair, a trial whose hashes match identifies exactly one task. The
arm still imports nothing from `src/benchmark/`; the task row is the caller's.

`test/baseline/hcu-shell/e2e.test.ts` runs the whole chain on fakes, over the **fc-v1 demo
subset** (30 tasks, R2's paired count, including 3 invalid-target tasks).

- **Per trial:** it captures a Calc-shaped `.xlsx` and writes `arm.jsonl` and `requests.jsonl`.
- **Both request paths agree:** the published `make-requests` CLI produces byte-identical
  requests from the same arm rows and documents.
- **Grading:** TIF-267's grader CLI and `checkBenchmark` report no errors. The grader agrees
  with the arm's own judge on every satisfiable task, and fails every document for the
  unsatisfiable ones.
- **Dropped capture:** a second run drops one capture, and that accepted DONE comes back
  `ungradable` and counted.
- **Fault classes:** recorded on each row, not injected. The fake guest has no faults; M2-12
  applies them live.

The arm's modules import nothing from `src/benchmark/`, which the import-boundary test
enforces, so the arm shares no code with the grader that scores it.

## The shell tool

**What it is.** A read-only shell in the guest, given as structured requests
`{"shell": OP, "path": ABSOLUTE_PATH}`, not as a command string:

| Op | Shell equivalent | What the agent learns |
|---|---|---|
| `ls` | `ls -l DIR` / `Get-ChildItem DIR` | whether a save landed |
| `cat` | `cat FILE` / `Get-Content FILE` (output capped at 4,096 chars) | the contents of a text artifact |
| `sha256` | `sha256sum FILE` / `Get-FileHash FILE` | whether the bytes changed |
| `convert-csv` | `soffice --headless --convert-to csv --outdir SCRATCH DOC` | the persisted cell values |

**Why this matches "a coding agent that self-checks with a shell".** After a GUI edit, a
coding agent checks its work by reading the saved file out of band. For an `.xlsx`, that
means converting it headlessly and reading the cells, which is exactly what `convert-csv`
does, and it reads the same persisted state the independent judge reads. The other three ops
are the ordinary inspection commands around it. The pre-registration counts reads and
forbids shell writes to the store: a shell "fix" counts as refuted (§4.1, item 2). A
read-only self-checker is therefore the strongest version of this arm that can still
succeed.

**Where it runs.** In the guest. It can read the task's document directory and a scratch
directory the arm owns (`convert-csv` writes its output there). Nothing runs on the host.

**What it cannot reach.** Ground truth is the grader's side: the expected value
(`src/tasks/intent.ts` `groundTruth`), the oracle, the judge's own conversion output, the run
directory, ledgers and the pinned manifest (which carries Myco's verdicts). The arm is kept
away from all of these in four ways:

1. **By location.** Ground truth lives on the host or in directories the policy denies.
   `createShellPolicy` refuses a policy in which a denied directory overlaps a read root, in
   either direction, or in which a read root is itself named like grader material.
2. **Before the call.** `checkShellRequest` takes only absolute paths inside the two roots.
   It refuses ambiguous paths rather than resolving them: `..` and `.` segments, UNC and
   device paths, NTFS alternate data streams, trailing dots and spaces, 8.3 short names,
   wildcards, variables, and every character a shell would interpret. It also refuses any
   path that names grader material (`oracles`, `expected`, `judge`, `runs`, `.myco`,
   `ledger.jsonl`, `sweep-v3.json`, and the rest of the list), even inside a root. Windows
   paths are compared case-insensitively. The guest receives the canonical path that was
   checked, not the planner's spelling of it.
3. **After the call.** The guest must report the resolved path of everything a call touched.
   A guest that cannot report this must throw, and the row then becomes `unaudited`.
   `checkResolvedAccesses` holds those paths to the same boundary, which is how a symlink in
   the document directory that points at the judge's output gets caught. On a violation, the
   trial stops, the output is never shown to the planner, and the row is `uncertain`, even if
   the document is correct.
4. **In the code.** `test/baseline/hcu-shell/import-boundary.test.ts` proves that no module
   under `src/baseline/hcu-shell/` imports, even transitively, `intent.ts`, the fixture
   generator, the manifest, the Foundry oracles or grader, the guest verifier, or `c1-judge.ts`.

A denied request is evidence, not an integrity failure. It is recorded, the agent is told
"denied", and the trial goes on.

## Gaps for a fair comparison

The first four rows are the gaps `docs/foundry/baseline-status.md` listed for `hcu+shell`. The
rest are R2's parity requirements.

| Gap | Status | How, or what remains |
|---|---|---|
| Complete tool-call audits | **Closed** | Every shell call is recorded with its status and resolved accesses. A call the guest cannot audit makes the row `uncertain`. GUI actions keep C1's per-action delivery records |
| Independently observed save snapshots | **Closed (offline)** | The saved `.xlsx` is captured on the host per trial and graded by TIF-267's grader from its bytes. The arm's own judge observation also stays on the internal row as a cross-check. The live capture over the guest agent is M2-12's |
| Trusted live evidence ingestion | **Remaining** | TIF-125 (attestation binding). Until it lands, rows are descriptive |
| Coordinated VM time | **Remaining** | M2-12 |
| Same task set | **Closed** | Benchmark rows use the published fc-v1 task set (R2: the 30-task demo subset), keyed by `taskSetVersion`/`taskId` and pinned per row by fixture hash, instruction hash and intent (`armRowForTask`). The fake end-to-end test runs the demo subset through `make-requests` |
| Same fixtures | **Closed** | `fixtureSha256` on every row (r6 had none; `docs/m1-scorecard.md` row 7, limit 2) |
| Same instruction | **Closed** | `taskText(params)`, the same text C1 used, recorded per row. The prompt is C1's with one phrase swapped ("screenshot only" becomes "screenshot and a read-only shell") and one sentence added. `decision.test.ts` pins both |
| Same output ceiling | **Closed** | 1024 (#340), recorded per row |
| Same step budget | **Closed against C1** | 30 steps, and shell calls spend the same budget as GUI actions, so the shell buys no extra turns. The gate arm's budget is not defined until M2-02 |
| Same time budget | **Closed against C1** | Neither arm has one (`timeBudgetMs: null`). The gate arm's is undefined |
| Same app state reset | **Closed in the interface; remaining in practice** | `prepare` restores a named snapshot, and the row records `snapshot` and `resetMs`. No snapshot with HCU installed exists yet (C1 used `cua-c1-base`) |
| Same evidence and ledger format | **Closed (against PR #474)** | `benchmarkArmRow` writes TIF-267's `arm-row/1`, validated against the published schema. The internal row stays a superset of the C1 `BaselineRow`. Depends on #474 merging; this branch merges it rather than copying it |
| One independent grader | **Closed (against PR #474)** | Both arms are graded by TIF-267's grader from captured bytes, and joined by its check on `trialKey`. Proven end to end on fakes |
| Verdict integrity (TIF-266) | **Closed for this arm** | The four layers above. M2-03 owns the general CI isolation test |
| HCU GUI transport | **Built; untried live** | `src/baseline/hcu-shell/hcu-gui.ts` drives HCU's `computer-use mcp` `GUI` tool, one batch per action, tested on a fake MCP session. A live run needs HCU in the trial base, serving the interactive desktop (`docs/benchmark/hcu-shell-runbook.md` §1) |
| Planner | **Built, on the subscription** | Headless Claude Code on the operator's subscription (`src/baseline/hcu-shell-live/planner.ts`). Lead ruling 2026-11-27: $0 Anthropic API, so there is no Messages-API adapter and no API-key path. Runner and runbook: `scripts/m2-hcu-shell-run.ts`, `docs/benchmark/hcu-shell-runbook.md` |

### Asymmetries that remain, stated

1. **GUI layer.** HCU here, Cua in C1, and whatever Claude Code drives in the gate arm.
2. **Harness.** This arm is a raw Messages-API loop like C1. The gate arm is Claude Code.
   "Same model settings" can hold for the model, but not for the harness.
3. **Planner memory.** The C1 planner is stateless per step. This arm sees its last three
   shell results, without which a shell is useless. Claude Code keeps the full conversation.
4. **Input bound.** With three full shell results, the per-call input can reach 9,198 tokens,
   while C1's planner refuses anything over 4,000 at its `count_tokens` gate. The live
   adapter must raise that bound for this arm. The estimate below uses the raised bound.
5. **Read-only, structured shell.** No writes and no arbitrary programs (see above). A real
   agent's shell can do more, but nothing more it could do would count as a success.
6. **Shared budget.** Every check costs a GUI step. This is deliberate (same budget), but it
   means the arm trades actions for checks.
7. **One task family.** This is the M1 single-cell Calc edit. Multi-step Calc (M2-07) is
   not covered.

## Cost estimate for the M2-12 runs

This is arithmetic only, and nothing was run. The base is C1 arm-003 r6, which used the same
task, model (`claude-sonnet-5-5`), output ceiling and budget. Rates are $2 / $10 per MTok, the
repo's frozen rates, which match the published Sonnet 5.5 price. The "expected" row adds one
shell result (about 1,366 tokens at 3 characters per token) plus the extra prompt sentence to
every call. The "ceiling" row is every call at the raised input bound with full output. Run
`pnpm tsx scripts/m2-hcu-shell-cost.ts` to recompute. `--check` fails if this block goes stale.

<!-- generated by scripts/m2-hcu-shell-cost.ts; do not edit by hand -->
| | Per trial | 30 trials (R2) |
|---|---|---|
| Measured base: C1 r6, 30 trials, 874 planner calls, $3.3714 | $0.1124 | $3.37 |
| hcu+shell expected (r6 per-call $0.0039 + 1466 input tokens per call) | $0.1978 | **$5.93** |
| hcu+shell ceiling (31 calls x (9198 in + 1024 out tokens)) | $0.8877 | **$26.63** |

**Not included:**

- **The gate arm.** Claude Code's token use per gated trial is unmeasured until M2-02 lands,
  so M2-12 must add it before asking for approval.
- **Reruns.** Omitted or harness-faulted trials are re-run, so budget for some above 30.
- **The spend cap.** It is still open (plan §4, Q4).

## Follow-ups (to file)

- HCU `HcuGui` implementation over the guest (`baseline-status.md`, guest item 2), for M2-12.
- `GuestShell` over the guest agent (`read_file`, `soffice --convert-to csv`), reporting
  realpath-resolved accesses. Its prepare must list the judge's conversion directory and the
  run directory in `groundTruthDirs`.
- A paid planner adapter for this arm: Messages API, an input gate raised to the ceiling
  above, and the same truncation handling as #340. Also a sweep runner with the C1 spend
  ceiling and resume rules.
- An R2 compare script in the style of `row7-compare.py`: pair the two arms' rows by task,
  over TIF-267's grade rows (M2-11 / M2-12). The check already gives per-arm counts, but not
  the paired sign test.
- The live harness (M2-12) must read each task row from `benchmark/false-completion/fc-v1/`,
  apply its `faultClass`, and pass the row to `armRowForTask` and `gradeRequestForTask`.
  For an invalid-target task it needs a stand-in target for the arm's internal judge, since
  `groundTruth` refuses one. The fake test uses B2.
- A reset snapshot with HCU installed, plus its reset timing (M2-01).
- A defined step and time budget for the gate arm (M2-02), so the parity rows above can be
  closed against it.
