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

6. **M2 research round landed (main fc4738e, PR #48; findings under
   `docs/research/findings/m2-0*.md`).** Research input to A/B/C, not a plan; the
   "M2 = MCP/API" lock-in stays retracted. It *independently confirms* item 4: nine
   products surveyed against vendor primary docs, none returns a verdict on persisted
   state. Closest: Cua per-action `effect`; Microsoft HCU window-level before/after
   diff, which says "Neither proves file contents, persistence or network state."
   What it changes for Discovery:
   - **A:** m2-02 is "what A must get right", not the wedge. Two keepers whichever
     wins: the verdict lives behind a tool the actuator cannot call as a claim
     (structural, not conventional), and `application_commit: not_verified` in every
     receipt (a widget read-back is not proof the app committed).
   - **B:** the second bounded surface is **LibreOffice Writer** (m2-03: 23/25, in
     the installed ARM64 MSI, table cells expose XCell+XText so the M1 UNO read
     transfers; only the address changes). Notepad++ is the one non-UNO proof if
     adapter generality matters. Office is licence-blocked.
   - **C:** Orgo (fork live ~2s pause, clone, suspend; $0.023-0.368/running hr) is
     the incumbent baseline and the price any verified-outcome product is compared
     to. m2-04: one demo cannot identify a loop, so "reusable procedure" claims need a
     verify-before-store gate; desktop-suite drift is unquantified. m2-05 correction:
     **8.3 s reset is the live path and is not the default**; the sweep default is a
     ~21 s warm disk-only cold restore because live wedges (-2700). Trial-heavy
     designs should budget ~21 s, not 8.3 s. APFS clone buys concurrency, not speed.
   - Effect on D1: strengthens "compete on verified outcome + durable artifact", and
     weakens any C claim that rests on cheap resets or durable procedures.

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
- The v0 Myco Viewer (gui-spec §9) over the **real** M1 artifacts already in the repo.
  This is the only UI that can be built before a desktop run exists. The earlier
  standalone report renderer is retired (it predates the locked spec).
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

- 2026-11-21 (late) · PR #74 merged (pre-registration). Planner for every arm: Claude `claude-sonnet-5-5`, pause never swap. Foundry: `ef-t01b` and the host-only grading merged (PR #75); hcu+shell arm planned. Coordinator: slot 6 tentatively S0+S1 only, after queue slots 1-5, VM lock + explicit GO; slots 4-5 are Calc-family descriptive references (no EF pairs, no myco-todo; slot 5 $0 cap). S0 runs on the Runtime Owner's Linux ARM64 guest (not myco-win11); open prerequisite: myco-todo deploy+verify there and an uninterrupted RT-011 run. Viewer v0 (PR #69) awaits Tiffany's sign-off; hosted perf guard added there. No VM, no spend, no accounts.

- 2026-11-21 (evening) · PR #50 merged; Viewer v0 (PR #69) built and independently verified, awaiting Tiffany's sign-off (tokens, two beyond-§6.2 verdict rules, DEVIATIONS.md). Wrote `docs/product/mvd-preregistration.md`: pre-declared head-to-head, A/B/C rules at Foundry §7a sample sizes (corrected the plan's underpowered 10-run rules), decisive hcu+shell arm (not yet in Foundry's registry), VM slot request S0-S4 (a request, not a start). Wedge stays provisional (A, narrowed). No VM, no spend, no accounts.

- 2026-11-21 (GUI spec locked, PR #51 = ed2f1f9) · binding for every human surface.
  Merged main. Retired the standalone report renderer (`src/report`, `docs/report`,
  `pnpm report`) as a spec deviation; MVD-007 now means the v0 Viewer. Resolved gui-spec
  Q3: SDK wraps `myco-rt-mcp` over stdio (`docs/product/dev-surface-decision.md`).

- 2026-11-21 (provider switch) · outer loop moved this thread from cheaperinference
  (402, wallet exhausted) to the Claude Code subscription, claude-sonnet-5-5. Four
  queued M2-research messages had only received 402 replies; processed now by reading
  the merged findings. Merged origin/main into this branch. No VM, no spend, no
  accounts. Model policy for this thread now: owner/judgment on Sonnet, build to Codex
  (backup Antigravity), no Opus children, no kimi-k3.

- 2026-11-21 · workstream bootstrapped; read vision, M1/dogfood/runtime backlogs,
  coordination state, ADRs, dogfood app, real M1 evidence. Wrote MVD backlog, this
  state, discovery plan. Started competitive teardown research + verifier.
  No VM, no spend, no accounts.