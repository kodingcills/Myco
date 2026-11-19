# Dogfood scenarios

Each scenario is a realistic desktop dev task for an agent running on a
Myco-provisioned desktop. Format: one markdown file per scenario with the
fields below. The **oracle is the contract**: a run is scored from the oracle's
read of persisted state, never from the agent's claims (ADR-0002).

Common fields:

- **id** — `DF-S0N`, stable.
- **task** — the exact prompt handed to the agent under test.
- **app** — path under `dogfood/apps/`.
- **runtime capabilities required** — ids from `docs/coordination/dogfood-state.md` (REQ-…).
- **success oracle** — independent check, run host-side against persisted state.
- **false-success trap** — what a credulous agent will claim vs. what the oracle shows.

Scoring and issue filing: see `dogfood/scoring.md`.
