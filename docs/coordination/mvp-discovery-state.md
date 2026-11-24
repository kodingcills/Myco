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
- **`myco-run` is the developer surface (MVD-001 acceptances 1/3/5).**
  `pnpm myco-run --transport mock --task df-s01 --out DIR` prints the claim, the
  persisted state read from the store, and the verdict, and its exit code comes
  from a schema + cross-file validation of the artifacts. `docs/product/quickstart.md`
  is the page a fresh agent follows; measured ~3 s from clone to a verified
  report. Acceptance 4 (two agent environments) is documented and contract-tested
  but not run inside Codex or Claude Code, and model cost is `not-measured`
  because the mock path calls no model.
- **`guestClean` is ratified; `oraclePresent` is not.** The outer loop ratified on
  Tiffany's behalf (2026-11-23): `guestClean` means *the app's store and published
  state files are absent before launch* — advisory, detectable, and it catches the
  contamination that matters (a stale app holding a previous trial's state). Every
  S0 evidence record must state that this definition was in force. `oraclePresent`
  stays unproven: Foundry's verifier has not validated anything in an S0 run, so an
  S0 PASS must not claim MVD-001 coverage. `RuntimeTransport.evidence()` reports
  both unproven and the preflight refuses, so nothing can pass on a weaker claim in
  the meantime. The launcher also refuses without `MYCO_COORDINATOR_GO=1` and
  `MYCO_HOST_LOCK=1` — the hole PR #99 was reverted for.
- **Model policy.** Judgment/verification `cheaperinference/deepseek-v4.1-flash`;
  building `cheaperinference/glm-5.3`; no kimi-k3.

## PR #99 post-merge verification (2026-11-22)

PR #99 merged as `9223229` before independent approval. The subsequent independent
review of `7e1bfb2` failed. The runner could reach the MCP server without genuine
Coordinator GO and did not acquire the shared host lock. It also marked synthetic
and stub evidence as live. This change reverts the runner, CLI flags, tests, and
unverified teardown claims added by that PR. Exclude any archives it produced
from Discovery evidence. Restore a live entry point only after Runtime,
Coordinator, and Foundry independently verify their respective gates and evidence.
Live Direction A awaits Coordinator GO after the queued work. A verifier PASS is
required before merge or auto-merge.

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
   "M2 = MCP/API" lock-in stays retracted. It *independently confirms* item 4: eight
   product lines surveyed against vendor primary docs (m2-01 lists nine entries, with
   Simular Agent S and Sai counted together per its §7.3), none returns a verdict on
   persisted state. Closest: Cua per-action `effect`; Microsoft HCU window-level before/after
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

**MVD-001 acceptance status (2026-11-23, host side only).**
1. Quickstart — **met on the mock path**: `docs/product/quickstart.md` goes
   from clone to a `verified` report in ~3 s measured, whole page ~20 s, against
   a 15-minute budget. A *fresh agent* has not been timed; the page was written
   for one and executed top to bottom by the builder.
2. Live DF-S02 refuted from the guest store — **not met**: needs the guest.
3. Schema-valid artifacts and a summary naming claim, state, verdict — **met**:
   `pnpm myco-run` prints the three parts and `validateRunDir` gates the exit code.
4. Two ordinary agent environments — **not met**: the invocation contract is
   documented and tested (flags only, no TTY, `--json`, explicit exit codes), but
   nothing ran inside Codex or Claude Code.
5. Wall-clock and model cost — **half met**: wall-clock is recorded with its
   provenance bound to its basis; model cost is `not-measured` because no model
   is called on the mock path.
6. One forced failure recovered or `uncertain` — **not met**: needs the guest.

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

## Merge rule (reaffirmed by the outer loop after PR #98)

No PR merges, and no auto-merge is enabled, without **an independent verifier PASS at
the exact PR head**, then **green CI at that same head**. Any head change — including
merging `main` in — needs a fresh verification before merge. PR #99 is the reason this
is written down: it merged a live runner whose gates could be bypassed; PR #100
reverted it (`8396c93` — that revert reached `main` via PR #101), and its archives are
excluded from Discovery evidence.

## Non-VM queue (2026-11-22 17:20 ET, operating rule B)

The guest queue is only for work that needs the Windows/Linux desktop. Everything
below runs now, offline, in parallel with M1.

| # | Work | Why it does not need the guest | Status |
|---|---|---|---|
| N1 | **Offline replay harness**: normalize recorded arm rows (`/tmp/baseline/c1-arm2/accounting.json`, `docs/research/experiments/*`) into the decision rule's `ScoredTrial` shape and print the rule's refusal/row plus what is missing | rows and traces are on disk; the rule is pure | **done** — `src/discovery/replay.ts`, `scripts/discovery-replay.ts`; replayed C1 (11 rows, 0 false successes) + M1 run (1 verified, false-success unknown); rule refuses `missing-arm` and names the three missing inputs |
| N2 | **Head-to-head report generator**: decision + per-arm metrics → the report (paired table, Wilson intervals, rule row, not-run arms) | pure function over rows; synthetic + recorded C1 rows exercise it | **done** — `src/discovery/report.ts`; renders the refused decision, per-arm intervals, paired table, not-run arms, and the "what this report does not say" section |
| N3 | **Direction A first-use quickstart**: the exact commands a fresh agent follows, validated against the dry-run path; measure command count and wall-clock | dry-run harness runs offline (`pnpm test:task`) | **done** — `docs/product/direction-a-quickstart.md`; measured 1.3 s, one command, 14 log lines |
| N4 | **Direction A live preflight**: script + checklist (guest up, `myco-todo` deployed, store path, oracle path, abort conditions), unit-tested with mocks | the checks are host-side; only the final run needs the guest | **done** — `src/discovery/preflight.ts`, `scripts/discovery-preflight.ts`; 8 checks, abort on any missing, 5 tests |
| N5 | **Direction B/C dry-run validation**: all three task packages run offline and emit schema-valid evidence | done 2026-11-22: A `REFUTED` (false success caught), B `UNCERTAIN` (interrupted write, 0 duplicates), C `VERIFIED` (modeled timings, explicitly not evidence) | done |
| N6 | **Docs**: keep plan/teardown/state current; no science moves without data | — | ongoing |
| N7 | **S3 resolved with Foundry** (`docs/foundry/answer-discovery-s3-gap.md`, PR #176): a todo screenshot arm is EF-005's, and `not-run` + C1-descriptive is the correct report today. Foundry asked for one wording nit in the C1 note | coordination, no code | done |
| N8 | **Direction A mock live runner**: exercise the full task → act → verify → report path against a fake transport, so the live run is a config change once the act op lands | no guest; the transport is injected | **done** — `src/discovery/live-runner.ts`, `src/discovery/mock-desktop.ts`, `test/discovery/live-runner.test.ts` (PR #187, `5c10cd3`), later wired to `typeTextGlobal`/`clickAt` and the S0 mock sequence (#210/#212). The runner is transport-agnostic; the seeded `BUG` double exercises the false-success path offline. |
| N9 | **Report section for the Cua/HCU arms** once EF-005 produces pairs; the report already has the not-run table | no guest | **done** — `src/discovery/report.ts` (`NotRunArm`, `HeadToHeadReportInput`) renders the not-run arms; real Cua/HCU pairs still await EF-005, which is the missing *input*, not missing code. |
| N10 | **Viewer head-to-head view** over the same report input (v0 reads a single run) | no guest | **done** — `viewer/src/data/head-to-head.ts`, `viewer/test/head-to-head.test.tsx`, `viewer/fixtures/head-to-head.json` (synthetic, labelled), screenshots in `viewer/screenshots/head-to-head-*.png`. Live intake is a separate, outer-loop-gated item (`viewer/DEVIATIONS.md`, TIF-108). |

**Corrected 2026-11-24:** the three rows above read `next` long after they shipped; this state file was the lagging copy, not the code. With them done, **the non-VM queue is empty**. Nothing in Discovery is startable without the guest window (MVD-001/002/006) or a runtime capability that does not exist yet (MVD-003), except MVD-008, whose remaining half needs a 1,000-screenshot run and Tiffany's Chrome Stable result — both heavier than the current host window allows.

### S0 is not guest-blocked; it is act-blocked (2026-11-22, 18:00 ET)

The VM queue records that Discovery S0/S1 use the disposable ARM64 QEMU+HVF Ubuntu
guest, not the Windows guest. That is correct, and it means the guest is not the
blocker. The blocker is the runtime's action union:

- `runtime/crates/myco-rt-core/src/ops.rs` — `Action` is `Launch`, `Click { target }`,
  `TypeText { target, text }`, `KeyPress { keys }`. `TypeText` **requires** an
  `ElementRef`; `KeyPress` sends key names, not text.
- RT-003 measured that Tk registers **zero AT-SPI nodes**, so the dogfood app's entry
  field has no ref. The app focuses its entry on launch and binds `<Return>` to Add
  (`dogfood/apps/myco-todo/myco_todo.py:68,90`), so the only missing primitive is
  **global text into the focused window** (XTEST), plus optionally a coordinate click
  for the Save button (Tab traversal may cover it).
- Consequence: S0 cannot type a single item on the current runtime, with or without a
  guest. Starting the guest now would burn a slot and produce no Direction A run.

Reported to the Runtime Owner with the smallest fix: `TypeTextGlobal { text }` (or an
optional `target` on `TypeText`) using the same XTEST path as `KeyPress`. S0 starts the
day that lands; the guest is otherwise ready.

**Next non-VM work, in order:** (a) Foundry's offline item — generalise `runArm` past its
model-only guard so a todo arm can be scored at all (Foundry owns the harness; Discovery
consumes it); (b) a report section for the Cua/HCU arms once EF-005 produces pairs;
(c) the Viewer's head-to-head view over the same report input, since the v0 Viewer only
reads a single run.

> **2026-11-24:** (b) and (c) have since shipped (N9, N10 above), so of this list only
> (a) remains, and (a) is Foundry's, not Discovery's. Discovery has no startable non-VM
> work until the guest window opens or the runtime grows the global-text op.


### What actually needs the guest (batched, M1 first)

| Slot | Need | Depends on |
|---|---|---|
| S0 | RT-020 Linux guest up, `myco-todo` deployed, store path + oracle reachable; one Direction A run (DF-S01 then DF-S02) with an OMP agent | Coordinator GO + host lock; RT-011/RT-015/RT-016 |
| S1 | `ef-t01b` no-verify, **Myco arm**, ≥30 refutable pairs | Foundry hidden split + trusted ingest |
| S2 | `hcu+shell` arm on the **same pairs**, shell calls trace-recorded | HCU in the guest; Foundry's audit ingest |
| S3 | screenshot-only arm on the same pairs | C1 is Windows/Calc today; it cannot supply `ef-t01b` pairs without a Windows todo run — flag to Foundry |
| S4 | Direction B interrupted-write trials, ≥30 | RT-016 process control |
| — | Direction C | **no guest need**: the runtime has no `snapshot()`/`fork()`; C stays design-only until it does |

The decision rule cannot fire on any recorded data today: the C1 arm is Calc, the
dry-runs are simulated, and no Myco/hcu+shell pair exists on `ef-t01b`. That is the
honest state, and it is why S1/S2 are the only slots that move the wedge.

## Log

- 2026-11-24 · **TIF-170 done** — #376 merged as `cf0377d0`. The launcher's
  bare-`mkdir` claim is replaced by an `flock` held for the run's lifetime, and the
  race test is un-quarantined (the quarantine #333 added is removed; `runIf(DIAG)`
  is gone and the test runs in every job). So the launcher now cannot double-admit
  a run even where `mkdir` did — that admission was the last mechanism under which
  two `--run`s could share a worktree, which the S0 gating depends on.
  - **Mechanism.** `exec 9>>"$LOCK_FILE"` → `flock(9, LOCK_EX|LOCK_NB)` →
    `nohup "$0" --watchdog &`. The lock belongs to the open file description, so
    the watchdog inherits and holds it; the kernel releases it when the last
    inheriting process exits. Order is the whole fix — opening after the spawn
    gives the child no fd and the lock dies with `--run`.
  - **Evidence.** Both arms on the 4-vCPU `tif-170-race-diagnostics` runner, 11
    invocations × 40 rounds (440) each: `mkdir` arm reproduced at round 8; `flock`
    arm 11/11 clean, zero double-admits. The un-quarantined test then passed on
    ubuntu (9.1 s) and macos (15.8 s) inside the ordinary `check` jobs, not just
    the diagnostics job.
  - **Verifier.** Independent Tier-2 reviewer at head `0741d897`: `correct`,
    confidence 0.85. It confirmed the primitive excludes across processes, the
    watchdog really inherits it (HELD from a separate process), `--stop` releases
    it, and a losing `--run` exits 1 / logs `flock-lost` / closes fd 9 / leaves no
    stray child. Its one finding (P2, not a blocker) was that the lock's lifetime
    is the run *tree's*, so a descendant that survives `--stop` keeps it and the
    next `--run` refuses until that stray is gone — that is now stated in the
    comment above the `exec` (`84075b0a`, comment-only).
  - **Merge note.** The verified behaviour is unchanged from `0741d897` to the
    merged head: the only non-sync delta is that comment-only block plus the
    two-to-three main-sync merges. No re-verification round was spent on a
    comment-only commit; the syncs pulled in unrelated docs only.
  - No VM, no spend, no accounts. Host load kept low: no repeated race loops.

- 2026-11-23 (later still) · `docs/product/wedge-recommendation.md` merged (#278,
  TIF-60): Direction A, narrowed, with its evidence and its gaps in separate
  sections, and the pre-registered §4.1 rule table quoted rather than paraphrased
  (three verifier rounds; the first rejection was for presenting the plan's
  overturn conditions as the rule rows, the second for inventing two of those
  conditions). Also merged: #277 (what the viewer does and does not show for a
  `myco-run` artifact — verdict, score, steps and check render; the
  claim-vs-persisted table reads `not recorded` because the artifact carries the
  verdict and reason, not the persisted list).
- 2026-11-23 (later) · Merged and closed out, in order: #248, #250, #256, #272.
  - **#250 / #256** (TIF-89): the live S0 path is real and gated. `RuntimeTransport`
    speaks MCP over `myco-rt-mcp` and reads the guest's published state; the
    launcher is detached, refuses without Coordinator GO + host lock, on a running
    guest, on a missing binary, or on an unreadable process table, and its stop is
    scoped to this worktree. Three verifier rounds on #250 and three on #256; every
    REJECT found a defect I had shipped — a gate that threw on the no-guest case, a
    `--stop` that killed other worktrees' processes, a watchdog that lost a failed
    child's exit code, and a launcher that booted a guest without a Coordinator GO
    (the PR #99 hole). The last is worth remembering: I fixed the hardware gate and
    reinstated the hole the revert existed to close.
  - **#256 also ships `myco-run`** and the quickstart; MVD-001 acceptances 1, 3 and
    5 are met on the mock path, 2 and 6 need the guest, 4 needs a person to run it
    inside Codex or Claude Code.
  - **Open, not mine to decide:** S0 live stays closed on `oraclePresent` and
    `guestClean`. I recommended narrowing `guestClean` to something the transport
    can check (the app's store and published-state files absent before launch) and
    recording the definition in the run's evidence. That changes what a S0 PASS
    means, so it is Tiffany's and Foundry's call; a GO without that answer leaves
    S0 unable to leave the preflight.
  - **A defect I introduced and fixed:** the quickstart told a reader to run
    `vitest run --changed HEAD`, which selects nothing on a clean tree and exits 0.
    It was a verification claim over zero tests — the class this workstream exists
    to kill.
  No VM, no spend, no accounts.

- 2026-11-23 (later) · Merged and closed out, in order: #248, #250, #256, #272.
  - **#250 / #256** (TIF-89): the live S0 path is real and gated. `RuntimeTransport`
    speaks MCP over `myco-rt-mcp` and reads the guest's published state; the
    launcher is detached, refuses without Coordinator GO + host lock, on a running
    guest, on a missing binary, or on an unreadable process table, and its stop is
    scoped to this worktree. Three verifier rounds on #250 and three on #256; every
    REJECT found a defect I had shipped — a gate that threw on the no-guest case, a
    `--stop` that killed other worktrees' processes, a watchdog that lost a failed
    child's exit code, and a launcher that booted a guest without a Coordinator GO
    (the PR #99 hole). The last of those is the one worth remembering: I fixed the
    hardware gate and reinstated the hole the revert existed to close.
  - **#256 also ships `myco-run`** and the quickstart; MVD-001 acceptances 1, 3 and
    5 are met on the mock path, 2 and 6 need the guest, 4 needs a person to run it
    inside Codex or Claude Code.
  - **Open, not mine to decide:** S0 live stays closed on `oraclePresent` and
    `guestClean`. I recommended narrowing `guestClean` to something the transport
    can check (the app's store and published-state files absent before launch) and
    recording the definition in the run's evidence. That changes what a S0 PASS
    means, so it is Tiffany's and Foundry's call; a GO without that answer would
    leave S0 unable to leave the preflight.
  - **A defect I introduced and fixed in the docs:** the quickstart told a reader
    to run `vitest run --changed HEAD`, which selects nothing on a clean tree and
    exits 0. A verifier caught it; it was a verification claim over zero tests,
    the exact class this workstream exists to kill.
  No VM, no spend, no accounts.

- 2026-11-23 (early) · S0 prepped and made startable without an agent turn
  (TIF-89, PR #250). Direction A's live arm now has everything but the window:
  - `src/discovery/runtime-transport.ts` — MCP stdio client over `myco-rt-mcp`,
    implementing the runner's `DesktopTransport`. It reads the app's own
    published state through `read_file` (RT-015) rather than the runtime's
    optional introspection config, so the claim and the persisted store both
    come from the guest. It returns observations and outcomes and cannot return
    a verdict.
  - `scripts/s0-live.sh` — detached launcher (nohup, pid file, log, watchdog).
    The gate refuses on a running guest, a missing or non-executable
    `myco-rt-mcp`, or an unreadable process table (fails closed); `--stop` is
    scoped to this worktree; the watchdog records a failed child's exit code.
  - `scripts/s0-live.ts --dry-run` produces DF-S01 verified and DF-S02 refuted
    offline (exit 0); `--live` deploys over SSH, reads the window geometry with
    xdotool, and runs both tasks.
  - **No live evidence exists.** One attempt started at 03:15 and was stopped
    two minutes into boot because the window was not ours (a guest from another
    worktree was already up, and no Coordinator message could be delivered —
    the peer id no longer resolves). The runs that produced `df-s01`/`df-s02`
    are synthetic and labelled so. Correcting an earlier slip: the arm-002
    entry's claim that a "first live run reported df-s01 verified" was wrong;
    that run was synthetic.
  - Three verifier rounds, REJECT/REJECT/PASS, each finding fixed and re-tested:
    a gate that threw on the normal no-guest case, a `--stop` that killed other
    worktrees' processes, an unscoped watchdog that lost a failed child's exit
    code.
  No VM left running; no spend; no accounts.

- 2026-11-22 (afternoon, second) · Pre-registered decision rule implemented
  (`src/discovery/decision.ts`, 12 tests). It consumes Foundry-scored trials and
  returns the §4.1 rule row mechanically: refuses while any scoped row is not
  `decisionEligible`, refuses below 30 paired refutable trials, evaluates rows 1–5
  top to bottom, and reports the exact sign test and Wilson intervals. It never
  scores a trial and never reads a fixture. This is the piece that makes the
  pre-registration executable rather than prose; no data exists yet, so no row has
  fired. No VM, no spend, no accounts.

- 2026-11-22 (afternoon) · M2 research processed into the decision documents (no VM,
  no spend, no accounts):
  - `docs/research/mvp-competitive-teardown.md` §2.6: cross-check against finding
    m2-01. 8 named products plus a screenshot-only control across the two documents
    (Simular Agent S and Sai counted as one product line, per m2-01 §7.3), none with a
    persisted-outcome verdict; the four overlapping products (HCU, Cua, Orgo, Sai)
    agree, including two defects both documents found separately (Orgo's $3-vs-$5 credit, Orgo's
    UUID-vs-`instance_id` spec contradiction). Adopted m2-01's billing point in its own
    hedge (Orgo bills machine-hours, Sai credits), so verification is free *if the
    customer writes it* — which is precisely why the `hcu+shell` arm is the decisive one.
  - `docs/product/mvp-discovery-plan.md`: §2 now cites m2-01's eight product lines
    (nine entries, Agent S and Sai one line per §7.3) as independent confirmation;
    §4-A's underpowered 10-run rule is withdrawn and §4-B's 10-trial rule is
    retargeted to `mvd-preregistration.md` §4.3 (≥30 interrupted trials); §6's second app is
    LibreOffice Writer per m2-03; §7 gains m2-04 (one demonstration cannot identify a
    loop) and m2-05 (~21 s is the default reset, not 8.3 s) as evidence that would
    overturn C and any trial-heavy budget.
  - Not changed: the pre-registration, the A/B/C rule table, the Viewer (gui-spec is
    locked), the Direction A plan. No science moved, so no re-verification of them.
  - Standing state: every live step is gated on the **Coordinator GO + host lock**
    (queued after C1, M1-016 and Foundry). Nothing runnable in this window; the work
    above is documentation reconciliation only.

- 2026-11-22 (morning) · PR #84 merged (`767a62c`): Descriptive Sai arm evidence, Amendment 3, and blocker fixes verified. Blocker 1 resolved: approval URLs in diagnostic fields (`error`, `message`, `description`) are safely captured to private `/private/tmp/sai-setup/approval-N.txt` (mode 0600) and redacted (`[REDACTED]`) from ledger excerpts. Blocker 2 resolved: strict paid and quota guards (`plan.free: true` + `plan.title: "Paid plan"`, plain-text `storage_quota_exceeded`, and pre-strip inspection of diagnostic fields). 50 tests pass (`test/sai/harness.test.ts`), credential scanner clean, independent verifier pass (`PASS`), CI green.
- 2026-11-22 (morning) · PR #81 merged (`aad8b59`): Orgo arm runner, fake service, spend guards, and preflight merged. Amendment 1 adopted (Free Medium gate-probe). Live probe remains ON HOLD pending verified provider-side $0.25 ceiling (real spend/keys blocked). Direction C analytical comparator: Orgo ~2s live memory pause on running Linux VM ($0.055/hr Medium) vs Myco's ~21s warm disk-only cold restore default (8.3s live RAM snapshot wedges in rapid cycling). Orgo branches the machine, not the task/intent. Branching (Direction C) is deferred in favor of linear retry from known-good state via intent log.
- 2026-11-22 (morning) · PR #83 merged (`5e590df`): Viewer screenshot retention (TIF-64 / MVD-009). Measured-width display bitmaps cut settled renderer memory from 1,091–1,111 MB to 349–376 MB. Peak summed footprint in headless Chromium shell is ~457 MB (native Chromium image decoder cache; Chrome Stable unmeasured).
- 2026-11-22 (morning) · PR #89 merged (`1f4619a`): Repaired `myco-todo` GUI startup, opt-in ADR-0016 publication with traced Tk variable, seeded persistence bug preserved.

- 2026-11-21 (late) · PR #74 merged (pre-registration). Planner for every arm: Claude `claude-sonnet-5-5`, pause never swap (outer loop). Foundry owner: `ef-t01b` and host-only grading merged (PR #75); `hcu+shell` is in the registry (not-run). Coordinator (message, not in repo): slot 6 tentatively S0+S1 only, after queue slots 1-5, with explicit GO and the host lock. Foundry owner (message): slots 4-5 are Calc-family descriptive references (slot 5 planned $0 cap). Coordinator + Runtime Owner (messages): S0 runs on the Runtime Owner's Linux ARM64 guest, not myco-win11; open prerequisite: `myco-todo` deploy and verify there and an uninterrupted RT-011 run. Viewer v0 (PR #69) awaits Tiffany's sign-off. No VM, no spend, no accounts.

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