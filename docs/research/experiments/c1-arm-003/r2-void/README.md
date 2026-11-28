# arm-003d r2 — VOID (do not score)

**These five rows are not evidence.** They were produced under a defective
configuration and are committed only so the failure is inspectable rather than
described from memory.

## Why they are void

Every model call was capped at `MAX_OUTPUT = 256`, and `stop_reason` was inspected
only for `"refusal"`. A reply cut off mid-tool-call therefore became partial JSON,
the planner found no parseable decision, and `planner-no-action` was scored
**against the agent** — a harness fault recorded as an agent failure.

**Trials 3 and 4 are the pure signature:**

| Trial | Steps | Model calls | Completions | Verdict |
|---|---|---|---|---|
| 0 | 3 | 4 | `[132,107,214,256]` | modified |
| 1 | 15 | 16 | `[…,256]` | modified |
| 2 | 4 | 5 | `[203,219,256,248,256]` | modified |
| **3** | **0** | **1** | **`[256]`** | **persisted-mismatch** |
| **4** | **0** | **1** | **`[256]`** | **persisted-mismatch** |

A zero-step trial with a single 256-completion call did not fail at the task; it
never received a usable answer. Two consecutive identical failures tripped the
abort-early rule and stopped the sweep.

**Fix: PR #340** (`fix(TIF-164): a truncated reply is a harness fault, not an agent
failure`) — ceiling raised to 1024, `stop_reason == "max_tokens"` now throws
`PlannerFailure` so the trial is **omitted** rather than scored, and the
abort-early rule is wired to scored rows.

## Why the run ended

**An operator kill, ordered by the outer loop at 20:48Z** once the truncation
defect was identified. It is **not** a launcher, VM or watchdog fault: the process
tree was killed deliberately (watchdog, wrapper, then the surviving sweep children
and `tee`), which is why `watch.log` stops ~2 minutes before `progress.log` — the
watchdog was killed first and the sweep children outlived it briefly. **Do not
investigate this as an unexplained abort.**

## What IS worth keeping from this run

**Trial 2 is the first live proof that `delivered ≠ saved`.** Its save escalated
background → foreground, was **delivered**, and the document still ended unsaved:

```
type_text (80,146)   "D60\n"          <- cell reference
type_text (283,260) "2024-05-28\n"    <- the CORRECT value
press_key (312,261) "Ctrl+s"          <- the save
press_key (283,260) "ctrl+a"          <- post-stall recovery
deliveries: steps 1-2 background, delivered
            steps 3-4 FOREGROUND, escalated TRUE, delivered
verdict: refuted / modified
```

That is the distinction `save-failed` is reserved for, demonstrated on live traffic
where arm-003c could only produce a routing refusal and the probe could only
suggest the mechanism. **n=1, so it is evidence of the mechanism, not a rate.**

## Contents

- `0.json`–`4.json` — the five scored rows, verbatim from the run directory
- `accounting.json` — the ledger; trial 5 is `reserved` and never ran
- `PRIOR_SPEND.md` — the ceiling arithmetic used for this launch
- `progress.log` — stops at `[5] Resetting VM to cua-c1-base...`

**Not included:** `launch.log`, `watch.log`, `wrapper.pid`, `watch.pid` — kept in
the original run directory, since they are operational rather than evidentiary.

## Spend

Cash **$0.086** (real trial cost). Booked **$0.463024**, of which **$0.376800** is
trial 5's reservation — a reset that made no planner call, so it is **booked, not
cash**, the same split as arm-002's $1.178562/$1.555362.

## Related

- **TIF-173** — the follow-up that corrects the arm-002 evidence claims
- **PR #340** — the truncation fix
- `../ANNOTATION-TIF-167.md` — the delivery-mode annotation for this arm

Redaction note (2026-11-25, TIF-241): absolute macOS home paths (and the account name) in this pack's files were replaced after the fact with `~/` or a `<account>` placeholder; nothing else changed.
