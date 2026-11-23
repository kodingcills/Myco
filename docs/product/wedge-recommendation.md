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
| The verdict is not the agent's claim | The exit code comes from schema + cross-file validation of the artifacts; a tampered run exits 2 | `src/discovery/run-artifacts.ts`; `docs/product/quickstart.md` §4; `test/discovery/myco-run.test.ts` |
| No surveyed competitor returns a persisted-outcome verdict | 8 product lines from vendor primary docs; closest is Cua's per-action `effect` and HCU's window-level before/after diff, which says it does not prove file contents | `docs/research/mvp-competitive-teardown.md` §2.6, `docs/research/findings/m2-01-competitive-teardown.md` |

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

The arbiter is the pre-registered rule table in `mvd-preregistration.md` §4.1,
evaluated top to bottom, first row that applies, on ≥30 refutable pairs per arm on
the no-verify variant. Reproduced here in its own order and wording:

| # | Condition | Consequence |
|---|---|---|
| 1 | Myco is not ≈ 0 (≥1 false success) | Myco's own verdict has a hole: fix and re-run before any wedge claim; A is not supported. |
| 2 | Myco ≈ 0, and `hcu+shell` has ≥6 discordant pairs worse than Myco | The differentiator is the independent verdict without agent discipline; A stands as written. |
| 3 | Myco ≈ 0, `hcu+shell` ≈ 0 on both prompt variants, "checks every trial" holds, and `hcu+shell` setup and cost are within 1.5× of Myco's | A's differentiation reduces to the durable artifact and recovery; re-open B-first or reframe A as "CI for GUI" (plan §7). |
| 4 | Myco ≈ 0, `hcu+shell` has ≥1 false success but <6 discordant pairs worse than Myco | Underpowered / inconclusive: add trials; no wedge change. |
| 5 | anything else (e.g. `hcu+shell` ≈ 0 but not within 1.5×, or shell calls not trace-recorded) | No wedge change; report the table as measured. |

Only row 1 withdraws A. Row 2 is the row that supports this recommendation. Row 3
reframes it and re-opens B. Rows 4 and 5 leave it where it is. So "a single row
firing decides" would be wrong: the rows say four different things.

Two limits on the table, both from the same document: the `hcu` (GUI-only) and
`screenshot-only` arms are reported the same way but **do not decide the wedge**;
and the table cannot be applied at all until Foundry's trusted ingest exists —
anything earlier is descriptive and never moves the wedge.

The plan's own overturn conditions (`mvp-discovery-plan.md` §7) are a separate,
broader list, not the rule table. Its seven rows: `hcu+shell` at 0 false successes
for similar cost and setup; setup that cannot get under 15 minutes; an oracle that
cannot be made portable; interrupted-operation trials that duplicate or silently
lose; small fork overhead with a large success gain; one demonstration being
mistaken for a reusable procedure; and resets cheap enough for trial-heavy
designs. They are reasons to re-examine the wedge; they are not rows of the
pre-registered rule.

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
   Foundry on `oraclePresent`: `guestClean` was ratified on 2026-11-23 as *the
   app's store and published state files are absent before launch*, and every S0
   record must state that definition was in force; `oraclePresent` stays unproven,
   so an S0 PASS must not be read as MVD-001 coverage. Until Foundry wires it, S0
   cannot leave the preflight.
2. **Run the head-to-head** the moment Foundry's fixtures and verifiers land:
   Myco, screenshot-only, HCU, Orgo, Sai on the same tasks, scored by Foundry, with
   the pre-registered rule as the only decision procedure.
3. **Time a fresh agent** on the quickstart, and run the same flow inside Codex or
   Claude Code, to close acceptances 1 and 4 with a measurement rather than an
   author's run.
