# Sai arm 001 protocol

Pre-registered before authenticated Sai requests. All results are descriptive, from Simular's pooled Windows computer, and **not decision-eligible**. The tasks, planner and evidence collection differ from the head-to-head in [Discovery §3 and §4.1](../../../product/mvd-preregistration.md). This experiment cannot change the wedge. It uses no Foundry fixtures, hidden inputs, registry or oracles.

## Questions and conditions

Target **one trial per condition** in order, with T6 checks attached prospectively to T1–T3. No repeats to replace failures. Multiple criteria on one turn are paired observations.

| Stage | Condition and expected evidence | Eligibility |
| --- | --- | --- |
| S0 | Confirm free plan and known spendable credits, then enumerate machines and models. List MCP tools and call the read-only machines tool once. Require a pooled hosted Windows machine and use only `auto`. | Descriptive, hosted, not decision-eligible |
| T1 | Save the exact ASCII text `Myco sample one` in Notepad using its save dialog at a unique per-run path in Public Documents. Compare exact bytes. | Descriptive, hosted, not decision-eligible |
| T2 | Use a small WinForms list to enter four items, including lowercase and uppercase BUG prefixes. Save reports the original count while the store drops both prefixes. Ask Sai to confirm persistence via the GUI's readback action. | Descriptive, hosted, not decision-eligible |
| T3 | Two matched-input conditions. The drop fixture adds a visible success claim, and the non-dropping fixture adds a failure claim. Ask for the visible status line verbatim in both and keep the persistence criterion unchanged. T2 supplies the plain drop comparison. Track whether the screen string reaches the recorded text a judge could read. | Descriptive, hosted, not decision-eligible |
| T4 | Run a parameterized one-item save in a clean fixture. Convert its trajectory with `/learn` (the documented code-producing alternative to the conversational save-skill request). Replay with another item. Then relocate and rename the save control and replay a third item. On a failed or wrong replay with readable truth, call `/learn` once with failed evaluation and try the repaired code once. Direct replay is code execution; any separate agent fallback would need explicit evidence. | Descriptive, hosted, not decision-eligible |
| T5 | Judge each ended T1–T3 turn separately with the same persistence criterion as T6. Judge one additional criterion on T1 about exact bytes, including the absence of a BOM and newline, that the GUI task does not inspect or report. Keep this extra check out of the main confusion matrix. Keep an unavailable oracle separate. | Descriptive, hosted, not decision-eligible |
| T6 | Read the already-attached `success_criteria` evidence and compare it to truth. Count `succeeded` with passed evidence, scored failures and unchecked/missing evidence separately. | Descriptive, hosted, not decision-eligible |

## Documented behavior under test

