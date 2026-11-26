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

### Targeted tests and targeted CI

While iterating, run only the tests for your area (per-area commands: `CONTRIBUTING.md`, "Targeted tests per area"; the rule: `docs/coordination/CONTRIBUTING-agents.md`, "Targeted testing"). The quickest is `pnpm exec vitest run --changed origin/main`. Run the full `pnpm test` once before opening a PR.

CI narrows itself too (`docs/ci.md`, "Targeted CI"): docs-only and low-tier PRs run the related tests plus a core smoke set; pushes to `main` and every Tier 2 PR run everything. A PR is Tier 2 for CI when its body has a `Tier: 2` line, it has the `tier-2` label, or it touches a Tier 2 or tooling path (all of `scripts/` and `src/benchmark/` among them) or a file a script can reach. If you raise a PR's tier, add the `tier-2` label: that starts a full run.

### Secrets (TIF-206, enforced)

Never print a secret value into a thread, log, PR, or commit. This is enforced, not advisory: on Tiffany's Mac every agent harness (Oh My Pi, Claude Code, Codex) runs `~/.config/secret-guard/guard.sh`, which refuses `ps e`/`eww`/`-E`, bare `env`/`printenv`/`export -p`/`set`/`declare -x`, `/proc/*/environ`, `launchctl getenv`, keychain `-w`/`-g` reads, `gh auth token`, reads of `.env*`, `credentials.txt`, `seed.iso`, `~/.t3/userdata/secrets`, `~/.myco/secrets` and private keys, and `echo $*KEY*`-style prints, and it redacts key-shaped strings from tool output. A block is the answer: do not rephrase, encode, or split the command to get past it. Use names-only checks instead (`env | cut -d= -f1`, `[ -n "$VAR" ] && echo set`, `test -f PATH && echo exists`, `ps -o pid,ppid,etime,command -p PID`), and if you truly need a value, stop and ask the human.

In code, load keys at the point of use (see `src/baseline/secret-file.ts`): pass a secrets file path, never the key, through environment or argv. CI scans every new commit with gitleaks (`secret-scan` job); enable the same check locally with `git config core.hooksPath .githooks`.
