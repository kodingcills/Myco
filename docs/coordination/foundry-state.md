# Evaluation Foundry — workstream state

Owner: Evaluation Foundry (project P-TIF-6, team TIF). Independent of the Runtime Owner and
of MVP Discovery. Reports to the outer loop (T3 Code Bridge).
Branch: `myco/eval-foundry` (fixture/verifier work now on `myco/hcu-evidence`, PR #110 while
slot 5 holds that branch). Canonical backlog: [docs/backlog/foundry.md](../backlog/foundry.md).

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
| TIF-50 | EF-001 | **done, PR #110 verified PASS** | Four fixtures across four defect classes, each with a statement-level screen-vs-store assertion; `docs/foundry/contract.md` §3 |
| TIF-51 | EF-002 | **done, PR #110 verified PASS** | `src/foundry/oracles/state.ts` (derived truth, no-leak by type), mutation audit, hidden split commitment |
| TIF-52 | EF-003 | six classes built and tested; PR #122 pending merge | `src/foundry/faults/`, `src/foundry/tasks/writer.ts`, `src/foundry/oracles/writer.ts`, `docs/research/findings/f1-ef-fault-taxonomy.md` |
| TIF-57 | EF-004 | blind scoring + hidden split landed (PR #64); `src/foundry/stats.ts` adds the interval/caveat contract (PR #110) | `src/foundry/oracles/blind.ts`, `foundry/hidden-commitment.json`, `src/foundry/stats.ts` |
| TIF-58 | EF-005 | host harness merged; live run awaits Coordinator GO | [baseline status](../foundry/baseline-status.md), PRs #70 and #75 |

### TIF-58 slot 5

The proposed HCU GUI run covers 30 normal Calc record-edit trials using the finalized
M1 v3 parameter list in order. TIF-19 owns the single Cua C1 run in slot 4. Join the two
runs on v3 trial ID and fixture hash, use the same cold restore and blind judge, and
report skipped or unfinished trials separately. The current spend cap is $0. Pause if
the pinned planner is unavailable within that cap or hits its quota.

The Calc rows are descriptive for the Discovery wedge. Slot 5 contains no EF myco-todo
tasks or hidden pairs. Those need a validated guest deployment, trusted paired evidence,
and a separate run window. Orgo and Simular Sai remain parked.

Slot 5 follows the C1 spike, C1 sweep, and M1-016 live reproduction. Before booking the
30-trial run, obtain the Coordinator's finalized v3 parameter manifest and its hash,
TIF-19's evidence index, and the cold-restore and blind-judge identifiers. Check that
the planned trial IDs and fixture hashes agree. Keep any missing C1 row visible as an
omission in the paired report.

The Foundry host runner exercises a model. Slot 5 still needs a live HCU GUI adapter
handoff and confirmation that the pinned planner can run within the $0 cap. For each
attempt, capture the driver and planner versions, setup steps and elapsed time, trial
disposition, independent verdict, and measured usage or cost. Keep the arm's claim
separate from the verdict and record unavailable measurements as unknown.

Wait for explicit Coordinator GO before touching the guest. Guest-changing work uses a
new snapshot and preserves both clean-base snapshots. Apply the Coordinator's host
gates, then stop the guest and report back when the run ends.

## Design decisions already taken

1. **Two oracles per task** — a persisted-state oracle (primary) and a screen oracle (trap).
   A pass requires the state oracle AND no contradicting screen claim. (contract §2)
2. **No-leak rule** — `expected()` may read intent + initial state only; never anything the
   agent produced. Enforced by types and a builder assertion. (contract §4)
3. **Trace guard** closes the file-I/O shortcut at the task level, not the runtime level, so
   it applies identically to every arm including the screenshot baselines. (contract §5)
4. **Two roots for the hidden split** — `foundry/tasks/` public, `foundry/oracles/` +
   `foundry/hidden/` hidden, separate roots and separate ownership. (contract §6)

## Log 2026-11-22 — EF-002 defect found by an independent probe, fixed, and regression-tested

An adversarial verifier run against the EF-001/EF-002 commit found that the **stale-row
fixture was not testing its own defect**. The app model resolved the rename target by its
*post*-rename text, so the lookup could never find the pre-rename row and the stale text was
never written. The fixture passed anyway because the order check refuted for an unrelated
reason — the "refuted" result was real, the reason was not, and no test distinguished them.
The same bug made an in-place rename refute while delete-then-append passed unnoticed.

Fixed in PR #110 with tests that would catch a regression: an in-place rename now verifies,
a reordered store refutes, and each of the four fixtures must disagree between screen and
store **for the reason its manifest states**. The general lesson is in the contract: a trap
test that only asserts "refuted" cannot tell a working fixture from a broken one.

Also in PR #110: fixture roles (`rename-target`) replace text-based row identification;
every fixture gains an untouched control row; the wrong-value task moved to a `Bug: ` label
so the app's own drop rule cannot turn it into a second silent-drop; fixture version is
derived from the id and the hidden commitment is regenerated.

## M2 research folded in (2026-11-22, main at fc4738e)

- **Statistics are now a contract clause** (contract §6.1). Under 100 normal trials a report
  must print the underpowered caveat; 10 corrupted trials bounds a zero false-success rate
  only below 25.9%, and **30** is the smallest meaningful count. Two arms are compared as a
  paired table with a sign test — 6 discordant of 30 is the smallest significant result.
- **Reset budget corrected** to ~21 s per cold restore (`scripts/reset-trial-vm.sh` default),
  not the 8.3 s live path; 100 trials is ~35 minutes of reset, so power is affordable and the
  real cost to optimise is verification.
- **LibreOffice Writer** becomes EF-003's sixth fault class: AutoCorrect is a silent in-app
  mutation Calc cannot produce, and Writer table cells read through the same UNO call shape.
- **No drift claim is available** from published sources (m2-04); if the Foundry needs one it
  must generate the evidence and say so.

## Log 2026-11-22 (2) — PR #110 through three verifier rounds to PASS

The first verifier rejected with seven findings. Six were mine, introduced while fixing the
stale-row defect; one was a doc error. All are fixed, and each fix has a test that fails if
it comes back:

| Round | Verdict | What it caught |
|---|---|---|
| 1 | REJECT | Stale-row save corrupted the store on a plain Add (it inferred "rename" from the typed text, which Add also sets); a no-op save capitalised untouched rows; contract §6.1's sign-test row was wrong by 15 orders of magnitude; `stats.ts` was dead code so its caveats could never reach a report; hidden fixtures had silently dropped to version 0; three fixtures changed content without the version bump §7 mandates; the partial-write assertion ignored the screen. |
| 2 | REJECT | One regression left: the stale text was keyed on the fixture's designated target, so renaming any *other* row wrote the wrong text and duplicated an untouched row. |
| 3 | **PASS** | Fixed by carrying each row's load-time text (`loadedRows`) and substituting at the renamed index — the defect is now stated generally ("a renamed row keeps its load-time text") and is correct for any row. |

Two things worth keeping from this:

1. **The verifier's probes were better than my tests.** Every rejection came from a script
   that printed the store next to the screen for a sequence I had not tried. ADR-0023 now
   requires statement-level assertions for exactly this reason.
2. **A fix can be worse than the bug.** Rounds 1 and 2 were both regressions I introduced
   while fixing the original defect. The lesson is in the tests, not the prose: the save
   path now has four cases (no-op, add, delete, rename) and a rename-after-add case, each
   asserting the store and the screen.

`stats.ts` is no longer dead: `oracles/report.ts` owns the single `wilson` implementation and
puts `scoreClaim()` into `completion.claim`, so a report cannot publish a rate without its
interval and caveats. Verified end to end — a 10-trial report carries both underpowered
caveats.

## Log 2026-11-22 (3) — EF-003's sixth class: Writer AutoCorrect

The M2 recommendation, built host-side. Writer's AutoCorrect rewrites typed text at save,
which is a silent in-app mutation Calc cannot produce: the agent typed one thing and the
document holds another. It is the one fault class where a screenshot-only agent is wrong for
a reason it never caused, and the only one that produces a **well-formed document holding
the wrong text** rather than an absence of state.

- `src/foundry/tasks/writer.ts` — a Writer table with cells addressed `A1`, `B2` (the same
  addressing `XTextTable.getCellByName` uses live, so the task survives the move to a real
  UNO read), the AutoCorrect replace table, and a save path where the **screen keeps the
  typed text and the file holds the rewrite**.
- `src/foundry/oracles/writer.ts` (hidden by path) — reads the modelled `word/document.xml`,
  derives the expected cell from the intent only, and reports `uncertain` for a missing,
  corrupt, or unknown-cell document.
- `autocorrect-rewrite` is a sixth fault class with its own entry point, so the todo-store
  and Writer document shapes never share a switch.
- The Writer family is wired into the public task bank (`ef-t05-writer-total`), so it is a
  task rather than a fixture only a test can find.

Verifier PASS at 91c3371 with three quality findings, all fixed: the family was dead
surface (now in the bank), the recovery test claimed a re-read it did not perform (it now
reads the persisted bytes through the oracle), and a comment implied screen nondeterminism
the model does not have (real Writer repaint timing is a live-run measurement).

**What this does not do:** it is a model, not a Writer driver. A live run needs the VM and a
UNO read. What it proves is that the class fires and is caught, host-side, with no guest.

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

## Sub-threads (verifier runs, reported to the outer loop)

Every distinct verification is a separate spawn against a named SHA, never a re-use of an
earlier verdict. All ran on `cheaperinference/deepseek-v4.1-flash` (judgment), no VM access.

| # | Verifier | Target | Verdict | Outcome |
|---|---|---|---|---|
| 1 | FoundryVerifier | EF-001/EF-002 at 3c7d6ba | aborted | Provider quota (402) killed it mid-run; it had already found two real defects, both carried forward. |
| 2 | PR110Verifier | PR #110 at f1f7bbb | REJECT | Seven findings: the stale-row defect could not fire; two regressions introduced by the first fix; a sign-test row wrong by 15 orders of magnitude; `stats.ts` dead code; hidden fixtures at version 0; three fixtures content-changed without a version bump; an assertion that ignored the screen. |
| 3 | PR110Recheck | PR #110 at 5d21862 | REJECT | One regression left: the stale text was keyed on the fixture's designated target, so renaming any other row wrote the wrong text. |
| 4 | PR110Final | PR #110 at e802a19 | **PASS** | All prior findings confirmed fixed; two minor cleanups applied after. Merged d09f209. |
| 5 | EF003Verifier | PR #122 at 91c3371 | **PASS** | Three quality findings — the Writer family was dead surface, a recovery test claimed a re-read it did not perform, a comment implied nondeterminism. All fixed. Merged c37d944. |

What the verifier rounds changed in the work itself, beyond the defects: a trap test that
asserts only "refuted" cannot distinguish a working fixture from a broken one (ADR-0023),
and two of the three rejections were regressions introduced *while fixing an earlier
finding*, which is why the save path now has five cases each asserting store and screen.

## Open issue for the outer loop — `viewer verdict budget (macos-latest)` is flaky on shared runners

Observed 2026-11-22 while landing PR #129 (a **docs-only** diff, one coordination file):

| Branch | Result | Time (UTC) |
|---|---|---|
| `myco/eval-foundry` @ 200b072 | **fail** 518.8 ms (limit 425.8) | 18:59:45 |
| `myco/eval-foundry` @ 3587513 | **fail** 506.4 ms (median, limit 425.8) | 19:03:12 |
| `myco/eval-foundry` @ earlier heads | **pass** | 18:55:30, 18:53:15 |
| `docs/c1-stack-proof` | **fail** | 19:01:13 |
| `feat/rt015-read-file-tool` | **fail** then pass then pass | 18:55:00 → 18:59:50 |

The diff under test touches no viewer code and no `src/`. The same commit passed the check
twice and failed it twice, and two unrelated branches failed it in the same window while
`main` passed. That is runner variance, not a regression — the samples are bimodal
(384–435 ms good runs, 672–860 ms bad runs), which is what a noisy-neighbour macOS runner
looks like on a 315 ms workload.

**Not my call to fix** (`.github/workflows/` is out of scope for this workstream and the
repo rule is that no agent edits it). Options for whoever owns CI, cheapest first:

1. Raise `relativeTolerance` above 35%, or drop the 10000-step case to a p95 rather than a
   median — the median is already robust; the tail is what moves.
2. Run the perf job only on `main` post-merge and on PRs labelled `perf`, so a docs PR is
   not gated by a timing race.
3. Pin the runner label and measure the baseline on that image, rather than reusing a
   darwin baseline that may not match the runner's CPU.

**Consequence for this PR:** #129 cannot merge on a green run without either a re-run or a
CI change. It is docs-only and the other five checks pass at the same head.

## Not touched

`myco-win11`, any VM, `agent/`, `src/win/`, `src/integration/`, `.github/workflows/`,
Linear, secrets, paid services, accounts.
## 2026-11-21 update (provider switch to Claude Sonnet 5.5)

- Merged main (M2 research, fc4738e) into `myco/eval-foundry`; typecheck, lint and 160 tests green.
- Contract §7a/§7b added: trial-count/CI policy, real ~21 s reset budget, verifier self-test
  as the standing "catches class X" claim, Writer AutoCorrect as a second-family fault class.
- Still no VM touched, no sub-threads, no Linear access (outer loop owns it).
- Switch note: owner thread moved off cheaperinference (402) to claudeAgent/Sonnet; builds go
  to Codex when delegated.

EF-003: host-only fault injectors and verifier self-tests implemented; fault scores carry a schedule version.
