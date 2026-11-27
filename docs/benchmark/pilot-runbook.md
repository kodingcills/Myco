# R1 pilot runbook (30 trials, headless Claude Code on the subscription)

Status: **launch-ready plumbing, not launched.** The pilot itself is a later, lead-approved
step. In this change the runner cannot start a real trial: `launch` refuses even with the
right flag and plan hash, because the VM-side capture of the saved document is not wired.

Code: `src/pilot/` (config, launch plan, ledger, runner, cost, dry run, live transport),
CLI `scripts/m2-r1-pilot.ts`, reviewed config `benchmark/pilot/r1/config.json`, tests
`test/pilot/`.

## What the pilot is

- **Trials.** 30 of fc-v1's 100 published tasks, in fc-v1's proportions: the first 18 `none`
  tasks and the first 3 of each of `kill-app`, `delayed-save`, `focus-change` and
  `invalid-target` (task ids `fc-v1-001`..`018`, `061`..`063`, `071`..`073`, `081`..`083`,
  `091`..`093`). The three invalid-target tasks come back `unregistrable`.
- **Agent.** Headless Claude Code (`claude -p`), model `claude-sonnet-5-5` (the hcu+shell
  arm's model, so a later R2 pairing keeps the same planner), on Tiffany's Claude
  subscription. There is no API-key path.
- **What the agent can reach.** One MCP server, `myco-gate`, bound to the trial's one task
  and run, and one tool, `mcp__myco-gate__myco_gate_check`. No built-in tools
  (`--tools ""`), `--strict-mcp-config` with the trial's own `mcp.json`,
  `--permission-mode dontAsk`, and `--setting-sources ""` so no user, project or local
  settings file (permission rules, hooks, `apiKeyHelper`, MCP servers) reaches the trial.
  Every trial's plan passes the existing launch audit (`src/integrity/launch.ts`) before it
  is recorded; a refused plan stops the whole run.
- **The gate contract is unchanged.** The agent supplies only `taskId`, `runId` and a claim
  through `myco.gate/v1`. The gate server reads an evidence root the harness never writes
  while the agent runs, so every mid-run call is `uncertain`; the trial's verdict is the
  harness's own post-stop check on the sealed capture (`runGatedTrial`). Reasons reach the
  agent as codes only. The gate stays CSV-only for Calc.
- **Not R1 evidence on its own.** R1 binds rows to every fc-v1 task run k times
  (`src/benchmark/taskset-binding.ts`); 30 rows are a launch-readiness run.

## Pacing (the default, and why)

| Knob | Default | Why |
|---|---|---|
| `concurrency` | 1 (max 3) | the pilot holds one subscription session; builder and verifier sessions keep the rest |
| `interTrialDelayS` | 90 | spreads the pilot's use across the rate window instead of bursting (one global spacing across all workers) |
| `rateLimitBackoffS` / `rateLimitBackoffMaxS` | 300 / 3600 | on a rate- or usage-limit signal, every worker waits 5 min, doubling to 60 min |
| `maxConsecutiveRateLimits` | 4 | then the run pauses (exit 4); re-run the same command later. A lost login (`auth`) pauses at once |
| `trialTimeoutS` | 1800 | a longer trial is stopped and recorded as a harness `timeout` |
| `maxAttemptsPerTrial` | 3 | attempts per trial that end in a harness fault **other than** a rate limit or a lost login; once spent, the trial is closed for this run directory and the run reports `incomplete` |

Rate-limit and `auth` faults never spend `maxAttemptsPerTrial`: they back off and pause, and a
resume re-runs the trial. So a limit spell on the shared subscription can never strand a trial,
and recovering from one needs no config change (and so no new run directory).

`error-result` (an error result the classifier cannot name, including a limit message worded in
a way the vocabulary does not know) **does** spend `maxAttemptsPerTrial`, with no backoff. That
is bounded (3 attempts, `interTrialDelayS` apart) and safe for the data, but it can exhaust a
trial. Recovering an `exhausted` trial: there is no in-place reset; start a **new run
directory** (`--out` to a fresh path) once the cause is understood, and keep the old directory
as the record of the faulted attempts. If the cause was an unrecognised limit message, add its
wording to `RATE_LIMIT_TEXT` (with a test) before the new run.

At the defaults, 30 trials take at least 43.5 minutes of spacing (29 gaps of 90 s) plus the
trials themselves.
The subscription's limits are not published per minute; if builder or verifier sessions
start hitting limits, raise `--delay-s`. Override per invocation with `--concurrency N` and
`--delay-s S`; an override changes the config hash, so it needs a new run directory.

## Retries: what is and is not re-run

- **Never re-run:** any attempt that reached the gate's post-stop check (verified, refuted
  or uncertain), any unregistrable trial, and any claim the agent made (done, not done, none)
  in a **clean** Claude Code result: subtype `success`, `is_error` false, exit 0, no
  structured error on any message.
