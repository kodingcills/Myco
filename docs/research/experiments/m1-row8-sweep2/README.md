# Row 8 §7.3: the fresh-operator 30-trial sweep (sweep #2, post-TIF-216)

Evidence that a fresh coding agent, following `docs/eval-runbook.md` §7.3 from a fresh clone,
reproduced the 30-trial normal sweep. This is the §7.3 part of scorecard row 8 only; §7.4
(corrupted suite), §8 (evidence) and §5 (desktop proof) are recorded separately.

## Result

`python3 scripts/m1-scorecard.py docs/research/experiments/m1-row8-sweep2/trials.jsonl`
(output committed as `final-scorecard.md`):

**28/30 verified, meets the ≥ 27/30 threshold.** Wilson 95% 0.79–0.98.

| status | count | trials |
|---|---|---|
| verified | 28 | all others |
| uncertain | 1 | 3: fixture convert missed its 240 000 ms deadline (`convertMs 240483`) at host 1-min load 12–15 during its convert window |
| deploy-failed | 1 | 14: the guest's sshd dropped the agent copy right after a cold reset (`scp: Connection closed`) |

**Strict count (lead ruling, 2026-11-25):** both non-verified rows are harness faults in which
Myco never acted, and both count as non-verified. No exclusions, no re-labelling. For
transparency only: of the 28 trials in which Myco acted, 28 verified. Both faults have fixes
merged after this sweep, not used by it: TIF-219 (#428, convert deadline) and TIF-220 (#429,
stable sshd and a verified deploy copy).

Seed check (`progress.log`): `SEED_CHECK {"distinctSeeds": 6, "distinctHashes": 6, "problems": []}`.

## Provenance

| | |
|---|---|
| Clone | fresh full clone `/private/tmp/row8-op3`, HEAD `10fa13c9` (main with #427, TIF-216) |
| Run dir (host) | `/private/tmp/row8-op3/runs/sweep-20261125T003136Z` |
| Start | `=== trial 0 2026-11-25T00:41:15Z` |
| End | `SWEEP_DONE 2026-11-25T04:48:36Z`, supervisor `DONE rc=0` |
| Pauses | one `PAUSED_LOAD 14.26 at trial 4 2026-11-25T01:25:13Z`; resumed by the supervisor at 01:33:50Z after 1-min load < 10 held for 3 min (`supervise.log`). Resume re-ran `scripts/m1-sweep.sh` on the same OUT, which skips indices already recorded |
| Operator | fresh Claude Opus operator, runbook only; findings G1–G22 in the row-8 operator report |

**Not mixed with the abandoned sweep.** An earlier sweep on the pre-TIF-216 harness
(`/private/tmp/row8-op2/runs/sweep-20261124T140938Z`, clone `d4f91d71`) was abandoned at 11 rows
(7 verified, 3 refuted, 1 uncertain) because of the 15 s agent-call timeout bug fixed in #427.
None of its rows are in this ledger.

## Schema validation

`schema-validation.log`: **29 result.json + 516 trace events, all OK** (trial 14 has no run
directory, because its deploy failed before the trial started).

Since #433 (TIF-223), `validate-live` walks nested layouts and fails on zero, incomplete or
miscounted runs, so the top level validates every run: `pnpm exec tsx
src/integration/validate-live.ts docs/research/experiments/m1-row8-sweep2/runs --expect 29`
prints `validated 29 result.json + 516 trace events … ALL OK` and exits 0 (runbook §8.2). When
this pack was recorded, `validate-live` read one level only and reported `ALL OK` on 0 files at
the top level, which is why `schema-validation.log` was produced per index directory.

## Files

`trials.jsonl` (the ledger), `params.json`, `fingerprints.json`, `progress.log`, `supervise.log`,
`final-scorecard.md`, `schema-validation.log`, and `runs/<index>/<runId>/{result.json,trace.jsonl}`
for the 29 trials that ran. The repo's `.gitignore` excludes `runs/` and `*.log`, so these are
force-added (`git add -f`), as other experiment packs do. `progress.log` contains the agent's ping
`session_id` values: random per-agent-start GUIDs (runbook §5), not credentials. Every `"token"`
field in it is the deploy script's literal `<token>` placeholder. Screenshots are not committed, as for the other experiment packs.

Redaction note (2026-11-25, TIF-241): absolute macOS home paths (and the account name) in this pack's files were replaced after the fact with `~/` or a `<account>` placeholder; nothing else changed.
