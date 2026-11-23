# M1 evaluation runbook

From a `clean-base` snapshot to a validated evidence set: reset → deploy → prove the agent is
on the desktop → generator proof → trials → evidence. Written to be followed by a coding agent
with no prior context. Every command is transcribed from the repo or the host VM scripts; the
two steps that need a human are marked GUI-ONLY.

Scope: M1-016 (TIF-20), acceptance row 8 of `docs/architecture/m1.md`. Environment facts:
`docs/env/windows.md`. Incident history quoted inline: `docs/coordination/m1-state.md` log N.

**Read this first.** Nothing below was executed while writing it: `myco-win11` was held by the
coordinator and UTM was being restarted in the GUI (log 37). So every expected output is a
*shape*, not a transcript, except where a measured value is quoted with its log or date.
Commands needing the VM are therefore **UNVERIFIED** until you run them — verify each output
before moving on.

| Marker | Meaning |
|---|---|
| (measured) | A real recording, cited to its log/date |
| **UNVERIFIED** | Correct shape, not executed at writing time; confirm the output yourself |
| **GUI-ONLY** | Cannot be done over SSH or by a script (2 steps, both in §1/§3) |

## 1. Preconditions

### 1.1 What must already exist

| Item | Where | Notes |
|---|---|---|
| UTM 5.0.9+ with VM `myco-win11` | macOS host, GUI session | UUID `6C6414A1-9449-4E30-9503-F3F6726C8FFE`, 6 vCPU / **6 GB** (8 GB until 2026-11-21; see `~/VMs/myco-win11/README.md` Changelog) / VirtIO disk, en-US Win11 Pro ARM64 26100 |
| Snapshot `clean-base` | inside the VM bundle | disk-only, VM powered off. The cold reset target |
| Snapshot `clean-base-live` | inside the VM bundle | RAM+disk, desktop logged in. Restores in ~8 s but wedges UTM under rapid cycling (§3.3) |
| Host SSH config + key | `~/VMs/myco-win11/{ssh_config,id_ed25519}` | alias `myco-win11` → 127.0.0.1:2222, user `myco`, key-only |
| VM lifecycle scripts | `~/VMs/myco-win11/scripts/` | `vm.sh`, `reset.sh`, `wait-ssh.sh`, `vssh`, `shutdown.sh`. **Not in the repo** |
| Guest toolchain | baked into the snapshots | LibreOffice 26.8.3 native ARM64, Python 3.12.10 at `C:\Program Files\Python312-arm64\python.exe`, pywin32 312 / comtypes 1.5.0 / pywinauto 0.6.9 / uiautomation 2.0.29, OpenSSH 9.5 |
| Interactive launcher | guest `C:\myco\bin\run-interactive.ps1` | the only way to start a GUI process from SSH (session-0 problem, §5) |
| Repo | this checkout | Node ≥ 24 (`package.json` `engines`), pnpm 10 (CI pins `pnpm@10`) |

Do not read, copy, or print `~/VMs/myco-win11/credentials.txt` or `seed.iso`.

### 1.2 Setup

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: four green commands. `pnpm test` runs vitest and then `schemas/validate-artifacts.ts`
(→ `validated artifacts for N trials (all ok)`). This proves the host half without touching the
VM; do it before any VM work so a later failure is unambiguous.

### 1.3 What a fresh operator cannot improvise

