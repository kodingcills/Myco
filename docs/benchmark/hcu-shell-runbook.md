# Runbook: the `hcu+shell` head-to-head arm on the Claude subscription (TIF-268)

This is R2's other arm: Microsoft Hybrid Computer Use (HCU) plus a read-only shell, driven by
headless Claude Code, over fc-v1's 30-task demo subset. It runs against the same trial VM, the
same VM lock and the same cold reset as the myco-gate arm. Its rows go to TIF-267's independent
grader. The scorecard rows it feeds are R2 (the head-to-head) and R7 (cost per verified task).

**Billing: $0 Anthropic API (lead ruling 2026-11-27 01:35Z).** The planner is headless Claude
Code on the operator's Claude subscription. There is no API-key path in the code. The planner
refuses to start if any API-path variable is set, and it halts if the CLI reports that it
authenticated with anything other than the subscription. Paid API use is not approved: if the
only way to run is an API key, the run refuses. Do not work around that refusal.

Code: `src/baseline/hcu-shell-live/` (planner, runner, live VM environment, refusals).
CLI: `scripts/m2-hcu-shell-run.ts`. The arm library it drives is `src/baseline/hcu-shell/`
(`docs/research/m2-hcu-shell-arm.md`).

## 1. What the operator must provide

Everything below is checked by the CLI or by the probe. Nothing is assumed.

