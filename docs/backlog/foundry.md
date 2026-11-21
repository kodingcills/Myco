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
- **status:** in progress (2026-11-21). Contract: docs/foundry/contract.md §3. Fixture
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
- **status:** in progress (2026-11-21). State oracles under `src/foundry/oracles/`
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
- **status:** blocked
- **owner:** foundry-owner
- **blocked_by:** EF-001, EF-002
- **description:** Failures that a screenshot-only agent mishandles: interrupted writes, stale
  UI, partial persistence, crashes mid-save, permission errors. Grounded in the failure
  taxonomy of OpenComputer (arXiv 2605.19769) and OSWorld 2.0 (arXiv 2606.29537 /
  <https://osworld-v2.xlang.ai/>) — see docs/research/findings/f1-ef-fault-taxonomy.md.
  The M1 corrupted-trial spirit (zero false successes) applies, but faults must be
  application- and GUI-specific, not only file corruption.
- **acceptance:** ≥5 fault classes, each producing a state where the screen and the persisted
  state disagree in the class's stated way; each has a golden trace proving the fault armed;
  every fault's ground truth is derived host-side from the schedule + intent; a fault that
  leaves no forensic trace is rejected; zero false successes across the faulted suite.

### EF-004 (TIF-57) Evidence collection, blind scoring, and a hidden test split
- **status:** blocked (design started in `src/foundry/oracles/blind.ts` + contract §6)
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
- **status:** blocked
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