| Value | Owner | Why it cannot be derived |
|---|---|---|
| The VM and its snapshots | environment owner | The image is built by `build-all.sh` (in the repo at `docs/env/vm-toolchain/`) from a Windows ISO, an offline installer payload and a uupdump-built ISO — none of those inputs are in the repo, and the script has never been run end to end from the repo (§10) |
| `~/VMs/myco-win11/ssh_config`, `id_ed25519` | environment owner | Hosts the port, user, key path; `AgentClient`/`SshTunnel` default to these paths (`src/win/agent-client.ts:202-208`) |
| `~/VMs/myco-win11/scripts/*` | environment owner | The reset/sanity primitives live outside the repo on purpose (PR #28's in-repo reset was reverted, PR #31) |
| The agent token | produced by the deploy | Rotated on every deploy (§4); read it from the guest, never from a file committed or cached |
| LibreOffice MSI SHA-256 | `8ee2ef81ca4103d3eeb06ca9f4ef0b5cbb83357d21d14a449f767bfb29183158` | SHA-256 of the retained `LibreOffice_26.8.3_Win_aarch64.msi` in the environment owner’s offline payload |

Overridable host values (defaults in parentheses): `MYCO_VM_SCRIPTS`
(`~/VMs/myco-win11/scripts`), `VM_SSH_CONFIG` (`~/VMs/myco-win11/ssh_config`), `VM_SSH_HOST`
(`myco-win11`), `MYCO_AGENT_PORT` (8765), `MYCO_TOKEN_PATH`
(`C:\ProgramData\Myco\agent.token`).

**The readiness gate is repo-only, by design.** `scripts/wait-guest-ready.sh` is resolved
from the checkout by `reset-trial-vm.sh` (`REPO_GATE`, line 42) and **no host script calls
it** — so a fresh `~/VMs/myco-win11/scripts` copy neither has it nor needs it, and
`sync-toolchain.sh` does not deploy it (that script mirrors `docs/env/vm-toolchain/`, and
the gate is not in there). This is why #318 could be closed: moving the gate into the synced
toolchain was unnecessary once it resolves from the repo. If you are debugging a gate
failure, check the **checkout's** copy — the host directory is not involved.

**Precedence, exactly:** `gate_script()` checks in this order — (1) `MYCO_VM_SCRIPTS` if
set, (2) the in-repo `REPO_GATE` if it is executable, (3) `$VM_SCRIPTS` as a fallback. So
the host path is reachable only when `MYCO_VM_SCRIPTS` is set **and** the in-repo copy is
missing or not executable. Setting `MYCO_VM_SCRIPTS` is how a test stubs the gate; leaving
it unset is how a normal run uses the repo's copy.

**The readiness gate is repo-only, by design.** `scripts/wait-guest-ready.sh` is resolved
from the checkout by `reset-trial-vm.sh` (`REPO_GATE`, line 42) and **no host script calls
it** — so a fresh `~/VMs/myco-win11/scripts` copy neither has it nor needs it, and
`sync-toolchain.sh` does not deploy it (that script mirrors `docs/env/vm-toolchain/`, and
the gate is not in there). This is why #318 could be closed: moving the gate into the synced
toolchain was unnecessary once it resolves from the repo. If you are debugging a gate
failure, check the **checkout's** copy — the host directory is not involved.

**Precedence, exactly:** `gate_script()` checks in this order — (1) `MYCO_VM_SCRIPTS` if
set, (2) the in-repo `REPO_GATE` if it is executable, (3) `$VM_SCRIPTS` as a fallback. So
the host path is reachable only when `MYCO_VM_SCRIPTS` is set **and** the in-repo copy is
missing or not executable. Setting `MYCO_VM_SCRIPTS` is how a test stubs the gate; leaving
it unset is how a normal run uses the repo's copy.

### 1.4 The two GUI-only steps

1. **The shell that drives the VM must be in the Mac's GUI (Aqua) session.** `scripts/vm.sh`
   wraps UTM's AppleScript API; from SSH it fails with a TCC/Automation denial (`utmctl`: OSStatus
   -1743, "does not work from SSH sessions or before logging in"). UTM must also be *running and
   visible* before the first `start` — a hidden launch can hang the start (UTM#8006).
   A fresh operator on another Mac must therefore sit at its screen, and either use a GUI
   Terminal or have the outer loop pre-grant Automation for UTM (provisioning step P0).
2. **A wedged UTM is repaired by quitting and reopening UTM in the GUI session** (§3.3). No
   script can do it; the coordinator cannot either.

## 2. Sanity: the VM is reachable and healthy

**UNVERIFIED** (no VM at writing time).

### 2.0 Is a guest running at all? (do this first)

```bash
scripts/vm-state.sh          # exit 0 running, 1 idle, 2 cannot tell
```

**Do not use `pgrep -f qemu-system-aarch64`.** UTM runs the guest as
`QEMULauncher`, and the qemu binary name appears only in that process's
*arguments*, not its `argv[0]` — so the narrow pattern returns 0 while a guest is
live. That trap was recorded in the state file three times (2026-11-21, logs 39,
43, and 600/656/932) and was still used in a VM grant on 2026-11-23, which is why
there is now a script instead of another note.

`vm-state.sh` reports `UNKNOWN` and **exits 2 rather than claiming idle** when it
cannot read the host, because a failed check must never read as an idle one.
Treat exit 2 as running.

The signals it checks, in order: `argv[0]` basename (`qemu-system-aarch64`,
`QEMULauncher`, `qemu-aarch64-softmmu`), then listeners on `:2222` (UTM's
forward) and `:10022` (boot.sh's), then UTM's own AppleScript status.

```bash
~/VMs/myco-win11/scripts/vm.sh status
```

Expected: `started`. Other values: `stopped` → start it; `resuming` → wedge, §3.3. **If it is
`stopped`, run the reset (§3) rather than a bare start**, so the trial starts from a known
snapshot.

**Ownership is the flock, never the lock file.** `/tmp/myco-win11.vm.lock` keeps
the last writer's `<pid> <driver>` after release, so its contents name a dead pid
routinely — two different stale contents were read on the morning of 2026-11-23
while the flock was free both times. Take a non-blocking `flock` to learn whether
the host is in use:

```bash
python3 -c 'import fcntl,sys
f=open("/tmp/myco-win11.vm.lock","a+")
try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print("FREE")
except BlockingIOError: print("HELD — someone owns the host")
finally: fcntl.flock(f,fcntl.LOCK_UN)' 2>/dev/null || true
```

A **`HELD` flock is the only evidence of ownership.** Free + a named pid means the
file is stale; free + `vm-state.sh` exit 0 means a guest is running with nobody
holding the lock, which is the case to stop and report rather than proceed.

```bash
~/VMs/myco-win11/scripts/wait-ssh.sh 120
~/VMs/myco-win11/scripts/vssh 'whoami'
```

Expected: `ssh up after Ns` (17 s fresh boot, longer after a cold restore under load), then
`myco-win11\myco`. A timeout here with UTM showing `started` is usually host RAM pressure
(§9, contention row) — check for other QEMU guests before touching the VM.

Optional deep check of the guest toolchain (197 UIA elements, 6/6 recorded):

```bash
~/VMs/myco-win11/scripts/vssh 'C:\myco\bin\smoke.ps1'
```

Expected: `expected=MYCO-SMOKE-<n> persisted=MYCO-SMOKE-<n> pass=True`.

## 3. Reset

Order matters: **reset first, deploy second**. `clean-base` and `clean-base-live` both predate
the agent install, so a reset deletes the agent (log 10).

### 3.1 COLD path — primary

**UNVERIFIED** — `scripts/reset-trial-vm.sh` is the deliverable of PR #32
(`feat/m1-013-cold-reset`), still open and pending its 5-consecutive-cold-reset check (log 37).
It is **not on `main`** (`main` has no `scripts/` directory). Get it from the PR branch, or use
§3.2.

```bash
scripts/reset-trial-vm.sh            # optional arg: snapshot name; default clean-base
```

What it does (read from the script): force-stop → wait for `stopped` (30 s cap) → **refuse** if
the state is `resuming` → restore → start → `wait-ssh.sh 600` → resync the guest clock. It
accepts only `clean-base`, `clean-base-live`, `m1-agent-live` as snapshot names and never
restores onto a running VM.

Expected: `reset-trial-vm: ready on 'clean-base'`. Cold boot costs ~21 s once UTM is warm, and
~134-152 s measured across 5 consecutive resets immediately after a UTM restart (m1-state log 39);
the script header's ~165 s figure is a single earlier sample. That is the price of a reset that
cannot wedge, versus the live path's ~7 s when healthy.

### 3.2 Fallback — `reset.sh cold`

**UNVERIFIED**, but this one is already exercised: `reset.sh cold` restore `clean-base` → cold
boot, ~20 s (VM README, measured 2026-11-18).

```bash
~/VMs/myco-win11/scripts/reset.sh cold
```

Expected: `reset (cold) ready in Ns`. It force-stops, waits at most 20 s for `stopped`, restores,
starts, waits for SSH, and resyncs the guest clock. Note the difference from §3.1: it **does not
diagnose** the wedge — after its 20 s poll it proceeds to restore regardless. If it prints an
AppleScript error containing `-2700`, go to §3.3.

For reference, the paths that are *not* the default any more: `reset.sh live` (8.3–8.6 s across 3
consecutive resets, measured 2026-11-19; 42–58 s under load) and `reset.sh disposable`.

### 3.3 The known wedge: UTM stuck in `resuming` (-2700)

Observed after 2–3 rapid reset/deploy cycles on the **live** (RAM+disk) path. Symptoms, in the
order they appeared (log 35, reproduced by a verifier):

1. `scp: Connection closed` during a deploy, then SSH banner-exchange timeouts.
2. `vm.sh restore` → `UTM error -2700 "Operation not available"`.
3. `vm.sh status` → `resuming`, unchanged for 5+ minutes. The SSH port forwards but the guest
   never boots.
4. `vm.sh kill` → -2700 "The virtual machine is not running" while `status` still says
   `resuming`: UTM's state machine is internally inconsistent.

Snapshots survive this; nothing is lost (log 35).

Resolution: **GUI-ONLY** — quit UTM and reopen it from the Mac's GUI session, then re-run the
reset. `scripts/reset-trial-vm.sh` (§3.1) detects the state and exits with this diagnosis
instead of hanging; `reset.sh` (§3.2) does not, which is why the cold path is the sweep default.
The `resuming` wedge remains an **open hypothesis** about rapid live-resume cycling, not a
conclusion (log 37).

## 4. Deploy the agent

```bash
agent/bootstrap/deploy-to-vm.sh
```

Foreground, 100–180 s (measured 126.9 s and ~176 s). It copies the agent tree to
`C:\Program Files\Myco\agent`, writes a **fresh token** to `C:\ProgramData\Myco\agent.token`,
installs pywin32/comtypes/uiautomation into LibreOffice's own Python, registers the `MycoAgent`
task, launches it through `run-interactive.ps1` (interactive session), and pings it through
`ssh -L 8765:127.0.0.1:8765`.

Expected tail:

```
==> ping verified:
{"ok": true, "id": 1, "result": {"agent_version": "0.1.0", "session_id": 1, ...}}
DEPLOY OK
```

**The token rotates on every deploy.** `run-live.ts` reads `MYCO_AGENT_TOKEN`, falling back to
`~/.myco-token` (`src/integration/run-live.ts:32-41`). Re-fetch it after every deploy:

```bash
export MYCO_AGENT_TOKEN="$(~/VMs/myco-win11/scripts/vssh 'Get-Content C:\ProgramData\Myco\agent.token')"
```

If it fails:

| Symptom | Cause | Fix |
|---|---|---|
| `deploy-to-vm: missing ssh config …` / `nc not found` / `openssl not found` | host prerequisite | fix the host (§1) |
| `ModuleNotFoundError` on `session_info`, or `uia`/`pywin32` import errors from the agent | deps missing from **LibreOffice's** Python | `guest-deploy.ps1` installs them; re-run the deploy and read its pip output |
| agent answers on the wrong interpreter, or `uno` fails to import | agent started under system Python instead of `C:\Program Files\LibreOffice\program\python.exe` | you are on old bootstrap code; the interpreter is fixed on `main` (log 18) |
| `scp: Connection closed` | guest or UTM unhealthy | §2, then §3.3 |
| ping never answers, no error | agent started in session 0 | §5 — this is the failure that matters |

## 5. Prove the agent is on the desktop

The agent's `ping` reports its session; `session_info` reports the window station and desktop
(both ops, `agent/README.md`). **UNVERIFIED** as a command — the shape is the one
`deploy-to-vm.sh` uses for `ping`, with the op swapped:

```bash
ssh -F ~/VMs/myco-win11/ssh_config -N -L 8765:127.0.0.1:8765 myco-win11 &
printf '{"id":1,"token":"%s","op":"session_info","params":{}}\n' "$MYCO_AGENT_TOKEN" | nc -w 5 127.0.0.1 8765
```

Expected:

```json
{"ok": true, "id": 1, "result": {"session_id": 1, "window_station": "WinSta0", "desktop": "Default", "user": "MYCO-WIN11\\myco"}}
```

`run-live.ts` prints the same fact in one line before every trial:
`agent ping ok: 0.1.0 session 1` on stderr.

**Why this is a gate, not a nicety.** Windows puts services in session 0, which has no visible
window station; `sshd` is a service, so everything it spawns inherits session 0 and cannot see or
drive a GUI (`docs/env/windows.md` §Control plane design). An agent in session 0 answers `ping`,
opens files, and runs UNO — so verification *appears* to work — while UIA sees an empty tree and
every keystroke goes nowhere. Trials then fail opaquely, or worse, produce verdicts from a
half-blind pipeline.

This exact bug happened: `schtasks /Run MycoAgent` from an SSH context left the agent in
session 0 (`session_id: 0`, `window_station: Service-0x0-…`) despite `InteractiveToken` in the
task XML; UIA showed only the title bar. It was found by probing
`Get-Process python*` (all SessionId 0) against `run-interactive.ps1` (session 1), and fixed by
launching through `run-interactive.ps1` (PR #13/#14, log 16/18). Consequence: **every trial
artifact produced before that fix is untrusted for the UIA path** — PR #11's verdicts stand only
for the UNO/file half (log 18/21). If your `session_info` shows `session_id: 0`, stop; do not run
trials.

## 6. Generator proof

Prerequisite for reliability numbers: if a generated value does not survive Calc's input path,
a `refuted` verdict may be a generator defect rather than an execution defect.

**UNVERIFIED.** Reset (§3) and deploy (§4) first, then run once on a quiet host. Do **not**
interleave with other work on the guest. `--mode values` runs its parameter sets back to back
without resets, so running it on a contaminated guest (leftover `soffice`, leftover run dirs)
measures the contamination, not the generator (log 27).

```bash
pnpm exec tsx src/integration/run-live.ts --mode values --limit 20
```

Expected: a JSON array of 20 rows, every one `"status": "verified"`, exit code 0 (non-zero if any
row is not verified; exit 2 if the generator yields no sets — a broken generator must not look
like a pass). Row shape, from the committed run
(`docs/research/experiments/m1-013-generator-proof.json`):

```json
{ "column": "qty", "typed": "9733", "status": "verified",
  "reason": "cell C24 (record EMP-0023, column qty) persisted as \"9733\"", "elapsedMs": 33438 }
```

Recorded result: **20/20 verified** (5 values × `name`, `qty`, `joined`, `salary`), 2026-11-20.

**A refutation means: stop.** A non-verified row names the mismatch in `reason`. Before blaming
the generator, rule out contamination (reset, then re-run) and contention. If it reproduces on a
clean guest, the generator's AutoCorrect-immune predicate or Calc's input path is wrong, and every
subsequent trial number is suspect. Fix that first.

## 7. The trials

All live trials run through one entrypoint: `src/integration/run-live.ts`, modes `normal`,
`kill`, `values`. It starts its own SSH tunnel (8765) and needs `MYCO_AGENT_TOKEN` (§4). Each run
writes `runs/<runId>/{trace.jsonl,result.json}` (§8) and prints the trial report as JSON.

### 7.1 Normal trial

```bash
pnpm exec tsx src/integration/run-live.ts --mode normal --seed m1-013-trial-01
```

Expected: `"verdict": {"status": "verified", "reasons": ["cell … persisted as \"…\""]}`,
`"completed": true`, **exit 0** (non-verified exits 1). Recorded wall times: 34.3 s, 40.2 s,
55.1 s. Report fields: `runId, verdict, completed, elapsedMs, xlsxPath, guardFailure?, cleanup`.

For a non-`verified` normal trial, read `verdict.reasons[0]` and find the failing stage.
`fixture convert did not produce … within 60000ms` is a setup timeout before Calc opens the
document. Record it as `uncertain`. The timeout message alone cannot distinguish a slow
conversion from a failed process or an unreachable guest.

### 7.2 Corrupted trial (kill Calc mid-program)

```bash
pnpm exec tsx src/integration/run-live.ts --mode kill --kill-after-step 3
```

The kill is **step-triggered**, not a wall-clock timer: launching Calc and making it observable
takes ~30 s, so a timer fires during launch and the trial records `steps: []` (that mistake is
log 22). `--kill-after-step 3` kills `soffice.bin` after the third dispatched action.

Expected: `"status": "uncertain"` — e.g. "could not look: UNO readback … NoConnectException
(WSAECONNREFUSED)", or a guard failure at the `setValue` step with `observe-after-action` —
in 15–28 s, no hang. Artifacts still validate.

**The rule.** Ground truth is computed host-side (ADR-0005/0008). A kill before the save cannot
satisfy the intent, so:

- `refuted` / `uncertain` → correct, this is a true negative.
- `verified` → **FALSE SUCCESS = stop the line.** Do not continue the sweep, do not re-run for a
  better number. The CLI already treats it as failure: kill mode exits **1** when the verdict is
  `verified`. Preserve the run directory and report it.

One documented exception, and only this one: with `--recovery`, the ADR-0006 ladder may relaunch
Calc and complete the trial, and the verdict then comes from the persisted-file check —
`retry:1-failed, retry:2-failed, relaunch:resumed, relaunch:completed`, verdict `verified`
(M1-011, log 26). That `verified` is legitimate **only** if `trace.jsonl` contains those
`recovery` events (`{"type":"recovery","event":…,"stateVersion":…}`). Note the CLI's exit code is
still 1 in that case — read `result.json`, not the exit code, for kill mode.

### 7.3 The 30-trial sweep

The sweep driver is `scripts/m1-sweep.sh` (PR #53). For every index 0–29 it runs: host gates →
cold reset (§3.1) → deploy (§4) → token fetch → one `run-live --mode normal` trial → one JSONL
record. Per-trial reset is mandatory, because a failed trial can leak `soffice` and run dirs
that contaminate the next verdict (log 27). The driver does it for you.

```bash
OUT="/tmp/m1-013/sweep-$(date -u +%Y%m%dT%H%M%SZ)"   # keep this path for a same-protocol resume
mkdir -p "$OUT"                        # the shell opens $OUT.runner.out before the driver runs
nohup caffeinate -dimsu scripts/m1-sweep.sh "$OUT" > "$OUT.runner.out" 2>&1 < /dev/null &
tail -F "$OUT/progress.log"            # what it is doing (-F: the file appears a few seconds in)
cat "$OUT/trials.jsonl"                # one record per finished index
```

- **Parameters.** On first run it writes `$OUT/params.json` (the 30 sets from
  `scripts/m1-sweep-params.ts params`: 6 fixture seeds × 5; varies seed, fixture size 33–128
  rows, row, column across all four data columns, and value) and `$OUT/fingerprints.json` (the
  SHA-256 of each seed's fixture CSV).
- **Seed check.** Each trial passes its set's `fixtureSeed` as `--seed`. Each trial report
  carries `fixture.csvSha256` over the bytes actually uploaded. If the seed or hash does not
  match, the record is `seed-mismatch` and the driver exits 7. At the end, all 6 seeds must
  appear, one to one with their hashes; otherwise `SEED_CHECK_FAILED` and exit 8. History: the
  pilot driver dropped the seed, and every trial ran on one sheet (log 47).
- **Gates and exit codes.** Checked before every trial; the driver exits rather than running
  through them: 4 = 1-min load > 14, 6 = swap free < 300 MB. Power is NOT a gate (Tiffany:
  never pause or gate VM work on charger state); `acPower` is recorded per row. Re-running the
  same command resumes: indices already in `trials.jsonl` are skipped, never re-run, whatever
  their status.
- **Fresh `OUT` per sweep.** Resume-skip means a stale `trials.jsonl` in a reused directory
  silently counts old records. Resume after a host gate only with the same commit, guest
  configuration, parameters and fingerprints. Preserve the old output and start at index 0
  in a fresh directory after a harness or protocol change.
- **Pin the code.** Run the driver from a dedicated worktree at a fixed commit
  (`git worktree add --detach /tmp/m1-013/ws <sha>`), so a checkout in your working tree cannot
  change the code mid-sweep.
- **A `seed-mismatch` disqualifies the whole output directory.** Never resume over it: the
  driver refuses to start on a `trials.jsonl` that contains one, and both `m1-sweep-record.py
  --final` and `scripts/m1-scorecard.py` reject it. Start a fresh `OUT`. Resume is only for
  the gate pauses (exit 3, 4, 6) and for an operator stop at a trial boundary, and only on the
  same pinned commit.
- **Statuses in `trials.jsonl`:** `verified` / `refuted` / `uncertain` are verdicts. `seed-mismatch`
  aborts the sweep. `harness-error`, `reset-failed`, `deploy-failed`, `token-failed` and
  `param-error` mean no verdict was produced. Count them as not verified, and report them
  separately.

The driver applies the host and seed gates. The operator also watches conversion failures
in `trials.jsonl`. The normal trial watchdog is 1,500 seconds. If the fixture timeout recurs,
stop at a trial boundary, retain the run
directory, and report the failure before resuming. The sweep v2 stop was recorded by the
operator in `progress.log`.

Sweep v2 completed five trial cycles in about 35 minutes on the 6 GB guest (20:12:30Z → 20:47:24Z in `/tmp/m1-013/sweep-v2/progress.log`), including cold
resets, deploys, trials and settles. Use the measured cycle time to plan a host window and
update the estimate from the next run. Report every recorded outcome.

### 7.4 The corrupted suite

Run from the repo root. The suite schedules 18 trials on distinct fixture seeds with a cold reset
and deploy before each trial. It runs three trials per corruption class with recovery off, and
also covers three kill and three invalid-target trials with ADR-0006 recovery enabled. The
normal sweep and this suite share `/tmp/myco-win11.vm.lock`. The guard also checks for older
sweep processes that started before the lock was introduced.

```bash
scripts/m1-corrupt-suite.sh /tmp/m1-014/corrupted
python3 scripts/m1-corrupt-suite-record.py --final \
  /tmp/m1-014/corrupted/params.json /tmp/m1-014/corrupted/trials.jsonl
```

Reissue the driver command to skip recorded indices. Recorded failures stay in the audit. The
driver runs `--final` automatically and saves its output to `summary.txt`. The second command
rebuilds the summary and ledger from existing artifacts. Keep the output directory and its
`runs/` tree together for replay. Each live trial has a 1,500-second watchdog.

Use a supplemental batch when a group needs more eligible trials. Give each batch a distinct
output directory basename using letters, digits, hyphens or underscores. The basename names
its fixture seeds. Resume with the same directory and group selection.

```bash
scripts/m1-corrupt-suite.sh /tmp/myco-evals/supplement-01 --groups dropped-save:3,kill+recovery:1
python3 scripts/m1-corrupt-suite-record.py --final-combined --out /tmp/myco-evals/combined \
  /tmp/m1-014/corrupted /tmp/myco-evals/supplement-01
```

The four corruption modes are valid group names. Use `kill+recovery` or
`invalid-target+recovery` for the two recovery groups. The supplemental driver audits its
recorded batch and leaves the six-group coverage decision to `--final-combined`.

The host-only combined audit reads each directory's `params.json`, `trials.jsonl` and saved
traces. It refuses duplicate fixture seeds across the manifests and checks at least three
eligible verdicts per group and at least ten in total. False successes, unproven verified
claims, fixture mismatches and unaccounted ledger rows fail the audit. The output directory
receives `summary.json` and `ledger.jsonl`. Ineligible records stay visible in both artifacts.
The supplemental run and new Calc timing instrumentation are **UNVERIFIED** on a real guest.

| Mode | Injection |
|---|---|
| `kill` | Request termination of `soffice.bin` after Set and before Ctrl+S. An unconfirmed kill stops the trial before save or recovery. After a confirmed kill, recovery can relaunch Calc and resume the edit. |
| `invalid-target` | After Locate, take a new observation between issuing and using the adapter's versioned UI target for the edit. The stale target is rejected before typing. Recovery retries with a newly resolved target. |
| `dropped-save` | Withhold Ctrl+S. The edited Calc document stays dirty and the disk keeps the old value. |
| `focus-change` | After the Name Box jump, transfer foreground focus to a disposable Windows window before typing, check ownership, and destroy the window. The temporary STATIC window has no explicit message pump during the short SendKeys call. Message handling and cleanup on Windows remain unverified. |

`trials.jsonl` records the `recovery` flag, verdict, host-computed expected value, disk readback
when available, `falseSuccess` and the reason. `refuted` means the verifier found evidence
against success. `uncertain` means it could not verify the outcome. A verified verdict with
a readable disk value that differs from host ground truth is a false success. A verified
verdict with an unreadable disk value fails the audit as `unprovenVerified`.
A verified recovery trial with a matching disk value, a landed fault and missing trace proof
of completed recovery is recorded separately as `unprovenRecovery` and is ineligible. A
fault that never landed is also ineligible. Both audit commands recompute the classification
from recorded evidence and print a `RECLASSIFIED` line when the stored false-success flag changes.

| Driver exit | Meaning |
|---|---|
| 0 | Full suite passed all coverage and evidence gates, or the supplemental batch recorded its manifest and passed its evidence checks. |
| 1 | Driver or manifest error. |
| 4 / 6 | Paused for one-minute load above 14, or swap free below 300 MB. Resume in the same directory when the gate clears. **Exit 3 (on battery) is no longer emitted** — power is recorded, never enforced. |
| 7 / 9 | Seed or CSV SHA-256 mismatch detected in this trial / already present at startup. Use a fresh output directory. |
| 8 | Final audit failed. Inspect `summary.json`, `summary.txt` and `ledger.jsonl`. |
| 10 | VM in use. `REFUSED_VM_LOCKED` names the lock holder or the legacy driver process. |

To inspect an individual live trial, use `pnpm exec tsx src/integration/run-live.ts --mode MODE`
with `MYCO_AGENT_TOKEN` set and `--seed SEED` to choose the fixture. Use `--audit-corruption` with
`kill` for suite-style evidence and `--recovery` to exercise the ladder. An audited mode exits 0
for a verdict of refuted, uncertain or proven recovery, 1 for an unsupported verified claim or a
harness error, and 2 if the requested fault did not land.

The final report includes the published OpenAdapt counts for context. Report live results only
after this suite has run on the reserved guest.

## 8. Evidence

### 8.1 Layout

```
runs/
  <runId>/                 every live trial (normal, corruption modes, values)
    trace.jsonl            one JSON event per line: run-start, observation, action,
                           guard-evaluation, guard-failure, fault-injection, recovery (ADR-0007)
    result.json            RunRecord: taskParams, steps with pre/postcondition results,
                           stateVersion, verdict with per-check partial scores
  values/<runId>/          --mode values nests its trials here
  <evalId>/ledger.jsonl    conformance ledger — written ONLY by runEvaluation()
                           (src/core/eval.ts) in the fake harness; the live corrupted suite writes its own
                           ledger.jsonl in its OUT dir (§7.4); derive the normal sweep ledger (§8.3)
```

A sweep (§7.3) writes under its own `OUT` dir instead:

```
$OUT/
  params.json, fingerprints.json   the 30 sets and the expected per-seed fixture hashes
  trials.jsonl                     one record per index (verdict, reason, fixture hash)
  progress.log                     gates, resets, deploys, ABORT/PAUSED/STOPPED lines
  runs/<index>/<runId>/            the trial's trace.jsonl + result.json
```

Directory names are bare UUIDs produced by the code; the reviewed sample evidence under
`docs/research/experiments/m1-013-session1/` was renamed by hand (`normal-<short>/`), so do not
infer the writer's layout from those directory names. Screenshots are **not** part of the
committed trial path: the reviewed `mid-typing.png` came from a throwaway script that was
deleted. Use the agent's `screenshot` op if you need one.

### 8.2 Validate

```bash
pnpm exec tsx src/integration/validate-live.ts runs
```

For a sweep, validate each trial index directory that has artifacts, for example
`pnpm exec tsx src/integration/validate-live.ts "$OUT/runs/0"`. The validator reads one directory
level below its argument. Check the result count against the recorded run IDs.

Expected: `validated N result.json + M trace events in runs: ALL OK` (recorded: 4 + 51 at PR #18;
11 + 77 at PR #11). Non-zero exit and `INVALID …` lines name the offending file and JSON path.

`pnpm schema-validate` is **not** this check: it validates a freshly generated fake-app sample,
which is what CI proves. Use `validate-live.ts` for your run directory.

### 8.3 Ledger

For normal sweep v3, join each `trials.jsonl` row to
`runs/<index>/<runId>/{result.json,trace.jsonl}`. Require indices 0–29,
matching run IDs and verdicts, a passing seed check, and validated result
and trace schemas. Emit one row per distinct `action.kind` in the run's
`action` trace events. Use `none` when no action ran.

| Ledger field | Sweep v3 source |
|---|---|
| `evalId`, `corruptionClass` | `sweep-v3`, `none` |
| `trialIndex`, `runId` | `trials.jsonl` index and run ID |
| `actionKind` | Distinct traced action kinds, or `none` |
| `state`, `oracle`, `refusalCode` | Verified trials map to `pass`, `UnoVerifier:verified`, and null. Index 3 maps to `refusal`, `UnoVerifier:refuted`, and `guard:adapter-available` |

Each action kind inherits the trial-level persisted-state verdict. V3
produces 88 schema-valid rows, with 87 passes (three action kinds each
for 29 verified trials) and one refusal (no action at index 3). All rows
are accounted for. The reliability denominator remains 30 trials.
Validate the derived artifact at `/tmp/m1-013/sweep-v3/ledger.jsonl`
with `node --import tsx scripts/m1-corrupt-suite-ledger.ts <ledger-path>`.

`runs/<evalId>/ledger.jsonl` — one row per (trial, corruption-class, action-kind) with an explicit
oracle and refusal code. The corrupted-suite recorder writes its live conformance ledger to
`OUT_DIR/ledger.jsonl` during `--final`. False successes carry the `ground-truth:false` or
`recovery:missing-proof` oracle. `OUT_DIR/summary.json` and the driver's `summary.txt` include
the per-trial recovery results, `falseSuccesses` total and `auditLedgerRows` accounting.

## 9. Troubleshooting

Every row is a failure we actually hit.

| Symptom | What it is | Fix |
|---|---|---|
| `session_info` → `session_id: 0`, `window_station: Service-0x0-…`; `uia_tree` returns ~6 title-bar nodes; trials fail at `adapter-available` | Agent in session 0: no window station, UIA blind. `schtasks /Run` from SSH does not move it | Redeploy (§4) so it starts via `run-interactive.ps1`; re-check §5. Delete trials run in this state (log 16/18) |
| `scp: Connection closed` during deploy | Guest unreachable mid-resume, or UTM wedged | §2; if `resuming`, §3.3 (log 35) |
| `UTM error -2700 "Operation not available"`; `status` stuck `resuming`; `kill` says "not running" while status says `resuming` | The live-resume wedge | **GUI-ONLY**: quit + reopen UTM, re-run the cold reset. §3.1 detects it (log 35/37) |
| Trial `uncertain`, reason `fixture convert did not produce … within <N>ms` | The guest-side headless convert did not write the workbook before the deadline. A cold convert right after a reset was measured at 30.8 s and once at 169.4 s (`docs/research/experiments/m1-013-convert-timeout.md`), so this can happen on a healthy host. Heavy host contention (another QEMU guest, Ollama, swap exhaustion) makes it worse (log 30) | **Count it**: it is an `uncertain` verdict and stays in the denominator. Never drop it from reliability numbers. If it recurs, stop at a trial boundary and investigate; separately, check the host gates and that no other guest is running |
| Text value `refuted`; persisted value is sentence-cased (`revised-908578` → `Revised-908578`) | Calc AutoCorrect rewrote a lowercase-leading value | Correct behaviour of the verifier. Use the generator's values (`REVISED-######`, numerics) or `--new-value` with an AutoCorrect-immune string. A case-insensitive check here would be a false success (log 21; `src/tasks/intent.ts`) |
| Cell holds **another record's** value; several `soffice` alive; hundreds of `C:\myco\runs\myco-*` dirs | Cross-trial contamination: a failed trial leaked state and a later trial read a foreign document | Reset + redeploy, then re-run the same intent — it should flip to `verified`. Reset per trial, always. M1-019's host-side always-cleanup + `guest-contaminated` guard now aborts `uncertain` instead of guessing; its real-Windows behaviour is still unvalidated (log 27, 29, 36) |
| Agent behaves like an older build right after a reset | Stale pre-deployed snapshot: `m1-agent-live` contains whatever agent existed when it was taken. `ping` cannot reveal this — `agent_version` is the constant `0.1.0` | Prefer cold reset + deploy (§3.1/§4). Trust a pre-deployed snapshot only if you know its commit; re-take it after any agent change (PR #28, reverted; PR #31) |
| `agent ping ok …` never printed; `MYCO_AGENT_TOKEN is required (or ~/.myco-token from vssh)` | Missing/stale token | Re-fetch from the guest after every deploy (§4) |
| Port 8765 already in use / two tunnels | A manual tunnel from an earlier step; `run-live` cannot bind its own and silently reuses the stale one | Close any manual tunnel first (`lsof -nP -iTCP:8765 -sTCP:LISTEN`); let `run-live` own the tunnel |

## 10. What is NOT reproducible from scratch

Be explicit with whoever asks for an "independent reproduction":

1. **`build-all.sh` has never been run end to end** (`docs/env/windows.md`, guest finding 4). It
   is an ordered sketch: Windows ISO (built by `build-win-iso.sh` from a uupdump UUID), the
   offline installer payload, `create-vm.sh`, `provision.ps1`, virtualising, disk conversion,
   snapshots. Expect it to need repair before it produces a bootable VM.
2. **The toolchain is in the repo** at `docs/env/vm-toolchain/` (landed in #206): `build-all.sh`,
   `build-win-iso.sh`, `build-seed-iso.sh`, `create-vm.sh`, `convert-disk-virtio.sh`, `vm.sh`,
   `reset.sh`, `wait-ssh.sh`, `vssh`, `shutdown.sh`, `set-cd.sh`, `guest/` and `seed/`. See that
   directory's `README.md`. The host copies under `~/VMs/myco-win11/` are the ones that have
   actually run; the committed copies are the same scripts, and the gap is that they have not
   been executed from the repo (item 1).
3. **The input files are not in the repo**: the Windows 11 ARM64 ISO (`~/VMs/iso/`), the offline
   installer payload referenced by `payload/SOURCES.txt`, the UTM guest-tools ISO, and the seed
   ISO with the auto-logon password.
4. **The snapshots are not in the repo.** `clean-base` / `clean-base-live` are the only known-good
   states; nothing regenerates them but a successful `build-all.sh`.
5. **Verify the pinned installer** against the SHA-256 in §1 before building
   a fresh guest. The hash identifies the retained offline payload.
6. **The corrupted suite has live evidence** (M1-014). The screenshot baseline
   (M1-015, Cua Driver as the agent with a local or approved planner) is also pending. A reproduction today can reach: reset → deploy
   → desktop proof → 20/20 generator proof → the 30-trial sweep (`scripts/m1-sweep.sh`, §7.3) →
   the corrupted suite (`scripts/m1-corrupt-suite.sh`, §7.4) → validated per-trial evidence.

What an independent reproducer must obtain from the environment owner: the VM bundle with its
snapshots (or a repaired `build-all.sh` plus its input ISOs), `ssh_config` + `id_ed25519`, the
host script directory, and permission to run in the Mac's GUI session. Everything else is in this
repo.
