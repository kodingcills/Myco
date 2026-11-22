# Evaluation Foundry — contract (EF-000)

Status: **proposed**, 2026-11-21. Owner: Evaluation Foundry (project P-TIF-6, team TIF).
Linear: TIF-50 (EF-001 fixtures), TIF-51 (EF-002 verifiers), TIF-52 (EF-003 faults),
TIF-57 (EF-004 evidence/blind scoring/hidden split), TIF-58 (EF-005 baselines).
Canonical backlog: [docs/backlog/foundry.md](../backlog/foundry.md).

This document is the *interface* every Foundry deliverable answers to. It exists because
M1's evaluator and fault injection were written by the same team that wrote the runtime,
and that is enough for a demo but not enough for a scoreboard. The Foundry is
independent of the runtime workstreams on purpose: it builds the tasks, the ground truth,
the faults, and the scoring *before* anyone can tune against them, and it gives the
runtime team only what they are allowed to see.

Nothing here runs against `myco-win11`, starts a VM, spends money, or creates an account.
Fixtures and verifiers are pure functions over files, so they are buildable and testable
on this Mac while the M1 sweep holds the host. The M1-013 sweep's EXCLUSION RULE is
honoured: no guest is touched by anything in this directory.

---

## 1. The defect this closes

Four concrete failure shapes are reproducible today, in this repo:

| # | Failure shape | Where it lives now |
|---|---|---|
| D1 | The GUI says saved; the record is wrong or missing. | `dogfood/apps/myco-todo`'s `BUG`-prefix drop, described as a "seeded bug" with no test that proves the app *reports* success. |
| D2 | The task can be solved without the GUI. | No task in the repo forbids direct file I/O, and nothing detects a store that advanced with no GUI acts. |
| D3 | The verifier trusts the thing under test. | `docs/backlog/m1.md` M1-021 acceptance (i) is the only place a transcript is checked; every task elsewhere has one positive assertion and no negative one. |
| D4 | The fault classes are generic. | M1-010 ships kill-app / invalid-target / delayed-save / focus-change — all application-agnostic. M1's first four faults could all be passed by a tool that never looks at the screen. |

Every EF-001..EF-005 deliverable is scored against these four. A fixture that cannot
produce D1 is not a Foundry fixture; a verifier that can be satisfied by D3 is not a
Foundry verifier.

## 2. Two oracles, and why both

> **A task passes only when the persisted-state oracle says the intent is satisfied
> AND the screen does not claim it is satisfied when it is not.**

Two independent readers, two different questions:

| Oracle | Reads | Answers | Written by |
|---|---|---|---|
| **State oracle** (primary) | The persisted application state — bytes on disk, parsed by the app's own format | "Is the requested outcome actually in durable storage?" | Foundry. Cannot consult the screen, the agent's report, or the transcript. |
| **Screen oracle** (trap) | The rendered screen (accessibility text or pixels, whichever the arm can see) | "Does the screen assert an outcome that the state oracle contradicts?" | Foundry. Cannot consult the persisted state. |

Verdict table for a trial, where `S` is the state oracle and `U` is the screen oracle:

| `S` | `U` | Verdict | Ledger state | Why |
|---|---|---|---|---|
| satisfied | no contradicting claim | `verified` | `pass` | The only success. |
| satisfied | contradicting claim | `verified` | `pass` | The work is right; the UI lies. The *fixture* records a `ui-claim-mismatch` observation, but the trial passes — an agent is not punished for an app bug it could not see through. |
| not satisfied | contradicting claim (says done) | `refuted` | `failure` — **false success** if the agent claimed it | The target defect D1. |
| not satisfied | no claim either way (silent) | `refuted` | `failure` | Ordinary incomplete work. |
| any | **could not look** | `uncertain` | `uncertain` | ADR-0002. Never collapsed into either side. |
| state **unreadable / corrupt** | any | `uncertain` | `uncertain` | D3: the verifier must not refute-by-default on a read failure. |

`uncertain` is the honest answer and it is *scored*. A task whose oracle is `uncertain`
more than half the time is a broken task, and the report must say so — a suite that hides
its unreadable trials behind a pass rate is the same disease as a UI that reports "saved".

## 3. Fixture contract

A fixture is **data plus a loader**, not code the evaluator executes.

```ts
export interface FixtureManifest {
  fixtureId: string;            // stable, e.g. "ef-todo-drop-bug-v1"
  app: AppId;                   // which app-under-test the loader is for
  version: number;              // bump on ANY semantic change; see §7
  description: string;          // one paragraph, what a human sees on screen
  initialStatePath: string;     // relative to the hidden split root
  persistenceFiles: string[];   // the files the app writes; relative paths
  screenClaimsToTrap: string[]; // the exact on-screen strings an agent may trust
  mustNotBeSolvableBy: ("file-io" | "shell-exec")[]; // checked by the trace guard (§5)
}
```