- **Re-run in place:** only a harness fault before a decision: `rate-limit` (backs off),
  `auth` (pauses at once), `error-result`, `timeout`, `spawn-failed`, `transport-error`, or
  `crash` (the runner died mid-trial). Classification reads structured fields first (the
  assistant message's `error` class such as `rate_limit` / `authentication_failed`,
  `api_error_status`, the result `subtype` and `is_error`, the exit status) and a tested text
  vocabulary only as a fallback (`src/pilot/claude-transport.ts`). Any error result it cannot
  name is `error-result`: a harness fault, never an agent outcome. The text vocabulary is
  applied **only** to runs that did not complete normally (no result event, an error result,
  a non-zero or null exit, a structured error) and to their stderr, never to a clean result:
  fc-v1's fixtures hold values such as qty 401, 403 and 429, so a clean result with no
  `DONE`/`NOT DONE` line is the agent's "no claim", decided and never re-run. Under the
  topped-up-run ruling (lead, 2026-11-26 12:22Z) the faulted attempt stays in the ledger with
  its arm row (cause `harness`) and its cost estimate, and the re-run's `start` line names it
  in `supersedes`. Its cost counts toward R7.
- **Anything else stops the run** (a harness bug, a binding failure in `gatedArmRow`). Fix it
  and re-run; the open attempt is closed as a `crash` and re-run.

## Cost

Reported only as a **token-derived ESTIMATE**, never a bill (the subscription bills nothing
per token). Each attempt's `cost.estimatedModelUsd` prices the tokens Claude Code reports at
frozen list rates (`src/pilot/cost.ts`); the arm row's `cost.modelUsd` carries the same
number, which the shared check already labels `token-derived estimate at frozen rates; not
billed USD`. It is `null` when the tokens were not measured or the model is not priced; a
null is never counted as 0, and one null makes R7 unmeasured. R7 = the estimates of ALL
attempts (faulted ones included) / verified (accepted DONE that the independent grader
passes). There is no billed-USD field anywhere.

Which number is R7: the numerator is `costEstimate.total` from `status` (every attempt,
faulted ones included); the denominator is the graded verified count from `benchmark-check`.
`status`'s own `perVerified` divides by `acceptedByGate` (not graded), and `benchmark-check`'s
`costPerVerifiedTask` sums `arm.jsonl` only (it leaves out the faulted attempts in
`faulted-attempts.jsonl`), so neither is R7 by itself.

## Preflight checklist (before a real launch)

1. The lead has approved the pilot launch, and the VM step that supplies the live capture is
   merged. Until then `launch` refuses.
2. No API-path credential is configured. The runner checks variable **names only** and refuses
   to start if any is set: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
   the Bedrock / Vertex / Foundry / federation variables (`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`), and
   `MYCO_ANTHROPIC_KEY_FILE` (full list: `API_CREDENTIAL_NAMES` in `src/pilot/launch.ts`).
   Check names the same way, never values: `env | cut -d= -f1 | grep -E '^(ANTHROPIC|CLAUDE_CODE_USE)'`.
   That grep is a coarse look and also lists harmless names (for example
   `CLAUDE_CODE_USE_CCR_V2`); what counts is the runner's own list, `API_CREDENTIAL_NAMES`,
   which `launch` checks and refuses on.
