# Myco

Make existing desktop software reliably executable by AI agents: **verified operations, recoverable execution, reusable procedural knowledge.**

Agents can already touch desktop software. The unsolved problem is *trust* — knowing whether a click actually changed the application, and being able to undo it when it did not. Myco's answer is to treat the desktop as a program: read authoritative app state, drive it through guarded steps, and decide success **only** from persisted state that the agent cannot write.

**Where this is going:** Myco is solving desktop use for agents broadly: letting AI agents operate real desktop software reliably, recoverably and at scale. Verified completion, the gate that checks whether a task really persisted, is the first proven piece, not the whole product. See the roadmap in [docs/product/vision.md](docs/product/vision.md).

**Milestone 1 status:** verified, recoverable `calc-record-edit` execution on real LibreOffice Calc in Windows 11 ARM64. See [docs/m1-scorecard.md](docs/m1-scorecard.md) for the acceptance criteria and their current evidence — that file is the record, not this page.

---

## M1 results

M1 was signed off on 2026-11-25 ([#444](https://github.com/kodingcills/Myco/pull/444)). All 8
acceptance rows are DONE; row 8 (reproducibility) is DONE **given the VM bundle**, because the ISO,
payloads and `clean-base` snapshots live outside the repo. The numbers below are taken from
[docs/m1-scorecard.md](docs/m1-scorecard.md), which is the record:

| Row | Result |
|---|---|
| 3. Reliability | 29/30 verified |
| 4. Failure detection | 0 false successes |
| 7. Baseline | Myco 29/30 verified vs the screenshot baseline 0/30, on the same 30 tasks paired by index; p = 3.73e-9 |
| 8. Reproducibility | a fresh operator's sweep: 28/30 verified; the corrupted suite: 18/18 recorded and eligible, 0 false successes |

Recompute every number from committed artifacts, with no VM:

```sh
python3 scripts/scorecard-check.py
```

---

## What runs today

| Surface | What it does | Needs a VM? |
|---|---|---|
| **Core runtime** (`src/core/`) | Typed state model, guarded action programs, independent verifier, trace and evidence schema, eval harness with fault injection | No |
| **Fake app** (`src/fake/`) | In-memory spreadsheet with scripted failure modes (crash, stale refs, delayed saves, focus steal) | No |
| **Runtime** (`runtime/`, Rust) | Guest agent, MCP stdio server, process control, file grants, VM backend | Partly |
| **Guest agent** (`agent/`, Python) | Runs inside the Windows guest in the interactive session; token-authenticated NDJSON over loopback | Needs VM to run; tests are host-side |
| **Foundry** (`foundry/`, `src/foundry/`) | Independent grading oracle, blind scoring, hidden-commitment fixtures | No |
| **Baselines** (`src/baseline/`, `scripts/c1-*.ts`) | Screenshot-agent arm (`c1`) on the same tasks and fixtures | Needs VM |
| **Viewer** (`viewer/`) | Static UI over recorded runs and evidence | No |
| **Dogfood** (`dogfood/`) | `myco-todo`, a small app with a seeded persistence bug, for end-to-end checks | Partly |

Core invariant: **`ActResult` never claims goal success, and the runner never decides task success.** Only the verifier, reading persisted state, produces a `verified` verdict — and the eval harness independently recomputes ground truth to catch a verifier that rubber-stamps.

---

## Quickstart: one command

After `pnpm install --frozen-lockfile` (see [Setup](#setup)), from the project you want your
agents to use the gate in:

```sh
/path/to/Myco/bin/myco init --dry-run   # every check and every planned change; writes nothing
/path/to/Myco/bin/myco init             # checks, then writes ./.mcp.json and ./.codex/config.toml
```

`myco init` checks the Linux desktop path (headless LibreOffice Calc and Python-UNO, or says
exactly what to install), starts the gate once with the launch line it is about to write and
checks it answers and fails closed, then adds the `myco-gate` MCP server for Claude Code
(`./.mcp.json`) and Codex (`./.codex/config.toml`). It changes only that entry (one splice; every
other byte is kept, and a file it cannot merge into valid JSON/TOML is left alone), backs up
any file it changes, and a second run changes nothing. It never reads or writes `~/.claude`,
`~/.claude.json` or `~/.codex` unless you pass `--global`: it refuses to run with your home
directory as the project and never follows a symlink or hard link out of the project. With
`--global` it only prints the exact diff until you add `--yes`. No config it writes carries a
key or token. It does not touch the Windows VM path. `--tasks <file>` registers an operator
task (for example a `calc-record-edit` task for the Linux Calc path); CI's `linux path` job
runs init end to end: real headless Calc edits the file under the configured evidence root,
and a scripted MCP client gets `verified` / `refuted` through the written config. Details:
[docs/product/setup.md](docs/product/setup.md).

---

## Setup

Prerequisites: Node ≥ 24 (`engines` in `package.json`) and pnpm 10 on your `PATH`; the repo does
not install pnpm for you. **This is a pnpm workspace, and `npm install` does not install it
correctly** — use `pnpm`. The `python3 scripts/…` checks below also need Python 3 (standard library
only; checked on 3.11, 3.12 and 3.13). An older Node only warns `Unsupported engine` at install; it
does not stop the install, so check `node -v` yourself.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

All five exit 0. Every command on this page was re-run, in order, on a fresh `git clone` of `a7d2cd2`
on 2026-11-25 (macOS arm64, Node 24.4.1, pnpm 10.34.9): install ~1 s from a warm pnpm store,
`typecheck` ~4 s, `lint` ~2 s, `test` ~47 s (1,128 tests), `build` ~1 s. `pnpm install` warns
`Ignored build scripts: esbuild`; nothing on this page needs it approved.
`pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test` is the CI path.

Run the suite with `pnpm test`, not a bare `pnpm exec vitest run`. `pnpm test` runs
`test/discovery/s0-live-launcher.test.ts` on its own, in one forked process, because that file
spawns and signals real processes; it also runs `pnpm schema-validate`. The launcher's lock test
used to flake when the bare run put it in parallel with everything else. #454 (TIF-233) fixed the
cause, and 3 of 3 bare runs passed after that fix on 2026-11-25, so the isolation is now kept as a
precaution.

Run `pnpm test` as a **non-root user**, in an environment whose PID 1 reaps orphaned processes. In a
container, that means a non-root user and `docker run --init` (or an equivalent init). Otherwise
`pnpm test` exits 1 for reasons that have nothing to do with the repo:

- As root, 2 tests in `test/deploy-copy-retry.test.ts` fail (the `MYCO_TOKEN_OUT` "unwritable"
  cases), because root can write to a `chmod 0500` directory or a `0400` file.
- Under a PID 1 that does not reap orphans promptly, the `--stop` test in
  `test/discovery/s0-live-launcher.test.ts` fails with `expected true to be false`. The child it
  stopped is left as a zombie, and `kill -0` still succeeds on a zombie.

Both were seen on a Linux cloud container on 2026-11-25. Run as a non-root user under a reaping
init, `pnpm test` exited 0.

> **`npm install` exits 0 and leaves the repo broken.** npm does not understand the `viewer/`
> workspace, so it installs the root package, leaves `viewer/node_modules` **empty**, and reports
> success. Captured on a clean worktree of `cb805ae5` with no pre-existing `node_modules`:
>
> | command | under `npm install` | under `pnpm install --frozen-lockfile` |
> |---|---|---|
> | `npm install` | exit **0** — and `viewer/node_modules` is empty | — |
> | `pnpm install --frozen-lockfile` | — | exit 0 |
> | `typecheck` | exit **2** — 36 × `TS2307: Cannot find module '@base-ui/react/…'` | exit 0 |
> | `lint` | exit **1** — `ERR_MODULE_NOT_FOUND: Cannot find package 'tailwindcss'` | exit 0 |
> | `test` | exit **1** — `4 failed / 77 passed / 1 skipped` | exit 0 |
> | `build` | exit 0 | exit 0 |
>
> **Three gates fail, not all four — `build` genuinely passes**, because it compiles the root
> package and never touches the viewer. The three failures do not fail the same way: `typecheck`
> fails in TypeScript, `lint` fails earlier at Node module resolution, and `test` fails because the
> root `test` script ends in `pnpm schema-validate`, which also needs the viewer's packages.
>
> **So `TS2307` alone is not the signal.** If *any* gate fails after an `npm install`, with a
> missing-module error of any kind, run `pnpm install --frozen-lockfile` before diagnosing anything
> else — the install is the likely cause, not your change.

### Run something

```sh
# The M1 task family, against the fake app — no VM, no network.
pnpm test:task
```

`test:task` **exits 1 on purpose.** It runs the `todo-save` trap: the UI claims `"saved 7 item(s)"` while two `BUG:`-prefixed items never reach the store. That is the false-success case Myco exists to catch, so a non-zero exit is the pass condition — the output prints `Final Verdict: REFUTED` and `False Success Caught: YES`. A `0` here would mean the harness missed it. **Observed 2026-11-25: exit 1, with both those lines.**

```sh
# A full mock run with evidence, then re-check what it wrote without re-running.
pnpm myco-run --transport mock --task df-s01 --out /tmp/myco-run
pnpm myco-run --task df-s01 --out /tmp/myco-run --validate-only
```

Both exit 0. The run prints the claim, the persisted state read back from the store, and `VERIFIED`; with `--task df-s02` it prints `REFUTED`, names the two dropped items, and **still exits 0**, because a refutation is a verdict, not an error. The run's `result.json` and every trace line are validated against the schema, so **a tampered run exits 2**: edit `verdict.status` in `/tmp/myco-run/df-s01/result.json` to any other string and `--validate-only` prints `ARTIFACTS: INVALID` and exits 2. Exit codes and the full walkthrough are in [docs/product/quickstart.md](docs/product/quickstart.md) §4–§6.

The live path — a real guest, real Calc — is documented in [docs/product/quickstart.md](docs/product/quickstart.md), which states exactly where it stops and why. **It requires a Windows VM and is not runnable on a bare checkout.**

On Linux, [docs/product/linux-path.md](docs/product/linux-path.md) runs the verify loop against a real headless LibreOffice Calc with no VM and no model: `pnpm myco-linux --demo` shows an agent that says it saved, a saved file that disagrees, and `REFUTED`.

---

## Reproduce M1

[docs/eval-runbook.md](docs/eval-runbook.md) is the procedure: from a clean snapshot to a full report, with every command checked against the repo. Read [§10](docs/eval-runbook.md#10-what-is-not-reproducible-from-scratch) first — it lists precisely what a fresh operator **cannot** improvise, including that `build-all.sh` has never run end to end and that the ISO, offline payload and `clean-base` snapshots live outside the repo.

Retained evidence is committed so a number can be re-checked without a VM:

```sh
# Reproduce the M1-013 reliability row (expects 29/30 verified) — no VM.
python3 scripts/m1-scorecard.py docs/research/experiments/m1-013-sweep-v3/trials.jsonl
```

That is the check that matters: the claim in the scorecard can be regenerated from committed data in one command. **Observed 2026-11-25: exit 0, `29/30 verified, MEETS NUMERIC THRESHOLD`, Wilson 95% 0.83–0.99 — the scorecard's headline number, regenerated from the committed `trials.jsonl` with no VM.**

The rest of the scorecard is held the same way:

```sh
# Recompute every number in docs/m1-scorecard.md's in-scope sections from committed artifacts.
python3 scripts/scorecard-check.py
```

It exits 1 on any mismatch and lists, by name, each number it cannot recompute and each section it leaves out of scope. **Observed 2026-11-25: exit 0, `SCORECARD CHECK OK`.** Validating a *new* live run's artifacts (`validate-live --expect N`) needs the VM; see [docs/eval-runbook.md](docs/eval-runbook.md) §8.

---

## Layout

```
src/core/         state model, adapter interface, programs, verifier, evidence, eval
src/fake/         fake spreadsheet + fault injectors (host-side testing)
src/tasks/        task families, fixture generation, ground truth
src/integration/  trial lifecycle, guest wiring
src/win/          Windows agent client, UIA adapter
src/verify/       UNO verifier
src/baseline/     screenshot baseline harness (c1 arm)
src/foundry/      grading oracle, blind scoring, fixtures
src/discovery/    live Direction-A runner and preflight
agent/            Python guest agent (interactive session, loopback NDJSON)
runtime/          Rust: guest agent, MCP server, VM backend, evidence crate
foundry/          fixtures and hidden-commitment data
dogfood/          myco-todo app, scenarios, scoring
viewer/           static run/evidence UI
schemas/          result, trace and ledger schemas + validation
scripts/          eval drivers, sweep/baseline runners, tooling
test/             vitest suites, including cross-boundary contract tests
docs/             see below
```

### Docs

| Path | Contents |
|---|---|
| [docs/m1-scorecard.md](docs/m1-scorecard.md) | **Acceptance criteria and evidence — the authoritative M1 status** |
| [docs/product/setup.md](docs/product/setup.md) | `myco init`: one-command setup of the gate's MCP config for Claude Code and Codex |
| [docs/eval-runbook.md](docs/eval-runbook.md) | How to run the evaluation from a clean snapshot |
| [docs/product/vision.md](docs/product/vision.md) | Product vision and M1 acceptance criteria |
| [docs/architecture/m1.md](docs/architecture/m1.md) | ADRs: adapter, verifier, evidence, recovery, baseline |
| [docs/backlog/](docs/backlog/) | Per-workstream backlogs (M1, runtime, foundry, dogfood, discovery) |
| [docs/research/](docs/research/) | Research findings, **and the experiments, including negative results** |
| [docs/coordination/](docs/coordination/) | Owner state, rules, VM queue, evidence packs |
| [docs/agents/](docs/agents/) | Agent operating conventions |

---

## Contributing

Read [AGENTS.md](AGENTS.md) and [docs/coordination/CONTRIBUTING-agents.md](docs/coordination/CONTRIBUTING-agents.md) before opening a PR. They carry the rules that came out of M1 the hard way — verification tiers, git sync, targeted testing, and the requirement that a PR carries a TIF issue id.

Two rules worth stating on the front page because they are the ones that cost the most:

- **Never claim success from an agent's report.** A verdict comes from persisted state, and a `refuted` row is a result, not a failure of the harness.
- **Never record a simulated or unaudited run as evidence.** If a number cannot be re-derived from committed data, it does not go in the scorecard.