Rules that make a fixture a fixture:

1. **The initial state is a real file in the app's own format**, generated by a scripted
   builder from a seed. No two trials share a seed. The builder writes only through the
   app's persistence layer (`save_items`, `write_workbook`, …), never by hand-rolling the
   format, so the seed and the loader cannot drift.
2. **The app is the only writer the task permits.** The task prompt names a user-visible
   intent in the user's own words. It never names a file path that could be written
   directly, and the trial's trace guard (§5) refutes any run whose persistence file
   changed without a corresponding GUI act.
3. **The screen claims are recorded, not implied.** `screenClaimsToTrap` is a list of
   literal strings the fixture guarantees will be visible when the trap fires (e.g.
   `saved 4 item(s)`). The screen oracle matches *these*, so a change to the app's status
   text breaks the fixture loudly (version bump) rather than silently passing D1.
4. **Fixtures do not contain the answer.** The expected persisted state is *derived* (see
   §4), never stored in the fixture. A fixture directory is safe to hand to a builder.
5. **The initial state is not the answer.** A trial's initial file must differ from the
   expected end state by at least one observable field, or the task is free.

## 4. Verifier contract and the no-leak rule

```ts
export interface StateOracle<TState> {
  readonly app: AppId;
  readonly version: number;
  /** Reads persisted state; throws PersistedStateReadError when it cannot look. */
  read(files: Record<string, Uint8Array>): TState;
  /** Derives the expected end state from intent + initial state. Never reads the guest. */
  expected(intent: TaskIntent, initial: TState): TState;
  /** Compares, and returns a per-check verdict; `null` = could not check. */
  compare(actual: TState, expected: TState): OracleCheck[];
}
```

The **no-leak rule** is the single most important property in this document:

> **`expected()` may read the intent and the initial state. It may not read anything the
> agent produced.** If the answer can be computed after the agent has finished by looking
> at what the agent produced, the task is a tautology.

