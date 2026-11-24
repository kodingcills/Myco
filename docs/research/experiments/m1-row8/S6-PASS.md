# §6 generator proof — PASS, 20/20 verified

**Run 2026-11-24 08:34:06Z → 08:49:46Z** (15 min 40 s), on a guest verified clean beforehand, with
the VM flock held by the run itself.

```
pnpm exec tsx src/integration/run-live.ts --mode values --limit 20 --runs-dir runs/s6-final
exit=0
```

**20 of 20 rows `verified`, exit 0, zero refuted, zero `uncertain`, zero harness errors.**

| | |
|---|---|
| columns | `name` ×5, `qty` ×5, `joined` ×5, `salary` ×5 |
| per-row wall time | 44.7 s – 99.1 s, median ≈ 48 s |
| run dirs written | `runs/s6-final/values/<runId>/` — 20 complete |
| sample | `cell B39 (record EMP-0038, column name) persisted as "REVISED-908578"` |
| lock held | `2536 run-live.ts` for the whole run; flock free on exit |
| guest after | no `soffice`, no stray run dirs |

## Why this run is the one that counts

Two earlier attempts on a clean guest also verified every row that reached the verifier (16 of 16)
but never finished — attempt A lost its host process mid-trial-16, attempt B was cold-reset by a
lock-holding driver at trial 2. **Neither produced a complete 20-row run.** This is the first
`20/20` on a quiet host, and it retires the row-8 §6 finding **F9**, which recorded that the
runbook's "20/20 verified (2026-11-20)" had not reproduced.

**These results are not comparable to attempt A's or B's**, and should not be pooled with them:
those ran at host load 5.8–10.0 and were cut short by infrastructure, not by the generator.

## What had to be true first

Every one of these was a precondition that failed on an earlier attempt:

1. **The flock was free and no driver was running.** r6 released it at ~08:2xZ.
2. **The guest was cleaned past §6.1's filter.** r6 left two stray `soffice` processes and a run
   dir named `20` (the C1 sweep output); `myco-*` does not match it, so every row failed
   `leftover run dirs: 20` until it was removed by name.
3. **A fresh agent token.** r6 installed its own; the cached `~/.myco-token` gave `AUTH_FAILED`
   *after* the guest had been touched.
4. **`nohup`, not `setsid`.** `setsid` does not exist on macOS, and a launcher built on it dies
   instantly and silently — no log, dead pid file, no exit file. Two launches were lost to it.

All four are now written into [`NEXT-RUN.md`](NEXT-RUN.md) so the next operator does not rediscover
them.

## Status

**§6 is PASSED.** This was the gate blocking §7 — the runbook makes the generator proof the
prerequisite for reliability numbers, and **F9 was the reason row 8 stopped there**. §7.3's
30-trial sweep and §7.4's corrupted suite are now unblocked, and the row-8 rerun (a fresh worker in
its own fresh clone, no lock reservation) can proceed with §6 no longer in question.

**Not claimed by this run:** anything about §7. It proves the generator and Calc's input path,
nothing about reliability or the corrupted suite.