3. Claude Code is logged in to the subscription on this machine (`claude` uses that session;
   the agent's environment carries only `HOME`, `PATH`, `USER`, `LOGNAME`, `LANG`, `TERM` and
   `TMPDIR`).
4. The reviewed config is unchanged: `npx tsx scripts/m2-r1-pilot.ts config` succeeds (it
   refuses a committed config whose launch surface drifted from the code).
5. The dry run passes: `npx vitest run test/pilot` and the dry run below.
6. The guest load gate holds (no trial starts at host 1-minute load >= 10; eval-runbook §7.3).
7. A fresh run directory outside `docs/research/experiments` (the runner refuses that path).

## Exact commands

```sh
# Print the reviewed config, and the launch plan with its sha256.
npx tsx scripts/m2-r1-pilot.ts config
npx tsx scripts/m2-r1-pilot.ts plan --out runs/r1-pilot

# SIMULATED dry run: fake transport, no model, no VM, $0, never evidence.
npx tsx scripts/m2-r1-pilot.ts dry-run --out runs/r1-pilot-dry
npx tsx scripts/m2-r1-pilot.ts status  --out runs/r1-pilot-dry
npx tsx scripts/m2-r1-pilot.ts export  --out runs/r1-pilot-dry --to runs/r1-pilot-dry-export

# Grade and check an export (the same tools as the benchmark).
npx tsx scripts/benchmark-make-requests.ts --bundle benchmark/false-completion/fc-v1 \
  --arm runs/r1-pilot-dry-export/arm.jsonl --docs runs/r1-pilot-dry-export/docs \
  --out runs/r1-pilot-dry-export/work
npx tsx scripts/benchmark-grade.ts runs/r1-pilot-dry-export/work/requests.jsonl \
  > runs/r1-pilot-dry-export/grades.jsonl
npx tsx scripts/benchmark-check.ts --arm runs/r1-pilot-dry-export/arm.jsonl \
  --grades runs/r1-pilot-dry-export/grades.jsonl \
  --expect myco-gate=30 --expect-unregistrable myco-gate=3
# Adding --evidence refuses the dry run: its planner is simulated:pilot-dry-run.

# Real launch (later, lead-approved). Needs the flag AND the configSha256 `plan` printed.
# In this change it prints the plan and then refuses.
npx tsx scripts/m2-r1-pilot.ts launch --out runs/r1-pilot \
  --launch-real-trials --plan-sha256 <configSha256 from plan>
```

Exit codes: 0 ok / complete, 1 run failed, 2 usage, 3 refused, 4 paused or incomplete.

## Pause and resume

- **Pause:** `touch <run dir>/PAUSE`. No new trial starts; in-flight trials finish and are
  recorded; the command exits 4 (`paused`). Ctrl-C or a crash also works: the open attempt
  is closed as a `crash` on resume.
