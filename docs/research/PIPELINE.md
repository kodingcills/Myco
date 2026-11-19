# Myco Research Pipeline

Owner: the Myco Research Coordinator thread, woken by the outer loop (T3 Code Bridge).
Outer loop also runs the cheap daily discovery tier (L0).

This document is the policy the pipeline runs under. It exists to keep research
measured by **engineering uncertainty resolved per dollar**, not by papers read.

## Prime directive

Eliminate useful uncertainty, cheaply. Every substantial investigation ends in
exactly one of:

- **adopt** — a finding enters an ADR or a backlog item,
- **benchmark** — a bounded experiment (L2) with its own budget,
- **create a Linear issue** — routed via the outer loop (agents do not call
  Linear directly; see docs/agents/issue-tracker.md),
- **reject with evidence** — the negative result is kept, not deleted.

Keep negative results. A rejected approach with evidence is a resolved
decision; a question nobody wrote down is not.

## Levels and budgets

| Level | Name | Scope | Budget | Who runs it |
|---|---|---|---|---|
| L0 | discovery | Titles, abstracts, metadata, release notes; deduped against `index.jsonl`. No heavy reasoning. | cheap, daily | outer loop |
| L1 | targeted investigation | One specific engineering question; ≤3 substantial sources, ≤5–10 tool calls. | extraction on deepseek-v4.1-flash children; synthesis + decision on kimi-k3 (this thread) | this thread |
| L2 | experiment | Read methods/code deeply, reproduce, benchmark against Myco baselines. Each L2 = one Linear issue in project "Myco Research" (team TIF) with explicit tool-call and compute budget. | per-issue budget; code run by glm-5.3 delegate_task workers in worktrees; independent kimi-k3 verifier checks results before anything is claimed | proposed here, mirrored by outer loop, run by delegates |

Budgets are starting values. More budget is requestable only by naming the
concrete information gap it would close.

Parallel research children are spawned only when a question splits into
genuinely independent sub-questions with different deliverables (systems
feasibility vs correctness vs economics). One narrow bug = one agent.

## Stopping conditions (explicitly permitted)

Stop when any holds:

1. The question is answered with adequate primary evidence.
2. A small experiment would resolve the rest better than more reading.
3. Searches have become repetitive.
4. The next step costs more than its expected engineering value.
5. The hypothesis is falsified or superseded.

Prefer an experiment over more speculation once there is a plausible approach.

## Artifacts

- `docs/research/index.jsonl` — one line per source. Fields:
  `canonical_id` (arXiv id / DOI / `repo:owner/name[@version]` / `doc:<path>`),
  `url`, `title`, `version`, `subsystem`, `question`, `key_claims`,
  `limitations`, `evidence_pointers`, `prior_experiments`, `decision`,
  `reopen_if`, `level_reached`. Committed. This is the dedup target: L0 checks
  `canonical_id` before adding anything.
- `docs/research/ledger.jsonl` — one line per investigation:
  `{ts, question, level, tool_calls, tokens, outcome, decision_resolved}`.
  Feeds the four metrics: cost per resolved decision, cost per actionable
  experiment, duplicate rate (L0 additions rejected as already-indexed ÷
  total L0 candidates), and the informative-outcome rate of experiments
  (succeeded or failed informatively ÷ total).
- `docs/research/findings/<id>.md` — one file per resolved finding. Sections,
  in order, no ten-page reports:
  1. Question
  2. Evidence — primary sources with exact pointers; claims vs limitations
  3. Decision — adopt / investigate experimentally / reject
  4. Proposed smallest experiment, if any
  5. Next action
  6. Reopen-if condition
  7. Cost spent — tool calls, tokens if known
- `~/.myco/research-cache/<canonical_id>/` — raw PDFs and cached parses,
  keyed by canonical id (the marciob/skill-research-papers cache pattern).
  Gitignored by location (outside the repo). Nothing large is pasted into
  context; findings link or point at the cache.

Optional: a SQLite file derived from `index.jsonl` is allowed only if it pays
for itself (rebuild it from the JSONL; the JSONL stays canonical).

## Reference designs evaluated (Phase 0, 2026-11-19, 4 tool calls)

- **grammy-jiang/research-pipeline** (pip package, CLI + 42-tool MCP server):
  staged plan→search→screen→download→convert→extract→synthesize pipeline with
  run manifests. Too heavy to install for Myco's per-question L1/L2 pattern.
  **Stolen:** the staged-pipeline shape and per-run manifest discipline.
  **Not installed.**
- **marciob/skill-research-papers** (Claude Code/Codex skill): arXiv/OpenAlex/
  PubMed discovery plus a fetch cascade, caching everything under
  `~/.cache/research-papers/<canonical_id>/`. **Stolen:** the canonical-id
  cache layout and identifier-resolution discipline. **Not installed** — our
  cache is `~/.myco/research-cache/` and our fetch needs are per-question, not
  a standing skill.

## Citation discipline

Every citation (arXiv id, title, claim) is verified against the primary source
before it enters the index or a finding. A link or claim that does not check
out is marked `unverified`, never repeated as fact. This matches the method
note at the top of docs/research/adapters.md and the `[UNVERIFIED]` /
`[INFERENCE]` tags used in existing research docs.

## Coordination rules

- This thread informs; it does not change other owners' code or override their
  ADRs. Recommendations route through the outer loop.
- Linear is owned by the outer loop (docs/agents/issue-tracker.md). This thread
  proposes issues; it never calls Linear.
- The Windows VM `myco-win11` is M1-owned and untouched by research.
- No paid APIs or accounts. Free public papers and repos only.
- Git: push a branch, open PRs, merge only after an independent verifier
  passes and CI is green. Never force-push main, change repo settings, delete
  others' branches, add secrets, or edit `.github/workflows`.

## Cadence

After Phase 0 and the initial L1 questions this thread goes **idle**. The
outer loop wakes it with specific questions from engineering blockers,
failures, and architecture decisions, or with promoted L0 discoveries. No
polling, no self-scheduling.