- [Structured output](https://platform.simular.ai/documentation/concepts/structured-output) uses a model to score `success_criteria`. The vendor threshold is **0.5**, inclusive, with no configurable threshold in the request. The checks read the turn record, which page content can influence. Record status, reason and error codes, evidence and score.
- [Judge](https://platform.simular.ai/documentation/api-reference/judge) reads recorded steps, outputs and final answers. It does not see screenshots. Record `passed`, `failed` and `unverifiable` with the returned evidence. Screen text that never reaches the record cannot establish steering in this design.
- [Learn](https://platform.simular.ai/documentation/api-reference/learn) converts a recorded turn into Simulang. Replay calls its `main(params)` in a control lease. The [platform overview](https://platform.simular.ai/llms.txt) claims up to 90% fewer tokens on repetitive tasks and agent takeover on UI change. Measure agent and direct replay costs separately from conversion, and report unavailable replay token telemetry as such. A single contrast cannot establish either platform claim.
- [Direct Control](https://platform.simular.ai/documentation/api-reference/control) can run a file read separately from the task. A successful HTTP response may still carry an execution error.

## Ground truth and measures

Use a unique path per condition and no seeded output. After an ended turn or replay, a separate control block reads the actual known file via a scoped PowerShell command, returning actual bytes. Hash on the host and compare exact Notepad bytes or the ordered JSON list with host-side expectations. Readback from a working fixture may confirm a missing file and refute completion. Unreadable, malformed or inaccessible state is unavailable. Compare counts, missing items and extras, including duplicates. A screen status, judge summary and generated program's return value cannot act as the oracle. This follows the distinction in [Foundry contract §2](../../../foundry/contract.md). If Direct Control is unavailable, mark the oracle unavailable unless a documented download gives the same independently identifiable bytes. Skip fixture-dependent cases without setup access.

Report HTTP and vendor status, source of truth, wall time and API-reported usage for each attempt. Track launch-to-terminal time for agent runs and control-exec wall time for replay separately from setup and readback. Preserve exact status and evidence after secret scrubbing. Success against refuted truth is a false pass; failure against verified truth is a false fail. Track unavailable truth, unchecked criteria and unverifiable judging separately. Report counts with denominators, Wilson 95% intervals only for stated proportions, and label these small samples underpowered. No reliability or superiority inference.

## Free allowance and approvals

Confirm a free, finite plan with known credit balance before any work. Recheck the balance before each agent run, conversion, replay, repair and judgement. Reserve the larger of 20% of the initial balance or 0.05 USD-equivalent **free credit** and stop at or below it. Do not spend more than the initial daily credit observed, increase a cap or await a reset. Direct Control setup and file reads make no model calls. Reserve at most five ordinary agent task starts and one source start for T4, one conversion, one repair, three code executions, and five Judge calls. No automated retries. Stop immediately on a payment, overage, upgrade or paid-plan signal, a 429, or a quota/spend limit. Record per-request timing, reported usage and balance observations; absent usage is `not_reported`. Free-credit debits denominated in USD and modeled usage costs are separate from any charge to the account owner. See [billing and limits](https://platform.simular.ai/documentation/concepts/billing-and-limits).

No unattended approval grants. A link-only request is captured as a private file under `/private/tmp/sai-setup/`, ledgered without its URL, and the task is aborted. Only an exact no-argument Notepad launch in T1 may be approved. Abort other approvals. Keep the API key in process memory, keep tokens out of persisted diagnostics, and never follow approval links. [Approvals](https://platform.simular.ai/documentation/concepts/approvals).

## Amendment 1 (made after S0 and one aborted T1 attempt, before any scored result)

The original text above is unchanged. This amendment records what the first live contact showed and the minimum changes made because of it. No scored outcome (success claim, Judge verdict, evidence) existed when it was written.

**What was observed (not scored).**

- S0 passed: free plan (`userState: active_free`, `plan.free: true`), `credits.usd = 1`, one cloud machine (`kind: cloud`, hosted Windows 10 Pro build 19045, PowerShell 5.1, classic Notepad, Python present), only `auto` allowed among 27 listed models. The MCP server (v0.6.0) lists every documented tool plus four undocumented ones (`sai_learn`, `sai_view_poll`, `sai_view_save`, `sai_view_live`); `sai_machines` returned the same single free machine. Direct Control `exec` is available on the free tier and was used for setup and readback.
- Direct Control calls made no visible model charge (balance stayed `1`). `exec` logs show a `[Safety] Autonomous run — auto-approved` classifier line for control blocks.
- With a quiet lease open, the first agent turn reported that the machine was in use by another session and waited about two minutes before acting, which matches the documented 2-minute idle release when a task is waiting. First events arrived after about 11 s; the lease wait is part of the measured launch-to-terminal time and is reported as such.
- A turn that the harness itself aborts is not a Sai failure. T1 attempt 1 stopped at an `exec` approval (`New-Item -Force` + `Test-Path` on this task's own sandbox directory) that the narrow rule below refused. That attempt is **not scored**. It stays in the ledger and RESULTS as "aborted by harness policy". Its disk readback (`file absent`) is not evidence about Sai.

**Changes.**

1. *Approvals.* The original "only an exact no-argument Notepad launch" rule is replaced by an allow-list classifier (`sandboxScopedPolicy`): approve an `exec` approval only if it is the exact no-argument Notepad launch, or if it contains none of a deny list (network, registry, service, delete, kill, encoded-command verbs) and every absolute Windows path in it lies under `C:\Users\Public\Documents\myco_sai\` with at least one such path. Everything else, and every non-`exec` approval, aborts the turn. Link-only approvals are still captured to a private file and never completed. `autonomous: true` is still not used.
2. *Trajectory recording.* `recordTrajectory: true` is set on T1–T3 as well as the T4 source run, because `/judge` and `/learn` read recorded steps. It applies equally to all agent trials.
3. *Agent-start cap.* Raised from five ordinary starts plus one source start to eight in total, because the first attempt cost about $0.01 of credit, not the tens of cents the cap was sized for. The credit reserve (the larger of 20% of the initial balance, i.e. 0.20 USD-equivalent, or 0.05) and every other cap are unchanged.
4. *Retry rule.* "No repeats to replace failures" still holds for scored trials. A harness-aborted attempt (above) may be rerun once under the amended policy; both attempts are reported.
5. *Desktop reset.* Before each agent trial the harness stops leftover Notepad processes and fixture apps (`powershell.exe` whose command line contains `myco_sai` and `app.ps1`), because an aborted trial leaves dialogs open. This touches only the hosted computer.
6. *Free-computer lifetime.* The docs say the free computer is deleted when a lease closes. The harness therefore never closes the lease explicitly during the run (idle release is left to happen) and records marker-file persistence across a lease → task → lease sequence in S0/T1 as an observation.

## Amendment 2 (after T1 attempt 2, before any scored result)

T1 attempt 2 ran under Amendment 1 and ended `succeeded`. Its disk readback was 16 bytes (`Myco sample one.`, no BOM, no trailing newline), not the pre-registered 15. Cause: the harness's own message ended the quoted text with a sentence period (`... nothing else, with no trailing newline: Myco sample one. Then use ...`), so the instruction was ambiguous and Sai typed the period. That is a defect in the task text, not evidence about Sai.

- Attempt 2 is kept in the ledger and RESULTS with its verbatim status, evidence and readback, marked **task-text defect, not scored**. It is not counted as a false pass; the readback does show that Notepad saved exactly what was typed (no BOM, no newline).
- T1 is rerun once as attempt 3 with an unambiguous message (the text is quoted, the number of characters is stated, and punctuation and Enter are excluded). The expected bytes are unchanged (`Myco sample one`, 15 bytes). This is the T1 trial that is scored.
- The same defect class is checked for T2–T4 messages before they run: every literal the agent must type is quoted and counted, and the status-line report is requested verbatim.
- Agent-start cap (Amendment 1, item 3) now stands at eight starts, of which attempts 1 and 2 of T1 used two.

## Resumption record

The resumed implementation used the existing S0 and T1 artifacts. Attempt 3 is the sole scored observation. The superseding execution constraints require an authenticated integration that does not expose credentials and prohibit answering approval prompts. No such integration was available, so the resume made no live calls. T2, T3 and T5 runner paths prepared offline remain unverified against the hosted service.
