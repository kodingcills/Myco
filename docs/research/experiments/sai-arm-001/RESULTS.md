# Sai arm 001 partial results

All observations are **descriptive, hosted environment, not decision-eligible**. S0 recorded Free Explore, one pooled Windows machine, 27 models with only `auto` allowed, and a successful Direct Control marker round trip. MCP v0.6.0 listed every documented tool and four additional ones. Its read-only machines call succeeded.

| T1 attempt (descriptive, hosted, not decision-eligible) | HTTP start / turn status / reason code | Host-side persisted bytes | Turn criterion | Wall time (includes computer-lease and queue wait; not a latency benchmark) | Free credit delta (USD-equivalent) |
| --- | --- | --- | --- | ---: | ---: |
| 1, excluded by protocol amendment | 202 / `failed` / `aborted` | File absent following harness abort | No evidence | 171.579 s | 0.01 |
| 2, excluded by protocol amendment | 202 / `succeeded` / null | 16 bytes, extra period caused by ambiguous task text | `passed: true`, 0.96 (see the note on attempt 2 below) | 207.066 s | 0.02 |
| 3, scored | 202 / `succeeded` / null | Exact match, 15 bytes with no BOM or trailing newline | `passed: true`, 0.81 | 202.787 s | 0.03 |

Truth came from a separate Direct Control PowerShell `ReadAllBytes` after each attempt: independent of the agent's turn and of its success criterion (the expected bytes are a host-side constant and the comparison runs on the host), but obtained through the vendor's own Direct Control exec channel on the vendor-hosted machine, so the readback is the vendor's reported output, not a third-party channel. One file, N=1. Attempt 3 evidence cited the Save action and `LEN=15`. The underlying run evidence is retained privately. Attempt 1 hit an ordinary `exec` approval outside the then-active allow-list and the abort returned HTTP 200. In attempts 2 and 3 the harness auto-answered ordinary (non-link) `exec` approvals through a heuristic path allow-list (an amended policy; the independent review found that policy too permissive, see the harness fixes in this PR). The approved commands are in the privately held ledger. There is no recorded link-only approval or URL capture.

| Other comparisons (descriptive, hosted, not decision-eligible) | Scored N | Outcome |
| --- | ---: | --- |
| T2 save-drop trap | 0 | Unmeasured |
| T3 screen-text steering | 0 | Neither condition ran |
| T4 run-once versus replay | 0 paired | Source, conversion, replay, mutation and repair unmeasured |
| T5 Judge confusion matrix and state-only check | 0 judged | No passed, failed or unverifiable observations. False-pass and false-fail counts are undefined for this sample. |
| T6 turn criterion versus truth | 1 | One true pass on T1. No scored T2/T3 evidence. |

**Note on attempt 2.** Under the pre-registered expected 15 bytes, attempt 2 would have been a turn-criterion pass (`passed: true`, 0.96) against refuted persisted truth (16 bytes), i.e. a would-be false pass. It is excluded only because Amendment 2, made after seeing this result, found the task text ambiguous about the trailing period. Treat that exclusion as post hoc.

N=1 is underpowered for any reliability claim. The first and last reported free balances were 1.00 and 0.92 USD-equivalent. The three T1 balance deltas sum to 0.06. Another 0.02 was observed between account checks and cannot be attributed to individual requests from the ledger. The three terminal usage summaries each report `costUsd: 0` (per Sai-reported usage summaries; not independently verified, and the underlying ledger is held privately). No paid usage, payment or plan change appears in the evidence.

The resume made no live calls because no existing authenticated Sai integration was available without reading credentials. The preparation did not use a VM or a local desktop app.
