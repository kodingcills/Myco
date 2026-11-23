# Myco Evaluation Foundry backlog

Canonical in-repo backlog for the Evaluation Foundry (project P-TIF-6, team TIF). The
outer loop mirrors this file into Linear; agents do not call Linear
(docs/agents/issue-tracker.md). Ids are stable; never renumber.
Owner roles: `foundry-owner` (this workstream), `verifier` (independent, per sub-thread),
`outer-loop`. Contracts: [../foundry/contract.md](../foundry/contract.md).

**Dependency rule (Tiffany, 2026-11-21):** EF-001 and EF-002 must exist before any
implementation team optimizes against Foundry tasks. EF-003, EF-004 and EF-005 are blocked
on both. MVP Discovery's head-to-head (TIF-59) is blocked on the same two and consumes
EF-001/EF-002 only; it does not own fixtures or hidden tests.

---

### EF-001 (TIF-50) GUI-required task fixtures where visible success can disagree with persisted state
- **status:** **done** (PR #110 merged d09f209, verified PASS at e802a19 after three
  verifier rounds). Four `myco-todo` fixtures across four defect classes, each with a
  statement-level screen-vs-store disagreement assertion; seed task is the extended dogfood
  app. Contract: docs/foundry/contract.md §3. Fixture
  manifests + builder/loader under `foundry/tasks/`; public task bank in
  `src/foundry/tasks/`. Seed task is the extended `myco-todo` GUI-disagreement family; further
  application-specific tasks follow the same contract.
- **owner:** foundry-owner
- **blocked_by:** none
- **description:** Fixtures where the on-screen result and the persisted result are designed
  to disagree, each recording the literal screen strings an agent is likely to trust. A
  verifier that trusts the screen must fail; an independent state oracle must reject. Tasks
  must not be correctly solvable by file I/O alone (trace guard, contract §5). Reuse and
  extend the dogfood `myco-todo` planted-bug app as a seed, then add more app-specific tasks.
- **acceptance:** ≥4 fixtures across ≥2 distinct persisted-state defect classes (silent drop,
  stale persisted row, wrong-value normalization, partial multi-file write), each with a
  manifest whose `screenClaimsToTrap` strings are asserted present by a test; a fixture-level
  test proves each initial state differs from its expected end state; a trace-guard test
  proves a file-only edit is refuted and a GUI-act path is not; the seed task's `myco-todo`
  bug contract is proven by a test, not only described in a docstring.

