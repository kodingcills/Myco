# Myco MVP Discovery — workstream state

Owner: MVP Discovery thread (this branch, `myco/mvp-discovery`). Cross-workstream
changes route through the M1 Coordinator and the outer loop. Backlog:
[../backlog/mvp-discovery.md](../backlog/mvp-discovery.md). Linear project
**P-TIF-5 Myco MVP Discovery** (team TIF) is mirrored from that backlog by the
outer loop; agents do not call Linear.

## What is being decided

Not "what is the M2 API". The question is: **what job does Myco do meaningfully
better than an existing computer-use tool, and is that job big enough to start
from?** The deliverable is a tested, working end-to-end experience plus a
recommended starting wedge. The earlier "M2 = MCP/API" lock-in is retracted.

Three directions, bounded proofs only:
A verified desktops for coding agents (TIF-53) · B verified operations on
business software without APIs (TIF-54) · C branchable desktops (TIF-55).
Head-to-head (TIF-59) and recommendation/product criterion (TIF-60) decide.

## Hard constraints in force

- **Host contention.** M1 keeps priority. No VM, no heavy local workload, no
  container desktop while the M1 sweep is blocked/running. Work is host-side
  research, design, and code. Host time is requested through the M1 Coordinator
  (MVD-006); the request is not assumed granted.
- **UI quality.** Anything a person sees gets real design work and screenshots in
  its PR (Tiffany t81u/t82u/t83u). Reference bar: details.so/mcp. Details MCP
  needs an account + paid plan → escalation, not action.
- **No spend/accounts/reboots/settings.** Competitor accounts and paid plans are
  escalations; record what could not be run.
- **Foundry owns ground truth.** Discovery does not write fixtures or verifiers
  and does not optimise against hidden tests.
- **Model policy.** Judgment/verification `cheaperinference/deepseek-v4.1-flash`;
  building `cheaperinference/glm-5.3`; no kimi-k3.

## Current position (2026-11-21)

Facts established by reading the repo, not by running anything:

1. **M1's technical core already works**: real Calc run on `myco-win11`, verifier
   from UNO + persisted `.xlsx`, guarded steps, recovery, schema-valid evidence
   (`docs/research/experiments/m1-013-session1/`). M1 keeps the Windows host.
2. **The runtime is close but not past its gate**: create→observe→act→evidence is
   live; reset takes 3–4 minutes; one uninterrupted MCP create→…→destroy run is
   still missing (RT-011). Extended ops needed by Direction A's oracle are pending:
   host-side guest file read (RT-015) and process kill/relaunch (RT-016).
3. **The dogfood app is the right seed**: `myco-todo` drops `BUG`-prefixed items at
   save while the status bar says "saved N item(s)" — the exact false-success shape
   (OpenAdapt 54/72) M1 exists to kill. DF-S01/S02/S03 already define oracle-checked
   tasks. On Linux, Tk exposes zero AT-SPI nodes; the accepted fallback is the
   app-side introspection channel (ADR-0016), so observation is partly app-provided.
4. **Competitor evidence is now collected from primary sources**
   (`docs/research/mvp-competitive-teardown.md`): HCU is an MIT cross-OS MCP server
   with AX + GUI + layout guards and published wins over CUA Driver; Orgo is cloud
   VMs with fork/clone; Sai is a hosted agent with replay-as-code and OSWorld 2.1
   numbers. None of them documents an independent persisted-outcome verdict.
5. **The honest counter-argument**: a competent coding agent with HCU and shell
   access can read a JSON store itself. Therefore Direction A's differentiator
   cannot be "verification exists"; it must be "the verified result is a durable,
   machine-checkable artifact produced without agent discipline, and it survives
   failure". MVD-004 adds the HCU+shell arm specifically to test this.

## Plan

### Phase 0 — evidence and plan (this turn, host-free)
- [x] Read vision, backlogs, dogfood, runtime state, M1 ADRs, existing research.
- [x] Competitive teardown from primary sources (`docs/research/mvp-competitive-teardown.md`),
      independently checked by a verifier sub-thread.
