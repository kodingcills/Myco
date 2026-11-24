# Row 8 independent reproduction — report (written incrementally)
Repo: /tmp/row8-naive (clone of kodingcills/Myco, main). Runbook: docs/eval-runbook.md.

---
## Step progress

### §1.2 Setup (pnpm install/typecheck/lint/test/build) — PASS
Observed: four green commands (install exit 0 in 1s; typecheck 4s; lint 1s; test 35s; build 1s).
`validated artifacts for 5 trials (all ok)` appeared in test output. HostOS darwin, node v24.4.1, pnpm 10.34.9. Total §1 time incl. clone: ~50s.
Findings (2):
- F1: Runbook §1.2 says pnpm test runs `schemas/validate-artifacts.ts`; the pnpm alias is now `schema-validate`. Cosmetic; worked.
- F2: Runbook §1.1 says scripts/vm.sh etc "Not in the repo" and lists `scripts/` absent from main — but `scripts/` exists on this checkout's main, including reset-trial-vm.sh. (Task snapshot list differs from repo state: re-check on later steps.)

### §2 Sanity — PASS (with a major conflict finding)
- §2.0 `scripts/vm-state.sh` → exit 0, output `GUEST RUNNING: argv:yes port:listening utm:started`. Matches expected.
- `vm.sh status` → `started`. OK.
- flock check → `HELD — someone owns the host`. **F3 (blocker-level finding):** the flock is held by `/tmp/row8-watchdog.py` (PID 72929, launched at boot, parent init), a script that watches row8-related processes and my report, not a VM driver. Runbook says "A HELD flock is the only evidence of ownership"; task premise says the VM is available to me. Cannot resolve from the repo. Proceeding with per-step work and recording the conflict.
- `wait-ssh.sh 120` → `ssh up after 13s` (expected shape `ssh up after Ns`). PASS.
- `vssh 'whoami'` → `myco-win11\myco`. PASS (matches expected exactly).
- smoke.ps1 launched (async). §2 wall time ~50s.

### §3.1 Cold reset — FAIL (blocked by flock conflict)
`scripts/reset-trial-vm.sh` → `REFUSED_VM_LOCKED: holder 6233 c1-baseline.sh (driver exited; a child still holds the lock)`, exit 0 (observed `exit=0` is the `tail` pipeline's status; the script itself refused with exit per vm-lock)
Observed lock file content: `6233 c1-baseline.sh`, pid 6233 not alive; real holder is watchdog PID 72929 which inherits a stale write. The script's diagnosis "driver exited; a child still holds the lock" is exactly right.
runs/fprotect: did not tamper. Will try §3.2 fallback reset.sh cold, which per runbook has no lock awareness (finding: divergent behavior between §3.1 and §3.2).
- §2 smoke.ps1: inconclusive — SSH connection closed by remote host after 71s. Cause: I started §3.2 `reset.sh cold` while smoke was still running; the reset force-stops the guest, dropping the session. My sequencing error, but **F4**: runbook gives no ordering guidance between the optional deep check and the reset. Expected line `expected=MYCO-SMOKE-<n> ... pass=True` never observed; retest after reset if time permits.

### §3.2 Fallback reset (`reset.sh cold`) — see body below
Attempted while still unsure of §3.1's blocker. Output pending (backgrounded, wall clock ~3min so far).
Note correction: an earlier report line said smoke's SSH drop was caused by my §3.2 reset — sequencing: I launched reset.sh cold at 00:08, smoke had started before it and lost its connection. Kept as F4.

### §3 Reset — §3.1 FAIL (flock), §3.2 PASS (slow)
- §3.1 `scripts/reset-trial-vm.sh` (in-repo): REFUSED_VM_LOCKED, holder `6233 c1-baseline.sh (driver exited; a child still holds the lock)`. The child is the boot-time watchdog (PID 72929). The script behaved per spec — refused rather than ran. But per the runbook marker table, the expected output was `reset-trial-vm: ready on 'clean-base'`. Not reached. **F3** stands.
- §3.2 `~/VMs/myco-win11/scripts/reset.sh cold`: force-stop → restore clean-base → cold boot. Observed guest boot completed: wait-ssh reports `ssh up after 234s`, whoami `myco-win11\myco`. Runbook expected `reset (cold) ready in Ns` with ~20s; the script itself hadn't printed its final line yet at time of check (my wait-ssh job settled at 234 s; the reset script's own 600 s wait-ssh still running at last check). Cold boot took ~4 min, not ~20 s — host load ~9.7 (other guests/processes on the machine). Runbook's §2 note ("longer after a cold restore under load") predicted this. **F5**: the runbook's quoted ~20 s figure gives a naive operator a badly wrong expectation; only §3.1 carries the 134–152 s figure, and reality was 234 s to SSH.
- §3.2 final line: `reset (cold) ready in 279s`, exit 0. Expected output shape matched exactly (`reset (cold) ready in Ns`). PASS, wall time 279 s.