- **Resume:** remove `PAUSE` and run the same command with the same `--out` and the same
  pacing. The runner reads `<run dir>/pilot-progress.jsonl`, skips every trial already decided,
  re-runs open trials in place, and appends; it never rewrites a line and never writes a
  second row for a trial. A different config hash, mode or planner is refused (use a new run
  directory). A second runner on the same directory is refused while the first is alive
  (`pilot.lock`, taken with an exclusive create; a dead runner's lock is taken over).
- **The progress file.** `pilot-progress.jsonl`: a header (config sha256, simulated or not,
  planner), then a `start` line before each attempt and an `end` line after it. A torn line
  from a crash (the header included) is closed with an appended `torn-previous-line` marker,
  never edited. It is deliberately **not** `attempts.jsonl`: that name is the R1 evidence
  attempt ledger (#518, `src/m2/attempt-ledger.ts`, hash-chained and pinned by `pack.json`),
  and the two formats are incompatible. #518 is on main and `checkPack` refuses an R1 pack
  without that ledger, its `pack.json` pin and its host-side anchor
  (`<pack parent>/attempt-anchors/<pack>.jsonl`). The pilot runner does not yet write them, so
  a pilot run or export cannot be assembled into an R1 pack: it is refused as R1 evidence, by
  design. TO FILE: write every attempt through #518's `AttemptLedgerWriter` and anchor, for R1
  evidence.
- **Deadline.** A trial past `trialTimeoutS` gets SIGTERM, then SIGKILL 10 s later if it is
  still running, and is recorded as a harness `timeout`.

## What counts as evidence

- **Never evidence:** anything the dry run writes (planner `simulated:pilot-dry-run`, a
  `SIMULATED` file in the run and export directories), and any row whose planner is not one of
  the Claude model ids in `EVIDENCE_PLANNERS` (`src/benchmark/check.ts`). `benchmark-check
  --evidence` refuses such rows, and the M2 pack CLI (`scripts/m2-evidence-check.ts`) now
  refuses them too (`src/m2/provenance.ts`), even in a full-size pack whose numbers pass.
- **The live pilot's rows** are real trials, but 30 rows are not an R1 result: R1 needs every
  fc-v1 task run k times, the asserted unregistrable split and the pack checks
  (`docs/m2-scorecard.md`, `src/m2/evidence.ts`). Pilot rows can become part of a pack only
  through review, never by the runner writing under `docs/research/experiments`.
- **Faulted attempts** are kept and linked (`faulted-attempts.jsonl` in an export); they are in
  no R1, R2 or R3 count, and their cost counts in R7.

## Corrections ON/OFF A/B

The A/B runs the gate with its agent-safe corrections (#514) ON against the same gate with them
OFF, on paired tasks. It uses this runner. The design is pre-registered and fixed:
`docs/benchmark/corrections-ab-prereg.md` (the lead's decision, verbatim) and its machine form,
`docs/benchmark/corrections-ab-prereg.json`. The runner is `src/pilot/ab.ts`, driven by
`scripts/m2-corrections-ab-run.ts`. The analysis is #547's `scripts/m2-corrections-ab.ts`.

- **Stage 0** (plumbing, no effect claim): the pilot's 30 tasks, 30 pairs.
- **Stage 1** (confirmatory): fc-v1, 100 pairs, a fresh seed, no Stage 0 row reused. Stage 1
  refuses to start until Stage 0 is complete in the same A/B directory with zero gate misses.
- **Arms:** the two arm configs differ in `corrections` and nothing else. `plan` diffs them at
  every depth, and diffs the launch plans too (only the ON arm's `--corrections` flag may
  differ). The run refuses any other difference.
- **Order:** the stage's seed shuffles the tasks, cuts them into chunks of 10 pairs and picks
  which arm runs first in each chunk. `schedule.json` is written once, then re-derived and
  compared on every resume.
- **Pacing:** the pilot's per-trial pacing inside a chunk. One chunk per invocation, and
  30 min between chunks within one invocation. Re-run the same command to continue.
- **Experiment only:** every arm row carries `experiment: {id: "corrections-ab", stage, arm, seed}`, the OFF
  arm included, and every pack carries an `EXPERIMENT` marker. `benchmark-check --evidence` and
  `m2-evidence-check` refuse them. They are never R1 evidence.

### Exact commands

```bash
# The pre-registration's hashes (what every pack records). jsonPinsMarkdown must be true.
npx tsx scripts/m2-corrections-ab-run.ts prereg-hash

# A stage's plan: planSha256, both arm config hashes, the launch-plan diff, the schedule.
npx tsx scripts/m2-corrections-ab-run.ts plan --stage 0

# The SIMULATED dry run ($0, no model, no VM, never evidence). It runs the whole path: both
# stages, export, the pack check, #547's analysis (the pre-registered command),
# the evidence refusal, a pack with a wrong pre-registration hash, and the gate-miss drill
# (halt, refused resume, refused wrong ack, the operator's ack, resume, Stage 1 refused).
npx tsx scripts/m2-corrections-ab-run.ts dry-run --out runs/ab-dry

# Practise pause and resume on the fake transport: one chunk per invocation.
npx tsx scripts/m2-corrections-ab-run.ts simulate --stage 0 --out runs/ab-sim   # exit 4: paused
npx tsx scripts/m2-corrections-ab-run.ts simulate --stage 0 --out runs/ab-sim   # the next chunk

# Progress (counts only, never a p-value before a stage is complete) and incidents.
npx tsx scripts/m2-corrections-ab-run.ts status --out runs/ab

# Export a stage as an A/B pack, check it, analyse it with #547.
npx tsx scripts/m2-corrections-ab-run.ts export --out runs/ab --stage 0 --to packs/ab-stage0
npx tsx scripts/m2-corrections-ab-run.ts check-pack packs/ab-stage0
npx tsx scripts/m2-corrections-ab-run.ts analyze --pack packs/ab-stage0
npx tsx scripts/m2-corrections-ab-run.ts export --out runs/ab --stage 1 --to packs/ab-stage1
npx tsx scripts/m2-corrections-ab-run.ts analyze --pack packs/ab-stage1 --stage0-pack packs/ab-stage0
# analyze refuses (exit 3) unless the pre-registered analysis command, filled in for the pack,
# equals the command it runs; otherwise it exits with #547's code.

# Real Stage 0, then Stage 1 (later, after the GO). In this change it prints the plan, lists
# every unmet precondition and refuses (exit 3).
npx tsx scripts/m2-corrections-ab-run.ts launch --stage 0 --out runs/ab \
  --launch-real-trials --plan-sha256 <planSha256 from plan --stage 0>
```

`analyze` checks the pack first: the manifest, the markers, the labels, identical arm configs,
one grade per row, every gate miss the rows show tied to its incident record (see below), and
the recorded pre-registration sha256 against the repository's file (a real run also requires
it committed). It refuses on any error
(exit 3). Then it prints and runs #547's exact command, with `--prereg-file` and
`--prereg-declared`, so #547 checks the hash too.

### Before a real run

`launch` refuses, naming each reason, until all of these hold. The same preconditions (1-5,
including the explicit flag and the printed plan's sha256) are applied inside the runner
itself (`runAbStage`, `liveAbRefusals`) before any live trial, and `runPilot` re-checks 1-4
from each A/B arm config (`liveExperimentRefusals`), so no caller can skip them:

1. The pre-registration (both files) is committed and unchanged from HEAD.
2. The lead's GO is committed as `docs/benchmark/corrections-ab-go.json`, with the stage(s) in
   `stages` and this pre-registration's sha256 in `preregSha256`.
3. The integrity fixes have landed. The gate reads the tasks' format: fc-v1 persists xlsx, and
   the gate reads CSV until the xlsx replacement for #503. #546's cold-boot guard is merged: the
   trial-ops schema has `resetBootClass`, and the live transport reports a cold boot per trial.
4. #518's attempt-event vocabulary names the pilot's harness classes. Until then, a fault it
   cannot name stays open in `attempts.jsonl` and is recorded with its exact class in
   `attempts-unclassified.jsonl`; the pack discloses the count.
5. The subscription preflight passes (no API-key variable, names only), with
   `--launch-real-trials` and the `planSha256` that `plan` printed.
6. A live driver with VM-side capture is wired. This change has none, so `launch` always
   refuses for now.

### Pause and resume

- `touch runs/ab/PAUSE` (the whole A/B) or `touch runs/ab/stage<N>/PAUSE` (one stage) stops new
  trial starts after in-flight trials finish. Remove the file and re-run the same command.
- Rate limits, a lost login and the chunk budget pause the run the same way as in the pilot.
  The pilot's crash recovery, lock and in-place re-runs of harness faults all apply per arm.
- A changed pre-registration, seed, config, planner or mode is refused on resume. It needs a
  new A/B directory.

### Integrity incident (gate miss)

A gate miss is a trial the gate VERIFIED whose independent grade is not pass. The runner
grades every decided trial as soon as it is decided, in both arms. A trial decided but never
graded, for example after a crash, is graded on the next invocation before anything else runs.

The record is crash-safe. For each decided trial the runner writes the incident record first
(atomically), then the boot-class record, and the grade last; a grade on disk means everything
before it is on disk. On every invocation it also re-derives gate misses from the rows (each
gate-VERIFIED row whose grade is not pass) and writes any missing incident record before
anything runs, so a crash at any point leaves the run halted. `export` and `check-pack` derive
the misses from the rows too (never from a flag), and refuse a miss without its record. Stage 1
also re-derives Stage 0's misses from its rows, not only from its incident files.

1. On a gate miss the runner halts the whole run (exit 4, status `halted`). It writes
   `runs/ab/stage<N>/incidents/incident-<trialKey>.json`: arm, trial, task, gate verdict,
   grader status and version, the persisted document's sha256 and the rule.
2. Every later invocation refuses (exit 3) until the incident is acknowledged. Nothing resumes
   automatically, and the runner never writes an ack.
3. Review the record and the trial (`runs/ab/stage<N>/<arm>/trials/<trialKey>/`), and file it.
   A gate miss is the one thing the gate must not do. Then acknowledge it with the record's
   sha256, which `status` prints:

   ```bash
   npx tsx scripts/m2-corrections-ab-run.ts ack-incident --out runs/ab --stage 0 \
     --incident incident-<trialKey> --incident-sha256 <sha256> \
     --operator "<name>" --statement "<what was reviewed and where it is filed>"
   ```

4. The incident stays in the export (`incidents/`, `ab-pack.json` `incidents` and
   `gateMisses`), and #547 reports the pack
   as `halted`. It is never counted as data. A Stage 0 gate miss blocks Stage 1 even after the
   ack: only a lead decision, recorded in code, reopens it.

### Integrity incident (live reset not a cold boot)

The pre-registration says a live trial whose reset is missing or is not a cold boot halts the
run (#546). The halt is sticky, in the same way as a gate miss:

1. The runner writes `runs/ab/stage<N>/incidents/incident-boot-<trialKey>.json` atomically,
   before the trial's `ab-trials.jsonl` record and its grade. The record holds the arm, trial,
   task, the recorded boot class (`fast`, `null` or anything else) and the rule.
2. On every invocation the runner re-derives the boot class of each decided trial in a live run
   from `ab-trials.jsonl`. A trial with no record, or with any record that is not exactly `cold`,
   gets its incident record if it is missing. "Not exactly `cold`" covers a missing field, `null`,
   `fast`, an unknown string and a non-string, and one record never masks another: a trial with
   one `cold` and one missing-field record halts. A trial re-recorded after a crash has an
   unknown boot class (`null`), so it halts too.
3. Every later invocation refuses (exit 3) until the record is acknowledged with `ack-incident`,
   exactly as for a gate miss (`--incident incident-boot-<trialKey>`). Nothing clears it
   automatically.
4. An ack lets the run continue. It does not make the trial count: `export` and `check-pack`
   refuse a live pack whose trials are not all recorded cold boots, so do not ack and carry on
   unless the lead has ruled how the stage is to be completed. A Stage 0 boot-class incident
   also blocks Stage 1, like any Stage 0 incident.
5. Only decided trials are checked. A trial that ends as a harness fault never reaches the
   decided-trial hook, so its boot class is never checked: it is not data, and the
   pre-registration's "Harness faults, ledger, resets" section already splits faults (closed,
   counted against the fault budget and re-run) from decided trials (the only ones whose reset
   must be a recorded cold boot). This is by design. If the re-run is decided, its own reset is
   checked.
