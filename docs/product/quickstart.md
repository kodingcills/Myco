# Quickstart — Myco from a clean clone

This page is written for a **fresh coding-agent session**: no prior context, no
Myco-specific setup, no account, no guest VM. Follow it top to bottom and you end
with a run directory whose verdict comes from persisted state, not from the
agent's claim.

Every command below was executed on a clean clone on the development host
(macOS, arm64, Node v24.4.1, pnpm 10.34.9) on 2026-11-23. The times are measured,
not estimated. Where the page stops, it says so and says why.

Measured total: **install to a `verified` report in about 3 s**, and the complete
page (mock runs, artifact re-check, tests) in **about 20 s**. Acceptance 1's
budget is 15 minutes.

---

## 0. What you need

- `git`, Node ≥ 24 (`package.json` `engines`), and pnpm 10.
- macOS or Linux for the mock path. Nothing else: no Docker, no VM, no network
  beyond the one `pnpm install`.

```sh
git clone <this repository> myco
cd myco
```

## 1. Install

```sh
pnpm install --frozen-lockfile
```

Measured: **~1 s** from a warm pnpm store. Add a couple of minutes on a cold
store with no network cache.

There is no build step for this path. The CLI runs from source through `tsx`,
which `pnpm install` already installed.

## 2. Run the demo task (the happy path)

```sh
pnpm myco-run --transport mock --task df-s01 --out /tmp/myco-out
```

Measured: **~1 s**, exit code **0**. You should see, in this order:

```
myco-run — df-s01: DF-S01 — clean saves verify
transport: MOCK (no guest, no kernel)

1. Claim (what the agent said)
   UI status line: "saved 4 item(s)"
   agent claim:    "All 4 items added and saved."

2. Observed persisted state (read from the store, not the screen)
   present  update the release notes
   present  write the incident summary
   present  verify database connection pool
   present  prepare deployment checklist

3. Verdict
   VERIFIED
   - all 4 items persisted
...
exit: 0
```

Those three sections are the whole point of the tool: the claim, the state read
back from the store, and the verdict. An agent's own report is never the verdict.

## 3. Run the task that refutes the agent (the point)

```sh
pnpm myco-run --transport mock --task df-s02 --out /tmp/myco-out
```

Exit code **0** (the run completed and produced a verdict — see §6 for why
`refuted` is not an error), and you should see:

```
2. Observed persisted state (read from the store, not the screen)
   MISSING  bug: login page crashes on save
   MISSING  BUG: token expires too early
   present  update the release notes
   present  write the incident summary

3. Verdict
   REFUTED
   - not persisted: bug: login page crashes on save, BUG: token expires too early

   FALSE SUCCESS: the UI claimed the save succeeded and the store disagrees.
```

The app is the dogfood `myco-todo`, seeded with a real bug: items whose text starts
with `BUG` appear in the list, are dropped at save, and the status line still says
`saved N item(s)`. The UI and the store disagree, and the verdict follows the store.

Add `--json` for one machine-readable object instead of the prose — same fields,
same exit codes, no TTY needed:

```sh
pnpm myco-run --transport mock --task df-s02 --out /tmp/myco-out --json
```

Measured: **~0.4 s**.

## 4. Read and re-check the artifacts

Each run writes `/tmp/myco-out/<task>/`:

| File | Contents |
|---|---|
| `trace.jsonl` | one JSON event per line: `run-start`, observations, actions, guard evaluations, the app's UI claim, the agent's claim |
| `result.json` | the record: task params, steps with pre/postconditions, the verdict with per-check scores, and `economics` |

Both are schema-validated **before** the CLI reports success. Re-check a
directory — or one you have hand-edited — without running anything:

```sh
pnpm myco-run --task df-s01 --out /tmp/myco-out --validate-only
```

```
ARTIFACTS: VALID
  task: df-s01
  dir: /tmp/myco-out/df-s01
  trace.jsonl lines: 27
```

