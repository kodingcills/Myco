# Row 8 §7.4: the fresh-operator corrupted suite, plus the deploy check and §5

Evidence that a fresh coding agent, following `docs/eval-runbook.md` from a fresh clone, reproduced
the corrupted / interrupted suite (§7.4), the real-guest deploy (§3.1 + §4) and the desktop proof (§5).

## §7.4 result

The suite's own audit (`summary.txt` / `summary.json`, written by `scripts/m1-corrupt-suite.sh`):
**18/18 recorded and eligible; 6 verified, 9 refuted, 3 uncertain; falseSuccesses 0,
unprovenVerified 0, unprovenRecovery 0; ledger 39 rows, 0 unaccounted; `"passed": true`.**

| class | recovery | recorded | verified | refuted | uncertain | false successes |
|---|---|---|---|---|---|---|
| kill | no | 3 | 0 | 0 | 3 | 0 |
| invalid-target | no | 3 | 0 | 3 | 0 | 0 |
| dropped-save | no | 3 | 0 | 3 | 0 | 0 |
| focus-change | no | 3 | 0 | 3 | 0 | 0 |
| kill | yes | 3 | 3 | 0 | 0 | 0 |
| invalid-target | yes | 3 | 3 | 0 | 0 | 0 |

Every corrupted trial without recovery ended non-verified, so no fault was scored as a success.
Every recovery trial verified against the persisted value (kill: two retries failed, then a
relaunch completed; invalid-target: the first retry completed).

## Schema validation

`schema-validation.log`: **18 result.json + 321 trace events, all OK**, validated per index
directory (`runs/<index>/`). Since #433 (TIF-223) the top level validates every run and fails on 0:
`pnpm exec tsx src/integration/validate-live.ts docs/research/experiments/m1-row8-corrupt/runs
--expect 18` prints `validated 18 result.json + 321 trace events … ALL OK` and exits 0 (runbook
§8.2). When this pack was recorded, the top level validated 0 files and still printed `ALL OK`,
which is why the log was produced per index directory.

## §8 reproduction (a new operator session on the same clone, host-only)

- **§8.2:** per-index `validate-live` gives 18 result.json + 321 trace events here, and 29 + 516 for
  the §7.3 sweep, all OK. Every ledger run ID and verdict matches its result.json and trace.
- **§8.3:** `scripts/m1-corrupt-suite-record.py --final <copy>/params.json <copy>/trials.jsonl`, run on a copy (it rewrites the ledger and
  summary in place and takes the eval ID from the directory name), rebuilt `ledger.jsonl` and
  `summary.json` **byte-identical** to the originals, and its printed summary matches `summary.txt`.
  `m1-corrupt-suite-ledger.ts` also passes.
  Replay it under the original OUT basename, `corrupt-20261125T052233Z` (the first `ledger.jsonl`
  row's `evalId`), not `m1-row8-corrupt`; runbook §8.3 has the exact commands.
- **TIF-223 (fixed since by #433):** at the time, `validate-live` on any OUT, on `runs/`, or on an
  empty directory printed `validated 0 … ALL OK` and exited 0, because it scanned one level only
  and had no minimum count.

## Deploy check and §5 (same operator, same clone, before the suite)

- **§3.1 reset:** 250 s, ended `reset-trial-vm: ready on 'clean-base'`.
- **§4 deploy:** 201 s, first copy attempt: `==> verified 13 files on the guest against the source
  (sha256)` then `DEPLOY OK` (`deploy-check.log`). This is the first run of TIF-220's hash-verified
  copy on the real Windows guest.
- **§5 desktop proof** (the TIF-209 `session_info` CLI): printed
  `{"session_id":1,"window_station":"WinSta0","desktop":"Default","user":"MYCO-WIN11\\myco"}`, exit 0.
  This is the first live pass of §5. The earlier inline recipe was always refused by the secret guard.

## Provenance

| | |
|---|---|
| Clone | fresh full clone `/private/tmp/row8-op4`, HEAD `bfbe2770` (main with #428 TIF-219 and #429 TIF-220) |
| Run dir (host) | `/private/tmp/row8-op4/runs/corrupt-20261125T052233Z` |
| Start / end | launched 2026-11-25T05:22:33Z; `SUITE_DONE` 07:36:16Z; supervisor `DONE rc=0` (`supervise.log`) |
| Launch | detached under a supervisor (`nohup caffeinate`), started after 1-min load < 10 held for 3 min; it would resume the same OUT only after a load pause (exit 4) |
| Operator | fresh Claude Opus operator, runbook only; findings G23–G31 in the row-8 operator report |

## Files

`trials.jsonl` (the recorder's input: one record per trial), `ledger.jsonl`, `params.json`,
`progress.log`, `summary.json`, `summary.txt`, `trial-<i>.out` /
`trial-<i>.err` (per-trial stdout report and stderr), `supervise.log`, `deploy-check.log`,
`schema-validation.log`, and `runs/<index>/<runId>/{result.json,trace.jsonl}` for all 18 trials.
`.gitignore` excludes `runs/` and `*.log`, so these are force-added. Every `"token"` field in the
logs is the deploy script's literal `<token>` placeholder; the pack contains no key-shaped string.
The per-start ping `session_id` GUIDs in the logs are not credentials (runbook §5). Screenshots
are not committed.
