# Myco MVP Discovery backlog

Canonical in-repo backlog for the MVP Discovery workstream. The outer loop mirrors
this into Linear, team TIF, project **P-TIF-5 Myco MVP Discovery**. Agents in this
repo may read Linear and update only the issue they work on, never create or
restructure issues (AGENTS.md, docs/agents/issue-tracker.md).

**MVD ids are the record; Linear ids are a mirror and drift.** The `(TIF-nn)` tag on
each heading is the Linear issue the outer loop mirrored *at the time the heading was
written*. When Linear restructures, the tag goes stale and the markdown does not —
so a stale tag is not evidence that the markdown row is wrong, and neither is it
permission to renumber: **ids are stable, never renumbered.** A row whose Linear
issue has been split, closed, or superseded keeps its MVD id and gains a
`linear_state` line saying so.

### Known Linear drift (recorded 2026-11-22, outer loop)

| Markdown row | Tag in heading | Linear today | How to read it |
|---|---|---|---|
| MVD-001 | **was** TIF-53; the heading no longer carries it | TIF-53 is not S0. **TIF-89** is "Discovery S0 first live run", reopened until the live run's evidence exists | MVD-001 stays the Direction A bounded proof; TIF-89 is the **execution** of MVD-001's acceptance 1–6. A PR for the S0 run carries **TIF-89** |
| MVD-005 | TIF-60 | **disagreement, escalated (2026-11-23):** the outer loop reports TIF-60 disagreeing with Linear; this repo has no Linear access and so cannot say what Linear now holds | keep the tag until the outer loop supplies the Linear id; no id is invented here |
| *(not a Discovery row)* | **TIF-52** is **not** claimed here | `docs/backlog/m1.md` records that its M1-022 heading previously carried TIF-52, which belongs to Foundry EF-003; that heading now reads `(TIF: unassigned)` | Discovery claims no part of TIF-52. Nothing to change in this file |
| (no markdown row) | — | TIF-86 (compare provenance, merged #203), TIF-103 (simulated notes, #215), TIF-106 (this reconciliation), TIF-107 (aliasing-bypass record), TIF-108 (compare nits) | Linear-only issues raised by review; they are tracked here by reference, not by a new MVD id |

PRs carrying a Linear id say so in the title: `TIF-89` for #210 and #213 (S0 prep and
the offline sequence), `TIF-86` for #203, `TIF-103` for #215.

Ids are stable; never renumber. `blocked_by` lists markdown ids. Owner roles:
`discovery-owner` (this thread), `build` (glm-5.3), `judgment`/verifier
(deepseek-v4.1-flash), `runtime` (Myco Desktop Runtime workstream), `foundry`
(Evaluation Foundry workstream), `outer-loop`.

Model policy (outer loop, 2026-11-21, superseded at the provider switch): owner and
judgment on Claude Sonnet (`claude-sonnet-5-5`); build subagents on Codex, backup
Antigravity; no Opus children; no kimi-k3. cheaperinference is exhausted.

---

## Mandate

The deliverable is **not a document**. It is a tested, working end-to-end
experience that shows why a developer chooses Myco over existing computer-use
tools, plus a recommended starting wedge backed by evidence. M1 established that
Myco can execute, verify, and recover one desktop operation. It did not establish
why anyone would choose it. The earlier "M2 = MCP/API" lock-in is retracted.

Three directions are investigated with **bounded proofs**, not three products:

- **A** — verified desktops for coding agents (executed under TIF-89; the old `TIF-53` label was stale).
- **B** — verified operations for existing business software without adequate APIs (TIF-54).
- **C** — branchable desktops for agent experimentation (TIF-55).

Head-to-head against real alternatives (TIF-59) and the recommendation + product
criterion (TIF-60) decide the wedge.

---