Now corrupt it and watch the check refuse. (§4 uses its own directory so that a
corrupt df-s01 cannot be confused with the df-s02 run from §3.) Re-run §2's happy
path once with `--out /tmp/myco-out-corrupt`, then edit
`/tmp/myco-out-corrupt/df-s01/result.json`
and set `verdict.status` to `"probably-fine"` (any value other than `verified`,
`refuted` or `uncertain`), then re-run the same command:

```sh
pnpm myco-run --task df-s01 --out /tmp/myco-out-corrupt --validate-only
```

```
ARTIFACTS: INVALID
  task: df-s01
  dir: /tmp/myco-out-corrupt/df-s01
  trace.jsonl lines: 27
  result.json $: value matches none of the anyOf branches
  result.json $.verdict.status: "probably-fine" is not a verdict a reader can act on
```

Exit code **2**. A normal run whose artifacts were corrupted the same way also
exits 2 and reports `artifacts: INVALID`; the exit code and the validity line are
decided by the validator, not by the in-memory verdict, so the summary's verdict
line alone is never what a caller should trust.

The viewer reads the same two files: `pnpm --filter viewer build`, then open
`viewer/dist/index.html` and drop the run directory in (or a `.mycotrace` zip of
the two files). It shows the verdict, the score, the steps, and the check. Its
claim-vs-persisted table is populated for M1's Calc records; for this item-list
task it shows the check as `not recorded`, because the artifact carries the
verdict and the reason but not the persisted list. The terminal summary above is
the complete claim/state/verdict view for this task.

## 5. Prove the rest of the tree still holds (optional)

```sh
pnpm typecheck
pnpm exec vitest run
```

Measured: **~4 s** and **~12 s** (870 tests). Use the full run: `--changed HEAD`
finds nothing on a clean tree and exits 0 having run zero tests, which reads as a
pass. It is only useful mid-edit.

## 6. Exit codes

`myco-run` exists so a caller never has to parse prose:

| Exit | Meaning |
|---|---|
| `0` | the run completed and produced a verdict (`verified` **or** `refuted`), and its artifacts validate |
| `1` | the run aborted: the preflight or the live gate refused, so no verdict exists |
| `2` | a verdict exists but its artifacts failed validation |
| `3` | the command was called wrongly (unknown task, missing value) |

A `refuted` run exiting 0 is deliberate. `refuted` is a **successful proof**: the
agent claimed success and the persisted store disagreed. A caller that wants the
verdict reads `verdict.status` from `--json`; a CI job that wants "the agent was
wrong" greps that field, not the exit code.

## 7. Where the live path stops today

`--transport mock` drives a **contract double**, not a desktop. It exercises the
whole path — preflight, act sequence, store read, oracle, evidence, summary — and
its `result.json` says `"simulated": true` and
`economics.provenance: "mock"`, so a mock latency can never be quoted as a live
one. It is not evidence that a guest was driven.

The live path is the same command with `--transport live`, and it is **closed
today**. It refuses, in this order, unless:

1. `--gate-passed` is given — the Coordinator's GO for this host window, which is
   granted in conversation and recorded in `docs/coordination/`;
2. the shared host lock is free (`--host-lock`, default `$TMPDIR/myco-host.lock`);
3. `runtime/target/debug/myco-rt-mcp` exists (`cargo build -p myco-rt-mcp`);
4. no QEMU guest is already running;
5. the preflight passes every check.

Step 5 is where it stops. `RuntimeTransport.evidence()` reports eight checks and
today establishes six: the runtime answers, the guest is up, the app and the store
are readable. Two are **not established by any owner yet**:

- `oraclePresent` — the oracle is the runner's injected verifier, not something a
  file read can prove;
- `guestClean` — nothing on the host can distinguish "no stray app process" from
  "no read grant".

The transport reports both as `false` rather than assuming them, which is the
intended state: a preflight that guesses is worse than one that refuses. So
`--transport live --gate-passed` currently exits **2** at the preflight and writes
no run directory.

The two flags come first and are machine-independent. Without `--gate-passed` it
refuses before touching the host at all, with exit code **1** (§6):