### EF-002 (TIF-51) Application-specific state verifiers and ground truth
- **status:** **done** (PR #110 merged d09f209, verified PASS at e802a19). Derived ground
  truth, three-valued verdicts, mutation audit (7 hand-written near-misses refused, unmutated
  run still verified), hidden-split commitment regenerated. An independent probe found the
  stale-row defect could not fire and a rename was accepted in the wrong position; both are
  fixed, and the save path now has five cases (no-op, add, delete, rename, rename-after-add)
  each asserting the store and the screen. State oracles under `src/foundry/oracles/`
  (hidden by path, contract §6); mutation audit in `test/foundry/`.
- **owner:** foundry-owner
- **blocked_by:** EF-001
- **description:** Verify persisted state, not the GUI's self-report. Report `unknown` when
  necessary evidence is unavailable. Every initial workflow needs an explicit verifier or a
  supported state oracle. Answers must not leak into implementer-facing traces: `expected()`
  reads intent + initial state only (no-leak rule, contract §4).
- **acceptance:** every EF-001 fixture has a state oracle; an unreadable/corrupt persistence
  file yields `uncertain`, never `refuted` and never `verified`; `expected()` never observes
  agent output (proven by a test that runs against an agent-mutated state and gets the same
  expected answer); a mutation audit (WorkArena's method) proves the oracle refuses
  hand-written near-miss end states — including the two that a GUI-trusting verifier accepts;
  the hidden split has separate roots and an import test proves `src/` cannot reach it.

### EF-003 (TIF-52) Fault injection for GUI-specific failure modes
- **linear status:** **partial** (matches Linear; this doc uses the same word deliberately —
  a doc that says "in progress" while Linear says "partial" is the drift this entry exists
  to prevent).
- **status:** **partial — six classes built and verified** (PR #122 merged c37d944, verifier
  PASS at 91c3371): stale-ui, interrupted-write, partial-persistence, crash-mid-save,
  permission-denied, and **autocorrect-rewrite** on the Writer table family
  (`src/foundry/tasks/writer.ts`, `src/foundry/oracles/writer.ts`), wired into the public
  task bank as `ef-t05-writer-total`. **Remaining and blocking "done":** the 30-corrupted-trial
  run and its zero-event bound, which needs VM time; and a live Writer/UNO read to replace the
  model, which needs the same.
- **owner:** foundry-owner
- **blocked_by:** EF-001, EF-002
- **description:** Failures that a screenshot-only agent mishandles: interrupted writes, stale
  UI, partial persistence, crashes mid-save, permission errors. Grounded in the failure
  taxonomy of OpenComputer (arXiv 2605.19769) and OSWorld 2.0 (arXiv 2606.29537 /
  <https://osworld-v2.xlang.ai/>) — see docs/research/findings/f1-ef-fault-taxonomy.md.
  The M1 corrupted-trial spirit (zero false successes) applies, but faults must be
  application- and GUI-specific, not only file corruption.
  **Corrupted-trial count (M2 statistics):** zero false successes in 10 trials bounds the
  true rate only below 25.9%; **30 corrupted trials** is the smallest count that bounds it
  below 9.5% (docs/research/benchmark-survey.md §7.2). EF-003 reports `scoreClaim()`
  caveats verbatim rather than a bare "0 false successes".
- **acceptance:** ≥5 fault classes, each producing a state where the screen and the persisted
  state disagree in the class's stated way; each has a golden trace proving the fault armed;
  every fault's ground truth is derived host-side from the schedule + intent; a fault that
  leaves no forensic trace is rejected; zero false successes across the faulted suite, with
  the trial count and its zero-event bound reported; **a Writer AutoCorrect class** (M2-03)
  because it is a silent in-app mutation Calc cannot produce.

### EF-004 (TIF-57) Evidence collection, blind scoring, and a hidden test split
- **status:** in progress (below)
- **owner:** foundry-owner
- **blocked_by:** EF-001, EF-002
- **description:** Graders must not treat the system-under-test's self-reported success as
  ground truth. Blind order: state read → oracle verdict → transcript attached after. Hidden
  split held out of implementers' reach by separate path, permissions, and owner review.
- **acceptance:** a run whose transcript claims success with a refuted state verdict scores
  `false-success`, and the reverse (claims failure, verified state) scores `verified` with a
  note; evidence records `verdict`, `stateOracle`, `screenOracle`, `traceGuard`, and the
  version triple; the hidden root is unreachable from `src/` (import test) and from the arm's
  environment (path test); a score report cannot be produced without its version triple.

### EF-005 (TIF-58) Baseline harness on the same tasks
- **linear status:** **in progress** for the original harness scope. **Later work is
  TIF-74** (see EF-006 below): the live transports, the trusted ingest, and the attestation
  gate are tracked there, not here. This entry keeps the arm registry, the reference
  policies, the paired comparison and the economics column.
- **status:** in progress
- **owner:** foundry-owner
- **blocked_by:** EF-001, EF-002
- **description:** Screenshot-only first. Microsoft Hybrid Computer Use (MIT, public repo)
  where the open-source repo permits. Orgo and Simular Sai only without account creation or
  paid spend; otherwise queue an escalation and record exactly what could not be run.
  Metrics: first-use setup, independently verified completion, failure recovery,
  repeatability, economics.
- **acceptance:** a screenshot-only arm scored on the identical fixtures, initial states,
  oracle versions and fault schedule; per-arm setup cost (wall-clock + steps) recorded; the
  economics column states the marginal cost or "blocked: account required"; escalation rows
  name the exact blocker for each arm not run; no arm's self-report is used as ground truth.
  **Trial-count honesty (M2 statistics):** the arm comparison is reported as a paired
  per-trial table with a sign test, and the report states "underpowered" when discordant
  trials are too few — the smallest significant result is **6 of 6** discordant, all one way
  (p = 0.031); 5 of 5 gives p = 0.0625 and proves nothing. A *split* result needs far more:
  the smallest significant total is 9 at an 8-to-1 split, and an even split proves nothing at
  any size (`src/foundry/baseline/compare.ts` enforces this and refuses to name a winner
  outside the bound).
  **Reset budget:** plan at ~21 s per cold restore (`scripts/reset-trial-vm.sh` default), not
  the 8.3 s live path; 100 trials is ~35 minutes of reset, so statistical power is affordable
  and the real cost to optimise is verification.

### EF-006 (TIF-74) EF-005 later work: live transports, trusted ingest, attestation
- **linear status:** **in progress** (Linear tracks this as TIF-74; EF-005/TIF-58 keeps the
  original harness scope).
- **owner:** foundry-owner
- **blocked_by:** EF-001, EF-002
- **description:** The work that turns the offline harness into something a live arm can run
  and a decision can trust. Split out of EF-005 because it is a different kind of work: the
  harness scores a model, this makes a real run gradeable and its evidence admissible.
- **delivered (merged):**
  - `src/foundry/baseline/recorder.ts` — the producer for the recorded-evidence schema the
    discovery grader already reconciles (PR #171).
  - `src/foundry/baseline/executor.ts` — the arm-facing `LiveTransport` runner: budget,
    action attribution, transport failure → `incomplete` (PR #171).
  - `src/foundry/baseline/compare.ts` — paired per-trial comparison with the exact sign test
    (PR #171).
  - `src/foundry/baseline/guest.ts` + `todo-transport.ts` — `GuestProtocol`, a fake guest
    driving the real app model, and the todo transport with the `myco-agent` adapter
    (PR #189).
  - `src/foundry/baseline/attest.ts` — `SaveObserver` and the `attest()` gate (PR #192).
- **remaining, and why it is not done:**
  1. **A live `LiveTransport`** for the todo app on the same guest the Myco arm uses. The
     harness is app-agnostic; this is one protocol implementation. Needs VM time.
  2. **A genuinely independent observer.** `offlineObserver` hashes bytes it is handed,
     which tests the gate's contract but not its premise. Needs a second guest connection.
  3. **The fixture-identity decision** (see EF-007): `attest()` takes the fixture as an
     argument, so a caller can pass the real `fixtureId` with a benign `persistenceFiles`.
     No function can verify its own inputs' provenance; the fix is where the gate runs.
  4. **Wiring `attest()` into `scoreDiscoveryTrial`.** This is the change that turns a
     descriptive row into a decision input. It must not land before item 3 is decided.
- **acceptance:** a live arm runs on grader-supplied hidden pairs through `executeTrial`; the
  observer is a second channel, not a function the arm can call; `attest()` is wired in and
  a run whose state oracle refutes can never be decision-eligible; the eligibility flip has
  its own Tier 2 verifier PASS at the exact head.

### EF-007 (TIF-114) Decision: where the attestation gate runs
- **linear status:** **decided 2026-11-22 — option 1** (resolve the fixture from the hidden
  commitment), implemented in PR #211.
- **owner:** outer-loop (decision), foundry-owner (implementation)
- **blocked_by:** none
- **description:** `attest()` (EF-006) takes the fixture as an argument and the observations
  as an argument. A caller can therefore pass the real `fixtureId` with a benign
  `persistenceFiles`, or supply observations and final bytes together, and a match between
  two things the caller controls proves nothing. This is not fixable inside the function:
  no code can verify its own inputs' provenance. Two options, both about *where* the gate
  runs:
  1. **Resolve the fixture from the hidden commitment.** The ingest looks the fixture up
     itself and rejects any whose hash does not match `foundry/hidden-commitment.json`.
     Cheaper, testable offline.
  2. **Run the ingest out of the arm's reach.** A separate process the arm cannot call, with
     `attest()` not exported to arm code. Stronger guarantee, more moving parts.
- **acceptance:** a recorded decision naming one option, with the reason; the chosen option
  implemented and tested; `attest()` cannot be satisfied by caller-supplied provenance under
  the chosen design.

### EF-008 (TIF-113) Slot 5: Microsoft Hybrid Computer Use GUI arm
- **linear status:** **filed as TIF-113**. Slot 5 is
  currently documented only inside TIF-58's handoff note
  ([docs/foundry/hcu-slot-5.md](../foundry/hcu-slot-5.md)), which means a run that needs its
  own GO, its own spend cap and its own evidence has no issue to be tracked against.
- **owner:** foundry-owner
- **blocked_by:** EF-001, EF-002, Coordinator GO, a VM slot
- **description:** Run Microsoft Hybrid Computer Use's `GUI` channel only (no `AX`, no shell)
  over the 30 normal Calc record-edit trials in the finalized M1 v3 parameter order, as a
  descriptive reference alongside C1. HCU is a computer layer, not an agent, so the planner
  must be named in every row or the result is not a result. Spend cap **$0**; pause on quota
  rather than swapping models.
- **what exists:** the adapter boundary and offline acceptance checks are written
  (`hcu-slot-5.md`); the evidence schema accepts an `hcu` sub-arm identity (PR #102); the
  frozen v3 inputs were verified offline (both SHA-256 hashes matched, all 30 rows joined).
- **what is missing:** a Windows ARM64 bundle with a pinned revision and hash; a live GUI-only
  transport; a planner confirmed within the $0 cap; and the Coordinator's GO.
- **acceptance:** the spike result recorded with evidence (a screenshot and a typed value
  persisted, or the exact structured refusal code); 30 trials scored by the shared blind
  judge on independently captured workbook evidence; skipped and unfinished trials reported
  separately; the report names the planner and states that HCU is a layer, not an agent.

### EF-009 (TIF-115) Hardening: run the attestation gate out of the arm's reach
- **linear status:** **filed as TIF-115**. Follow-up to TIF-95, which took the cheap half of
  the isolation option.
- **owner:** foundry-owner
- **blocked_by:** EF-006 (TIF-74)
- **description:** TIF-95 closed the fixture-identity hole by resolving the fixture from the
  hidden commitment, and stopped exporting `attest()` to arm-facing code with a transitive
  import-closure test. That is a boundary, not isolation. The exploit is recorded in PR #211
  as a known limit: `attestedBrand` is an own symbol property and
  `Object.getOwnPropertySymbols` is public API, so a caller holding any real attestation can
  copy the symbol onto a fresh `{ eligible: true }` and `isAttestation` accepts it. **No
  in-process fix can bind** — nothing inside the process distinguishes a copied symbol from
  one the module set. Full isolation means the ingest runs in a process the arm cannot call,
  with the observations produced by a second guest connection rather than a function the arm
  invokes.
- **acceptance:** the ingest runs as a separate process with no shared memory or module
  handle reachable from arm code; the observer is a second guest connection, not
  `offlineObserver`; a test proves arm code cannot reach the gate even by dynamic import; the
  import-closure test from TIF-95 is retained as a cheap first line.
