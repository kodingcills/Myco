# F3 — Details MCP: fit for the Foundry's (and the repo's) design workflow

Question: should the Myco design workflow adopt Details MCP, and can the Foundry use it
under the standing no-account / no-spend constraint?

Date: 2026-11-21. Level: L1 (read of the vendor's own MCP page and pricing surface). Owner:
Evaluation Foundry. Scope of the decision: the whole repo, because the answer is the same
for any UI-owning workstream.

## What it is (from the vendor's page, not inferred)

- A **remote Streamable-HTTP MCP server** at `https://api.details.so/mcp`, authenticated with
  **OAuth against a Details account**.
- Two layers: **Inspo** (curated reference gallery: search, then fetch one reference's
  evidence — a static image or seven video frames plus versioned instructions, source
  excerpts, CSS) and **Vault** (production-ready packaged resources: accordions, text
  reveals, page transitions, buttons).
- Tool access by plan: **Inspo tools require a paid plan** (Pro and above). **Vault tools
  require Max, Team or Lifetime.** Free accounts get **20 lifetime credits** "while free
  access is enabled" — explicitly revocable, never refilling.
- Metering: every search costs 2 credits, every inspection 3, **admitted calls spend credits
  even when they return nothing or fail**; no refunds.

## Fit

**It fits the workflow better than a generic "look at pretty sites" step, for three concrete
reasons:**

1. **The evidence model matches the Foundry's contract.** `get_inspiration` returns *proof*
   (frames + versioned source excerpts + CSS), not a screenshot, and the vendor's own
   instructions require reading the evidence before building. That is the same discipline as
   contract §6 (do not score from a preview, score from the artifact).
2. **Vault's stock in trade is stateful UI primitives** — accordions, reveals, transitions.
   Those are exactly the places a runtime's action-verification story is thin: an accordion
   whose opened state is animation-only is a UI where the screen and the state can disagree,
   which is the Foundry's core subject. Details would fail the Foundry's own test if applied
   to product UI without a state assertion, and that is worth knowing before we build one.
3. **It is a *reference* source, not a design system.** Nothing in it commits Myco to a look;
   it supplies the bar (as <https://www.details.so/mcp>'s public site does) and the evidence
   for one detail at a time.

## Constraint check (Tiffany's rules)

| Requirement | Status |
|---|---|
| No account creation | **Blocked** — OAuth against a Details account is mandatory for every tool. |
| No paid spend | **Blocked** — Inspo needs Pro; Vault needs Max/Team/Lifetime. The 20 free lifetime credits are not a plan (2 credits per search, 3 per inspection, revoked at will). |
| No install beyond the repo | **Blocked** — registering the MCP server adds a client-level server (`claude mcp add` user scope, or a `mcp.json`), which is outside the repo. |
| Privacy | Search queries and project context go to OpenAI for ranking. Nothing secret may be passed; a Myco prompt is fine, a guest path is not. |

## Decision

**Queue as an escalation. Do not install, do not create an account, do not subscribe.**
The public site (<https://www.details.so/mcp>) remains available as the *bar* — the design
workstream can and should study it unauthenticated, which is what the brief already asks.

Escalation wording for the outer loop is in
[docs/coordination/foundry-state.md](../../coordination/foundry-state.md) §Escalations.

## What we lose by not having it, and what we do instead

Without Vault, a score report's UI is written from scratch against the bar. That is more
work, not a worse result: the Foundry's report is a single dense page (trial table, verdict
counts, guard status) with no motion, which is the case where a design system adds least.
The one thing genuinely lost is the Inspo **evidence** (frames + source CSS) for a
particular detail — real, but not on the critical path to EF-001/EF-002.

## Reopen-if

- Tiffany authorises a Pro plan (spend) — then adopt for Inspo only, and record the credits
  spent per design task in the ordinary budget ledger.
- Details offers a free read-only mode that returns evidence rather than search previews.

## Cost spent

One public page read (the vendor's `/mcp.md` markdown twin), zero credits spent, no account.