### MVD-001 (TIF: TIF-89 executes it) Direction A bounded proof: verified desktop for a coding agent
- **linear_state:** the Linear issue that executes this row is **TIF-89** ("Discovery
  S0 first live run"), reopened 2026-11-22 until the live run's evidence exists. The
  heading no longer carries a Linear tag, because `TIF-53` was stale and a future
  reader would have taken it. MVD-001's acceptance criteria below are unchanged, and
  #210 (S0 prep) and #213 (offline sequence) close neither this row nor TIF-89.
- **status:** design in progress. Host-dependent half blocked on the guest window
  (memory-gated, see TIF-106's sibling in `docs/coordination/mvp-discovery-state.md`)
  and on Foundry's trusted ingest.
- **owner:** discovery-owner (design, DX surface), build (implementation), foundry (task set + oracle)
- **blocked_by:** MVD-006 (host window), RT-first-path, RT-015
- **surfaces:** developer surface per `docs/product/dev-surface-decision.md` (SDK over
  MCP/stdio, thin CLI/SDK/MCP over one core); human output is a v0 Viewer trace (MVD-007).
- **description:** One OMP/coding agent, one Myco desktop, one real GUI task, end
  to end: the agent requests a desktop, installs and launches the dogfood
  `myco-todo` app (seeded persistence bug), exercises the GUI, and receives an
  execution report whose verdict comes from persisted state, not from the agent's
  claim. The task is DF-S01 (happy path) plus DF-S02 (find the seeded bug); the
  proof demonstrates a **false-success trap**: the UI says "saved N item(s)" while
  the store holds fewer.
  Public task set and oracle are Foundry-owned (MVD-006); this issue consumes them
  and must not implement its own verifier.
- **acceptance:**
  1. A fresh coding-agent session, following only a README, takes Myco from install
     to a `verified` or `refuted` report on DF-S01 in ≤15 minutes on the development host.
  2. DF-S02 run produces `refuted` with the missing items named from the persisted
     store; an agent claiming success on the same run is recorded as a false success
     by the oracle (not by the agent's transcript).
  3. The report contains schema-valid `trace.jsonl` + `result.json` and a
     human-readable summary that names the claim, the observed state, and the verdict.
  4. The same flow is driven from at least two ordinary coding-agent environments
     (OMP and one of Codex/Claude Code) with no Grok Bot / custom harness.
  5. Median wall-clock and model cost per run are recorded, with n and dispersion.
  6. One forced failure (kill app, or a wrong target) is recovered or reported
     `uncertain` — never `verified` — with the recovery events in the trace.

### MVD-002 (TIF-54) Direction B bounded proof: verified operation on business software
- **status:** design in progress. Execution blocked on the same host window.
- **owner:** discovery-owner (design), build, foundry
- **blocked_by:** MVD-006 (host window), RT-first-path, RT-015, RT-016
- **description:** A callable operation with a correctness guarantee on software
  that has no adequate API. Bound the proof to one operation: create/update a record
  through the UI, kill the app or the desktop mid-operation, then read the persisted
  state and report `verified`, `refuted` (and the operation not applied), or
  `uncertain` with the unresolved state — never a silent duplicate or a silent loss.
  Candidate surfaces, in order of availability: LibreOffice Calc plus the M1
  UNO/persisted-file oracle (no account, already exercised), then **LibreOffice
  Writer** as the second surface (m2-03: near-zero build cost, same UNO read,
  address becomes (table,"D3")); Notepad++ only if evidence of a non-UNO adapter is
  wanted. Office is licence-blocked. No account creation. Every receipt carries
  `application_commit: not_verified` unless the persisted file was read (m2-02).
- **acceptance:**
  1. On ≥10 trials of the same operation, including ≥3 interrupted mid-write, the
     outcome after recovery is `verified` or `uncertain`; 0 false successes; 0 silent
     duplicates (persisted record count checked host-side).
  2. The operation is callable from a coding agent as one request returning outcome +
     evidence; the caller never has to reason about UI steps.
  3. A written statement of what an "adequate API" would have done better and what
     Myco's guarantee adds, with the operation's domain oracle named.
  4. Cost per operation and per retry recorded; the unknown/uncertain rate recorded
     separately and never folded into success.

### MVD-003 (TIF-55) Direction C bounded proof: is branching worth it?
- **status:** design only. Needs fork/snapshot capability the runtime does not have
  (Q3: add `snapshot()` + `fork()` when fork/search lands) and host time.
- **owner:** discovery-owner (design), runtime (capability), build
- **blocked_by:** MVD-006, runtime fork capability
- **description:** Do not prove that branching is possible — Orgo already ships
  cloning and live forking. Test whether branching **improves verified completion**
  enough to justify its infrastructure cost, against the cheap alternative: replay
  from the last verified step (intent log). One task with a genuinely uncertain
  branch point (two plausible UI paths, one wrong), N attempts per arm:
  (a) linear retry from known-good, (b) fork 2–3 candidate states, run, keep the
  verified branch.
- **acceptance:**
  1. Paired comparison on the same task: attempts-to-verified, wall-clock, memory
     and disk overhead per fork; the exact test (paired sign test) and the
     underpowered statement, as in M1-015 §4.5.
  2. Kill criterion stated before the run: if fork does not beat intent-log replay
     by a pre-declared margin at equal or lower cost, C is deferred and the memo
     says so.
  3. Budget resets at the measured default (~21 s warm cold restore), not the 8.3 s
     live path, which wedges (m2-05). Orgo's documented fork/clone semantics are cited as the incumbent baseline;
     no claim of novelty for "branching exists".

### MVD-004 (TIF-59) Head-to-head on the same tasks, not feature lists
- **status:** research started (`docs/research/mvp-competitive-teardown.md`);
  executions blocked on Foundry task set/verifiers and on accounts/paid plans.
- **owner:** discovery-owner (research + protocol), foundry (task set + scoring),
  judgment (independent scoring)
- **blocked_by:** TIF-50 (fixtures), TIF-51 (verifiers), MVD-006
- **description:** Run the same public task set, initial states, and model settings
  across: screenshot-only control, Microsoft Hybrid Computer Use (MIT MCP server),
  Orgo (cloud VM + agent), Simular Sai (hosted agent), and Myco. Score on first-use
  setup, **independently verified** correctness (not reported success), failure
  recovery, repeatability, and economics. Ground truth and scoring are Foundry's;
  no hidden-test optimisation.
  Necessary extra arm, because it is the strongest fair competitor: **HCU + the
  agent's own shell/file verification** — a competent coding agent can check a JSON
  store itself. If that arm produces zero false successes on DF-S02, Direction A's
  differentiation is the durable test artifact and recovery, not one-off verification.
- **acceptance:**
  1. Every arm run on identical task parameters, initial state, and step budget; a
     per-trial table, not two aggregate rates; Wilson intervals and the sign test.
  2. Every "could not run" arm reports the exact blocker (account, paid plan, OS,
     licence); no arm is silently dropped and no competitor is handicapped by a
     deliberate misconfiguration.
  3. First-use setup measured as time-to-first-verified-result by a fresh agent
     following only public docs, with deviations recorded.
  4. Economics: wall-clock, model tokens/cost, infrastructure overhead per trial.
  5. The report states which numbers are comparable and which are not.

> Protocols, sample sizes and the VM slot request for MVD-001..005 are pre-registered in
> `docs/product/mvd-preregistration.md`.

### MVD-005 (TIF-60) Recommendation and product criterion
- **linear_state:** tag unchanged (the outer loop has not reported a move). If Linear
  ever splits this row, record the split here rather than editing the tag.
- **status:** provisional recommendation in `docs/product/mvp-discovery-plan.md`;
  final after MVD-004.
- **owner:** discovery-owner, judgment (independent review)
- **blocked_by:** MVD-001, MVD-002, MVD-004
- **description:** Decide the starting wedge and state the two MVP criteria:
  (1) technical — Myco reliably completes, verifies, recovers a supported workflow
  with reproducible evidence (with Runtime/M1); (2) product — someone can use Myco
  from an ordinary coding-agent environment, without the custom Grok Bot setup, and
  get a meaningfully better result than an existing alternative. "Meaningfully
  better" is defined in advance on the head-to-head axes, with a number.
- **acceptance:**
  1. A wedge recommendation with the evidence that decides it, the alternatives
     considered, and the assumptions that would overturn it (kill criteria).
  2. The product criterion restated as a testable protocol (who, environment, task
     set, metric, threshold, sample size), not as prose.
  3. Explicit statement of what Myco should **not** build (transport coverage that
     HCU/Cua already provide; features without a measured job).

### MVD-006 (TIF-61) Coordination: public task set + host window
- **linear_state:** the `TIF-61` tag has not been reported as drifting; the outer
  loop lists TIF-52/53/60 as the disagreements, and MVD-006 is none of them.
- **status:** **task set delivered; host window requested and queued, not granted.**
  The row's own acceptance also requires the window to be recorded "with start/end
  and owner" — that value does not exist yet, so this row is not closed.
- **delivered — task set (Foundry):** `src/foundry/tasks/bank.ts` holds the public
  bank (`ef-t01-add-four-items`, `ef-t02-rename-row`, `ef-t03-whitespace-value`,
  `ef-t04-delete-row`, plus `ef-t01b-add-four-items-noverify`); oracles live under
  `src/foundry/oracles/` and are hidden by path. Discovery consumes them and writes
  neither fixtures nor oracles. Foundry's answer to Discovery's S3 gap is
  `docs/foundry/answer-discovery-s3-gap.md`.
- **requested — host window (not yet granted):** the S0 request is recorded in
  `docs/coordination/mvp-discovery-state.md`, which says plainly that "the request
  is not assumed granted"; the queue slot is Discovery S0 in
  `docs/coordination/vm-queue.md`. The host-memory measurement that gates it lives in
  `docs/coordination/runtime-state.md` (`scripts/memory-budget.sh`). No start, end, or
  owner value is recorded, because no window has been handed over.
- **not this row:** the live Direction A run itself is MVD-001 / TIF-89, which stays
  open until its evidence exists.
- **owner:** discovery-owner; foundry (task set/verifiers); runtime (RT-011/RT-015/RT-016); M1 coordinator (host)
- **blocked_by:** none
- **description:** Two shared-resource dependencies that gate every proof:
  1. **Foundry:** agree the public task set and the oracle for `myco-todo`
     DF-S01/S02 plus the outage/recovery task for B, and the scoring procedure.
     Discovery does not write verifiers or fixtures.
  2. **Host:** request a bounded host window from the M1 Coordinator after the M1
     sweep: runtime first path (RT-011), host-side guest file read (RT-015), process
     control (RT-016), then the Direction A run. No VM is started before sign-off.
- **acceptance:** Foundry's task ids and oracle paths are recorded here; the
  coordinator's host window is recorded with start/end and owner; no run starts
  outside it.

### MVD-007 (TIF-62) Developer-facing run report: the v0 Myco Viewer
- **status:** **done**: Viewer v0 merged as PR #69 (`e0b5a9e`), approved by Tiffany 2026-11-21 22:39 ET (`viewer/DEVIATIONS.md`). The earlier standalone HTML renderer (`src/report`, `docs/report`) is
  **retired**: it predated the locked GUI spec and deviated from it (no Now/Why/Proof
  modes, no tokens, own layout). The deliverable is now the v0 Myco Viewer defined by
  `docs/design/gui-spec.md` (PR #51), built to the spec, not a Discovery-specific UI.
- **owner:** discovery-owner (brief, journeys), build (Codex), outer-loop (spec review)
- **blocked_by:** none for v0 (opens the three real M1 runs in
  `docs/research/experiments/m1-013-session1/`); Direction A's own trace needs MVD-001.
- **description:** Direction A's human-facing output is a v0 Viewer trace. Scope is the
  §9 v0 cut line only: open one trace offline, Verdict Bar, Proof (Comparator, Checks,
  Failures and recovery), Why (step list, Inspector, Scrubber). Now, branches, compare,
  replay, live are v1+ and are not built.
- **acceptance:** gui-spec §11 in full, including 1440x900 screenshots of each state,
  the verdict-mapping unit tests against the M1 sample runs, and journeys J1-J3 by
  keyboard. Any deviation needs written outer-loop sign-off in the PR.

### MVD-008 (TIF-63) Viewer: screenshot latency and memory at 1,000 screenshots; Chrome Stable check
- **status:** in progress (GO from the outer loop, 2026-11-21). Follow-up from Viewer v0 (PR #69), not blocking v0; needs no VM and no host-time grant. The Chrome Stable result is Tiffany's and is a placeholder in `viewer/PERF.md` until she supplies it.
- **owner:** discovery-owner (spec), build; outer-loop mirrors this item into Linear (agents do not create issues).
- **description:** gui-spec §8 budgets that Viewer v0 never measured: full screenshot shown on
  select (<=100 ms cached, <=250 ms cold, thumbnail first) and memory with 1,000 screenshots
  (<=400 MB; LRU 64 full bitmaps; thumbnails only for visible +-20). Also a Chrome Stable
  spot-check by Tiffany (the build environment could not launch Chrome Stable; v0 was measured on
  Playwright's headless Chromium).
- **acceptance:** a generated run with 1,000 screenshots (outside the repo, via the Foundry
  fixture generator or a documented script); measured cached/cold select latency and peak memory
  with N>=15 and the machine described; results in `viewer/PERF.md` against the §8 numbers; any
  budget miss reported plainly; Chrome Stable result recorded.

### MVD-009 (TIF-64) Viewer: find and bound the retained native renderer memory with many screenshots
- **status:** **done** (memory gate closed and met). Follow-up from MVD-008 (PR #80, TIF-63 Done); outer-loop mirrors this item into Linear (agents do not create issues).
- **owner:** discovery-owner (spec), build
- **description:** With 1,000 step-linked 1440x900 screenshots the Viewer's renderer retains about
  0.9 GB of native memory on Playwright's headless shell that GC, a JS-memory purge and a critical
  memory-pressure notification do not release, and it grows about 0.4 MB per distinct step viewed
  (gui-spec §8 budget: 400 MB). App-held state is small (JS heap ~17-42 MB, 12 full-image URLs,
  ~35 thumbnail URLs). Isolate the cause (suspects: Chromium decode/resource caches; worker
  allocator retention of full-size PNG decodes, including the thumbnail path) and bound it in-spec
  (e.g. resize thumbnails without a full decode, release decoded images, or bound the retained set).
- **acceptance:** the root cause named with evidence; peak and settled renderer memory re-measured
  with the MVD-008 harness (`viewer/scripts/screenshot-bench.mjs`) on the same run with N>=15 and
  the machine described; budget status stated plainly (met, missed, or undecidable) including
  Tiffany's Chrome Stable result when she supplies it; no regression of the 10,000-step verdict
  guard or of select latency; the 12-entry effective cache and the truncated-PNG behaviour
  decided or fixed.
- **outcome:** Gate **CLOSED and MET**. Bounded display-sized bitmap cache to 16 entries (16 MiB cap)
  in `viewer/src/components/Screenshots.tsx`.
  - **Google Chrome Stable (157.0.8103.79):** Peak renderer footprint **350,081,848 B** (~350.1 MB, ≤ 400 MB gate),
    settled renderer footprint **349,688,632 B** (~349.7 MB, ≤ 400 MB gate), peak 16 full bitmaps, 39.3 MB JS heap.
  - **Chromium Headless Shell (159.0.8154.6):** Settled total physical footprint **395,924,760 B** (~395.9 MB, ≤ 400,000,000 B gate),
    settled renderer footprint **314,378,472 B** (~314.4 MB), peak renderer footprint **353,749,176 B** (~353.7 MB).
  - **Select Latency:** Cold select median 43.6 ms (max 55.2 ms, budget ≤250 ms), cached select median 32.2 ms (max 33.9 ms, budget ≤100 ms),
    scrub drag median 33.4 ms (budget ≤250 ms), first-frame preview 15/15 (100%), median 9.6 ms.
  See [the measurement record](../../viewer/PERF.md#screenshots-bounded-retained-memory-mvd-009--tif-64).

### MVD-010 (TIF-65) Viewer: simulated/dry-run run indication and filmstrip frame spacing review
- **status:** **done** (PR #94 merged, commit `1029c03`). Follow-up from Direction A dry-run review (PR #93, MVD-001); outer loop mirrored to Linear TIF-65.
- **owner:** discovery-owner, build
- **blocked_by:** MVD-001
- **description:** Direction A runner generates simulated runs with placeholder step frames. The archive must carry an explicit simulated/dry-run flag, and the Viewer must visibly render a "Simulated" badge next to the run identifier so users do not mistake simulated runs for live desktop execution evidence. Additionally, check filmstrip thumbnail spacing on sparse runs against gui-spec §2.8 and clamp edge thumbnail positioning to prevent negative-offset clipping.
- **acceptance:**
  1. Archive manifest (`manifest.json`) and run record carry `simulated: true`.
  2. Viewer VerdictBar and RunsSidebar display an in-spec `Simulated` badge next to the task/run name when `simulated` is set.
  3. Filmstrip thumbnails in Scrubber clamp within visible bounds (`[0, width - thumbWidth]`), eliminating negative offset clipping on the first frame.
  4. Vitest unit tests cover simulated badge rendering and manifest parsing.
  5. Playwright headless verification script captures updated 1440x900 screenshots with the badge rendered.

---

## Review findings and incidents (Linear-only ids)

Raised by review, not by the original plan. Recorded here by reference so the repo
carries the evidence even though the issue lives in Linear.

### TIF-107 — verifier FAIL: live-runner evidence aliasing (fixed in #187)
- **status:** fixed and merged (`5c10cd3`, PR #187); this entry is the record.
- **what happened:** the injected verifier received the same `items` array that the
  runner had aliased into its own `persisted` evidence. A verifier that mutated its
  input could erase `missing` and force `verified` on a run whose store had dropped
  items — a false success produced by the verification boundary itself.
- **how it was found:** the round-2 verifier of PR #187 constructed the mutation and
  reproduced `status: verified` on a store that persisted nothing.
- **fix:** snapshot `persisted` before calling the verifier, and pass copies of both
  the store and the intent; a hostile-verifier test now fails if the copy is removed.
- **residual:** the runner still trusts the verifier's verdict. The contradiction
  guard downgrades `verified` to `uncertain` when the store is missing items, which
  is the second line of defence, and it is tested.

### TIF-108 — compare-surface deferred nits (open)
- dead `[data-report-open]` CSS block and its `reportOpenMaxWidth` token (the screen
  it styled was removed in #203);
- report-load failures reuse the run-specific heading "Can't read this run";
- no test pins the Not-run `<th scope="col">` headers or the report `h1` tag.

### TIF-86 / TIF-103 — compare provenance and simulated notes (done)
- TIF-86: #203 merged `60484fe`. TIF-103: #215 merged `56f9c20`.

## Dependencies owned by other workstreams

| Dependency | Owner | Status |
|---|---|---|
| Runtime first end-to-end path (create→observe→act→evidence→reset→destroy) | Runtime (RT-011 / RT-first-path) | not passed; host-gated |
| Host-side guest file read (REQ-08) | Runtime RT-015 | pending |
| Process kill/relaunch (REQ-09) | Runtime RT-016 | pending |
| Public task set, fixtures, verifiers, scoring | Foundry (TIF-50/51/58) | being launched |
| M2 research round (competitor teardown, API design, app #2) | Research Coordinator | feeds MVD-004/MVD-002; do not duplicate |

## Out of scope

- Building a second runtime or a competitor harness.
- Writing Foundry-owned fixtures or verifiers.
- Paid plans, competitor accounts, MCP subscriptions, host reboots, settings changes.
- Claiming a public benchmark score; MVD-004 is an internal head-to-head on a public
  task set, not a leaderboard entry.