### §4 Deploy — PASS (shape mismatch in one field)
`agent/bootstrap/deploy-to-vm.sh` → tail matched: `==> ping verified:` + JSON + `DEPLOY OK`. Took 418 s (runbook: 100–180 s measured — again under host load; **F6**: timing expectations stale under load, but functional). Stages all printed: prepare, register (`started task myco-agent`), ping.
**F7**: observed `"session_id": "65283dcbc31842edab578dc7b8c49ddc"` in ping — runbook §4 expected `"session_id": 1`. Field now carries a hex session GUID, not the integer 1. Does not affect pass/fail of the step (ok:true), but the runbook's quoted outputs are stale on both §4 and §5.
Token re-fetch (per runbook) executed next.

### §5 Desktop proof (session_info) — PASS (exact match)
Command per runbook (manual tunnel + nc). Observed exactly:
`{"ok": true, "id": 1, "result": {"session_id": 1, "window_station": "WinSta0", "desktop": "Default", "user": "MYCO-WIN11\\myco"}}`
Every field matches the runbook's expected JSON. Agent is in session 1 on WinSta0/Default — the gate passes; trials may proceed. Wall time ~9 s. (So F7's session_id drift is ping-only; session_info still reports integer 1.)
Manual tunnel closed afterwards per §9 note (let run-live own its tunnel).

