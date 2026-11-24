# Myco

See `docs/product/vision.md` for the product vision and Milestone 1 acceptance criteria.

## Agent skills

### Issue tracker

Issues are tracked in Linear, team TIF. Tiffany's outer-loop assistant (T3 Code Bridge) owns the issue structure and mirrors `docs/backlog/*.md` into Linear. Agents (including Claude cloud sessions) MAY read Linear and MAY update the status of, comment on, and link PRs to the TIF issue they are working on. Agents MUST NOT create, delete, re-parent, or move issues between projects, or edit other issues' scope; those changes still go through the outer loop. See `docs/agents/issue-tracker.md`.

### Triage labels

Default triage label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), applied to the Linear mirror. See `docs/agents/triage-labels.md`.

### Verifier briefs

How to brief a delegated verifier, and the failure each rule exists to prevent: `docs/agents/verifier-briefs.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
