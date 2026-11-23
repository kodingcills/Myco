# MVP Discovery — handoff

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
| [#315](https://github.com/kodingcills/Myco/pull/315) | Part of TIF-138 — launcher claims a run atomically, and can stop what it started | `b92ee9f` | OPEN, round 1 verifier `LauncherPRVerifier` running; no auto-merge armed |
| [#300](https://github.com/kodingcills/Myco/pull/300) | Same scope, earlier attempt | `9171ed` | **CLOSED** at the 3-round cap (TIF-162), superseded by #315 |

Other open PRs in my name are **other owners' ticket work** I am carrying, not
Discovery's: #316 (TIF-166), #314 (TIF-164), #313 (TIF-163), #312 (TIF-158),
#304 (TIF-159), #276 (TIF-140).

`origin/main` when this was written: `6d19507`.

**What #315 must keep** (from #300's three rounds, all independently reproduced):
- `--run` claims the run with `mkdir "$RUN_DIR/s0.lock"`. A noclobber redirect inside a
  subshell is **not** atomic — bash parses the redirect before `set -C` runs in the same
  subshell — measured at 28 double-starts in 30 rounds. `mkdir` measured 0 in 400.
- The child is spawned with an **absolute** script path so the `$ROOT`-anchored `--stop`
  fallback can match it; the fallback walks pids from `pgrep` and never signals the shell.
- `--status` is anchored on `$ROOT`; unanchored it listed other worktrees' children.
- The probe and gate verdict go to the log; `--probe`/`--status`/`--stop` answer on the
  terminal (a person asked).
- The lock is released on gate refusal, watchdog exit and `--stop`.
- The race test must fail against **both** reverts: check-then-write → `expected 8 to be 1`,
  subshell noclobber → `expected 3 to be 1`. #300's own test passed against the revert,
  which is the specific failure this one exists to avoid.

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