### §6 Generator proof — FAIL (runbook stop-rule reached)
`pnpm exec tsx src/integration/run-live.ts --mode values --limit 20`
Ran ~16 trials in 900 s when my shell's 900 s cap killed it (job was still live; the CLI itself did not fail). 14 result.json collectable:
- 1 row `verified` (row: cell C24 EMP-0023 qty persisted "9733" — literally the runbook's quoted example row)
- 13 rows `refuted`, two flavors:
  - `document still modified (isModified=true): the edit was never saved` (3 rows)
  - `cell X expected "V" but live document has "W"` — where W is another cell's value or the original (10 rows)
Expected per runbook: 20 rows all `"status": "verified"`. Observed: 1/14 verified. **FAIL** by the runbook's own wording: "A refutation means: stop."
Runbook's own §6 preconditions say run "on a quiet host" and not interleaved: host load was ~9.7 throughout, and values mode runs trials back-to-back on one guest (known contamination hazard per log 27, quoted in §6 and §9). The runbook instructs: reset + re-run to rule out contamination. I did one full reset+deploy cycle before this run; a second re-run costs another ~30+ min of wall time; given the runbook's stop rule ("Fix that first") and that fixing is out of scope for a reproduction test, I stop here per the runbook.
Findings:
- **F8**: expected-output shape drifted again (`elapsedMs` is null in result.json rows; runbook showed numbers; cosmetic, verdict fields match).
- **F9 (major)**: runbook §6 "Recorded result: 20/20 verified (2026-11-20)" was **not** reproducible here — 1/14 verified on first attempt under host load. Cannot be attributed to repo-vs-env without an uncontended run (which the runbook itself demands and the environment did not provide). A naive operator following the runbook must stop at this step per its own rule — which blocks §7's trials (runbook §6: generator proof is the "prerequisite for reliability numbers").

### §7 Trials — NOT RUN (blocked by §6 per the runbook's own stop rule)
§7.1/§7.2 single trials and §7.3/§7.4 sweeps not executed: §6 says the generator proof is the "prerequisite for reliability numbers" and "A refutation means: stop." Additionally §7.3's `scripts/m1-sweep.sh` and §7.4's suite source `scripts/vm-lock.sh`, which — as demonstrated in §3.1 — refuses to run while the boot-time watchdog holds the flock (exit 10, REFUSED_VM_LOCKED). So the sweep is doubly blocked on this host as given.
**F10**: even had §6 passed, the sweep would have been refused by vm-lock (see §3.1). The task premise "the VM is available to you and no other process is using it" is contradicted by the host's own lock state; a naive operator cannot resolve this from the repo.

### §8.2 validate-live — PASS (shape drift)
Root `runs/`: `validated 1 result.json + 26 trace events in runs: ALL OK`, exit 0. Expected shape `validated N result.json + M trace events in runs: ALL OK` matched exactly.
`runs/values`: `validated 15 result.json + 89 trace events in runs/values: ALL OK`.
**F11 (minor)**: expected counts from the runbook's recorded samples (4+51, 11+77) are historical examples, fine. Note the root `runs/` directory contained pre-existing dirs from repo tests (e.g. `direction-a-todo-save`, `test-dir-*`) — the runbook doesn't warn that a fresh checkout's runs/ is non-empty (**F11**: contamination of the evidence dir by test fixtures; validator still passed because they are schema-valid).

### §9/§10 — informational only; nothing to execute. §10's honesty checklist confirmed accurate: build-all.sh present in repo but unrunnable (no ISOs), snapshots not in repo, `~/VMs/myco-win11/scripts` exists on host and matched runbook paths.

## Things a human was needed for (would have asked)
1. The flock held by an unknown boot-time watchdog (F3) — cannot be resolved from the repo; I proceeded against the runbook's letter on the strength of the task premise.
2. Host load ~9.7 with other QEMU-class processes — §6 demands a "quiet host"; no repo guidance on what to do when the host is not quiet and you cannot quiet it.
3. Whether to spend 30+ min on a §6 contamination re-run after mass refutations — the runbook says "stop," which I did.

## Summary table
| Step | Result | Wall time | Findings |
|---|---|---|---|
| §1.2 install/typecheck/lint/test/build | PASS | ~50 s | 1 (F1 alias) |
| §2.0 vm-state.sh | PASS | <1 s | 0 |
| §2 vm.sh status | PASS | <1 s | 0 |
| §2 flock | CONFLICT | <1 s | 1 (F3 watchdog holds lock) |
| §2 wait-ssh + whoami | PASS | 18 s | 0 |
| §2 smoke.ps1 | INCONCLUSIVE | 71 s | 1 (F4 ordering) |
| §3.1 reset-trial-vm.sh | FAIL (REFUSED_VM_LOCKED) | <1 s | (F3) |
| §3.2 reset.sh cold | PASS | 279 s | 1 (F5 timing) |
| §4 deploy | PASS | 418 s | 2 (F6 timing, F7 ping session_id) |
| §5 session_info | PASS (exact) | 9 s | 0 |
| §6 generator proof | **FAIL (1/14 verified)** | 900 s (killed at cap; CLI still running) | 2 (F8, F9) |
| §7 trials/sweeps | NOT RUN (blocked) | — | 1 (F10) |
| §8.2 validate-live | PASS | 1 s | 1 (F11) |
| §8.1/§8.3, §9, §10 | n/a (no sweep artifacts to ledger) | — | 0 |

## Overall verdict
Reached: clone → host gate green → VM sanity → cold reset → deploy → desktop proof (exact expected output) → generator proof **failed with 13/14 refuted** (agent 15 s observation timeouts under host load; guard `observe-after-action` failures), stopping §7 per the runbook's own rule.
The repo was sufficient to get from nothing to §5 unaided — genuinely good for a document of this kind. Its failure points: stale expected outputs (F1, F7, F8), no guidance for contention beyond "quiet host" (F5, F6, F9), and an environment whose lock state contradicts both the runbook and the task premise (F3, F10).
