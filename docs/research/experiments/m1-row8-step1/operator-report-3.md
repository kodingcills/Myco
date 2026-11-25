# Row 8 operator report 3 (fresh operator, runbook-only)

## Step 0: PR #433 gate
- 2026-11-25T07:59:56Z `gh pr view 433 --json state` -> OPEN (load 4.01). Polling every 2 min up to 40 min.
- 2026-11-25T08:04:03Z poll saw MERGED (mergedAt 08:02:31Z, merge commit 5a00c578).

## Clone
- `git clone https://github.com/kodingcills/Myco /private/tmp/row8-step1` at 08:04:11Z, load 3.48.
- HEAD = 5a00c57877bad630ad2d06a2df04b484b6edd039 (the #433 merge itself). Runbook = docs/eval-runbook.md, 1326 lines, read in full before starting.

## Step 1: §1 preconditions + setup
### §1.1 preconditions (08:04:30Z, load 3.52)
- `test -e` on ~/VMs/myco-win11/{ssh_config,scripts/vm.sh,reset.sh,wait-ssh.sh,vssh,shutdown.sh}, scripts/{vm-state.sh,reset-trial-vm.sh,wait-guest-ready.sh}, agent/bootstrap/deploy-to-vm.sh: all exist. UTM.app installed and running (pid 72072). nc, openssl present. Node v24.4.1, pnpm 10.34.9.
- A `test -e ~/VMs/myco-win11/id_ed25519` was BLOCKED by the host secret guard ("reading private key file"). Not rephrased. See H2.
### §1.2 setup
- `pnpm install --frozen-lockfile` 08:04:45Z, load 3.43: rc 0, 1 s.
- `pnpm typecheck` rc 0, 3 s. `pnpm lint` rc 0, 1 s.
- `pnpm test` 08:04:55Z→08:05:42Z, load 3.52, 47 s: rc 0. vitest 86 files / 1087 passed, 1 skipped; second vitest run (s0-live-launcher, forks) 7 passed; then `validated artifacts for 5 trials (all ok)` after one long no-newline line. Expected: matches (see H3 on the second vitest run).
- `pnpm build` rc 0, 1 s. End 08:05:44Z.
- `runs/` afterwards holds exactly the 5 fixture dirs §7 lists. Expected = actual.
- Result: PASS (four green commands). Wall ~60 s.

## Step 1b: §2 sanity (08:06:00Z→08:06:12Z, load 3.86, wall ~12 s)
- `scripts/vm-state.sh` → `GUEST RUNNING: argv:yes port:listening utm:started`, exit 0. Expected exit 0 running: matches.
- `~/VMs/myco-win11/scripts/vm.sh status` → `started`. Expected `started`: matches.
- Ownership: `lsof /tmp/myco-win11.vm.lock || echo free` → `free` (no fcntl probe, per the hard rule and §6's own "Use lsof" line; see H1). No sweep/suite/c1/run-live/reset/deploy process in `ps`. Free + running guest = the normal state per §2; proceeded. Did not read or clear the lock record (housekeeping only).
- `wait-ssh.sh 120` → `ssh up after 4s`. `vssh 'whoami'` → `myco-win11\myco`. Expected: matches.
- Optional `smoke.ps1` deep check: NOT run (runbook marks it optional; skipped to keep the guest untouched before the reset). Recorded here so the skip is visible.
- Result: PASS.

## Step 2: §3 reset, §4 deploy, §5 desktop proof
### §3.1 cold reset
- Gate: `lsof /tmp/myco-win11.vm.lock || echo free` → free.
- `scripts/reset-trial-vm.sh` 08:06:24Z→08:09:19Z, load 3.95 at start (7.99 at end), wall 174 s, exit 0.
- Output: `reset-trial-vm: ready on 'clean-base'` (the only line). Expected: same line, 180–280 s planning range. Matches (a little under the range).
### §4 deploy
- Gate → free. `agent/bootstrap/deploy-to-vm.sh` 08:09:26Z→08:11:59Z, load 7.53, wall 153 s, exit 0 (range 100–420 s).
- Output had `==> verified 13 files on the guest against the source (sha256)` (clean first attempt, no `copy succeeded on attempt` line), `==> ping verified:` + `{"ok": true, "id": 1, "result": {"agent_version": "0.1.0", "session_id": "[REDACTED]", ...`, `DEPLOY OK`. Expected tail: matches, except that DEPLOY OK is not the last line (H4).
### Token fetch (§4/§5)
- 08:12:2xZ: the runbook's token fetch `(umask 077; vssh '... Get-Content C:\ProgramData\Myco\agent.token' > ~/.myco-token)` was refused by this harness's permission classifier ("Unauthorized Access"). My call ran it together with a names-only check of whether MYCO_AGENT_TOKEN was set, plus `wc -c`/`stat` of the file. Per the hard rule I did NOT rephrase or retry it. See H5.
### §5 desktop proof
- Gate → free. `pnpm exec tsx src/integration/session-info.ts` 08:12:28Z, load 5.51, wall <1 s, exit 3.
- Output: `agent op failed (AUTH_FAILED): missing or invalid token`. ~/.myco-token is either missing or another operator's stale file; the deploy above rotated the guest token. Expected: the session_info JSON with exit 0. Actual: exit 3 = "could not ask the agent" (auth failure), which is what §5's exit-code list predicts for a stale token.
- Result: §3 PASS, §4 PASS, §5 FAIL (blocked by the environment's permission layer, not a repo defect). The CLI's own behaviour on the stale token matches the doc.

## Step 3: §6 generator proof, 4-row subset
### §6.1 guest clean
- Script written to `/private/tmp/row8-step1/.row8/guest-clean.ps1` instead of the runbook's `/tmp/guest-clean.ps1` (H6), content verbatim. Gate → free.
- 08:12:52Z, load 5.34: `scp -q -F ~/VMs/myco-win11/ssh_config .row8/guest-clean.ps1 myco-win11:'C:/myco/guest-clean.ps1'` rc 0; `vssh 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\myco\guest-clean.ps1'` printed nothing, rc 0. Expected: nothing on a fresh clean-base guest. Matches. Wall 12 s.
### §6 run
- Gate → free. `pnpm exec tsx src/integration/run-live.ts --mode values --limit 4 --runs-dir runs/s6-subset` 08:13:09Z→08:13:10Z, load 5.19, wall ~1 s, exit 1.
- stdout empty. stderr: uncaught `AgentOpError: agent op failed (AUTH_FAILED): missing or invalid token` at `run-live.ts:68` (the initial ping). No `runs/s6-subset` dir was created.
- Cause: no fresh token (token fetch refused, see H5). Not a generator result, and the 4 rows never started.
- Pass condition as written (§6 "Expected"): "a JSON array of 20 rows, every one `"status": "verified"`, exit code 0", and the recorded result is 20/20. A 4-row subset CANNOT meet that condition as written: the most it can show is 4/4 verified with exit 0, which is evidence toward the condition but not the condition itself. The decision table and the bounded retry are also phrased in 20/20 terms (H7). Note also that `run-live` defaults to `--limit 40` (`run-live.ts:135`), so `--limit` is what makes the run 20 rows.
- Result: NOT RUN (blocked, exit 1 AUTH_FAILED before row 1).

## Step 4: §8 evidence on the COMMITTED packs (copies only)
Copies: `cp -R docs/research/experiments/{m1-row8-sweep2,m1-row8-corrupt} /private/tmp/row8-step1/.row8/packs/`, plus a replay copy of the corrupt pack at `.row8/replay/corrupt-20261125T052233Z` (see H10). `git status --porcelain docs/` was empty afterwards, so the committed packs are untouched. Window 08:13:40Z→08:15:30Z, load 5.86 at start, wall ~2 min.

### §8.1 layout
- sweep2: params.json, fingerprints.json, trials.jsonl (30 rows), progress.log, runs/<index>/<runId>/ for 29 indices (14 missing = deploy-failed). Matches the §8.1 sweep layout, and the "one fewer run dir than rows" note.
- corrupt: params.json, ledger.jsonl, summary.json, summary.txt, trial-<i>.out/.err ×18, progress.log, runs/0..17. Matches the §8.1 suite layout.

### §8.2 validate
- `pnpm exec tsx src/integration/validate-live.ts "$OUT/runs" --expect "$(grep -c '"runId": "' "$OUT/trials.jsonl")"`
  - sweep2: expect 29 (30 rows) → `validated 29 result.json + 516 trace events in …/runs: ALL OK`, exit 0. Matches the runbook's recorded 29 + 516.
  - corrupt: expect 18 (18 rows) → `validated 18 result.json + 321 trace events in …/runs: ALL OK`, exit 0.
  - Negative control (`--expect n+1`): both print `EXPECTED <n+1> run dirs, found <n>` and `1 FAILURES`. So --expect is live.
- Per-index cross-check loop (verbatim, run under bash): sweep2 0 FAILED, 29 ALL OK lines, `result.json validated: 29`, ledger count 29; corrupt 0 FAILED, 18 ALL OK, `result.json validated: 18`, ledger count 18. The counts match.

### §8.3 ledger / summary reproduction
- corrupt suite: `python3 scripts/m1-corrupt-suite-record.py --final "$OUT/params.json" "$OUT/trials.jsonl"` on the replay copy (basename `corrupt-20261125T052233Z`), exit 0, <1 s.
  - Rebuilt ledger.jsonl is BYTE-IDENTICAL to the committed one (39 rows). summary.json is byte-identical. The printed summary is identical to the committed summary.txt (`diff` empty).
  - `node --import tsx scripts/m1-corrupt-suite-ledger.ts <ledger>` → `{"rows":39,"pass":18,"refusal":18,"failure":0,"gap":0,"uncertain":3,"unaccounted":0}`, exit 0.
  - Control: the same `--final` on a copy keeping the committed basename `m1-row8-corrupt` gives a DIFFERENT ledger (`"evalId": "m1-row8-corrupt"`). See H10.
  - Numbers: total 18, withVerdict 18, verified 6 (all 6 recovery trials: kill+recovery 3/3, invalid-target+recovery 3/3), refuted 9 (invalid-target, dropped-save, focus-change no-recovery, 3 each), uncertain 3 (kill no-recovery), falseSuccesses 0, unprovenVerified 0, unprovenRecovery 0, ineligible [], ledger 39 rows / 0 unaccounted, passed true, problems [].
- sweep2: §8.3 says no derived ledger exists for non-v3 sweeps ("do not invent one"), and that the sweep's evidence is trials.jsonl, the progress.log seed check, m1-scorecard.py and §8.2. Did exactly that:
  - `grep SEED_CHECK progress.log` → `SEED_CHECK {"distinctSeeds": 6, "distinctHashes": 6, "problems": []}`.
  - `python3 scripts/m1-scorecard.py <copy>/trials.jsonl` exit 0 → `Reliability: 28/30 verified, MEETS NUMERIC THRESHOLD. Wilson 95% … 0.79–0.98`; deploy-failed 1 (idx 14), uncertain 1 (idx 3, fixture convert 240000 ms), verified 28. Output identical to the committed `final-scorecard.md` (`diff` empty; H11).
- Reliability tally (independent python count of trials.jsonl): sweep2 30 rows, indices 0–29 contiguous, {verified 28, uncertain 1, deploy-failed 1}, falseSuccess 0 → 28/30 against the ≥27/30 bar, denominator 30. corrupt 18 rows, 0–17 contiguous, {verified 6, refuted 9, uncertain 3}, falseSuccess 0.
- Result: PASS. Every committed number reproduced exactly.

## Step 5: scorecard check
- `python3 scripts/m1-scorecard.py --help` → `m1-scorecard: [Errno 2] No such file or directory: '--help'`, exit 1. The script accepts only `<trials.jsonl> [--json]` (`scripts/m1-scorecard.py:134`). No check mode.
- `ls scripts | grep -i scorecard` → build-scorecard-runs.py, c1-scorecard-adapter.py, check-scorecard-links.py, m1-scorecard.py, scorecard-viewer-links.py. There is no `scripts/scorecard-check*`. check-scorecard-links.py is a trace-link checker, not a scorecard check mode, and was not run.
- Result: NONE on main (nothing built).

## H-findings
**H1 (§2 contradicts itself on how to check ownership).** §2 l.148-151: "Take a non-blocking `flock` to learn whether the host is in use:" followed by a `fcntl.flock` probe. Later §2 (l.169-176) and §6 (l.463) say: "Use `lsof`, not a `fcntl.flock` probe". I had to decide which one is the procedure. Used `lsof … || echo free` only (it is also my hard rule) and never ran the probe.

**H2 (§1.1 precondition that cannot be checked).** §1.1: "Host SSH config + key | `~/VMs/myco-win11/{ssh_config,<key>}`". No check is given, and the host secret guard BLOCKS even a `test -e` on the SSH private-key path ("reading private key file"). Not rephrased. I inferred the key's presence from `vssh whoami` working. The guard also blocked my first attempt to append this report, because the heredoc merely contained the key's filename. The runbook should say "§2's `vssh whoami` is the key check; do not test the key file".

**H3 (§1.2 describes `pnpm test` wrongly).** "`pnpm test` runs vitest and then `schema-validate`". package.json runs two vitest invocations (the main suite, then `--pool=forks … s0-live-launcher.test.ts`) and then schema-validate, so a second "Test Files 1 passed / Tests 7 passed" block appears. I decided it was expected.

**H4 (§4's expected tail is not the tail).** "Expected tail: … `DEPLOY OK`". In the real output DEPLOY OK is line 21 of 24, followed by the `token`/`tunnel`/`ops` lines. §4's bullets mention the `ops` line, but the "tail" block implies DEPLOY OK is last. I judged it a pass because the ping JSON and DEPLOY OK were both present.

**H5 (BLOCKING: the token fetch is refused in this agent environment).** §4/§5: `(umask 077; ~/VMs/myco-win11/scripts/vssh '… Get-Content C:\ProgramData\Myco\agent.token' > ~/.myco-token)`. The Claude Code auto-mode permission classifier refused it ("Unauthorized Access"). My call bundled a names-only `[ -n "$MYCO_AGENT_TOKEN" ]` check plus `wc -c`/`stat`. The runbook says this file method is the guard-compatible path (TIF-206), and it offers no other way to supply a token to `session-info.ts`/`run-live.ts`. Settling it needs someone outside the repo (a permission grant, or a ruling that the bare command may be retried). Per the hard rule I did not retry or rephrase it. Consequence: §5 exit 3 AUTH_FAILED, §6 exit 1 AUTH_FAILED. The shared `~/.myco-token` evidently already held a stale token ("invalid", not "missing").

**H6 (§6.1 uses shared /tmp paths on a multi-operator host).** "`cat > /tmp/guest-clean.ps1 <<'EOF'`" (also `/tmp/guest-cleanup.ps1`, `/tmp/row8-guest-residue`). These fixed names collide between concurrent operators, and §4 already warns that `~/.myco-token` is shared. Decided: write the identical script to `/private/tmp/row8-step1/.row8/guest-clean.ps1`. The guest-side `C:\myco\guest-clean.ps1` is shared too, which I could not avoid.

**H7 (§6 pass condition vs a subset).** "Expected: a JSON array of 20 rows, every one `"status": "verified"`, exit code 0". The bounded-retry decision table is also written in 20/20 terms. A `--limit 4` run cannot meet that condition as written: at most it shows 4/4 verified with exit 0. The runbook has no rule for a partial run. Recorded the subset as unable to meet the condition. (It never reached row 1 anyway, H5.)

**H8 (§6's status contradicts the header).** The header says "§6 has since PASSED 20/20 (`S6-PASS.md`)". §6 says "**UNVERIFIED.**" (l.442) and "**`20/20` on a quiet host is therefore still outstanding**" (l.608-614). The header anticipates this ("the section is the one to fix", F3), but it is still unfixed. I took the header (newer) as the truth. It did not change any action.

**H9 (the auth-failure path is undocumented in §6/§9).** §6 lists exits 0 / non-zero-if-unverified / 2 (no sets). A stale token gives an uncaught `AgentOpError … (AUTH_FAILED): missing or invalid token` stack and exit 1 with zero rows, which by exit code is indistinguishable from "a row not verified". §9's token row quotes `MYCO_AGENT_TOKEN is required (or ~/.myco-token from vssh)`, which a stale file does not print. I classified it from stderr.

**H10 (§8.3 "SAME basename" for a renamed committed pack).** "To re-check a finished run, copy the OUT to a scratch directory with the SAME basename and run it there." The committed pack is `m1-row8-corrupt`, but its ledger's evalId is `corrupt-20261125T052233Z`, so "same basename" means the ORIGINAL OUT's name, which the runbook does not give. I inferred it from the first ledger row's `evalId`. With the committed basename the rebuilt ledger differs (evalId `m1-row8-corrupt`), which reads as a failed reproduction. With the inferred name it is byte-identical.

**H11 (§8 gives no comparison target for the committed sweep pack).** §8.3 lists the sweep's evidence (trials.jsonl, seed check, m1-scorecard.py, §8.2), but does not say what output to compare a reproduction against. I chose to diff the scorecard output against the pack's own `final-scorecard.md` (identical) and the validate counts against §8.2's quoted "29 results + 516 trace events" (identical). "Reliability tally" is not a runbook term; I took it as the 28/30 count over a 30-trial denominator.

**H12 (the committed sweep2 pack README contradicts §8.2 and the code).** `m1-row8-sweep2/README.md`: "`validate-live` must be run **per index directory** … Run on `runs/` itself it … validates 0 files and still prints `ALL OK`". Post-TIF-223, validate-live on `$OUT/runs` validated 29 + 516 with `--expect`, as §8.2 says. I followed the runbook and treated the README as stale.

**H13 (§6.2's lead-in does not match its code block).** "Before §6 you still want to know *why* nobody holds it — a free flock plus a running guest is the good state, and a §2 flock that reads `HELD` means wait:" is followed by the `run-live … --mode values` command, not a lock check. I treated the block as THE §6 command, with §6's lsof gate before it.

## Final table
| step | result | wall | findings |
|---|---|---|---|
| 0 PR #433 gate | MERGED 08:02:31Z (seen 08:04:03Z) | ~4 min | — |
| clone | HEAD 5a00c578 | <10 s | — |
| §1 preconditions + setup | PASS (4 green; 1087+7 tests; 5 trials schema ok) | ~60 s | H2, H3 |
| §2 sanity | PASS (running, started, free, ssh 4 s, whoami ok) | 12 s | H1 |
| §3.1 cold reset | PASS (`ready on 'clean-base'`) | 174 s | — |
| §4 deploy | PASS (13 files sha256-verified, ping, DEPLOY OK) | 153 s | H4 |
| token fetch | BLOCKED (permission classifier) | — | H5 |
| §5 desktop proof | FAIL exit 3 AUTH_FAILED (stale token) | <1 s | H5, H9 |
| §6.1 guest clean | PASS (empty) | 12 s | H6 |
| §6 subset (--limit 4) | NOT RUN: exit 1 AUTH_FAILED before row 1; a subset cannot meet the 20/20 condition anyway | ~1 s | H5, H7, H8, H9, H13 |
| §8.2 validate (sweep2 / corrupt) | PASS 29+516 / 18+321; --expect matched; loop matched | ~15 s | H12 |
| §8.3 corrupt --final replay | PASS byte-identical ledger, summary.json, summary.txt | <1 s | H10 |
| §8.3 sweep2 scorecard + seed check | PASS 28/30, Wilson 0.79–0.98, SEED_CHECK 6/6 | <1 s | H11 |
| scorecard check | NONE on main | — | — |

Guest left as the procedure leaves it: running, clean-base + freshly deployed agent, VM lock free. Nothing committed or pushed.
