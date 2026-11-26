<!-- Read CONTRIBUTING.md first. Never paste a key, token or password here. -->

## Linked issue

<!-- Fixes #123 / Fixes TIF-123, or "Part of TIF-123" if this does not close it. -->

## Tier

<!-- 0 (docs only), 1 (small low-risk code) or 2 (verdicts, scoring, recovery, VM/guest,
     locks, spend caps, secrets, schemas, M1 evidence numbers). See CONTRIBUTING.md. -->

Tier:

## What changed

## How it was verified

<!-- The commands you ran and their exit codes, e.g.
     pnpm typecheck  -> exit 0
     pnpm lint       -> exit 0
     pnpm test       -> exit 0
-->

## Evidence and scorecard impact

<!-- Does this change a verdict path, a trace, or a number in docs/m1-scorecard.md?
     If yes: which row, and the exit code of `python3 scripts/scorecard-check.py`.
     If no: say "none". -->

## Checklist

- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `npx biome check .` passes
- [ ] `pnpm leak-guard` passes before every push (result stated in a PR comment)
- [ ] No secrets in the code, logs, commits or this description
- [ ] Synced by merging `origin/main`; no force push
