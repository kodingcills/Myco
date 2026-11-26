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
  and the two formats are incompatible. Once #518 lands, the runner must also write every
  attempt through #518's writer for R1 evidence; until then a pilot run directory carries no
  R1 attempt ledger.
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
