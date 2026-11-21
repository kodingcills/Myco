# F2 — Baseline arms for EF-005: what can actually be run without an account or spend

Question: which screenshot-only / computer-use baselines can EF-005 (TIF-58) run on the
*identical* Foundry fixtures, under Tiffany's standing constraint (no paid spend, no account
creation, no settings changes)?

Date: 2026-11-21. Level: L1 (primary-source reads of each project's public surface). Owner:
Evaluation Foundry. Consumed by: EF-005.

## Evidence, one row per named arm

| Arm | Licence / access | What it is | Account needed? | Spend? | Runs on our fixture set? |
|---|---|---|---|---|---|
| **Microsoft Hybrid Computer Use** (`microsoft/Hybrid-Computer-Use`) | MIT, public GitHub repo, 65★, Go + per-OS providers | An **MCP server** (`computer-use`) exposing `AX` (semantic tree) and `GUI` (screenshot + input) channels; the *agent* is whatever coding agent drives it. Reported: OSWorld 2.0 72.37% partial / CUA Driver 68.82%; WAA 80.86% / 71.89%; Linux·macOS·Windows. | **No** (for the repo itself) | **No** for the repo; a planner model is required | **Yes, in principle** — but it is a computer layer, not an agent. EF-005 must supply a planner, and record that the planner is ours, exactly the credibility caveat M1-021 already carries for the UI-TARS fallback. |
| **Orgo** (`orgo.ai`) | Commercial SaaS; API/SDK + hosted MCP; Linux desktops | Cloud VM provider + desktop control. Pricing page: "Free to sign up"; new accounts that pass checks get **$3 starting credit**; plans $29/$99/$399 per month; hourly rates from $0.023/hr (Small) — **billed to a card/credit balance**. | **Yes** (sign-up required; API keys are generated in the dashboard) | **Yes** (credit, then card) | **No under the constraint.** Blocked: account creation + billing details. |
| **Simular Sai** (`platform.simular.ai`) | Commercial API + MCP (`@simular-ai/sai-mcp`); "Explore" tier free | A hosted computer-use **agent** (not just a layer). OSWorld 2.1 claim: 79.38% partial at $14.34/task. | **Yes** — "Sign in with Google … and create an API key"; free accounts must verify a phone number before their first key | "Explore is free, with daily credits"; Pay-as-you-go **$50/mo** | **No under the constraint**, and doubly so: it runs on **Simular's cloud computer**, not ours, which changes the environment and makes a same-task comparison invalid even if access were free. |
| **Cua Driver** (already M1's chosen baseline layer, M1-021) | MIT, `cua-driver-rs` `windows-arm64` release asset | Driver with element + pixel ladder | No | No (with a local planner) | Yes — but this is the *M1* baseline and EF-005 must not fork it; EF-005's value is running the **same Foundry fixtures** through it. |

Reading the primary pages changed two things a summary would have got wrong:

1. **HCU is a computer layer, not an agent.** Its README's numbers are "with GPT-6 Astra" /
   "with GPT-5.4" — the planner is the variable. EF-005 reporting "HCU scored X" without
   naming the planner would repeat the exact error the M1 baseline design spent §1b.2
   correcting (a published number that no longer describes what is measured).
2. **Orgo and Sai are blocked for different reasons.** Orgo fails on access alone; Sai fails
   on access *and* on environment (its cloud computer is not our fixture host), so even a
   future allowance of the Explore tier would not give a comparable number.

## Decision

**Schedule for EF-005:** a screenshot-only arm **first**, and HCU as the second arm once a
planner is chosen; **queue Orgo and Sai as escalations** naming the exact blocker, rather
than running them.

- Screenshot-only arm: Cua Driver C1 (pixel rung) on the Foundry fixtures — the honest
  "screenshot agent", $0 with a local planner, already the M1 baseline's computer layer.
- Second arm: HCU `GUI`-only channel (MIT, no account), planner named per run; the `AX`
  channel makes it the structural arm analogous to Cua's C2.
- Orgo: **blocked — account creation and credit/card required.** Not run.
- Sai: **blocked — account creation (Google + phone verification + API key) and a hosted
  computer instead of ours.** Not run even if access were granted, without a separate
  comparability decision.
- Standing gate from M1-021 unchanged: any guest-side work waits for the VM to be released
  by the M1 Coordinator. EF-005's host-side work (harness, scoring, transcripts) does not.

## Next action

After EF-001/EF-002 verification: write the EF-005 arm adapter interface so both arms are
driven by the same scorer, then escalate the Orgo/Sai rows to the outer loop for the
evening summary.

## Reopen-if

- Tiffany authorises an Orgo or Sai account/budget → re-run this comparison with that
  permission recorded, and re-check whether Sai can target *our* desktop rather than its
  hosted machine.
- HCU's repo gains a batteries-included agent (not just the MCP layer) → the "planner is
  ours" caveat can be dropped for that arm.

## Cost spent

Four public page reads (HCU repo README, orgo.ai, orgo.ai/pricing.md, Simular llms.txt).
No accounts, no API keys, no spend.