```sh
pnpm myco-run --transport live --task df-s01 --out /tmp/myco-out
# myco-run: refusing the live path without the Coordinator's GO for this window.
```

Past that, which refusal you meet depends on the machine, so both are listed. This
is the one this host printed:

```sh
pnpm myco-run --transport live --task df-s01 --out /tmp/myco-out --gate-passed
# myco-run: live transport refused (guest already running)
# refusing: a qemu guest is already running, so this window is not ours
```

On a machine that has not built the runtime, the same command refuses earlier with
`myco-run: live transport refused (runtime binary absent: runtime/target/debug/myco-rt-mcp)`.
Either way the exit code is 2 and no run directory is written.

The detached launcher for the full S0 sequence (both tasks, one process, watchdog)
is `scripts/s0-live.sh --run`, gated the same way through
`MYCO_COORDINATOR_GO=1 MYCO_HOST_LOCK=1`.

---

## Appendix — the same flow from an ordinary agent environment

`myco-run` takes every input as a flag, never reads a TTY, prints one object under
`--json`, and returns the exit codes in §6. That is the whole contract a
non-interactive agent needs; `test/discovery/myco-run.test.ts` pins it.

**Codex** (non-interactive exec, no TTY):

```sh
pnpm --reporter=silent myco-run --transport mock --task df-s01 --out /tmp/myco-out --json \
  | tee /tmp/myco-out/df-s01.json
```

`--reporter=silent` matters: without it pnpm prints its `> @myco/core@0.1.0
myco-run` banner on stdout and the piped file is not JSON. The CLI itself prints
exactly one object; the wrapper is what would break it.

**Claude Code** (non-interactive print mode, JSON output):

```sh
pnpm myco-run --transport mock --task df-s02 --out /tmp/myco-out --json
```

Neither line has been executed *inside* those environments. They are the exact
commands this page's CLI contract implies, not a claim that Codex or Claude Code
was run: what was verified here is the invocation shape — flags only, no prompt,
one JSON object, explicit exit codes — from a plain non-TTY process.

## Time log

What I actually did on a fresh clone of this tree, in order, with measured wall
clock (2026-11-23, macOS arm64):

| Step | Command | Measured |
|---|---|---|
| clone (local, warm) | `git clone --local` | 1.2 s |
| install | `pnpm install --frozen-lockfile` | 1.0 s |
| happy path | `pnpm myco-run … --task df-s01` | 0.8 s |
| refutation | `pnpm myco-run … --task df-s02` | 0.3 s |
| re-check | `pnpm myco-run … --validate-only` | 0.3 s |
| typecheck | `pnpm typecheck` | ~1 s |
| tests | `pnpm exec vitest run` | ~12 s |
| **total** | | **~20 s** |

Things I had to guess, and what they cost:

- **`--out` is required.** The page says so; a first attempt without it exits 3
  with the usage text, which is a 1-line correction rather than a debugging
  session.
- **`refuted` exits 0.** A reader expecting "non-zero means the agent failed" will
  misread §3 for about ten seconds. §6 exists for that reason.
- **No build step is needed for the mock path.** Nothing in the tree's other docs
  says whether the CLI wants `pnpm build` first; it does not.
- **`pnpm install` prints an "Ignored build scripts: esbuild" warning.** It is
  harmless for this path (`tsx` bundles its own esbuild) and the page does not ask
  the reader to approve builds. If `pnpm` refuses to run without approval on a
  stricter machine, `pnpm approve-builds` is the fix — untested here.

## What this page does not claim

- The mock path is not live evidence. `MVD-001` acceptance 2 (a live DF-S02
  refutation with the missing items named from the guest store) and acceptance 6
  (a forced failure recovered or reported `uncertain`) need a live guest and are
  not exercised here.
- The live path has never produced a verdict from the CLI. Its gate is implemented
  and refuses correctly; it has not been opened.
- Model cost per run is recorded as `not-measured`, with the reason, because
  `myco-run` calls no model. Filling that field needs a run where a model drives
  the agent, which is a different measurement (acceptance 5's "model cost").
