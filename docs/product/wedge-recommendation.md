# Wedge recommendation — 2026-11-23

Status: **provisional recommendation, not a decision.** The pre-registered rule in
`mvd-preregistration.md` is the arbiter, and it has not fired: no paired trials
exist yet. This page states what the evidence supports today, what it does not,
and what would change the answer.

## Recommendation

**Direction A, narrowed: verified GUI tests for coding agents.**

The product is not a desktop runtime and not a computer-use API. It is the thing a
developer commits to a repo: a task, the state oracle behind it, and a run report
whose verdict comes from persisted state. The agent writes and repairs the
procedure; Myco guarantees the verdict.

Positioning sentence to test:

> Myco is the test runner for desktop apps your agent can't otherwise trust: it
> drives the real GUI and returns a verdict from persisted state, so a green run
> means the work landed.

## What is measured

| Claim | Evidence | Where |
|---|---|---|
| The technical core works on a real desktop | 29 verified, 1 refuted, 30 recorded; 21 eligible trials, 0 false successes, 0 unaccounted ledger entries | M1-013, M1-014 |
| A false success is caught, not reported | `myco-run --task df-s02` prints the UI claim `saved 4 item(s)`, the store's 2 missing items, and `REFUTED` | `docs/product/quickstart.md` §3 |
| A developer can get there from a clean clone | ~3 s from clone to a verified report, measured; the whole page ~20 s | `docs/product/quickstart.md` |
| The verdict is not the agent's claim | The exit code comes from schema + cross-file validation of the artifacts; a tampered run exits 2 | `src/discovery/run-artifacts.ts`, `test/discovery/myco-run.test.ts` |
| No surveyed competitor returns a persisted-outcome verdict | 8 product lines from vendor primary docs; closest is Cua's per-action `effect` and HCU's window-level before/after diff, which says it does not prove file contents | `docs/research/mvp-competitive-teardown.md` §2.6, `docs/research/findings/m2-01` |

## What is not measured

- **No head-to-head.** TIF-59 is blocked on Foundry fixtures and verifiers. There
  are zero paired trials, so no rule row has fired and no competitor has been run
  on the same task. The recommendation rests on the mechanism and the teardown,
  not on a measured win.
- **No live S0.** The live path is built and gated, but the preflight refuses on
  `oraclePresent` and `guestClean`; no guest has produced a verdict. Every run
  quoted above is the mock contract double, labelled `simulated: true`.
- **No fresh-agent timing.** The quickstart was executed by its author, not by a
  fresh coding-agent session. Acceptance 1's 15-minute budget is met by the
  author's ~3 s, which is not the same measurement.
- **No model cost.** `myco-run` calls no model, so `economics.modelCost` is
  `not-measured` with its reason. Acceptance 5's model-cost half is open.
- **No second agent environment.** The invocation contract is documented and
  tested (flags only, no TTY, `--json`, explicit exit codes), but nothing ran
  inside Codex or Claude Code.
- **B's per-operation value is untested.** B's buyer is an operations owner and
  its value is higher per operation, but each app needs an oracle and the first
  proof would be another spreadsheet. Nothing here measures that trade.
- **C's branching is unmeasured.** Orgo already ships cloning and live forking;
  the open question is whether branching beats replay-from-known-good enough to
  pay for memory snapshots. No measurement exists.

## Why A first, on the four criteria

| Criterion | A | B | C |
|---|---|---|---|
| Technical feasibility | Highest: M1's core is the hard half, and the developer surface now exists | Medium: needs a second app and a per-app oracle | Lowest: needs snapshot infrastructure and a measured benefit |
| User value | The user is already in a coding-agent environment with a repo and an app to test | Higher per operation, but the buyer is not the agent developer | Unclear until branching is measured against replay |
| Differentiation | The durable, machine-checkable verdict survives failure; no surveyed competitor sells it | Same verdict property, applied to software without APIs | "Branching exists" is not a differentiator; Orgo has it |
| Integration cost | Low: a task package and a run report, no new protocol | Medium: per-app oracle work, slow coverage | High: memory snapshots, and the benefit is unproven |

## What would overturn this

The pre-registered rule rows, in order:

1. Setup cannot get under 15 minutes on a developer machine → A is not a developer
   wedge; the transport becomes the product problem.
2. Myco does not beat the screenshot-only control on independently verified
   correctness → the verdict is not the differentiator.
3. Myco does not beat `hcu+shell` → a competent agent with HCU and shell access
   can read the store itself; the durable artifact is not enough.
4. Myco does not beat Orgo or Sai on the same tasks → the incumbent's lifecycle
   and hosting win.
5. Resets are cheap enough for trial-heavy designs → the economics change.

A single row firing is enough to move the wedge. The rule refuses to decide below
30 paired refutable trials, and it reports `unknown` rather than a verdict when
evidence is unavailable.

## The two MVP criteria

1. **Technical (with M1 / Runtime):** Myco reliably completes, verifies, and
   recovers a supported desktop workflow with reproducible evidence.
   *Status: the mechanism is proven on M1's Calc workflow and on the mock path;
   the live S0 path is built and gated but has not produced a verdict.*
2. **Product (this workstream):** someone can use Myco from an ordinary
   coding-agent environment, without the custom Grok Bot setup, and obtain a
   meaningfully better result than an existing alternative.
   *Status: the first half is met on the mock path (`myco-run` + quickstart); the
   "meaningfully better than an alternative" half is exactly what the head-to-head
   has not measured.*

## Next three actions, in order

1. **Open S0 live** by deciding the two unproven preflight checks with Tiffany and
   Foundry: either a guest-side process probe, or a narrower `guestClean`
   definition recorded in the run's evidence. Until then, S0 cannot leave the
   preflight.
2. **Run the head-to-head** the moment Foundry's fixtures and verifiers land:
   Myco, screenshot-only, HCU, Orgo, Sai on the same tasks, scored by Foundry, with
   the pre-registered rule as the only decision procedure.
3. **Time a fresh agent** on the quickstart, and run the same flow inside Codex or
   Claude Code, to close acceptances 1 and 4 with a measurement rather than an
   author's run.
