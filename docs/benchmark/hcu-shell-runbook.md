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
| 3 | **HCU in the guest, inside the trial base.** Install Microsoft Hybrid Computer Use (`computer-use`, github.com/microsoft/Hybrid-Computer-Use, MIT, v1.0.1 or later, Windows build with its .NET 8 provider) in the snapshot both arms reset to. By default it is reached as `ssh myco-win11 'C:\myco\bin\computer-use.exe mcp'`. It must serve the **interactive** desktop (session 1). An SSH session runs in session 0, so a plain `computer-use mcp` over SSH cannot see the desktop. Use a relay into session 1, as C1 did for `cua-driver` (`C:\myco\bin\run-interactive.ps1` and a named pipe), and pass that command with `--hcu-command '<cmd>'`. Passing it changes the plan hash, so the lead's GO names the exact command. | On every trial, prepare probes HCU: MCP initialise, the `GUI` tool must be present, and one screenshot. If the probe fails, the driver precondition is not ready and the row is `uncertain` with the probe's code (for example `hcu-unreachable`). The run continues, but every such row is non-verified. Check the first rows. |
| 4 | **Guest basics already in the trial base.** Windows PowerShell 5.1, LibreOffice at `C:\Program Files\LibreOffice`, and `myco-agent` with `run-interactive.ps1`, as for the C1 and myco-gate runs. | Prepare fails with a code (`agent-unreachable`, `fixture-convert-failed`, `calc-uno-timeout`). Two identical failures in a row abort the run. |
| 5 | **The lead's GO.** A committed, unchanged `docs/benchmark/hcu-shell-go.json`: `{"schema":"myco.hcu-shell.lead-go/1","arm":"hcu+shell","planSha256":"<the printed hash>","ruling":"<who and when>"}`. The repo does not contain it until the lead gives it. | `launch` refuses with `lead-go-missing`, `lead-go-invalid`, `lead-go-plan-mismatch` or `lead-go-uncommitted`. |
| 6 | **The VM lock.** Run under `scripts/vm-session.sh -- ...` (TIF-210), so nothing else drives the VM during the run. | `launch` refuses with `vm-lock-not-held` otherwise. |

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
npx tsx scripts/m2-hcu-shell-run.ts probe-planner --call-claude

# 3. The run, under the VM session lock.
scripts/vm-session.sh -- npx tsx scripts/m2-hcu-shell-run.ts launch --out runs/hcu-shell-r2 \
  --launch-real-trials --plan-sha256 <hash from step 1> [--hcu-command '<cmd>']

# 4. Ground truth, only from the independent grader.
npx tsx scripts/benchmark-grade.ts runs/hcu-shell-r2/requests.jsonl > runs/hcu-shell-r2/grades.jsonl
npx tsx scripts/benchmark-check.ts --arm runs/hcu-shell-r2/arm.jsonl \
  --grades runs/hcu-shell-r2/grades.jsonl --expect hcu+shell=30 --evidence
