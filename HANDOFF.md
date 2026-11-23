# MVP Discovery — handoff

---

## 0. Session 2026-11-23 10:25 ET — read this first

Restarted thread. Preflight done; #315 amended (test-only), pushed, and **round 1 PASSED**.
**Head `5b610b2` (code `434d1ba`); PR #315 is MERGEABLE and `BEHIND` origin/main.**

### 11:00 ET — round 1 verdict: PASS

`LauncherPRVerifier2` at `434d1ba`: **correct, confidence 0.93**, no patch-introduced
defect. Six checks, all green, independently reproduced:
- targeted suite 7/7 on 3/3 runs;
- check-then-write control fails 3/3 with the expected assertion;
- `exec -a` scoping fix: 0 leaked sleepers and 0 leaked watchdogs across 3 runs;
- a decoy `sleep 297` outside the suite survives and is the only sleeper;
- `scripts/s0-live.sh` differs from `b92ee9f` in **comment lines only** (0 non-comment
  changed lines); the `mkdir` claim line is byte-identical to `b92ee9f`.

**Next: sync `origin/main` and merge** (outer loop's call on timing). `mergeStateStatus:
BEHIND` as of 11:00. No verifier rounds remain to spend (1 of 3 used).

### 10:50 ET — round 1 verdict, its two nits, and the fix

`LauncherPRVerifier` returned **correct** (confidence 0.88) on `75467ed`: 8/8 PASS at
head, 3/3 FAIL against revert A, and it independently confirmed the revert-B gap (20/20
rounds admit one, with and without the pid guard). Two P3s, both fixed at `434d1ba`:

- **The `--run` comment was wrong.** It justified `mkdir` by claiming bash truncates
  through noclobber. On bash 3.2.57 `( set -C; : > f )` refuses and exits 1, and admits
  exactly one winner in 20/20 races of eight. The `mkdir` code was always right; the
  rationale and the "28 double-starts in 30 rounds" figure were unsupported and are gone.
- **The cleanup killed other people's processes.** `afterEach` ran an unscoped
  `pkill -9 -f "sleep 297"`. Its fix took four approaches: the sleeper's argv is exactly
  `sleep 297`, its parent stub dies and orphans it, macOS has no `setsid`, and ppid
  matching fails the moment the parent is reaped (29 orphans in one 30-round run). What
  works: the stub now `exec -a "<dir>/sentinel" sleep 297`, so argv[0] carries the fixture
  path and the existing dir-scoped `pkill -f <dir>` reaps it. Measured: 0 leaked sleepers
  across 3 suite runs, and a decoy `sleep 297` started outside the suite survives.

Re-verified at `434d1ba`: HEAD 7/7, revert A still fails 3/3, lint/typecheck clean,
launcher differs from `b92ee9f` only in that comment.

### 10:37 ET — outer-loop rulings

1. **No #316 conflict.** #315 does not touch `scripts/run-s0*.sh`; the `mkdir` claim stays.
2. **Test-only amendment AUTHORISED**, launcher untouched. Done at `75467ed`:
   the race test now asserts, *before any `--stop`*, that exactly one racer's watchdog is
   still alive and that `s0.pid` names it; 30 rounds; explicit 30 s timeout.
3. **Negative control: revert A confirmed, revert B does not exist.**
   - HEAD, 30 rounds: PASS 3/3 (~7.7 s each).
   - Revert A (check-then-write on `$PID_FILE`, 30 rounds): **FAILS 4/4** — `expected 2 to be 1`.
   - Revert B (subshell noclobber): **not reproducible against this launcher at all.**
     With the pid-file guard *also* removed, 320 racers in 40 rounds still admitted exactly
     one. So no test can be made to fail against B here; that is a property of the code
     (`--run` kills its own watchdog on refusal, and the pid-file guard short-circuits
     first), not a gap in the test. The outer loop's "must fail against both reverts"
     premise from §1 is **falsified by measurement** and should be retired.
4. Pushed `75467ed` on `tif-138-launcher-claim` after merging `origin/main` (`a5fb548`).
   PR linked; no watch armed (the merge is the outer loop's call).

### Host preflight (the requested first task)

- **The load test was already gone.** No match for `t2-lc-verify`, `race.sh`, `s0-live.sh`,
  or pids 4057 / 4123–4132; no `while :` spinners anywhere. Nothing was killed; it had
  exited before this session began.
- `uptime` at 10:23: **load averages 33.55 / 45.55 / 40.65**.
- Top 5 by CPU: Grok Bot GPU helper `0.5%`, Grok Bot renderer `0.4%`, Chrome helper
  `0.3%`, `biomesyncd` `0.4%`, `mapssyncd` `0.2%` — under 1.5% of one core *combined*.
  **The load average is not sustained by any running process on this host.** Tell M1: their
  "load 31–33" is a decaying 1-minute EMA from an old spike, not live contention; the VM
  queue is very likely unblocked right now.

### #315 Tier-2 pre-check result — REJECT-shaped, do not hand to a verifier as-is

Harness `/tmp/t2-lc-verify/race.sh`; stubs first on PATH (TIF-161); no VM; launcher at
`bf7d738` on `tif-138-launcher-claim`; worktree restored to HEAD afterwards.

| State | Params | winners / refusals | bad_rounds | winner_pid_dead |
|---|---|---|---|---|
| HEAD (`mkdir` claim) | 8×5 | 5 / 35 | 0 | 0 |
| **Revert A** check-then-write on `$PID_FILE` | 8×5 | 7 / 33 | **2** | 0 |
| **Revert A** | 8×10 | 11 / 69 | **1** | 0 |
| **Revert B** subshell noclobber `( set -C; : > "$LOCK_DIR" )` | 8×10 | 10 / 70 | **0** | 0 |
| **Revert B** | 8×50 | 50 / 350 | **0** | 0 |

- **A: confirmed.** The "expected 8 to be 1" shape is reached fast. Good.
- **B: FAILS the pre-check.** 400 claims, 4000 processes, zero bad rounds. §1's claim that
  the race test must fail against **both** reverts does **not** hold for the current
  harness. A PASS against B is the exact failure this PR exists to avoid.
- **Why:** `--run` starts `nohup "$0" --watchdog` *before* the claim and kills it on
  refusal. The per-refuser kill makes the race resolve to one live winner anyway, so a
  winner-count assertion cannot see the recording race. The subshell-noclobber revert
  does leak — the second claimer overwrites `s0.pid` and kills the first's child — but the
  detectable symptom is `rounds_winner_pid_dead`, and the harness's `--stop` masks it.

### Blocked on the outer loop (Linear is 401 for me; no peer to message)

1. **#316 conflict question.** #316 (TIF-166) pins `not.toContain("set -C")` in
   `scripts/run-s0*.sh`. #315 does not touch those files → no conflict. Confirm, or tell me
   whether #315 must be the *toolchain-independent* mkdir.
2. **Authorise a test amendment** (launcher untouched): the race test's success criterion
   becomes "`s0.pid`'s recorded pid is alive after the round, and exactly one of the N
   racers is still alive" — the assertion revert B actually fails. This re-arms the B
   requirement without changing the shipping fix.
3. Or: say explicitly that the verifier should run against unchanged `bf7d738` with the
   revert-A evidence attached and B recorded as a known gap.

Then: one verifier, ≤4 spinners, ≤3 min, only after a Coordinator slot is confirmed
(TIF-137). **M1's host is free now — the VM queue can proceed.**

---

Written 2026-11-23 10:0x ET by the MVP Discovery thread, at the outer loop's request,
so this thread can be restarted with fresh context and the host freed for the M1 VM
queue. Read this first; it is the entry point, not the archive.

Durable worktree for launcher work: `/Users/tofuinparis/Projects/myco-launcher-claim`
(created for TIF-138 because the outer loop asked for a path outside `/tmp`).
Discovery's own worktree: `myco-mvp-discovery-4b5ff1cd3a7126c4`.

---

## 1. Open PRs and their state

| PR | What | Head | State |
|---|---|---|---|
| [#315](https://github.com/kodingcills/Myco/pull/315) | Part of TIF-138 — launcher claims a run atomically, and can stop what it started | `434d1ba` | OPEN, round-1 verifier `LauncherPRVerifier2` running; no auto-merge armed |
| [#300](https://github.com/kodingcills/Myco/pull/300) | Same scope, earlier attempt | `9171ed` | **CLOSED** at the 3-round cap (TIF-162), superseded by #315 |

Other open PRs in my name are **other owners' ticket work** I am carrying, not
Discovery's: #316 (TIF-166), #314 (TIF-164), #313 (TIF-163), #312 (TIF-158),
#304 (TIF-159), #276 (TIF-140).

`origin/main` when this was written: `6d19507`.

**What #315 must keep** (from #300's three rounds, all independently reproduced):
- `--run` claims the run with `mkdir "$RUN_DIR/s0.lock"`. The subshell-noclobber
  alternative is not a claim at all — on bash 3.2.57 `( set -C; : > f )` refuses and exits
  1, and admits exactly one winner in 320 racers (measured 2026-11-23, §0). `mkdir` is the
  form that both claims and fails cleanly, and it measured 0 double-starts in 400.
- The child is spawned with an **absolute** script path so the `$ROOT`-anchored `--stop`
  fallback can match it; the fallback walks pids from `pgrep` and never signals the shell.
- `--status` is anchored on `$ROOT`; unanchored it listed other worktrees' children.
- The probe and gate verdict go to the log; `--probe`/`--status`/`--stop` answer on the
  terminal (a person asked).
- The lock is released on gate refusal, watchdog exit and `--stop`.
- The race test must fail against the **check-then-write revert** (`expected N to be 1`).
  The "subshell noclobber → `expected 3 to be 1`" requirement is **retired by measurement**
  (2026-11-23, §0): that revert admits exactly one winner in 320 racers across 40 rounds,
  with and without the pid-file guard, so no test can be made to fail against it.
  #300's own test passed against its revert, which is the failure this one avoids.

## 2. Linear

I **cannot read or write Linear**: the configured MCP server
(`https://mcp.linear.app/mcp`) returns **401**, there is no credential on this host
(`~/.omp/oauth/native/darwin/` holds only `zcode`), and `api.linear.app/graphql` also
401s. Every status change below has to go through the outer loop.

| Id | Meaning | State |
|---|---|---|
| TIF-89 | Discovery S0 first live run (executes MVD-001) | **Blocked, not started.** No live S0 evidence exists. |
| TIF-138 | The launcher work in #315 / closed #300 | Round 1 under way |
| TIF-162 | The cap log for #300 | #300 closed under it |
| TIF-165 | Tracking for the #315 remainder | Referenced in #315's body |
| TIF-144…147 | The four gui-spec compare-view must-fixes | **Not started** |
| TIF-148 | Make `intake()` reachable | **Not started**; outer loop says after S0 work |
| TIF-137 | Guest-without-lock escalation | Closed by evidence; see §5 |
| TIF-144…150, TIF-153, TIF-155, TIF-158, TIF-159, TIF-163, TIF-164, TIF-166 | Other owners' work I am carrying PRs for | See §1 |

## 3. Directions A / B / C

The recommendation lives in `docs/product/wedge-recommendation.md` (in the Discovery worktree: `myco-mvp-discovery-4b5ff1cd3a7126c4/docs/product/wedge-recommendation.md`)
(merged as [#278](https://github.com/kodingcills/Myco/pull/278), TIF-60).

- **Recommended: Direction A, narrowed** — verified GUI tests for coding agents: a task, a
  state oracle, and a run report whose verdict comes from persisted state, not the agent's
  claim.
- **B** (verified operations on API-less business software) is the long-term execution
  abstraction, not the first experience. **C** (branchable desktops) is deferred: Orgo
  already ships fork/clone, and no measurement says branching beats replay-from-known-good.
- **Measured:** M1's core (29 verified / 1 refuted, 21 eligible trials, 0 false successes,
  0 unaccounted ledger entries); the false-success demo (`--task df-s02` prints the UI claim,
  the store's two dropped items, and REFUTED); ~3 s clone→verified report; exit code from
  schema + cross-file validation; 8 surveyed product lines, none returning a persisted-outcome verdict.
- **Not measured:** no head-to-head (TIF-59 blocked on Foundry fixtures/verifiers), no live
  S0 verdict, no fresh-agent timing, no model cost, no Codex/Claude Code run, B and C unmeasured.

### MVD-001 acceptance, honestly

1. Quickstart — **met on the mock path** (a fresh agent has not been timed).
2. Live DF-S02 refuted from the guest store — **not met** (needs the guest).
3. Schema-valid artifacts + a summary naming claim, state, verdict — **met**.
4. Two ordinary coding-agent environments — **not met** (contract tested, never run inside Codex/Claude Code).
5. Wall-clock and model cost — **half met** (wall-clock recorded with provenance; model cost `not-measured`).
6. One forced failure recovered or `uncertain` — **not met** (needs the guest).

**The ratified `guestClean` definition** (outer loop on Tiffany's behalf, 2026-11-23, on
`main` via [#290](https://github.com/kodingcills/Myco/pull/290)): *the app's store and
published state files are absent before launch* — advisory, and every S0 record must state
it was in force. **`oraclePresent` stays unproven**: Foundry's verifier has not validated an
S0 run, so an S0 PASS must not be read as MVD-001 coverage. `RuntimeTransport.evidence()`
returns both `false` on every path, so `--transport live` cannot leave its preflight today.

## 4. gui-spec compare-view review

[PR #230](https://github.com/kodingcills/Myco/pull/230) is **MERGED** (`d7b84669`); the
review comment is on it. Verdict **CONDITIONAL PASS**; the DEVIATIONS entries are signed off.
Four must-fixes in **one** Tier-1 PR:

| Id | Fix | Site |
|---|---|---|
| TIF-144 | unknown false successes must read `not recorded`, never `0`/`n/a` | `viewer/src/components/HeadToHead.tsx:148` (in the Discovery worktree: `myco-mvp-discovery-4b5ff1cd3a7126c4/viewer/src/components/HeadToHead.tsx:148`) |
| TIF-145 | remove the forbidden verdict words `Refuted`/`Uncertain` from arm-table headers | `viewer/src/components/HeadToHead.tsx:131` (in the Discovery worktree: `myco-mvp-discovery-4b5ff1cd3a7126c4/viewer/src/components/HeadToHead.tsx:131`) — **read `docs/design/gui-spec.md` §4.3 for sanctioned wording first; do not invent a synonym** |
| TIF-146 | `?compare=<url>` must not `fetch()` arbitrary URLs | `viewer/src/components/App.tsx:135` (in the Discovery worktree: `myco-mvp-discovery-4b5ff1cd3a7126c4/viewer/src/components/App.tsx:135`) — restrict to same-origin |
| TIF-147 | "does not say" copy is hardcoded ef-t01/ef-t01b; `Generated` is UTC `Z` | `viewer/src/components/HeadToHead.tsx:299` (in the Discovery worktree: `myco-mvp-discovery-4b5ff1cd3a7126c4/viewer/src/components/HeadToHead.tsx:299`) and `:118` — the report already carries `decision.taskId`/`promptVariant` |

Nits after M1: TIF-149, TIF-150.

**TIF-148 (do not conflate):** the run view is **live and works on real artifacts** (TIF-155,
[#296](https://github.com/kodingcills/Myco/pull/296) merged; 54 trials committed under
`docs/research/experiments/m1-runs/`; guarded by `scripts/check-scorecard-links.py`). **Do
not touch the run loader or the trial-row links.** `intake()` is the **head-to-head** path
and is reached only from `viewer/test/live-report.test.ts`. The design question is what
`ArmSource` the app can construct — **state which in the PR**, because it decides whether
the scorecard can deep-link the compare table. The outer loop adds those links after.

## 5. Host and guest

- **My guest is down and has been since ~01:12.** `pgrep -f qemu-system-aarch64` → none;
  port 10022 → nothing listening. It was stopped on the first request with
  `runtime/guest/shutdown.sh`. The "up ~2h / port held" reports were five stale reads; the
  outer loop confirmed and apologised.
- **The lock is still not a lock.** `/tmp/myco-win11.vm.lock` says `free`, nothing writes it,
  and `runtime/guest/boot.sh` never reads it. That is the mechanism behind three owners
  each reading `free` as an idle host. The fix is an `flock LOCK_EX` taken in `boot.sh` and
  refused when held; [PR #283](https://github.com/kodingcills/Myco/pull/283) is the runtime
  side of exactly that.
- **Do not start a guest** unless the Coordinator grants a locked slot (TIF-137). The
  Screenshot owner holds the VM.
- **No repeated full-suite loops while a VM slot is open** — ask the Coordinator first. The
  load spike this thread caused (pid 4381 at ~1200% CPU) came from a 10× `pnpm test` loop
  under CPU burners, run because a message asked for it.

## 6. Environment faults to know about

- **The shell tool is dead.** `echo alive` times out (>60s, repeatedly). Everything is being
  run through the Node bridge from the eval kernel instead: `child_process.spawnSync` for
  `git`, `gh`, `pnpm`, `node`. That works, but the harness's shell backend needs a restart.
- **`pnpm test` and the launcher file:** the launcher test signals real processes and
  deadlocks vitest's worker-thread pool (`>200s` hang, `ERR_IPC_CHANNEL_CLOSED`). #315 runs
  it in its own forked, single-fork invocation from `package.json`; ~3 s alone, ~18 s for
  the whole suite.

## 7. Next three steps

1. **Wait for `LauncherPRVerifier`'s verdict on [#315](https://github.com/kodingcills/Myco/pull/315) at `b92ee9f`.**
   On PASS: sync with `main`, merge, and report the merge SHA. On REJECT: do **not** loop —
   narrow to the part that passed, merge that on green CI, and put the remainder in a new
   small PR under a new TIF id with a fresh round 1.
2. **Then the four compare-view must-fixes (TIF-144…147) as one Tier-1 PR**, after reading
   `docs/design/gui-spec.md` §4.3/§4.5/§4.6/§4.7 for the sanctioned wording and time format.
   One verifier round. This is the piece the M1 scorecard-to-viewer links wait on.
3. **Then TIF-148**, splitting the compare source from the run view, and report back so the
   outer loop can add the paired-table links.

**S0 stays closed** until the outer loop sends an explicit GO carrying the advisory
`guestClean` definition, and it queues behind Dogfood's DF-S01.

## 8. Standing discipline this thread learned the hard way

- Three of #300's four rejections were about **the test**, not the fix: a test that asserted a
  refusal both shapes produce, a test pinning source text, and a race test whose liveness
  assertion read state a gate-refusing watchdog had already deleted. **Prove a new test fails
  before the fix, and passes after** — that is the only thing that makes it a regression test.
- Two claims I shipped were false and were caught by verifiers: a "first live run reported
  df-s01 verified" that was synthetic (self-retracted), and a `guestClean` "ratification"
  quoted from a PR description rather than the document ([#287](https://github.com/kodingcills/Myco/pull/287),
  closed by me). Read the source, not the summary of it.
- Report which parts of a result are live and which are mock, per artifact, not per run.