- [x] Write MVD backlog + this state + `docs/product/mvp-discovery-plan.md`.
- [ ] Record Foundry task-set agreement (waiting on Foundry owner).
- [ ] File the host-window request to the M1 Coordinator (via outer loop).

### Phase 1 — developer experience, host-free where possible
- The exact 60-second experience and the report surface (design first, then build).
- A task-package + run-report contract that consumes Foundry oracles and runtime
  evidence. No verifier implementation.
- A run-report renderer over the **real** M1 artifacts already in the repo, with
  design work and screenshots. This is the only UI that can be built before a
  desktop run exists.
- Exit: a person can look at an existing real run and understand verdict, claim,
  and evidence without opening JSON.

### Phase 2 — Direction A on a real desktop (host window)
- Runtime first path + RT-015/RT-016 with the Runtime owner inside the granted window.
- Direction A run: OMP agent, myco-todo, DF-S01 → DF-S02, Foundry oracle, report.
- Exit: MVD-001 acceptance 1–6. If it fails, the failure is recorded as a runtime
  or DX gap, not papered over.

### Phase 3 — head-to-head and wedge
- MVD-004 on Foundry's task set with whatever arms can be run without accounts/paid
  plans; unrun arms recorded with blockers. Includes the HCU+shell arm.
- MVD-002 bounded proof on the same host window if time permits (B needs RT-016).
- MVD-005: recommendation + product criterion + kill criteria, independently
  reviewed. C stays design-only unless A/B evidence says otherwise.

## Sub-thread registry

| id | owns | model | verifier | status |
|---|---|---|---|---|
| CompetitiveTeardown | `docs/research/mvp-competitive-teardown.md` (TIF-59 research) | deepseek-v4.1-flash | `TeardownVerifier` (separate, deepseek) | running |
| TeardownVerifier | claim-by-claim check against cited primary sources | deepseek-v4.1-flash | — | queued behind the artifact |

Rule: no sub-thread's own author declares it good; each artifact gets a separate
verifier, and every sub-thread is reported here and to the outer loop.

## Decisions

- **D1 (provisional, 2026-11-21):** Direction A is the **distribution** wedge and
  the first developer experience; Direction B is the long-term execution
  abstraction; C is deferred until A/B evidence earns it. This *confirms* the
  current preference but narrows A's positioning: compete on verified outcomes,
  recovery, and evidence — not on transport coverage, where HCU/Cua already are.
  Final call after MVD-004.
- **D2:** Myco should be able to sit **above** an existing transport (HCU is MIT and
  cross-OS; Cua is the M1 baseline). Building a second accessibility stack is not
  the wedge. [INFERENCE pending runtime-owner review; do not change runtime scope
  from this thread.]
- **D3:** Direction A's demo uses DF-S01/DF-S02 unchanged. The seeded bug is the
  product argument; do not build a new app.
- **D4:** "Independently verified correctness" means the verdict is computed from
  persisted/object-model state by a component that never reads the agent's
  transcript; `uncertain` is a first-class outcome. If Foundry's oracle disagrees
  with ours, Foundry wins.

## Escalations (outer loop / Tiffany)

1. **Details MCP** — needs an account and a paid plan. Not purchased or installed.
   Question: is it worth buying for the design workflow, or is public
   details.so as reference enough? (No action taken.)
2. **Competitor execution** — HCU and Cua Driver are open-source and can run
   without accounts; Orgo and Simular Sai require accounts/paid plans (Sai has a
   free tier, still an account). Head-to-head arms for Orgo/Sai need an explicit
   go-ahead; until then they are documented from primary sources and marked
   "not run".
3. **Host window** — request to the M1 Coordinator via the outer loop: after the M1
   sweep, a bounded window for RT-011 + RT-015/RT-016 + one Direction A run.
   No VM starts before sign-off.
4. **Vision-capable model for the baseline arm** — M1-022 already open; not
   duplicated here.

## Log

- 2026-11-21 · workstream bootstrapped; read vision, M1/dogfood/runtime backlogs,
  coordination state, ADRs, dogfood app, real M1 evidence. Wrote MVD backlog, this
  state, discovery plan. Started competitive teardown research + verifier.
  No VM, no spend, no accounts.