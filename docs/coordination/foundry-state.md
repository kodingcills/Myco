# Evaluation Foundry — workstream state

Owner: Evaluation Foundry (project P-TIF-6, team TIF). Independent of the Runtime Owner and
of MVP Discovery. Reports to the outer loop (T3 Code Bridge).
Branch: `myco/eval-foundry`. Canonical backlog: [docs/backlog/foundry.md](../backlog/foundry.md).

## Why this workstream exists (Tiffany, 2026-11-21, approved t80u / widget t80s288)

M1's evaluator and fault injection were built by the same team as the runtime. Calc file
edits can be solved without a GUI. Nothing in the repo is designed so that the screen and the
saved state disagree on purpose, and no separate team builds those tasks. The Foundry closes
that: tasks, verifiers, fault injection, evidence and scoring that implementation teams
cannot game, built **before** they optimize against them.

Hard rule (Tiffany): **TIF-50 and TIF-51 must exist before implementation teams optimize
against Foundry tasks.** Discovery's head-to-head (TIF-59) is blocked on the same two.

## Host contention

The M1 sweep is memory-starved and holds priority on the Mac (`myco-win11`). Nothing in this
workstream starts a VM, touches the guest, or runs a heavy local workload. Fixtures,
verifiers, guards, and scoring are pure functions over files — buildable and testable on the
host without a desktop. Any future VM work is scheduled through the M1 Coordinator.

## Deliverables and where they live

| Linear | Id | Status | Artefact |
|---|---|---|---|
| TIF-50 | EF-001 | in progress | `foundry/` fixture contracts + the GUI-disagreement seed task; `src/foundry/` runner; `docs/foundry/contract.md` |
| TIF-51 | EF-002 | in progress | `src/foundry/oracles/` (state oracles, hidden by path), mutation audit, hidden split scaffolding |
| TIF-52 | EF-003 | blocked on EF-001 + EF-002 | `src/foundry/faults/` (planned) + `docs/research/findings/f1-ef-fault-taxonomy.md` |
| TIF-57 | EF-004 | blocked on EF-001 + EF-002 | blind scoring in `src/foundry/blind.ts`; split roots `foundry/hidden/` |
| TIF-58 | EF-005 | blocked on EF-001 + EF-002 | baselines over the same tasks; escalation list in the report |

## Design decisions already taken

1. **Two oracles per task** — a persisted-state oracle (primary) and a screen oracle (trap).
   A pass requires the state oracle AND no contradicting screen claim. (contract §2)
2. **No-leak rule** — `expected()` may read intent + initial state only; never anything the
   agent produced. Enforced by types and a builder assertion. (contract §4)
3. **Trace guard** closes the file-I/O shortcut at the task level, not the runtime level, so
   it applies identically to every arm including the screenshot baselines. (contract §5)
4. **Two roots for the hidden split** — `foundry/tasks/` public, `foundry/oracles/` +
   `foundry/hidden/` hidden, separate roots and separate ownership. (contract §6)

## Escalations (queued for the outer loop; the Foundry does not act on them)

- **Orgo**: public site requires sign-up before any use and bills from a card/credit
  balance. Under Tiffany's rules this is a hard block → queued, not run.
- **Simular Sai**: free "Explore" tier exists but every path needs a Google sign-in plus an
  API key created in a portal, and the free plan runs on **Simular's hosted cloud computer**,
  not ours — which changes the environment and is not the same-task comparison. Queued.
- **Microsoft Hybrid Computer Use**: MIT, public repo, buildable. It is a *computer layer*
  (MCP server), not an agent — it needs a planner model, and it reports strong Windows
  results. Candidate for EF-005; work is host-only and can start once EF-001/EF-002 land.
- **Details MCP** (<https://www.details.so/mcp>) — requires a Details account and paid plan.
  Assessment and escalation queued; nothing installed, no account created.
- **Web search** — the Ollama-backed search tool returns HTTP 402 (usage credits exhausted
  on that endpoint). Research in this workstream therefore uses direct primary-source reads
  (arXiv API, project sites, GitHub API), which is the repo's citation discipline anyway.

## Sub-threads

Each sub-thread carries its own independent verifier and is reported back here and to the
outer loop. As of 2026-11-21: none spawned yet; the first wave (fixtures + verifiers) is
being executed in this thread because it is one coherent contract.

## Not touched

`myco-win11`, any VM, `agent/`, `src/win/`, `src/integration/`, `.github/workflows/`,
Linear, secrets, paid services, accounts.