```

`launch` prints the plan, then lists every unmet precondition and exits 3. It starts nothing
until all of them hold.

Exit codes: 0 complete, 1 failed, 2 usage, 3 refused, 4 halted, aborted or incomplete.

### Watching it

`runs/<dir>/progress.json` is replaced atomically on every event, so a watchdog can poll it
safely. It holds `status` (`running`, `complete`, `incomplete`, `halted` or `aborted`), the
stop `code`, `pid`, `updatedAt`, `total`, `decided`, `failed`, the `current` trial key and
`lastFailure`. `npx tsx scripts/m2-hcu-shell-run.ts status --out DIR` prints counts and the
cost estimate. It never prints a pass rate: ground truth is the grader's.

### Stops, and resuming

Nothing retries automatically. Every stop is final for that invocation and names its code in
the ledger (`ledger.jsonl`, fsync'd appends) and in `progress.json`. Fix the cause, then re-run
the same command with `--resume`. Decided trials are kept. Failed and unfinished trials run
again. A resume under a different plan, or in a run directory of the other mode
(simulated or live), is refused.

| Code | Meaning | What to do |
|---|---|---|
| `planner-auth` | The CLI reported an authentication fault (a lost or refused login). | Log in again (`/login`, subscription account), run the probe, then `--resume`. |
| `planner-quota` | Credit, billing, quota or a subscription usage limit. | Wait for the limit to reset (the message names when), then `--resume`. Do not switch to an API key. |
| `planner-api-key-path` | The CLI authenticated with an API credential, for example from a settings file or an `apiKeyHelper`. | Remove that credential so that `claude` uses the subscription. The planner already runs with `--setting-sources ""`; check the host's managed settings. |
| `planner-auth-source-unknown` | The CLI did not report how it authenticated. | Fail-closed. A CLI upgrade that changed its init event needs a reviewed code change, not a workaround. |
| `planner-model-mismatch` | The CLI ran a model other than the plan's. | Check the CLI version and plan access. |
| `api-key-path-configured` | An API-path variable is set (refused before any call). | Unset it. Names are checked, values are never read. |
| `boot-class-not-cold` | A trial's reset was not a recorded cold boot (#546). | As in the eval runbook §3.5. Then `--resume`. |
| abort: `<code>` | Two failed trials in a row with the same failure code (for example `reset-failed`, `agent-unreachable`, `planner-timeout`). | Diagnose the code, then `--resume`. |

## 3. What the rows are, and are not

- **Keyed to fc-v1** (#491). `armRowForTask` and `gradeRequestForTask` refuse a trial that did not
  run the published task: the fixture hash, the instruction hash and the intent must all match.
  The fixture placed in the guest is the published bundle file, checked against its hash.
- **Evidence is captured on the host by the harness.** After the agent stops, the harness reads
  the saved `.xlsx` from the guest at the path the harness created. The agent never names or
  supplies evidence. The pack re-checks every row file and captured document against the
  ledger before writing `arm.jsonl` and `requests.jsonl`.
- **Cost is a token-derived estimate at frozen rates, never billed USD.** The subscription bills
  nothing per token. A row whose calls were not all priced has `cost.modelUsd: null`, never 0
  (R7).
- **Fault classes are recorded, not injected**, as in the myco-gate pilot runner. Pairs match
  on the recorded fault class. Live fault injection for both arms is a follow-up.
- **The arm's internal judge is a cross-check only.** The benchmark verdict is TIF-267's grader
  over the captured bytes. R1's evidence rules are unchanged: R1 is computed for the myco-gate
  arm only, and the check reports `r1: null` for an hcu+shell-only pack.

## 4. Fairness: what matches the myco-gate arm and what does not

The two arms use the same model (`claude-sonnet-5-5`, `PILOT_MODEL`), the same tasks, fixtures
and instruction text, the same snapshot and cold reset, the same VM lock, the same grader, and
the same environment allowlist for `claude`. The planner also uses the gate arm's
settings-isolation flags: `--setting-sources ""`, `--strict-mcp-config` with no MCP server,
`--tools ""` and `--permission-mode dontAsk`.

These differences cannot be avoided, because they come from the arm's design. The plan
(`plannerDifferences`) records them:

- One headless call per planner decision, where the gate arm makes one call per trial. The
  arm's loop owns the 30-step budget, which GUI actions and shell calls share.
- The screenshot is sent on stdin as stream-json (`--input-format stream-json
  --output-format stream-json --verbose`), and `--max-turns 1` is set.
- The per-call output ceiling is 1024 tokens (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`). This is C1's
  ceiling, and every hcu+shell row records it. The gate arm sets no ceiling.
- The hcu+shell prompt (C1's prompt plus the shell sentence) is the user message.
- The GUI layer is HCU's pixel `GUI` tool. HCU's accessibility tool (`AX`) is not offered, so
  the arm stays the C1 pixel arm plus a shell. The library's other recorded asymmetries
  (read-only structured shell, three-result shell memory) are listed in
  `docs/research/m2-hcu-shell-arm.md`.

Subscription load: a trial makes at most 31 planner calls, so a full run makes at most about
930 headless calls, one at a time.
