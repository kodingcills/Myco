# Issue tracker: Linear (team TIF), mirrored by the outer loop

Issues and specs for this repo live in **Linear**, team **TIF**.

## Access model

- **Tiffany's outer-loop assistant** (T3 Code Bridge, Grok Bot) owns Linear. It is the only party that creates, deletes, re-parents, or moves issues, or edits scope.
- Agents working in this repo (including Claude cloud sessions) MAY read Linear and MAY update status, comment on, and link PRs to the TIF issue they are working on. They MUST NOT create, delete, re-parent, or move issues between projects, edit other issues' scope, create Linear accounts, or install Linear tooling beyond what the session already provides.
- The canonical backlog lives in this repo as markdown: `docs/backlog/m1.md` (Milestone 1). Each entry carries a stable id, title, description, acceptance criteria, owner role, and explicit `blocked_by` ids.
- The outer loop mirrors `docs/backlog/*.md` into Linear (team TIF) and reports back the Linear identifiers. Until then, refer to issues by their markdown ids (e.g. `M1-007`).
- Status flow: an agent updates `docs/backlog/m1.md` and `docs/coordination/m1-state.md`; the outer loop propagates to Linear. Escalations (blockers, decisions needing Tiffany) go in the coordinator's end-of-turn report, not in Linear.

## Conventions

- **Create / update an issue**: edit `docs/backlog/m1.md`. Keep ids stable; never renumber.
- **Blocking**: the `blocked_by` field lists markdown ids. A ticket is unblocked when every id in its `blocked_by` is marked done.
- **Comment / discuss**: write into `docs/coordination/m1-state.md` (decisions, blockers) or the relevant `docs/research/` note.
- **Close**: mark the entry `status: done` with a one-line evidence pointer (PR, test output, doc path).

## When a skill says "publish to the issue tracker"

Add or update the entry in `docs/backlog/m1.md` and flag it in the coordinator's report for the outer loop to mirror.

## When a skill says "fetch the relevant ticket"

Read `docs/backlog/m1.md`.

## Pull requests as a triage surface

**PRs as a request surface: no.** PRs live on GitHub (`kodingcills/Myco`) and are tracked by the coordinator; they are not a request queue.
