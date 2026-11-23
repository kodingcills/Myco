# TIF-105 coverage brief (from the Research Coordinator)

Read this before researching. It says what is already covered, where the gaps are, and the rules that sit on top of the Linear spec.

## Already covered: cite, do not redo

| Doc | Covers | What it does not cover |
|---|---|---|
| `findings/m2-01-competitive-teardown.md` | Cua, Anthropic computer use, OpenAI CUA/Operator, Simular Agent S, UiPath, heyclicky. Verdict: none proves persisted outcomes (delivery confirmed, not state). Action-space and safety-check mechanics for Anthropic/OpenAI are already there. | Failure RATES. Do not write another feature table. |
| `mvp-competitive-teardown.md` | Microsoft HCU, Cua Driver, Orgo, Simular Sai, screenshot-only. Capability matrix on the TIF-59 axes. Section 3.7 is the failure class none of them covers. | Rates. |
| `benchmark-survey.md` | OSWorld / OSWorld-Verified, WAA, AndroidWorld, ScreenSpot*, OfficeBench: how each benchmark GRADES, task counts, leaderboard integrity, statistics. | Why agents FAIL. Your failure mining is the new part. |
| `findings/f1-ef-fault-taxonomy.md` | Fault-injection taxonomy from OpenComputer (arXiv 2605.19769) and OSWorld 2.0 (arXiv 2606.29537). | Reuse its categories as the vocabulary for the Myco-lever mapping. |
| `findings/m2-02..05` | MCP/API design (verdicts behind a separate tool; `application_commit: not_verified`), second app (LibreOffice Writer), procedure learning (one demo cannot identify a procedure; drift unmeasured), fast reset (default reset is cold, about 21 s, not the 8.3 s live path). | Rates for any of these. |
| `index.jsonl` | 31+ sources. | Dedupe on `canonical_id` before adding. |

## Gaps to hit

1. Per-category failure breakdowns, with denominators, from the OSWorld, WAA and AndroidWorld papers and trajectory analyses (grounding vs planning vs knowledge vs harness/timeouts).
2. Failures caused by the harness or tool design: screenshot scaling and coordinate mismatch, zoom, step limits, stale state, self-reported false success.
3. False-success and unverifiable-success rates. These map most directly to Myco's state oracles.
4. UI-drift failure rates for procedures. m2-04 flagged this as unmeasured; it is TIF-100.
5. Gemini computer-use public numbers. Mark UNVERIFIED where thin.

## Rules on top of the spec

- **ISSUE-FIRST** (Tiffany, Nov 22): any finding that implies work (a build, an experiment, a change of direction) appears in the final report as a proposed Linear TIF issue with evidence links. No action without a TIF id. Existing ids: TIF-98 fast VM reset, TIF-99 Writer UNO read, TIF-100 procedure drift, TIF-101 verify-before-store ADR-0017 (waits on Discovery's A/B/C choice), TIF-102 paid-tier teardowns (needs Tiffany's approval). Link to these where your bets overlap instead of proposing duplicates.
- **A/B/C is Discovery's call.** m2-00 ranks M2 bets; it does not retract or pre-empt the A/B/C product choice.
- **Index entry:** PR #217 registers a placeholder line with `canonical_id` `doc:docs/research/findings/m2-00-failure-mode-sweep.md`. Update that line when the doc lands. Do not append a duplicate.
- **Verifier:** the Research Coordinator launches and settles the independent Claude verifier (at least 15 citations and numbers, PASS/FAIL at the exact head SHA). Report the final head SHA to the coordinator; do not merge before the PASS.
- **Git sync** (Tiffany, Nov 22): fetch and sync with `origin/main` before resuming and again right before opening or pushing a PR; never open a PR from a stale branch; if you sync after a verifier PASS, reverify per the PR's tier.
- Claude (Fable or Sonnet) helpers only. No kimi, no cheaperinference. No VM, no C1 arm (pid 41790), no spending, no secrets.
