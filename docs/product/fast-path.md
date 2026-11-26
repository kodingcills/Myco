# Fastest reliable action path (capability track J)

**Status: built and tested offline on the Linux path; not measured.** Nothing here has been
run against a model, and no result is claimed. Measurement waits for the integrity fixes
(#518's attempt ledger, the xlsx replacement for #503, the #494 tests-only follow-up) and
the lead's GO, and runs on Claude Ultra only.

**Why (Tiffany, 2026-11-26 10:29 and 10:41 ET):** Myco must ADD capabilities to desktop
agents, not only check them. Track J: "App APIs, scripts or shell when available, GUI as
fallback, with routing logged." The bar: lower time and steps per verified task with no drop
in verified rate.

Capability spec: `docs/product/capability-spec.md`, section J (PR #525, in flight). If that
spec lands with different wording, its text wins; §5 below is this track's proposal for it.

---

## 1. What it does

The agent asks for an **action**; Myco picks the **route**.

| Action (`src/actions/router.ts`) | Routes, in the order tried | Notes |
|---|---|---|
| `calc.set-cell {cell, value, save?}` | `api` (UNO cell API + store), then `gui` (Calc's input path) | No allowed shell program edits a workbook cell, so there is no script route. |
| `doc.export-csv {}` | `script` (`soffice --headless --convert-to csv` into scratch) | How the agent reads cells without the GUI. |
| `shell.run {command}` | `script` | The agent's command text, parsed by the policy (default deny). |

Route preference is fixed: **app API > script/shell > GUI** (`ROUTE_PREFERENCE`). For each
action the router takes the routes the action supports (`ROUTE_TABLE`) that are available on
this host (probed once, when the router is built), in that order. The first one runs. If it
fails, the next one runs: that is a **fallback**. If the policy denies a route, the action
stops there (§3).

Every action leaves one `RouteDecision` in the run record (`myco.fast-path-run/1`):

```json
{
  "seq": 2,
  "kind": "calc.set-cell",
  "candidates": ["api", "gui"],
  "route": "gui",
  "reason": "fallback-after-failure",
  "fallbackFrom": "api",
  "attempts": [
    { "route": "api", "outcome": "failed", "code": "ROUTE_FAILED", "ms": 412 },
    { "route": "gui", "outcome": "ok", "code": "OK", "ms": 1530 }
  ],
  "code": "OK",
  "ms": 1942
}
```

`reason` is one of `preferred-route`, `first-available-route` (a more preferred route was
unavailable on this host), `fallback-after-failure`, `policy-denied`, `all-routes-failed`,
`no-route-available`, `bad-request`. The run record also keeps the availability probe, the
policy id, a per-route count, fallbacks, denials and the wall time.

### Linux path routes (`src/actions/linux-routes.ts`)

- **`api`**: `scripts/linux/calc_uno_api.py` opens the document in a headless soffice with
  a throwaway profile, sets the cell through the UNO object model and stores it. It applies
  Calc's own number recognition through the document's number formatter, so a currency,
  date or integer lands as the same cell a typed entry produces (checked for all four fc-v1
  column types by the end-to-end test). A value Calc could read as a formula is refused
  before any route runs.
- **`script`**: one argv, run with `shell: false`, working directory the trial workspace,
  environment `PATH`, `LANG` and a throwaway `HOME` outside the workspace.
- **`gui`**: the existing Linux actuator (`src/linux/actuator.ts`), which types through
  Calc's input path. On the Windows path this is the HCU GUI channel (§6).

## 2. What it does not do

- **It never decides completion.** An `ActResult` has `ok`, `code`, `route` and, for reads,
  bounded `output`. It has no verdict field. Completion is the gate's decision from the
  bytes the harness captures after the agent stopped, and the independent grader grades
  those bytes. A route that reports success on an unsaved edit is refuted by the gate and
  graded `fail` (end-to-end test, `no-save` case).
- **It never touches the gate.** `myco.gate/v1` is unchanged: still `taskId`, `runId`,
  `claim`. The router's code imports nothing from `src/gate/`, `src/benchmark/`,
  `src/tasks/` or the Linux oracle (`test/actions/import-boundary.test.ts`).
- **It is not a way around the capture.** The harness reads the document after the agent
  stops, exactly as for every other arm.

## 3. Security model

The router must not widen what the agent may touch. Four layers:

1. **Typed actions name no path.** `calc.set-cell` and `doc.export-csv` always act on the
   trial's own document, which the harness fixes when it builds the router. Only
   `shell.run` takes agent text.
2. **Every route goes through the policy** (`ActionPolicy`, `src/actions/policy.ts`), the
   seam to track O's policy layer (lands with O). Before a route runs, its paths read,
   paths written, and argv or raw command go to `check`. The route then acts on the
   policy's resolved paths and argv, never on its own spelling.
3. **A denial never falls back.** The policy judges the target, not the route: if the API
   route may not touch a path, the GUI route may not either. Only an execution failure
   moves to the next route.
4. **The launch is pinned to the trial** (`auditFastPathLaunch`, `src/actions/arm.ts`). The
   agent reaches the router through one MCP server, `myco-cap`, with two tools, `act` and
   `act_script`. The integrity launch audit (`src/integrity/launch.ts`, unchanged) fails
   closed on an unclassified server. `myco-cap` is classified as trial-confined only when
   its environment is exactly `MYCO_CAP_RUN_ID = <runId>` and
   `MYCO_CAP_WORKSPACE = <this trial's absolute, normalised workspace>`. Anything else
   (another run, another trial's workspace, a parent directory, `/`, a relative path, an
   extra variable) classifies both tools as `host-fs`, and the audit refuses the launch.

The local policy (`workspacePolicy`) is narrower than O is expected to be:

| Rule | Enforcement |
|---|---|
| Paths stay in the trial's workspace | Each path is resolved through symlinks the way the kernel resolves it (`realpath(3)` on the spelling as given, or its parent's for a new file; no lexical `..` collapsing first, so `link-to-dir/..` is the link target's parent) and must lie under the workspace's resolved root. `..`, absolute host paths, another trial's workspace, symlinks out and a `..` after a symlinked directory are `PATH_OUTSIDE_WORKSPACE`. Every program then runs on the resolved operands the policy checked, never the agent's spelling, passed relative to the resolved root (`./<path>`), which is the route's working directory: the kernel opens exactly the scoped file, and a program that echoes its operands (`wc`, `sha256sum`, multi-file `head`, multi-operand `ls`) never prints the workspace's host path. |
| Hard links are refused | A regular file with more than one hard link is `PATH_OUTSIDE_WORKSPACE`: `realpath` cannot see where its other names live. |
| Writes are narrower | Only the trial document and the scratch directory (`WRITE_NOT_ALLOWED` otherwise). soffice never writes into the approved `--outdir` itself: the route converts into a fresh directory it creates there (`mkdtemp`), so the export, soffice's lock file and its temp files are created where nothing can have been planted, then moves the regular-file result into place with `rename(2)`, which replaces a symlink planted at `<outdir>/<doc>.csv` and never writes through it. |
| Shell text that cannot be parsed safely is denied | No shell interpreter. A strict reader accepts bare words and `'…'`/`"…"` words without escapes; any of `` | ; & $ ` < > ( ) { } [ ] * ? ~ ! # \ % ^ ``, a control character (newline included), an unterminated or glued quote, or an oversized command is `UNPARSEABLE_COMMAND`. Nothing is sanitised. |
| Only listed programs | `ls`, `cat`, `head`, `wc`, `sha256sum` with listed flags, and exactly `soffice --headless --convert-to csv --outdir <scratch…> <the trial document>`. An operand that starts with `-` is a flag and must be listed (so `--accept=…` is `OPERAND_SHAPE`); the soffice source must resolve to the trial document itself, and soffice runs with the resolved absolute paths, never the agent's spelling (soffice prints nothing that comes back: a `shell.run` conversion returns only `converted`). No interpreter, no `sh -c`, no `cp`/`ln`/`rm`, no absolute program paths (`PROGRAM_NOT_ALLOWED`, `FLAG_NOT_ALLOWED`, `OPERAND_SHAPE`). |
| The argv decides | For the script route, the paths the argv names are what is checked, whatever else the request lists. |
| Codes only | The agent sees codes (`PATH_OUTSIDE_WORKSPACE`, …), never resolved paths or the layout. Only stdout comes back, bounded to 4,096 characters; stderr never does. Output that contains the workspace's host path (resolved or as given) is not returned at all: the route fails with `ROUTE_OUTPUT_LEAK`. |

Known limits, stated rather than hidden:

- **Time of check to time of use.** Paths are resolved at check time. The agent has no tool
  that creates links or moves files (no write program is allowed, and typed actions name no
  path), so it cannot swap a path between check and use. A guest-side router on Windows
  must re-check resolved paths after the call, as `hcu+shell` does
  (`checkResolvedAccesses`).
- **`ls -l` shows a symlink's target string.** A symlink planted in the workspace before
  the trial (the agent cannot create one) is listed with its target path by `ls -l`. That
  leaks a host path string, not access: reading through the link is still
  `PATH_OUTSIDE_WORKSPACE`.
- **soffice profile.** The API and GUI routes start soffice with a throwaway profile in the
  system temp directory. It is harness-owned, outside the workspace, and removed after the
  call; the agent cannot address it.
- **On the Linux path the trial workspace is the sandbox.** There is no guest. A route runs
  as the harness's user, confined by the policy, not by a VM. On Windows the routes belong in
  the guest (§6).

Every guard has a test that fails when the guard is removed (§7).

## 4. The fast-path arm

`FAST_PATH_ARM_SPEC` (`src/actions/arm.ts`): id `fast-path`, the capability spec's
`hcu+shell+J`. It pairs with the two baseline arms, `hcu+shell` and `screenshot-only` (C1).
**What is built here is the cap-only surface, not yet `hcu+shell+J`.** `fastPathLaunchPlan`
launches Claude Code with `--tools ""` (no built-in tool, so no host shell) and exactly two
tools, `mcp__myco-cap__act` and `mcp__myco-cap__act_script`. On the Linux path that is the
whole arm: `act` reaches the GUI route (the Linux actuator, standing in for HCU) as a
fallback, and `act_script` is the policy-confined shell. The launch audit is tested on this
plan only.

The spec's `hcu+shell+J`, the paired baseline's surface plus the two `myco-cap` tools with
nothing else changed (task, instruction, model, step budget, output ceiling), needs the
HCU channel and the guest-side router (§6). It is not built or audited here, and the bar's
primary comparison (§5) cannot run until it is: that combined plan, and its launch audit,
are a blocker on measurement (`FAST_PATH_ARM_SPEC.blocker`; TO FILE).

Rows (`myco.capability.fast-path-row/1`) carry the route log without action payloads (no
agent text, no paths), steps, wall time, the gate verdict and the grade, `verified` (a done
claim graded `pass`, nothing less), `simulated` (true when the planner is not a model id)
and `evidence: false` as a literal. They are never R1 evidence:

- the arm is not `myco-gate`, and `myco.benchmark.arm-row/1` admits only `myco-gate` and
  `hcu+shell`, so `checkBenchmark` refuses a fast-path row outright (tested);
- `fastPathRowProblems` refuses a row that claims `evidence`, or `verified` without a done
  claim graded `pass`;
- R1 rules (`src/benchmark/taskset-binding.ts`, `src/m2/evidence.ts`) are unchanged.

The gated harness's own launch audit (`runGatedTrial`) still refuses a plan that includes
`myco-cap`, because the gate only classifies its own server. That is deliberate: a gated
run with the cap server needs its own reviewed change (TO FILE). The arm as the spec defines
it does not call the gate (spec §1.3, "gate presence is the same in both arms").

## 5. Proposed pre-registered bar (for the capability spec to adopt)

To be frozen, per spec §3, in `docs/product/capability-prereg/J-v1/prereg.json` before the
first run. Nothing below has been run.

**Arms.** Primary: `fast-path` (`hcu+shell+J`) against `hcu+shell`. Secondary, reported and
not part of the bar: `fast-path` against `screenshot-only` (C1). Same harness (Claude Code on
Claude Ultra), same model id, same task text, step budget 30, output ceiling 1,024, retry
budget 0, gate absent in both arms. Seeded, interleaved ABBA assignment per task.

**Task set.** fc-v1, the 90 satisfiable tasks; the 10 invalid-target tasks run as a guardrail.

**Graded by the independent grader** (`src/benchmark/grade/`, `false-completion-grader/1`)
on the persisted bytes the harness captures after the agent stops. A verified task is a done
claim graded `pass`.

**Metrics.**

- *Verified rate*: verified tasks / trials.
- *Wall time per verified task*: the sum over ALL trials of agent wall time (agent launch to
  agent stop, harness clock; reset, capture and grading excluded) / verified tasks.
- *Steps per verified task*: the sum over ALL trials of agent tool calls (each `act`,
  `act_script`, GUI action or shell call is one step) / verified tasks.
- Reported, not in the bar: route mix, fallbacks per trial, denials per trial, cost per
  verified task (token-derived ESTIMATE over all trials, null never 0, never billed USD),
  false done.

**Bar, tested in a fixed sequence at one-sided alpha 0.05** (a later step is tested only if
every earlier one is shown):

1. **No drop in verified rate (non-inferiority).** The one-sided 95% upper bound of
   (`hcu+shell` rate − `fast-path` rate), Newcombe's paired score interval over tasks, is
   below 5 percentage points.
2. **Lower wall time per verified task.** Paired bootstrap over tasks (10,000 resamples,
   pre-registered seed): the one-sided 95% upper bound of `fast-path`/`hcu+shell` is below
   1.0.
3. **Fewer steps per verified task.** The same bootstrap: the upper bound of the ratio is
   below 1.0.

**Guardrails** (any breach and the bar is "not shown"):

- Every action has a route record; a trial with an action missing one is a harness fault,
  counted, never excluded.
- Zero route accesses outside the trial workspace (the policy's denials are logged; any
  allowed access that resolves outside it voids the trial as `uncertain`).
- False DONE on the 10 invalid-target tasks is no higher in `fast-path` than in `hcu+shell`.
- The launch audit passes for every `fast-path` trial with `capPinned: true`.

**Sample size.** n = 90 paired tasks, k = 1 run per task per arm. The non-inferiority step is
the binding one. With no true difference, its upper bound is about 1.645 · √(p_d / n), where
p_d is the share of tasks whose outcome differs between the arms. It stays below 5 points only
while p_d < n · (0.05 / 1.645)² ≈ 0.083 at n = 90. If more than about 8% of tasks are
discordant, step 1 is "not shown" even with equal rates. **Proposal:** k = 2 runs per task
per arm (180 paired trials, bootstrapped by task), which allows p_d up to about 0.166. If
the lead keeps k = 1, the result must be reported as "underpowered at n = 90" whenever
p_d ≥ 0.083. This answers spec §6's open question about the 5-point margin at n = 90.

**Rows are experiment rows, never R1 evidence** (spec §3.4). Simulated rows (scripted
agents, like the end-to-end test's) never count.

## 6. Out of this PR (VM, single owner)

The Windows Calc tasks need the routes inside the guest: UNO through the guest agent's
`uno_eval` (read-only today) widened to a scoped write, and the GUI fallback through the HCU
channel. That is VM work under the VM lock (`scripts/vm-session.sh`) and is filed as a
queued local, single-owner task, not done here.

## 7. Tests

| Test | What it proves |
|---|---|
| `test/actions/router.test.ts` | Routing table and preference; first-available when the API is down; fallback on failure and timeout; denial stops without fallback; resolved paths and argv reach the route; bad requests never run; results carry no verdict; determinism. |
| `test/actions/policy.test.ts` | Default-deny parser (each metacharacter, quotes, size); program and flag allowlist; scoping through `..`, absolute paths, file and directory symlinks; write narrowing; malformed requests. |
| `test/actions/scoping.test.ts` | The real script route with planted markers in another trial and the host: no hostile command runs, every marker is byte- and mtime-identical, no marker's contents appear in results or the run record. |
| `test/actions/arm.test.ts` | Launch audit passes only when pinned to this trial; rows are refused by the benchmark schema and check; `verified` needs a done claim graded `pass`. |
| `test/actions/import-boundary.test.ts` | No route code reaches the gate, the grader or ground truth. |
| `test/linux/fast-path-e2e.test.ts` | Real Calc, $0: the API route on all four column types, then the real gate (sealed vault) and the grader; API failure falls back to the GUI; an unsaved edit that the route reports as done is refuted and graded `fail`; hostile commands are denied with markers untouched; the gated harness refuses the cap server. Runs in the `linux path` CI job; skips cleanly without LibreOffice. |

Run them:

```sh
pnpm exec vitest run test/actions
MYCO_LINUX_PATH=1 pnpm exec vitest run test/linux/fast-path-e2e.test.ts
```
