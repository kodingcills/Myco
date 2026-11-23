# Myco

Make existing desktop software reliably executable by AI agents: **verified operations, recoverable execution, reusable procedural knowledge.**

Agents can already touch desktop software. The unsolved problem is *trust* — knowing whether a click actually changed the application, and being able to undo it when it did not. Myco's answer is to treat the desktop as a program: read authoritative app state, drive it through guarded steps, and decide success **only** from persisted state that the agent cannot write.

**Milestone 1 status:** verified, recoverable `calc-record-edit` execution on real LibreOffice Calc in Windows 11 ARM64. See [docs/m1-scorecard.md](docs/m1-scorecard.md) for the acceptance criteria and their current evidence — that file is the record, not this page.

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

## Setup

Node 24 required. `npm` works out of the box; CI uses `pnpm`.

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

All five are verified to run on a clean checkout. `pnpm install --frozen-lockfile` then `pnpm typecheck && pnpm lint && pnpm test` is the CI path.

> **If a gate fails unexpectedly,** run `pnpm install --frozen-lockfile` first — a stale `node_modules` produces a false `TS2307` that looks like a broken build.

### Run something

```sh
# The M1 task family, against the fake app — no VM, no network.
npm run test:task
```

`test:task` **exits 1 on purpose.** It runs the `todo-save` trap: the UI claims `"saved 7 item(s)"` while two `BUG:`-prefixed items never reach the store. That is the false-success case Myco exists to catch, so a non-zero exit is the pass condition — the output prints `Final Verdict: REFUTED` and `False Success Caught: YES`. A `0` here would mean the harness missed it.

```sh
# A full mock run with evidence, then validate what it wrote.
pnpm myco-run --transport mock --task df-s01 --out /tmp/myco-run
```

`myco-run` prints the claim, the persisted state read back from the store, and the verdict; `df-s02` prints `REFUTED` and names the dropped items. It re-reads `result.json` and every trace line against the schema, so **a tampered run exits 2** rather than reporting success.

The live path — a real guest, real Calc — is documented in [docs/product/quickstart.md](docs/product/quickstart.md), which states exactly where it stops and why. **It requires a Windows VM and is not runnable on a bare checkout.**

---

## Reproduce M1

[docs/eval-runbook.md](docs/eval-runbook.md) is the procedure: from a clean snapshot to a full report, with every command checked against the repo. Read [§10](docs/eval-runbook.md) first — it lists precisely what a fresh operator **cannot** improvise, including that `build-all.sh` has never run end to end and that the ISO, offline payload and `clean-base` snapshots live outside the repo.

Retained evidence is committed so a number can be re-checked without a VM:

```sh
# Reproduce the M1-013 reliability row (expects 29/30 verified) — no VM.
python3 scripts/m1-scorecard.py docs/research/experiments/m1-013-sweep-v3/trials.jsonl
```

That is the check that matters: the claim in the scorecard can be regenerated from committed data in one command.

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