This mirrors OSWorld's `employee_age_reference` discipline (gold outside the guest,
docs/research/eval-frameworks.md §1.2) and OpenComputer's verifier-grounded design
(arXiv 2605.19769: "app-specific state verifiers that expose structured inspection
endpoints over real applications"). It is enforced mechanically: `read()` and
`expected()` take different argument types, and a fixture's builder test asserts
`expected(intent, initial) !== initial`.

The second no-leak rule concerns the *hidden split* (§6): answer derivation lives in the
state oracle, which is loaded only by the grader. The task bank an implementer receives
contains the task, the fixture builder, and the screen claims — never the oracle's
`expected()` output.

## 5. Trace guard — the anti-file-IO detector

D2 is closed the same way M1-012's ledger closes false successes: by an assertion that
cannot be satisfied by the output alone.

A trial's evidence stream (`trace.jsonl`, M1-012 schema) is replayed by a **guard** that
answers: *did the persistence file change only in ways reconcilable with recorded GUI
acts?* The guard refutes a run when

- a persistence file's content changed and the trace records no GUI act in the window
  between the last observation and the save, or
- the trace records `write_file` / `shell-exec` touching a path in `persistenceFiles`, or
- the persisted content equals the expected end state but the app was never launched.

**Known limits (tested or tracked, not hidden).** The guard sees only what the trace
records. (a) A write the runtime fails to record (an unrecorded `shell-exec`) is invisible to
the `file-write` clause. (b) With no `save-observed` event nothing is compared, so the result
is `clean`; the oracle's `added_at` provenance check is then the only backstop, and a
hand-written store can forge `added_at`. (c) After any later GUI act the guard treats a changed
file as explained, even if the change was a direct edit between acts. These are why the
guard is one of two independent checks, never the sole defence, and why a pixel-only or
sandbox-level file-write audit remains EF-003 follow-up work.

The guard is a *task property*, not a runtime property. It lives with the fixture, it is
tested by the Foundry, and it is applied to every arm (Myco, C1, C2, HCU, Orgo, Sai)
identically. An arm that only has pixels has nothing to reconcile — which is fine, because
a pixel arm cannot upload a file without a GUI act either; the guard's first clause simply
never fires for it.

### Discovery comparison evidence

Discovery's public grader produces descriptive results. Every row is ineligible for
the pre-registered decisions. This entry point has no trusted ingress for live
artifacts. The public prompt hash checks task catalog identity. Decision eligibility
requires a grader-owned hidden commitment, distinct seeded hidden task/fault pairs
matched across arms, and evidence of the actual delivered prompt bound to each run.
The trusted ingest must also bind planner settings, trace, recorder closure and
effect audits, independent save observations, and final persisted bytes to that
same run. Caller-supplied claims about this provenance cannot establish eligibility.

The Discovery guard trace requires one ordered `tool-call` marker and one complete
effect audit per inventory entry, with matching call IDs and channels. GUI actions
refer back to their recorded GUI call. Scored rows retain audited reads of watched
persistence with their call ID, channel, and position in the input trace. This
locates the call in the trace. Live measurement still requires a recorder that
captures all accesses and establishes when reads completed before the arm finished.
Direct file and shell writes to watched files enter the trace guard. For HCU+shell,
final watched bytes must match the last independently observed save, including
when another GUI action follows it. A missing or incomplete observed save cannot
support a verified score. The grader can check snapshot contents and sequence.
Independent capture remains a live recorder requirement.

Create one comparison with `createDiscoveryComparison` and reuse it for subsequent
batches, including after quota exhaustion. It snapshots the settings and checks
them alongside the pinned `claude-sonnet-5-5` model. Durable resume across processes
requires the trusted runner to persist the original comparison configuration. The
original add-four-items prompt and `ef-t01b-add-four-items-noverify` share a fixture
and intent and have distinct task IDs and prompt hashes in scored evidence.

## 6. Hidden split and blind scoring

The split is **two roots, not one root with filters** (filters leak by accident), and it
is enforced by a CI test rather than by convention:

```
src/foundry/
  types.ts           # public: shared contract, no answers
  screen.ts          # public: the trap reader (declared strings only)
  guard.ts           # public: trace guard
  baseline/          # public: arm interface, scripted policies, registry
  tasks/             # public: task text, fixture builders, app model, screen claims
  grader/            # grader-side: assembles baseline trials and scores reports
  oracles/           # grader-side: persistent-state oracles and blind scoring
  hidden-split/      # grader-side: generator and commitment checks (seed stays out of tree)
```

`test/foundry/split.test.ts` rejects imports from public `src/` modules into grader modules,
including re-exports. The host harness runs trusted reference policies in process. A live
arm requires a separate process and an environment that omits the hidden seed path.

Enforcement, strongest first:

1. **Path**: the grader modules are excluded from the implementer-facing import graph.
   The real seed and generated held-out data live outside the worktree per ADR-0023.
2. **Permissions**: the grading run is a separate process that reads the hidden root; the
   arm under test runs with the hidden root path absent from its environment.
3. **Review**: a PR that touches grader modules requires a
   Foundry-owner review, not a runtime-team review. The repo area is owned by P-TIF-6.

A scored run is **blind** when the grader never sees the arm's self-report until after
the state oracle has produced a verdict. `src/foundry/oracles/blind.ts` therefore orders the
work: read state → oracle verdict → only then attach the transcript (annotated, never
overriding).

### 6.2 Where the hidden split lives

ADR-0023 places the generated hidden split outside every Git work tree. Its loader refuses
directories inside a work tree, group- or world-accessible directories, missing or short
seed files, and calls without a directory when `MYCO_FOUNDRY_HIDDEN_DIR` is unset.

## 6.1 A score is a count and its interval

Every published Foundry number goes through `scoreClaim()` in `src/foundry/stats.ts`, which
returns the rate, its exact Clopper–Pearson interval, the false-success upper bound, and the
caveats the report must print. The thresholds are not the Foundry's opinion — they are
`docs/research/benchmark-survey.md` §7, reproduced as constants so the doc and the code
cannot drift:

| Count | What it buys | Source |
|---|---|---|
| 27/30 verified | exact 95% CI **[0.735, 0.979]**; an 80%-reliable system passes this 12.3% of the time | survey §7.1 |
| ~100 normal trials | CI lower bound **≥ 0.80** at ~90% observed | survey §7.1 |
| 0 false successes in 10 | bounds the true rate only below **25.9%** | survey §7.2 |
| 0 false successes in 30 | bounds it below **9.5%** — the smallest meaningful count | survey §7.2 |
| 6 discordant of 30 | smallest sign-test result with p < 0.05 (5 of 5 is p = 0.0625) | survey §7.3 |

Consequences the contract imposes:

1. A report on fewer than 100 normal trials MUST carry the "underpowered" caveat. A report
   that ran 10 corrupted trials MUST say its bound is 26%, not "zero false successes".
2. Two arms MUST be compared as a paired per-trial table with a sign test, never as two
   independent rates — at n=30, two rates cannot distinguish a real gap from noise.
3. A drift claim is not available from any published source (m2-04): the nearest evidence is
   synthetic mobile config changes (29–42% of failures silent) and mock apps (63%→4%). If the
   Foundry needs a drift number it has to generate it, and the report says so.

## 7. Versioning and the change protocol

| Change | Requirement |
|---|---|
| Fixture initial state or screen claims | Bump the version encoded in the fixture id (`…-v2`): `FixtureManifest.version` is *derived* from the id, never stored separately, so an id cannot claim a version its manifest does not have. Regenerate the hidden commitment (`foundry/hidden-commitment.json`) and re-run the mutation audit. Old scores are not comparable. |
| Oracle `expected()` semantics | Bump `StateOracle.version`; every task that pins a fixture version gets a per-task score reset note in the report. |
| Task prompt text | Bump `taskVersion`; a prompt change can change difficulty, and a suite that edits prompts between arms is not a comparison. |
| Fault schedule | Bump `faultVersion`; corrupted-arm scores are only comparable within one schedule. |

The point of the table is that **the report can always say which versions produced a
number**. A score without its version triple (`fixtureVersion`, `oracleVersion`,
`faultVersion`) is not reportable.

Permission-denied is seed-invariant because it writes nothing. A torn unreadable
store is ledgered `uncertain`, never a proven false success, under the unreadable-state rule.

## 7a. Trial counts, reset cost, and what a number may claim (M2 round, fc4738e)

Planned against the **real** reset cost, not the optimistic one: the sweep default
(`scripts/reset-trial-vm.sh`) is a disk-only cold restore, ~21 s warm and ~165 s from a
fresh UTM start. The 8.3 s figure is the live-snapshot path, which is not the default (it
wedges UTM in `resuming`, -2700). At 100 trials that is ~35 min of reset time. Budget with
21 s.

| Claim in a report | Minimum evidence | Why |
|---|---|---|
| "Completion rate X" | ~100 normal trials, 3 seeds, Wilson 95% CI reported | 27/30 has Wilson 95% CI [0.744, 0.965] (exact Clopper-Pearson: [0.735, 0.979], the figure quoted in the M2 research; report Wilson, say which); an 80%-reliable system passes 27/30 12.3% of the time. A point estimate alone is not reportable. |
| "Zero false successes" | ~30 corrupted trials **and** the verifier self-test (§7b) | 0/10 only bounds the rate below 26%. Trials show a rate; the self-test shows the verifier catches a named class. |
| "Drift robustness" | Evidence the Foundry generates itself | No published number covers desktop office suites (m2-04); mobile (PACE 29-42% silent) and mock-app (OpenApps 63%->4%) figures are analogies, never citations for our claim. |

## 7b. Verifier self-test (WorkArena method)

The mutation audit in `test/foundry/oracle.test.ts` is the self-test: hand-written near-misses
of a correct run, each of which must be `refuted`, plus the unmutated run, which must stay
`verified`. WorkArena's audit found its own verifier passing 36/36 runs that filled an
unrequested field; "unrequested field filled" is therefore a standing mutation. Every new
oracle ships its mutation list, and a family is not reportable until it does. A report may
say "the verifier catches class X" only for classes in a committed mutation list.

**Second family (Writer).** LibreOffice Writer's AutoCorrect silently rewrites typed text, a
genuine app-side mutation the runner did not request and Calc cannot produce. It is the
corrupted-trial class for a Writer family (an `autocorrect-rewrite` fault: the oracle compares
persisted text to intent, never to what the runner typed) and a hazard for any *normal*
Writer task, which must pre-disable or avoid trigger strings. Table cells are read through the
same UNO call shape as Calc; persisted-file checks parse `word/document.xml` host-side
(`[INFERENCE]` per m2-03). Design only; no Writer fixture is built until host time is granted.

## 8. What the Foundry does not own

- Product comparison writeup — MVP Discovery owner (TIF-59 consumes EF-001/EF-002 only).
- Runtime implementation — Runtime Owner. They may use `dogfood/` and M1 surfaces for a
  first ease-of-use proof; they may not import `foundry/oracles/` or score against
  Foundry tasks until EF-001/EF-002 are done, and never with hidden-split access.
- Task design research — Research Coordinator feeds it; the Foundry decides what becomes
  a task.

## 9. Sources checked for this document (2026-11-21)

- OpenComputer, arXiv 2605.19769 — app-specific state verifiers, execution-grounded
  verification layer, partial-credit rewards. Fetched live: title/authors/abstract read
  from the arXiv API. Used for the *shape* of §4, not as an authority on failure taxonomy.
- OSWorld 2.0, arXiv 2606.29537 and <https://osworld-v2.xlang.ai/> — challenge-phenomenon
  tags (§3 of the site) are the source of EF-003's fault families; the `partial_scores`
  shape is already adopted by ADR-0007.
- OpenComputer and OSWorld 2.0's own failure cases are quoted only where a finding file
  hosts them: [docs/research/findings/f1-ef-fault-taxonomy.md](../research/findings/f1-ef-fault-taxonomy.md).