| # | What | How it is checked |
|---|---|---|
| 1 | **The trial VM host.** The Mac with `myco-win11` and the files `~/VMs/myco-win11/ssh_config`, `scripts/vssh` and `scripts/vm.sh`, as for every live run (`docs/eval-runbook.md` §3). `trial-base-v3` must be built and recorded (#564). | `launch` refuses unless `scripts/reset-trial-vm.sh` has #546's cold-boot guard and defaults to `trial-base-v3`. Every trial then parses the reset's `boot class=` line. |
| 2 | **`claude` on `PATH`, logged in to the operator's Claude subscription.** Log in with `/login` using the subscription account, not an API key or Console account. The environment must hold **no** `ANTHROPIC_*` or provider variables, not even empty ones. The full list is `API_CREDENTIAL_NAMES` in `src/pilot/claude-cli.ts`. | The preflight checks variable names only and never reads a value. On every call the planner checks the CLI's own `system/init` event: `apiKeySource` must be `none`, and `model` must be the plan's model. |
| 3 | **HCU in the guest, inside the trial base.** Install Microsoft Hybrid Computer Use (`computer-use`, github.com/microsoft/Hybrid-Computer-Use, MIT, v1.0.1 or later, Windows build with its .NET 8 provider) in the snapshot both arms reset to. By default it is reached as `ssh myco-win11 'C:\myco\bin\computer-use.exe mcp'`. It must serve the **interactive** desktop (session 1). An SSH session runs in session 0, so a plain `computer-use mcp` over SSH cannot see the desktop. Use a relay into session 1, as C1 did for `cua-driver` (`C:\myco\bin\run-interactive.ps1` and a named pipe), and pass that command with `--hcu-command '<cmd>'`. Passing it changes the plan hash, so the lead's GO names the exact command. | On every trial, prepare probes HCU: MCP initialise, the `GUI` tool must be present, and one screenshot. If the probe fails, the attempt fails with the harness code `hcu-unreachable` before the agent or the planner runs. No row is written and nothing is counted. The trial re-runs in place, and a second `hcu-unreachable` in a row aborts the run (exit 6). |
| 4 | **Guest basics already in the trial base.** Windows PowerShell 5.1, LibreOffice at `C:\Program Files\LibreOffice`, and `myco-agent` with `run-interactive.ps1`, as for the C1 and myco-gate runs. | Prepare fails with a code (`agent-unreachable`, `fixture-convert-failed`, `seed-readback-failed`, `calc-uno-timeout`). Two identical failures in a row abort the run. |
| 5 | **The lead's GO.** A committed, unchanged `docs/benchmark/hcu-shell-go.json`: `{"schema":"myco.hcu-shell.lead-go/1","arm":"hcu+shell","planSha256":"<the printed hash>","ruling":"<who and when>"}`. The repo does not contain it until the lead gives it. | `launch` refuses with `lead-go-missing`, `lead-go-invalid`, `lead-go-plan-mismatch` or `lead-go-uncommitted`. |
| 6 | **The VM lock.** Run under `scripts/vm-session.sh -- node --import tsx ...` (TIF-210), so nothing else drives the VM during the run. Start the runner with `node --import tsx`, **not** `npx tsx`: a Node launcher replaces FD 9, so the lock never reaches the runner or the reset. | `launch` refuses with `vm-lock-not-held` otherwise. The reset is spawned with FD 9 passed through, so it accepts the session's lock. |

As far as this repo records, `trial-base-v3` does **not** contain HCU yet
(`docs/research/m2-hcu-shell-arm.md`, "Same app state reset"). Item 3 therefore needs the trial
base rebuilt with HCU installed. That rebuild is VM time and a lead decision. Both arms should
then reset to the rebuilt base, so the snapshot stays the same across the pair. If the
snapshot name changes, `TRIAL_SNAPSHOT` in `runner.ts` and the reset default change with it
in a reviewed PR.

## 2. Run it

```bash
# 0. Practise the whole path at $0. It is simulated and never evidence (sim- trial keys,
#    planner "simulated:hcu-shell-dry-run", which --evidence refuses).
npx tsx scripts/m2-hcu-shell-run.ts dry-run --out runs/hcu-shell-dry

# 1. The plan and its hash. The lead's GO names this hash.
npx tsx scripts/m2-hcu-shell-run.ts plan [--hcu-command '<cmd>']

# 2. One planner call on the subscription, no VM: proves the CLI is logged in to the
#    subscription and on the plan's model. Expect {"ok": true, ...}; any halt code means stop.
#    This is a real subscription call ($0 API) made WITHOUT the lead's GO; it starts no trial.
npx tsx scripts/m2-hcu-shell-run.ts probe-planner --call-claude

# 3. The run, under the VM session lock. node --import tsx, never npx (npx drops FD 9).
scripts/vm-session.sh -- node --import tsx scripts/m2-hcu-shell-run.ts launch --out runs/hcu-shell-r2 \
  --launch-real-trials --plan-sha256 <hash from step 1> [--hcu-command '<cmd>']

# 4. Ground truth, only from the independent grader.
npx tsx scripts/benchmark-grade.ts runs/hcu-shell-r2/requests.jsonl > runs/hcu-shell-r2/grades.jsonl
npx tsx scripts/benchmark-check.ts --arm runs/hcu-shell-r2/arm.jsonl \
  --grades runs/hcu-shell-r2/grades.jsonl --expect hcu+shell=30 --evidence
```

`launch` prints the plan, then lists every unmet precondition and exits 3. It starts nothing
until all of them hold.

Exit codes are the myco-gate arm's (#598):

| Exit | Meaning |
|---|---|
| 0 | complete |
| 1 | failed (a harness bug) |
| 2 | usage |
| 3 | refused (a precondition is unmet; nothing started) |
| 4 | paused, halted on a non-cold boot, or incomplete |
| 5 | fail-closed stop on the subscription: `planner-auth`, `planner-billing`, `planner-api-key-path`, `planner-auth-source-unknown`, `planner-model-mismatch`, `planner-fault-unknown` |
| 6 | two identical failures in a row (abort) |
| 7 | the subscription's usage limit (`planner-usage-limit`). The run prints `USAGE LIMIT: ... This must go to the lead`. |

### Pacing (the myco-gate arm's `DEFAULT_PACING`)

A live run is paced exactly as #598's live runs. The values are in the plan, so the lead's GO
names them:

- one trial at a time;
- trial starts at least 90 s apart;
- a 1800 s deadline per attempt, covering the reset, the agent and the capture. Past it the
  attempt fails `trial-timeout`, in-flight planner calls are stopped, the trial's planner
  refuses further calls, and no row is written;
- no attempt starts while the host 1-minute load is 10 or more (the M2 guest load gate). The
  run polls every 30 s and pauses (`host-load-high`) after 30 min;
- a harness failure re-runs the trial in place, up to 3 attempts. After that the trial is
  `exhausted` for this run directory and the run ends `incomplete`;
- a transient 429, 529 or overload backs off 300 s, doubling to at most 3600 s, and re-runs
  the trial. It never spends an attempt. A second transient limit on the same trial in one
  invocation pauses the run (`rate-limit-repeat`), so a limit spell costs at most one extra
  cold reset per trial. Four in a row pause it (`rate-limit-pause`);
- a `PAUSE` file in the run directory pauses the run before the next attempt.

Simulated runs (`dry-run`) skip the spacing and the load gate.

### Watching it

Two files in `runs/<dir>/` are replaced atomically on every event and every 60 s, so a
watchdog can tell a hang from a long trial:

- `live-status.json` has the myco-gate arm's heartbeat shape: `pid`, `state`, `startedAt`,
  `updatedAt`, `lastLog` and `costBasis`;
- `progress.json` holds `status` (`running`, `complete`, `incomplete`, `paused`, `halted` or
  `aborted`), the stop `code`, `pid`, `updatedAt`, `total`, `decided`, `failed`, the `current`
  trial key and `lastFailure`.

`npx tsx scripts/m2-hcu-shell-run.ts status --out DIR` prints counts and the cost estimate. It
never prints a pass rate: ground truth is the grader's.

### Stops, and resuming

A halt is never retried. Every stop is final for that invocation and names its code in the
ledger (`ledger.jsonl`, fsync'd appends) and in `progress.json`. Fix the cause, then re-run
the same command with `--resume`. Decided trials are kept, exhausted trials stay closed, and
the other trials run again. A halt spends no attempt, so the trial it stopped re-runs on
resume. A resume under a different plan, or in a run directory of the other mode (simulated
or live), is refused.

The repeat-failure rule survives `--resume`. Each failure's signature (its code) is in the
ledger, and a resumed run starts from the last one, unless a decided trial came after it. A
resume that hits the same failure again aborts after that one attempt.

| Code | Exit | Meaning | What to do |
|---|---|---|---|
| `planner-auth` | 5 | The CLI reported an authentication fault (a lost or refused login). | Log in again (`/login`, subscription account), run the probe, then `--resume`. |
| `planner-billing` | 5 | Credit, billing or quota (`billing_error`, HTTP 402, "Credit balance is too low", "out of extra usage", "Payment required"). | Fix the subscription account. Do not switch to an API key. Then `--resume`. |
| `planner-usage-limit` | 7 | The subscription's own usage quota ("usage limit reached", "5-hour limit", "Weekly limit reached", "resets at ..."). No retry, no attempt spent. | **Report it to the lead.** Do not resume until the lead decides when the run continues. |
| `planner-api-key-path` | 5 | The CLI authenticated with an API credential (any message's `apiKeySource` is not `none`), for example from a settings file or an `apiKeyHelper`. | Remove that credential so that `claude` uses the subscription. The planner already runs with `--setting-sources ""`; check the host's managed settings. |
| `planner-auth-source-unknown` | 5 | The CLI did not report how it authenticated. | Fail-closed. A CLI upgrade that changed its init event needs a reviewed code change, not a workaround. |
| `planner-model-mismatch` | 5 | The CLI ran a model other than the plan's. | Check the CLI version and plan access. |
| `planner-fault-unknown` | 5 | A fault class this planner does not know. Every class halts unless it is on the explicit per-trial list. | Needs a reviewed code change. |
| `api-key-path-configured` | 3 | An API-path variable is set (refused before any call). | Unset it. Names are checked, values are never read. |
| `boot-class-not-cold` | 4 | A trial's reset was not a recorded cold boot (#546). | As in the eval runbook §3.5. Then `--resume`. |
| `rate-limit-repeat`, `rate-limit-pause`, `host-load-high`, `pause-file` | 4 | A pause (see Pacing). | Wait, or remove `PAUSE`, then `--resume`. |
| abort: `<code>` | 6 | Two failed attempts in a row with the same code (for example `reset-failed`, `agent-unreachable`, `hcu-unreachable`, `trial-timeout`, `planner-timeout`). | Diagnose the code, then `--resume`. |

## 3. What the rows are, and are not

- **Keyed to fc-v1** (#491). `armRowForTask` and `gradeRequestForTask` refuse a trial that did not
  run the published task: the fixture hash, the instruction hash and the intent must all match.
  The fixture placed in the guest is the published bundle file, checked against its hash.
- **Evidence is captured on the host by the harness.** After the agent stops, the harness reads
  the saved `.xlsx` from the guest at the path the harness created. The agent never names or
  supplies evidence. Before the agent runs, the harness reads the seeded document back and
  records its hash. Each captured document has a provenance record,
  `captures/<trialKey>.json`, with the fields of the myco-gate arm's `host-capture.json`
  (`guestPath`, `persistedSha256`, `seededSha256`, `resetBootClass`). The pack re-checks every
  row file, captured document and provenance record against the ledger before writing
  `arm.jsonl` and `requests.jsonl`.
- **Cost is a token-derived estimate at frozen rates, never billed USD.** The subscription bills
  nothing per token. A row whose calls were not all priced has `cost.modelUsd: null`, never 0
  (R7).
- **Fault classes are recorded, not injected**, as in the myco-gate pilot runner. Pairs match
  on the recorded fault class. Live fault injection for both arms is a follow-up.
- **The arm's internal judge is a cross-check only.** The benchmark verdict is TIF-267's grader
  over the captured bytes. R1's evidence rules are unchanged: R1 is computed for the myco-gate
  arm only, and the check reports `r1: null` for an hcu+shell-only pack.

## 4. Fairness: what matches the myco-gate arm and what does not

Compared with the myco-gate arm's live driver, #598 at head `13fccd96` (open, not merged when
this was written). `plannerDifferences` in the plan lists every remaining difference, so the
lead's GO approves them by naming the plan hash.

**The same in both arms:**

- the model (`claude-sonnet-5-5`, `PILOT_MODEL`), the tasks, fixtures and instruction text, the
  snapshot (`trial-base-v3`) and cold reset, #546's boot-class halt, the VM lock and the grader;
- the environment allowlist for `claude` and the settings-isolation flags: `--setting-sources ""`,
  `--strict-mcp-config` with no MCP server, `--tools ""` and `--permission-mode dontAsk`;
- the subscription only: the env-name preflight, plus a halt on any `apiKeySource` other than
  `none`, on any message and whatever the call's outcome;
- the fault classes and their stops: auth, billing (402 included) and the usage limit each halt
  with their own code, and only a transient limit backs off. The vocabulary is #598 round 2's,
  matched exactly in `src/baseline/hcu-shell-live/subscription-faults.ts`. A test compares
  the two directly once #598 merges;
- exit codes 5, 6 and 7, and the usage-limit report for the lead;
- pacing (`DEFAULT_PACING`): concurrency 1, 90 s between starts, an 1800 s trial deadline, the
  back-off, 3 attempts per trial re-run in place, and at most one transient re-run per trial;
- the repeat-failure rule, persisted in the ledger and restored on `--resume`;
- the `live-status.json` heartbeat every 60 s, and the `PAUSE` file;
- seed read-back before the agent runs, host-side capture, and host-capture provenance;
- real VM seams refuse to be built under a test runner; the launch is `vm-session.sh -- node --import tsx`.

**Differences that come from the arm's design:**

- One headless call per planner decision, where the gate arm makes one call per trial. The
  arm's loop owns the 30-step budget, which GUI actions and shell calls share.
- The screenshot is sent on stdin as stream-json (`--input-format stream-json
  --output-format stream-json --verbose`), and `--max-turns 1` is set.
- The per-call output ceiling is 1024 tokens (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`). This is C1's
  ceiling, and every hcu+shell row records it. The gate arm sets no ceiling.
- The hcu+shell prompt (C1's prompt plus the shell sentence) is the user message.
- The agent's tools are HCU's pixel `GUI` tool and the read-only shell; the gate arm's agent has
  Myco's gate tool. This is what the head-to-head compares. HCU's accessibility tool (`AX`) is
  not offered, so the arm stays the C1 pixel arm plus a shell. The library's other recorded
  asymmetries (read-only structured shell, three-result shell memory) are listed in
  `docs/research/m2-hcu-shell-arm.md`.

**Other remaining differences, and why they remain:**

- **The document format (material to R2; the lead decides).** This arm hash-checks the
  published fixture CSV on the host, converts it to `.xlsx` in the guest, opens it in Calc,
  and captures the `.xlsx`. The gate arm seeds and captures the raw CSV (`doc.csv`). The arm
  keeps `.xlsx` for three reasons:
  - fc-v1 declares `persistedFormat: "xlsx"`;
  - a GUI agent needs the document open in Calc;
  - the gate arm's CSV comes from its pilot gate's CSV-only path, which #598 lists as a
    follow-up to move to `.xlsx`.

  Before a paired R2, the lead's GO on this plan records the decision, or one arm changes in a
  reviewed PR.
- **The seed check.** The gate arm compares its read-back with the bytes it wrote. This arm
  cannot, because the `.xlsx` is made in the guest and the host never holds it. It requires the
  read-back to be non-empty and records its hash (`seededSha256`). The source CSV is checked
  against `fixtureSha256` on the host.
- **The repeat-failure signature.** It is the harness's failure code here, and class plus
  message in the gate arm. Both are persisted and restored on resume.
- **The load gate.** This arm waits before an attempt while the host load is 10 or more. The
  gate arm records the start load, and the M2 evidence rule refuses rows at 10 or more. The
  threshold is the same.
- **The reset call.** This arm passes `trial-base-v3` explicitly and kills a reset after 20 min.
  The gate arm uses the script's default and its trial deadline.
- **Formats.** The ledger, progress and host-capture schemas are this arm's own
  (`myco.hcu-shell.*`). `live-status.json` has the gate arm's shape with `runner: "hcu-shell"`.

Subscription load: a trial makes at most 31 planner calls, so a full run makes at most about
930 headless calls, one at a time, with trial starts at least 90 s apart.
