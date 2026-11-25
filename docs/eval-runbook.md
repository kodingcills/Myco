# M1 evaluation runbook

From a `clean-base` snapshot to a validated evidence set: reset → deploy → prove the agent is
on the desktop → generator proof → trials → evidence. Written to be followed by a coding agent
with no prior context. Every command is transcribed from the repo or the host VM scripts; the
two steps that need a human are marked GUI-ONLY.

Scope: M1-016 (TIF-20), acceptance row 8 of `docs/architecture/m1.md`. Environment facts:
`docs/env/windows.md`. Incident history quoted inline: `docs/coordination/m1-state.md` log N.

**Read this first.** This file was originally written without executing anything — `myco-win11`
was held by the coordinator (log 37) — so the expected outputs are *shapes*, not transcripts,
except where a measured value is quoted with its log or date.

**It has since been executed end to end, and the markers are no longer uniform.** As of
2026-11-24: §1, §2, §3.2, §4 and §5 have each been run and their outputs matched
(`docs/research/experiments/m1-row8/`), and **§6 has since PASSED 20/20** (`S6-PASS.md`). Fresh
row-8 operators have since re-run §3.1 (2026-11-24 and 2026-11-25) and §4 on post-TIF-220 code
(2026-11-25: `verified 13 files on the guest against the source (sha256)`, `DEPLOY OK`), §5
against the real guest (2026-11-25, exit 0, the expected stdout below), and the §7.3 sweep
(28/30 verified, `docs/research/experiments/m1-row8-sweep2/`). §7.4 was run by a fresh
operator on 2026-11-25: 18/18 recorded and eligible, 0 false successes, every recovery trial
verified (`docs/research/experiments/m1-row8-corrupt/`), and §8 was reproduced on both runs. Take a step-level `UNVERIFIED` marker as
"not re-checked recently", not as "never run" — and where a section's own marker contradicts this
paragraph, the section is the one to fix (F3, 2026-11-24).

Commands needing the VM still deserve a check of their output before you move on.

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

Expected: four green commands. `pnpm test` runs vitest and then `schema-validate` (the pnpm alias; the file is `schemas/validate-artifacts.ts`)
(→ `validated artifacts for N trials (all ok)`). This proves the host half without touching the
VM; do it before any VM work so a later failure is unambiguous. `schema-validate` prints its
per-trial `ok …` lines with no newline between them, so expect one long line before the summary.

**Run `pnpm test` on a quiet host** (1-min load under 10, the same level as the §7.3 resume gate).
Under load it fails on timeouts alone: on 2026-11-25, with the 1-min load at 12.9–15.4 while a
sweep ran, 43 of 1080 tests failed, every one a 5 s timeout (vitest's default `testTimeout`, and
`spawnSync(..., {timeout: 5000})` at `test/vm-lock.test.ts:27`), with no logic failure. If every
failure is a timeout, wait for the load to drop and re-run before blaming the repo. A running VM
guest alone can hold the load at 12–15 (row-8 operator report, S8).

### 1.3 What a fresh operator cannot improvise

| Value | Owner | Why it cannot be derived |
|---|---|---|
| The VM and its snapshots | environment owner | The image is built by `build-all.sh` (in the repo at `docs/env/vm-toolchain/`) from a Windows ISO, an offline installer payload and a uupdump-built ISO — none of those inputs are in the repo, and the script has never been run end to end from the repo (§10) |
| `~/VMs/myco-win11/ssh_config`, `id_ed25519` | environment owner | Hosts the port, user, key path; `AgentClient`/`SshTunnel` default to these paths (`src/win/agent-client.ts:202-208`) |
| `~/VMs/myco-win11/scripts/*` | environment owner | The reset/sanity primitives live outside the repo on purpose (PR #28's in-repo reset was reverted, PR #31) |
| The agent token | produced by the deploy | Rotated on every deploy (§4); the verified deploy writes it to `~/.myco-token` (or `$MYCO_TOKEN_OUT`) on the host. Never commit it or reuse a copy from before your deploy |
| LibreOffice MSI SHA-256 | `8ee2ef81ca4103d3eeb06ca9f4ef0b5cbb83357d21d14a449f767bfb29183158` | SHA-256 of the retained `LibreOffice_26.8.3_Win_aarch64.msi` in the environment owner’s offline payload |

Overridable host values (defaults in parentheses): `MYCO_VM_SCRIPTS`
(`~/VMs/myco-win11/scripts`), `VM_SSH_CONFIG` (`~/VMs/myco-win11/ssh_config`), `VM_SSH_HOST`
(`myco-win11`), `MYCO_AGENT_PORT` (8765), `MYCO_TOKEN_PATH`
(`C:\ProgramData\Myco\agent.token`), `MYCO_TOKEN_OUT` (`~/.myco-token`, the host file the deploy
writes the token to; a path, never a secret).

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

(measured) Run by a fresh row-8 operator on 2026-11-24 with the expected outputs below (operator
report S2). Only the optional `smoke.ps1` check was not re-run.

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
file is stale.

**Free + a running guest is the NORMAL state, not a stop.** It is what every driver
leaves behind when it releases — r6 and the §6 attempts both finish with the guest
still up. Report it and proceed; do not stop and ask. (An earlier revision said
"stop and report", which a fresh operator read literally and would have stopped at
§2 on every run — finding F4, 2026-11-24.) The state that IS worth reporting is the
opposite one: a guest that is running while some *other* process claims to own it.

**Check ownership read-only if you only want to look.** The probe below takes the
flock for an instant, and `scripts/vm-lock.sh:34` acquires with `LOCK_NB` and no
retry — so a probe and a real driver starting in the same moment can make the driver
refuse with exit 10. Measured as F5 on 2026-11-24. When you only need to know
whether anyone owns the VM, use `lsof` instead:

```bash
lsof /tmp/myco-win11.vm.lock     # a table = someone owns it; empty = nobody does
```

**NEVER hold the flock as a "reservation".** This section has no way to express *"the VM is
reserved for you"*, so a coordinator who holds the lock to keep the VM free **makes the VM
unusable to the very operator being tested** — a held flock is indistinguishable from a
competing owner, and the primary reset (§3.1) will refuse. That happened on 2026-11-24 and cost
the row-8 operator its §3.1 step and two "should I break this lock?" questions it could not
answer. **If the VM must be kept free, do it by agreement, not by holding the lock.** The test
begins only when **both** are true: the flock is `FREE` **and** no process outside the operator's
own work holds a claim on the guest.

**The stale lock file is expected, and it is not a signal.** Its contents name the last writer
and routinely name a dead pid. Read the flock; ignore the text. (Same class as TIF-180.)

**To clear a stale record** — do it under the lock, so it cannot race a driver acquiring it:

```bash
python3 - <<'PY'
import fcntl
f = open("/tmp/myco-win11.vm.lock", "a+")
try:
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit("HELD - a driver owns the host; do not touch the record")
f.seek(0); f.truncate(0); f.flush()
print("cleared a stale lock record (the flock was free)")
PY
```

Clearing is housekeeping, not a prerequisite: `vm_lock_acquire` truncates and rewrites the
record only after the kernel grants the lock, so a stale pid never blocks a driver. It is worth
clearing because a dead pid in that file reads exactly like a live owner - the 2026-11-24
row-8 operator saw `44837 reset-trial-vm.sh` (dead) with the flock free and had no way to tell
the two apart from the file alone.

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

**Verified, and on `main`.** `scripts/reset-trial-vm.sh` is present and executable at the
checkout you are reading (PR #32 merged long ago; the 5-consecutive-cold-reset check was
recorded at log 37). The earlier "not on `main` / get it from the PR branch" note was stale by
2026-11-24 — `main` has a `scripts/` directory, and §1.3 and §2.0 above already use it.

```bash
scripts/reset-trial-vm.sh            # optional arg: snapshot name; default clean-base
```

What it does (read from the script): force-stop → wait for `stopped` (30 s cap) → **refuse** if
the state is `resuming` → restore → start → `wait-guest-ready.sh 600` (guest CPU must advance, then
SSH must answer 3 consecutive probes 5 s apart, TIF-220) → resync the guest clock. It
accepts only `clean-base`, `clean-base-live`, `m1-agent-live`, **`cua-c1-base`** (the C1
screenshot-baseline snapshot, and the one the C1 arms run on) as snapshot names and never
restores onto a running VM.

Expected: `reset-trial-vm: ready on 'clean-base'`. Cold boot costs ~21 s once UTM is warm, and
~134-152 s measured across 5 consecutive resets immediately after a UTM restart (m1-state log 39);
the script header's ~165 s figure is a single earlier sample. That is the price of a reset that
cannot wedge, versus the live path's ~7 s when healthy.

**Plan for 180–280 s, the same range as §3.2.** The two fresh row-8 runs fell outside the quiet
figures above without a UTM restart: **195 s** at load 5.65 (2026-11-24) and **250 s** at load
10–14 (2026-11-25), both ending in the expected line (operator report S3 and operator 4 step 2).
The ~21 s figure needs a warm UTM and a quiet host; do not plan on it.

### 3.2 Fallback — `reset.sh cold`

**UNVERIFIED**, but this one is already exercised: `reset.sh cold` restore `clean-base` → cold
boot; the ~20 s figure is the VM README's and is **wrong for the in-repo path** — a
cold reset measured **279 s end to end (234 s to SSH)** on 2026-11-24 under load ~9.7, and
**134–152 s** when quiet. **Use 180–280 s as the planning range**, and see the decision rule in
§6: a step that exceeds its range is *evidence about the host*, not about the repo.

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

Foreground, **100–420 s** (measured 126.9 s and ~176 s quiet; **418 s** on 2026-11-24 under
load ~9.7). The 100–180 s figure is the quiet case only. It copies the agent tree to
`C:\Program Files\Myco\agent`, writes a **fresh token** to `C:\ProgramData\Myco\agent.token`,
installs pywin32/comtypes/uiautomation into LibreOffice's own Python, registers the `MycoAgent`
task, launches it through `run-interactive.ps1` (interactive session), and pings it through
`ssh -L 8765:127.0.0.1:8765`. (The script's header comment, lines 6–7, still says it starts the
agent "via schtasks /run". That comment is stale; the launch is `run-interactive.ps1`, as the
script's own output says.)

Expected tail:

```
==> ping verified:
{"ok": true, "id": 1, "result": {"agent_version": "0.1.0", "session_id": "<random hex GUID, not 1>", ...}}
DEPLOY OK
```

**The token rotates on every deploy, and the deploy leaves the fresh one on the host.** Once the
ping check passes, `deploy-to-vm.sh` writes the token to `~/.myco-token` (or `$MYCO_TOKEN_OUT`) and
prints only the path: `==> wrote the fresh token to … (mode 600)`. There is nothing to fetch back
from the guest. The token never passes through argv, a shell variable or the output (the host's
secret guard refuses commands that carry it, TIF-206; §5). (row-8 H5: on 2026-11-25 the old guest
fetch was refused by an agent session's permission system, and §5 and §6 then failed
`AUTH_FAILED` on a stale file.)

- **Written only after a verified deploy.** The file is written mode 600, under `umask 077`, to a
  temp file in the same directory, then `mv`ed into place, so it is never world-readable and never
  half-written. A deploy that fails (copy, register or ping) leaves any existing file byte-identical.
  The guest token may already have rotated by then, so after a failed deploy that file can be stale:
  fix the deploy and re-run it, do not run trials on the old file.
- **Each deploy rotates the token**, including the deploy inside every §7.3/§7.4 trial. A copy from
  before your latest deploy fails `AUTH_FAILED`.
- **`~/.myco-token` is one path shared by every operator on this Mac (G25).** Another operator's
  deploy overwrites it, and their guest token replaces yours. When several operators share the Mac,
  give each a private path, and pass the same path to §5 and §6:

  ```bash
  export MYCO_TOKEN_OUT="$(mktemp -d)/agent-token"   # a fresh private directory (mode 700)
  agent/bootstrap/deploy-to-vm.sh
  ```

  Then pass `--token-file "$MYCO_TOKEN_OUT"` in §5, §6 and §7, from the same shell. The directory
  must exist; the deploy checks that before it copies anything. Even with a private file, a later
  deploy by anyone rotates the guest token, so do not run single trials while a sweep is deploying.
- **`run-live.ts` reads `--token-file PATH`, else `MYCO_AGENT_TOKEN`, else `~/.myco-token`**
  (`src/integration/run-live-token.ts`). With the default path, leave `MYCO_AGENT_TOKEN` unset
  (`unset MYCO_AGENT_TOKEN` if an earlier shell exported a stale one: a set variable wins over the
  default file). `--token-file` wins over the variable and never falls back. The §5 CLI reads only
  a file (`--token-file`, default `~/.myco-token`).
- **The `ops` line in the deploy output holds no token.** It prints a literal `<token>`
  placeholder, but the host secret guard redacts it, so on screen the tail can *look* as if it
  printed one.

**Fallback, only for a guest deployed by something else** (an older checkout's deploy, a
pre-deployed snapshot, or another tool): then no host file was written for you, and the token
exists only on the guest. Fetch it into a file, never through a shell variable, with `umask 077`
first. Do **not** do this after a `deploy-to-vm.sh` from this checkout: it is redundant, and an
agent's permission system may refuse it.

```bash
(umask 077; ~/VMs/myco-win11/scripts/vssh 'powershell -NoProfile -Command "Get-Content C:\ProgramData\Myco\agent.token"' > ~/.myco-token)
```

PowerShell ends the line with CRLF; both readers trim it (`src/integration/session-info-core.ts`
`readTokenFile`, used by `run-live` too).

**Known gap: the drivers do not follow the token-file rule (G28, not fixed here).**
`scripts/m1-sweep.sh:89,94` and `scripts/m1-corrupt-suite.sh:80,94` read the token into a shell
variable (`TOK=$(vssh … Get-Content …)`) and pass it to `run-live` as `MYCO_AGENT_TOKEN`, so it
sits in a long-lived process's environment for the whole trial. This is a known exception to the
rule above, tracked separately; it is not something an operator should copy. By hand, use the
file.

If it fails:

| Symptom | Cause | Fix |
|---|---|---|
| `deploy-to-vm: missing ssh config …` / `nc not found` / `openssl not found` | host prerequisite | fix the host (§1) |
| `ModuleNotFoundError` on `session_info`, or `uia`/`pywin32` import errors from the agent | deps missing from **LibreOffice's** Python | `guest-deploy.ps1` installs them; re-run the deploy and read its pip output |
| agent answers on the wrong interpreter, or `uno` fails to import | agent started under system Python instead of `C:\Program Files\LibreOffice\program\python.exe` | you are on old bootstrap code; the interpreter is fixed on `main` (log 18) |
| `deploy-to-vm: copy attempt 1/3 failed; redoing the whole copy` | sshd dropped a connection while settling after a cold boot (TIF-220; 1 in 28 cycles) | nothing, if a later attempt prints `copy succeeded … verified`. The copy is redone in full and hash-checked, never resumed. A clean first attempt prints only `==> verified N files on the guest against the source (sha256)`: the `copy succeeded on attempt N/3` line appears only after a retry |
| `scp: Connection closed` followed by `copy to guest failed on all 3 attempts` | guest or UTM unhealthy, not a settling blip | §2, then §3.3 |
| ping never answers, no error | agent started in session 0 | §5 — this is the failure that matters |

## 5. Prove the agent is on the desktop

The agent's `ping` reports its session; `session_info` reports the window station and desktop
(both ops, `agent/README.md`). The old inline recipe printed the token into the command line,
which the host's enforced secret guard refuses (TIF-206, F16), so no agent could run it; it is
replaced by a repo CLI that reads the token from a file. (measured) **Passed against the real
guest on 2026-11-25** (fresh row-8 operator, HEAD `bfbe277`): exit 0 in 7 s, stdout identical to
the expected JSON below. Its other exit codes are covered by unit tests
(`test/session-info.test.ts`).

No token fetch: the deploy wrote the fresh token to `~/.myco-token` (or `$MYCO_TOKEN_OUT`) after it
verified the agent (§4). Only for a guest deployed by something else, use the §4 fallback first.
Pass the same path the deploy wrote:

```bash
pnpm exec tsx src/integration/session-info.ts --token-file ~/.myco-token   # or your $MYCO_TOKEN_OUT
```

The CLI opens its own ssh tunnel (`SshTunnel`), takes and releases the VM lock, prints the
`session_info` result JSON to stdout, and always stops the tunnel — so the old manual-tunnel
teardown is no longer needed; nothing of §5 is left listening on 8765.

Exit codes (`src/integration/session-info-core.ts` header): `0` desktop proof passed;
`2` the agent is in session 0 and/or not on `WinSta0` — **stop, do not run trials**;
`3` could not ask the agent or could not evaluate its answer — bad invocation (usage); token file
missing, unreadable, or empty; tunnel did not come up or agent unreachable; auth failure or any
other `ok:false`; a malformed `session_info` result (including `ok:true` with no result); the
tunnel teardown failing;
`10` `REFUSED_VM_LOCKED: …` — the VM lock is held (holder named), or its state could not be
determined.

Expected stdout on the passing path:

```json
{"session_id":1,"window_station":"WinSta0","desktop":"Default","user":"MYCO-WIN11\\myco"}
```

**`run-live`'s per-trial line is NOT this proof, and cannot be.** It prints
`agent ping ok: 0.1.0 session <id>` on stderr (`src/integration/run-live.ts:68`), and that id is
`ping`'s `session_id`, which is a **random hex GUID generated per agent start**
(`agent/myco_agent/__init__.py:4`, `uuid.uuid4().hex`; returned by `agent/myco_agent/ops.py:8`).
It is **not the Windows session number**, so no value of that line can distinguish session 1 from
session 0. The desktop proof is the `session_info` call above, which reads the real number through
`ProcessIdToSessionId` (`agent/myco_agent/windows_backend.py:288-321`). An earlier revision
presented the ping line as "the same fact"; it is not (F9/F10, 2026-11-24).

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

**UNVERIFIED.** Reset (§3) and deploy (§4) first, then run once on a quiet host.

**When you may skip §3 and §4 (F20).** On a **row-8 reproduction run, never**: the point of the
run is that a fresh operator can do every step, so reset, deploy and §5 are part of what is being
tested. Outside row 8, for example re-measuring the generator on a guest that another driver
has just released, skipping is acceptable only when all three hold: §5 passes on the guest as it
stands, your token file holds the token from the last deploy (that deploy wrote it, or, for a
guest deployed by something else, you ran the §4 fallback after it), and §6.1 prints nothing after
cleanup.
Record the skip, and why, next to the §6 result. A skip that is not recorded reads as a full run.

**The M1 lock procedure: each step takes and releases the lock itself (F20; lead ruling 2026-11-24).**
Do not hold the VM flock by hand across steps, and the lock code is not changed for M1. A child
accepts an ancestor's lock only when the ancestor is one of the named drivers (`m1-sweep.sh`,
`m1-corrupt-suite.sh`, `c1-baseline.sh`, `c1-sweep.sh`, `c1-spike.sh`, per `vm_lock_owned_by_parent`
in `scripts/vm-lock.sh` and `PARENT_DRIVERS` in `src/integration/vm-lock.ts`). Under an
operator-held lock, §3.1 and §6 would refuse with exit 10. So run each step through its own
script, and **before every step** run the gate check, read-only:

```bash
lsof /tmp/myco-win11.vm.lock || echo free     # a table = someone owns the VM: wait
```

Use `lsof`, not a `fcntl.flock` probe: a probe holds `LOCK_EX` for an instant, and a driver
starting in that instant refuses with exit 10 (F5).

| step | how it holds the lock |
|---|---|
| §3.1 `scripts/reset-trial-vm.sh` | takes it, releases on exit |
| §4 `agent/bootstrap/deploy-to-vm.sh` | **does not take it.** Run it straight after the gate check prints `free`. Inside a §7.3 sweep it runs as a child of `m1-sweep.sh` and is covered by the sweep's lock |
| §5 the `session_info` check | takes it, releases on exit (TIF-209) |
| §6.1 check and cleanup (`vssh`/`scp`) | **do not take it.** Run them straight after the gate check |
| §6 and §7.1/§7.2 `run-live` | takes it, releases on exit |
| §7.3 `scripts/m1-sweep.sh`, §7.4 `scripts/m1-corrupt-suite.sh` | take it for the whole sweep; their children inherit it |

Between steps the VM is unlocked, so another driver can take it. If a step exits 10, wait for the
named holder and re-run the step. If the gate check shows an owner you did not expect, stop and
report it. Do not break the lock. An operator-session lock wrapper is a post-M1 change. Do **not**
interleave with other work on the guest. `--mode values` runs its parameter sets back to back
without resets, so running it on a contaminated guest (leftover `soffice`, leftover run dirs)
measures the contamination, not the generator (log 27).

### 6.1 Prove the guest is clean before you start

`--mode values` runs 20 sets back to back on one guest, so **a single leftover run dir fails
every row** — measured 2026-11-24: 20/20 `uncertain`, every reason
`could not look: guest contaminated — leftover run dirs: myco-54774-…; refusing to read a
foreign document`. That is the M1-019 guard doing its job; it will not score someone else's
document. Do not start §6 until this prints nothing:

```bash
cat > /tmp/guest-clean.ps1 <<'EOF'
Get-Process soffice* -ErrorAction SilentlyContinue | ForEach-Object { "soffice $($_.Id)" }
# Everything that is not ours, minus the two names the agent owns. NOT a 'myco-*' filter:
# a C1 run leaves C:\myco\runs\20, which 'myco-*' does not match, so that filter prints
# nothing (a false clean) and every row then fails 'leftover run dirs: 20' (F13).
Get-ChildItem C:\myco\runs -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notin @('myco-admin','profiles') } |
  ForEach-Object { "run-dir $($_.Name)" }
EOF
scp -q -F ~/VMs/myco-win11/ssh_config /tmp/guest-clean.ps1 myco-win11:'C:/myco/guest-clean.ps1'
~/VMs/myco-win11/scripts/vssh 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\myco\guest-clean.ps1'
```

On a guest just restored from `clean-base`, `C:\myco\runs` does not exist yet, and that is a
clean guest. The `-ErrorAction SilentlyContinue` keeps the check silent in that case. An older
copy of this check without it prints `Cannot find path 'C:\myco\runs' because it does not exist`
instead, which also means clean (operator report S5).

**If a previous §6 attempt was aborted** — killed, Ctrl-C'd, or interrupted by a guest reset —
it leaves one `run-dir myco-<hostpid>-<nonce>-<nonce>` and possibly one `soffice` behind. A run
that is not a trial — the C1 arms write `C:\myco\runs\<index>` — leaves a directory whose name
matches nothing in particular, including a bare number. Clean them before re-running, or the
re-run measures the residue.

**A stray C1 guest dir is not row-8 evidence. Copy it aside, then clean it (F17).** A
`C:\myco\runs\<index>` directory belongs to a C1 arm's trial, not to this run. It proves
nothing about row 8 and must not be cited as row-8 evidence. But it may be the only guest-side
copy of that C1 trial, so do not delete it unseen. For each `run-dir` line the check printed
whose name is not `myco-<hostpid>-<nonce>-<nonce>` (your own aborted §6 residue), copy the
directory to the host first:

```bash
mkdir -p /tmp/row8-guest-residue
scp -q -r -F ~/VMs/myco-win11/ssh_config myco-win11:'C:/myco/runs/<name>' /tmp/row8-guest-residue/
```

Record the copied path in your report so the C1 owner can find it. Then run the cleanup:

```bash
cat > /tmp/guest-cleanup.ps1 <<'EOF'
Get-Process soffice* -ErrorAction SilentlyContinue | Stop-Process -Force
# Same reason as the check above: remove everything except the agent's own names.
Get-ChildItem C:\myco\runs -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notin @('myco-admin','profiles') } |
  Remove-Item -Recurse -Force
Get-ChildItem C:\myco\profiles -Directory -ErrorAction SilentlyContinue | Where-Object Name -like 'myco-*' | Remove-Item -Recurse -Force
EOF
scp -q -F ~/VMs/myco-win11/ssh_config /tmp/guest-cleanup.ps1 myco-win11:'C:/myco/guest-cleanup.ps1'
~/VMs/myco-win11/scripts/vssh 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\myco\guest-cleanup.ps1'
```

Then re-run `guest-clean.ps1` and confirm it prints nothing.

**Do not delete** `C:\myco\runs\profiles` or `C:\myco\runs\myco_uia_act.py*` — those are the
profile root and the agent's own script plus its result files, not trial residue.

**What trips the trial's contamination guard (F18).** From `src/integration/guest-health.ts`
(`probeGuestHealth`, `guestContaminated`): **any** running `soffice`, and **any** directory
directly under `C:\myco\runs` other than `myco-admin`, `profiles` and the trial's own, **whatever
its name**: `myco-*`, a bare `20` or `29`, anything. Sub-directories *inside*
`C:\myco\runs\profiles` are reported as `leftover profiles` but do **not** trip the guard. The
§6.1 check above prints exactly the set that trips it, so a clean check means a clean guard.

### 6.2 Hold the VM, or nothing else may touch it

`run-live` **takes the VM flock itself** (TIF-191). If another driver owns the host it refuses
before touching the guest:

```
REFUSED_VM_LOCKED: holder 36343 c1-baseline.sh
exit 10
```

Exit **10** is that refusal, and it is not a generator failure — wait for the named holder to
finish, then re-run. Nothing has been created on the guest or in `runs/` when it happens.

This was not always so, and the reason is worth keeping. Measured 2026-11-24: a baseline driver
acquired the lock and cold-reset the guest to its own snapshot ~55 s into a §6 run. The first
row verified; the tunnel then died with the guest, and **the next 19 rows each returned
`uncertain` in 0–1 ms** — `could not look: agent unreachable — ssh tunnel is not running (call
start() first)`. The run exited 1 with one genuine verdict and 19 harness aborts, which reads
exactly like a generator defect and was not one.

A driver that spawns `run-live` as a child (§7.3, §7.4) keeps working: the child inherits the
lock its ancestor owns (`MYCO_VM_LOCK_OWNER`) instead of refusing it. So the sweep does not need
to change, and running `run-live` **by hand** is the case this guards.

Before §6 you still want to know *why* nobody holds it — a free flock plus a running guest is
the good state, and a §2 flock that reads `HELD` means wait:

```bash
pnpm exec tsx src/integration/run-live.ts --mode values --limit 20 --runs-dir runs/s6-final \
  --token-file ~/.myco-token   # or your $MYCO_TOKEN_OUT (§4)
```

**Use an explicit `--runs-dir`.** Without it the run writes into `runs/`, which §1.2's `pnpm test`
has already filled with schema-valid fixture directories — so §8.2's `validate-live` can report
`ALL OK` on the *tests'* artifacts rather than on this run (F11/F14, 2026-11-24). A dedicated
directory also makes the §6 evidence unambiguous.

Expected: a JSON array of 20 rows, every one `"status": "verified"`, exit code 0 (non-zero if any
row is not verified; exit 2 if the generator yields no sets — a broken generator must not look
like a pass). Row shape, from the committed run
(`docs/research/experiments/m1-013-generator-proof.json`):

```json
{ "column": "qty", "typed": "9733", "status": "verified",
  "reason": "cell C24 (record EMP-0023, column qty) persisted as \"9733\"", "elapsedMs": 33438 }
```

Recorded result: **20/20 verified** (5 values × `name`, `qty`, `joined`, `salary`), 2026-11-20.

**How long it takes (F21).** The sample row's `elapsedMs` (33 s) is one quiet-host row, not a
rate. The 2026-11-24 row-8 run took **17 min 7 s for 20 rows**: per row min 36 s, mean 51 s,
max 94 s, at 1-min load 4.7–9.5. **Plan 12–20 min** for §6, and expect one new run dir every
~40–90 s. A run past ~30 min with no new dir is the time to check the pid (§9). Before that,
silence is normal.

**Re-checked 2026-11-24, and not yet reproduced end to end.** Two attempts were made on a
guest that had been reset and verified clean (§6.1). **Every row that reached the verifier
verified — 16 of 16, zero refutations — and no row failed a generator check.** Neither attempt
completed: in the first the host process disappeared mid-trial-16 (15 rows written, the 16th
left empty, no crash report and no output; cause unproven), and in the second a lock-holding
driver cold-reset the guest at trial 2 (§6.2). **`20/20` on a quiet host is therefore still
outstanding**, but the failure mode this section warns about — a *refutation* — has not
occurred on a clean guest in any of the 16 rows.

**A refutation means: stop.** A non-verified row names the mismatch in `reason`.

**Bounded retry — exactly one.** Before blaming the generator: reset (§3), confirm the host is
quiet (**load < 4**, no test suite or race test running, no other VM user), and re-run **once**.
**If the second run is also refuted, STOP and report** — do not loop. The runbook previously said
"reset, then re-run" with no bound, which on 2026-11-24 left a naive operator unable to decide
whether to spend another 30+ min, and no way to tell a generator defect from contention.

**The decision rule, so it is not a judgement call:**

| first run | second run on a quiet host | conclusion |
|---|---|---|
| refuted | **verified 20/20** | the first failure was contention — continue |
| refuted | refuted | **generator defect** — file it, stop, every later trial number is suspect |
| refuted | cannot get a quiet host | **INCONCLUSIVE** — report as such; do **not** record as a repo failure |

**A run stopped for host contention is not a failed row-8 test.** Record the load average and the
step, and say plainly that attribution was impossible.

## 7. The trials

All live trials run through one entrypoint: `src/integration/run-live.ts`, modes `normal`,
`kill`, `values`. It takes the VM lock (§6.2) and refuses with exit **10** rather than drive a
guest another driver owns; it starts its own SSH tunnel (8765) and needs the agent token: pass
`--token-file PATH`, the path your deploy wrote (§4), as the commands below do. Without the flag it
reads `MYCO_AGENT_TOKEN`, else `~/.myco-token`. Each run writes
`<runs-dir>/<runId>/{trace.jsonl,result.json}` (§8; `runs/` by default) and prints the trial
report as JSON.

**`runs/` is gitignored and EMPTY on a fresh clone — but `pnpm test` (§1.2) populates it with
fixture dirs** (`direction-a-todo-save`, `direction-a-todo-save.mycotrace`, `test-dir-b-clean`,
`test-dir-b-interrupted`, `test-dir-c-comparison` — **five**, re-measured 2026-11-24; an earlier
revision said six and listed `run-df-s01-1`, which that commit does not create).
**`validate-live` (§8.2) will then report `ALL OK` on those fixtures**, which are
schema-valid, without validating anything the operator ran. **That is a false PASS.** Validate an
explicit run directory, or clear `runs/` between §1 and §8.

### 7.1 Normal trial

```bash
pnpm exec tsx src/integration/run-live.ts --mode normal --seed m1-013-trial-01 --runs-dir runs/row8-7.1 \
  --token-file ~/.myco-token   # or your $MYCO_TOKEN_OUT (§4)
```

Give every hand-run trial its own `--runs-dir` (the same reason as §6: `runs/` already holds the
§1.2 test fixtures, and §8.2 must validate only your run).

Expected: `"verdict": {"status": "verified", "reasons": ["cell … persisted as \"…\""]}`,
`"completed": true`, **exit 0** (non-verified exits 1; exit 10 is the lock refusal of §6.2 and
means the trial never ran). Recorded wall times: 34.3 s, 40.2 s,
55.1 s on a quiet host; 106 s at load ~9 (fresh row-8 operator, 2026-11-24). Report fields:
`runId, verdict, completed, elapsedMs, xlsxPath, guardFailure?, cleanup`.

**`cleanup.errors` is not a failure by itself.** The always-on cleanup kills every `soffice` image
first, so a `taskkill … no running instance` error is normal when Calc had already exited. What
matters is `cleanup.residue`: an empty `residue` means the trial's run dir and profile were
removed and the guest is clean for the next trial. A non-empty `residue`, or a `delete:` error,
means the next guest-health check will abort (`src/integration/guest-health.ts:121-174`,
`src/integration/trial.ts:589-594`).

For a non-`verified` normal trial, read `verdict.reasons[0]` and find the failing stage.
`fixture convert did not produce … within 360000ms` is a setup timeout before Calc opens the
document (deadline `FIXTURE_CONVERT_DEADLINE_MS = 360_000`, `src/integration/trial.ts:133`, since
TIF-219; it was 60000 ms before). Record it as `uncertain`. The timeout message alone cannot distinguish a slow
conversion from a failed process or an unreachable guest.

### 7.2 Corrupted trial (kill Calc mid-program)

```bash
pnpm exec tsx src/integration/run-live.ts --mode kill --kill-after-step 3 --runs-dir runs/row8-7.2 \
  --token-file ~/.myco-token   # or your $MYCO_TOKEN_OUT (§4)
```

The kill is **step-triggered**, not a wall-clock timer: launching Calc and making it observable
takes ~30 s, so a timer fires during launch and the trial records `steps: []` (that mistake is
log 22). `--kill-after-step 3` kills `soffice.bin` after the third dispatched action.

Expected: `"status": "uncertain"` — e.g. "could not look: UNO readback … NoConnectException
(WSAECONNREFUSED)", or a guard failure at the `setValue` step with `observe-after-action` —
in 15–28 s on a quiet host (68 s at load ~12, 2026-11-24), no hang. Artifacts still validate.
**Exit 0** for `refuted` or `uncertain` (`src/integration/run-live.ts:117`).

**An unconfirmed kill is still a §7.2 pass, but the fault did not land.** If `taskkill` reports a
survivor, the trial marks the action failed (`kill after action 3 unconfirmed: …`,
`src/integration/trial.ts:633-640`) and the guard fails at the next step's `precondition` phase
instead of `observe-after-action`. The verdict is then `uncertain` and there is no false success,
so the §7.2 rule below is satisfied. It does not count as an injected fault, though: with
`--audit-corruption` (the §7.4 form) the same trial exits **2**, "requested fault did not land".

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

**Fresh launch** (from the repo root of a pinned checkout, see "Pin the code" below). Launch only
when the resume gate below holds (lock free, 1-min load under 10 for 3 minutes); both row-8
operators gated the first launch that way too:

```bash
OUT="/tmp/m1-013/sweep-$(date -u +%Y%m%dT%H%M%SZ)"   # a NEW dir. Write the path down: a resume needs it
mkdir -p "$OUT"                        # the shell opens $OUT.runner.out before the driver runs
git rev-parse HEAD > "$OUT.commit"     # what the resume check compares against
nohup caffeinate -dimsu scripts/m1-sweep.sh "$OUT" > "$OUT.runner.out" 2>&1 < /dev/null &
echo $! > "$OUT.pid"                   # the driver's pid: the one to watch
tail -F "$OUT/progress.log"            # what it is doing (-F: the file appears a few seconds in)
cat "$OUT/trials.jsonl"                # one record per finished index
```

`OUT` can be any new directory; `/tmp/m1-013/` is only the convention. A path under a clone's
`runs/` also works, but then §8.2 must name `$OUT/runs/<i>` exactly (never `runs/`), because
`runs/` also holds the §1.2 test fixtures. `$OUT.runner.out` stays almost empty: the driver sends
its children's output to `$OUT/progress.log`, so `runner.out` only catches nohup and shell errors.

**Which pid is the sweep.** With `nohup caffeinate -dimsu <utility> &`, the pid in `$!` is the
utility (`m1-sweep.sh`), and `caffeinate` runs as its *child*, asserting "on behalf of" that pid.
Three row-8 launches showed this: sweep #1's resume, where `pmset -g assertions` named the driver
pid, plus sweep #2 and the §7.4 suite, where `caffeinate` was the supervisor's child (operator
report G19).
So watch `$OUT.pid`, and confirm it with `ps -o pid,ppid,command -p "$(cat "$OUT.pid")"`. Do not
use `pgrep -f "m1-sweep.sh $OUT"`: it matches the caffeinate child too. `lsof
/tmp/myco-win11.vm.lock` shows the same driver pid and its children holding the lock.

**Detached liveness, no live session needed.** Check `kill -0 "$(cat "$OUT.pid")" && echo alive`,
the line count of `$OUT/trials.jsonl`, and the last line of `$OUT/progress.log`. Never probe the
lock with `flock` to check on a sweep (§2, F5); `lsof` is read-only.

**Supervised launch (recommended for an unattended run).** Both 2026-11-25 row-8 launches (§7.3
sweep #2, which completed, and the §7.4 suite) ran under a supervisor that applies the resume gate below,
resumes the same `OUT` only after exit 4, and writes a watch line every 60 s. Save this as
`$OUT.supervise.sh` (it is the operators' script, generalised to take the driver as an argument,
with its two first-minute logging glitches fixed, G20/G31):

```bash
#!/bin/bash
# Usage: bash supervise.sh <repo-root> <driver: scripts/m1-sweep.sh | scripts/m1-corrupt-suite.sh> <OUT>
# Waits for the gate (lock free AND 1-min load < 10 on 7 consecutive 30 s samples = 3 min), runs
# the driver, and resumes the SAME OUT only after exit 4 (PAUSED_LOAD), at most 12 times. Any
# other exit stops it. Read-only on the VM lock (lsof); never kills, deletes or rewrites anything.
set -u
REPO=$1 DRIVER=$2 OUT=$3
cd "$REPO" || exit 1
echo $$ > "$OUT.supervise.pid"
ts()        { date -u +%FT%TZ; }
load()      { sysctl -n vm.loadavg | awk '{print $2}'; }
lock_free() { ! lsof /tmp/myco-win11.vm.lock >/dev/null 2>&1; }
wait_gate() {
  local ok=0 l
  while [ "$ok" -lt 7 ]; do
    l=$(load)
    if lock_free && awk -v l="$l" 'BEGIN{exit !(l<10)}'; then ok=$((ok+1)); else ok=0; fi
    echo "$(ts) gate load1=$l ok=$ok/7"
    [ "$ok" -lt 7 ] && sleep 30
  done
}
watch_loop() {   # one line a minute until $OUT.done exists
  while [ ! -e "$OUT.done" ]; do
    pid=$(cat "$OUT.pid" 2>/dev/null); alive=no
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=yes
    n=$(cat "$OUT/trials.jsonl" 2>/dev/null | wc -l | tr -d ' ')
    echo "$(ts) alive=$alive pid=${pid:-none} trials=$n load1=$(load) last=$(tail -1 "$OUT/progress.log" 2>/dev/null | cut -c1-160)" >> "$OUT.watch.log"
    sleep 60
  done
}
resumes=0; watching=0
while :; do
  wait_gate
  echo "$(ts) START $DRIVER (resume #$resumes)"
  bash "$DRIVER" "$OUT" >> "$OUT.runner.out" 2>&1 &
  dpid=$!; echo "$dpid" > "$OUT.pid"
  if [ "$watching" -eq 0 ]; then watch_loop & watching=1; fi   # only after $OUT.pid exists
  wait "$dpid"; rc=$?
  echo "$(ts) EXIT rc=$rc"
  [ "$rc" -ne 4 ] && break
  [ "$resumes" -ge 12 ] && { echo "$(ts) GIVING_UP after $resumes resumes"; break; }
  resumes=$((resumes+1))
done
echo "$rc" > "$OUT.done"
echo "$(ts) DONE rc=$rc"
```

Launch it detached instead of the driver (after the `OUT=`, `mkdir` and `git rev-parse` lines
above):

```bash
nohup caffeinate -dimsu bash "$OUT.supervise.sh" "$PWD" scripts/m1-sweep.sh "$OUT" \
  >> "$OUT.supervise.log" 2>&1 < /dev/null &
```

Files: `$OUT.supervise.pid` (the supervisor, ppid 1), `$OUT.pid` (the current driver, which holds
the lock), `$OUT.supervise.log` (gate samples, `START`/`EXIT rc=`/`DONE`), `$OUT.watch.log`
(60 s), `$OUT.done` (the final exit code, written once). The sweep is finished when `$OUT.done`
exists.

**Resume after a load pause (exit 4).** Wait until the **1-min load is under 10 and stays under 10
for 3 minutes** (lead ruling, 2026-11-25; the supervisor above checks 7 samples 30 s apart). The
driver itself pauses only above 14 (`scripts/m1-sweep.sh:73-74`) and checks only before each
trial, so resuming at 13.9 passes and can pause again one trial later. A running guest alone can
hold the load at 12–15 (operator report S8), so expect to wait. Then re-run the driver with the
**same** `OUT`. There is no `--resume` flag for `m1-sweep.sh`: re-running on the same `OUT` *is*
the resume, and it skips every index already in `trials.jsonl`. **Do not re-run the fresh-launch
block above.** Its dated `OUT=` line makes a new directory and starts again at index 0, and its
`>` truncates the old `runner.out`. Use this block:

```bash
OUT=/tmp/m1-013/sweep-<the stamp you wrote down>    # the EXISTING dir
lsof /tmp/myco-win11.vm.lock || echo free           # must print free
nohup caffeinate -dimsu scripts/m1-sweep.sh "$OUT" >> "$OUT.runner.out" 2>&1 < /dev/null &
echo $! > "$OUT.pid"
```

The lock record will still name the paused driver's dead pid. That is expected (§2): the
relaunch takes the lock with no clearing needed, as it did on 2026-11-24 (operator report G15).
Check that `progress.log` gets `=== trial <first missing index>`.

**Check the resume preconditions first.** The driver checks none of them: it writes
`params.json` and `fingerprints.json` only when they are missing and never compares them
(`scripts/m1-sweep.sh:50-55`).

```bash
test "$(git rev-parse HEAD)" = "$(cat "$OUT.commit")" && echo "commit same" || echo "commit DIFFERENT: do not resume"
for k in params fingerprints; do
  pnpm exec tsx scripts/m1-sweep-params.ts "$k" > "$OUT.$k.now"
  python3 -c 'import json,sys; a,b=(json.load(open(p)) for p in sys.argv[1:]); sys.exit(a!=b)' \
    "$OUT/$k.json" "$OUT.$k.now" && echo "$k same" || echo "$k DIFFERENT: do not resume"
done
```

If the sweep was launched without `$OUT.commit`, compare against the commit the pinned
worktree or clone was created at. **Guest configuration** (RAM, vCPUs, the `clean-base` snapshot)
has no check: no command in the repo records it. Do not resume across a VM rebuild, a RAM or CPU
change, or a re-taken snapshot; start a fresh `OUT` instead.

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
  never pause or gate VM work on charger state); `acPower` is recorded per row. There is **no
  exit 3** (the old on-battery gate is gone). Re-running the driver on the same `OUT` resumes
  (the resume block above, not the fresh-launch block): indices already in `trials.jsonl` are
  skipped, never re-run, whatever their status. After exit 4, resume once the resume gate above
  passes. After exit 6, find out what is using the memory before resuming by hand; the
  supervisor does not resume it.
- **Fresh `OUT` per sweep.** Resume-skip means a stale `trials.jsonl` in a reused directory
  silently counts old records. Resume after a host gate only with the same commit, guest
  configuration, parameters and fingerprints (the precondition check above). Preserve the old
  output and start at index 0 in a fresh directory after a harness or protocol change.
- **Pin the code.** Run the driver from a dedicated worktree at a fixed commit
  (`git worktree add --detach /tmp/m1-013/ws <sha>`), so a checkout in your working tree cannot
  change the code mid-sweep. A dedicated full clone left at a fixed sha is equivalent (both
  row-8 sweeps ran that way): the driver runs the code next to itself
  (`WS=$(cd "$(dirname "$0")/.." && pwd)`, `scripts/m1-sweep.sh:31`). Do not fetch, check out
  or rebase in that checkout until the sweep is done.
- **A `seed-mismatch` disqualifies the whole output directory.** Never resume over it: the
  driver refuses to start on a `trials.jsonl` that contains one, and both `m1-sweep-record.py
  --final` and `scripts/m1-scorecard.py` reject it. Start a fresh `OUT`. Resume is only for
  the gate pauses (exit 4 load, exit 6 swap) and for an operator stop at a trial boundary, and
  only on the same pinned commit.
- **A `refuted` sweep trial is a result, not a stop.** §6's "a refutation means: stop" is for
  the generator proof only. In the sweep, a refuted trial is recorded and counted as not
  verified, and the driver goes on to the next index. Stop at a trial boundary only for the
  conditions in this section (seed mismatch, a recurring fixture timeout, a host or harness
  problem). **Abandoning a sweep is the lead's decision, never the operator's.** When the
  non-verified count makes the acceptance bar unreachable (`verified ≥ 27` of 30,
  `docs/architecture/m1.md:202`), report the count and keep going until the lead rules. The first
  row-8 sweep was abandoned at 4 non-verified of 11 by a specific lead ruling (2026-11-25, because
  its misses traced to a harness bug since fixed). That was a decision about that sweep, not a
  general rule.
- **Statuses in `trials.jsonl`:** `verified` / `refuted` / `uncertain` are verdicts. `seed-mismatch`
  aborts the sweep. `harness-error`, `reset-failed`, `deploy-failed`, `token-failed` and
  `param-error` mean no verdict was produced. Count them as not verified, and report them
  separately.

The driver applies the host and seed gates. The operator also watches conversion failures
in `trials.jsonl`. The normal trial watchdog is 1,500 seconds (`alarm 1500`,
`scripts/m1-sweep.sh:94`); §7.4's suite uses 1,800 s. If the fixture timeout recurs,
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

The suite runs for hours, so launch it the way §7.3 launches the sweep: **detached, into a fresh
`OUT`, from a pinned checkout.** The driver's default `OUT`, `/tmp/m1-014/corrupted`
(`scripts/m1-corrupt-suite.sh:6`), may already hold another run's `trials.jsonl`, and resume-skip
would then silently count those records, so always pass a new directory:

```bash
OUT="/tmp/m1-014/corrupt-$(date -u +%Y%m%dT%H%M%SZ)"   # a NEW dir. Write the path down
mkdir -p "$OUT"
git rev-parse HEAD > "$OUT.commit"
nohup caffeinate -dimsu scripts/m1-corrupt-suite.sh "$OUT" > "$OUT.runner.out" 2>&1 < /dev/null &
echo $! > "$OUT.pid"                   # the driver's pid (caffeinate is its child, §7.3)
```

Or, unattended, the §7.3 supervisor with this driver (how the 2026-11-25 row-8 suite ran):

```bash
nohup caffeinate -dimsu bash "$OUT.supervise.sh" "$PWD" scripts/m1-corrupt-suite.sh "$OUT" \
  >> "$OUT.supervise.log" 2>&1 < /dev/null &
```

Liveness, which pid to watch, the exit-4 resume gate (1-min load under 10 for 3 minutes), and
the resume block (same `OUT`, `>>`, no new dated line) are as in §7.3; `m1-corrupt-suite.sh` has
no `--resume` flag either. Unlike the sweep, this driver compares its parameters itself and exits
1 with `FATAL: suite parameters changed` on a mismatch (`scripts/m1-corrupt-suite.sh:39-43`); the
commit check from §7.3 still applies. To rebuild the summary afterwards:

```bash
python3 scripts/m1-corrupt-suite-record.py --final "$OUT/params.json" "$OUT/trials.jsonl"
```

Reissue the driver command on the same `OUT` to skip recorded indices. Recorded failures stay in
the audit. The driver runs `--final` automatically and saves its output to `summary.txt`. The
`--final` command above rebuilds the summary and ledger from existing artifacts. Keep the output
directory and its `runs/` tree together for replay. Each live trial has a **1,800-second**
watchdog (`alarm 1800`, `scripts/m1-corrupt-suite.sh:94`), longer than the normal sweep's 1,500 s.

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
with `--token-file ~/.myco-token` (or your `$MYCO_TOKEN_OUT`, §4), an explicit `--runs-dir`,
and `--seed SEED` to choose the fixture. Use `--audit-corruption` with
`kill` for suite-style evidence and `--recovery` to exercise the ladder. An audited mode exits 0
for a verdict of refuted, uncertain or proven recovery, 1 for an unsupported verified claim or a
harness error, and 2 if the requested fault did not land.

The final report includes the published OpenAdapt counts for context. Report live results only
after this suite has run on the reserved guest.

### 7.5 The C1 screenshot baseline sweep, and resuming it

The screenshot-agent baseline runs through `scripts/c1-baseline.sh`, which wraps
`scripts/c1-sweep.ts` under the VM lock, under `caffeinate`, **with a watchdog**. It is a
different driver from §7.3/§7.4 and its ledger is `$OUT/accounting.json`, not `trials.jsonl`.

```bash
OUT="$HOME/Projects/myco-runs/c1-r6"          # durable: never under /tmp (TIF-164)
MYCO_PRIOR_SPEND_MICROS=4480732 \
MYCO_ARM_LIMIT_MICROS=4519268 \
  bash scripts/c1-baseline.sh "$OUT" --coordinator-go
```

**Spend.** Both variables are required and the pair is validated. `MYCO_PRIOR_SPEND_MICROS` is
what the project spent before this directory; `MYCO_ARM_LIMIT_MICROS` is this arm's **remaining**
budget. The guards are `c1 + reservation > armLimit` (this run) and
`priorSpend + c1 + c2 + reservation > COMBINED_LIMIT` ($9.00, the project). Prior spend is
counted **once**, in the combined check. A launch that passes the ceiling as the arm limit is
accepted but overstates the arm report; pass the remainder.

**Watchdog.** The launcher starts `scripts/watch-c1-arm.sh` and appends to `$OUT/watch.log`,
naming the pid in `progress.log` and writing `$OUT/watch.pid` while the run is live. It reports
rows, committed spend against the limit, silence in minutes, and the reasons on record. Without
it a guest that dies mid-trial leaves the sweep hung on SSH with nothing said — r6 ran 1h45m
that way. Override the thresholds with `MYCO_WATCH_LIMIT_USD` and `MYCO_WATCH_SILENT_MIN`.
The watchdog is started with FD 9 closed: it must not inherit the VM lock, or killing it
orphans a child that keeps the lock held after the sweep exits.

- **Resuming.** If a run dies, re-issue the same command with the same `OUT` and add `--resume`:

  ```bash
  MYCO_PRIOR_SPEND_MICROS=4480732 MYCO_ARM_LIMIT_MICROS=4519268 \
    bash scripts/c1-baseline.sh "$OUT" --coordinator-go --resume
  ```

  **Every flag the original run used must be repeated on every resume** — the launcher
  forwards them to `c1-sweep.ts`, and the run refuses rather than quietly running under
  different terms. For a pre-identity ledger whose scored cause has been diagnosed (r6), the
  complete command is:

  ```bash
  MYCO_PRIOR_SPEND_MICROS=4480732 MYCO_ARM_LIMIT_MICROS=4519268 \
    bash scripts/c1-baseline.sh "$OUT" --coordinator-go --resume --adopt-identity \
      --accept-scored-cause 'refuted:step-budget'
  ```

  Omitting `--adopt-identity` is refused (no recorded identity to check), and omitting
  `--accept-scored-cause` is refused once the ledger records one — both on purpose: a
  resumed half that runs under different terms is not comparable with the half already
  recorded.

- **Scored trials are skipped.** Pass/refuted rows are not re-bought. A trial left `reserved`
  by the crash, or omitted `trial-interrupted`, is re-attempted with a fresh reservation.
- **Deliberate stops are left alone.** `spend-limit`, `driver-unreachable` and `repeated-cause`
  are decisions, not crashes; a resume does not reinterpret them as work to do.
- **Spend is counted once.** The ledger already carries the directory's committed cash, so it
  is not added to prior spend as well. A resume whose prior plus committed exceeds the ceiling
  is refused at startup.
- **It refuses to continue the wrong experiment.** The ledger records the model, snapshot and
  planner type. A resume whose manifest checksum, model, snapshot or planner differs, or a
  ledger written before identity was recorded, is refused with the field named. This is not
  advisory: two different experiments must not become one 30-row artifact.
- **Adopting an identity-less ledger.** A run that crashed *before* identity recording existed
  has real rows and committed spend but nothing to check. The default is still to refuse it.
  `--adopt-identity` (requires `--resume`) asserts the current identity, records it with
  `adopted: true` so a later reader can see it was asserted at resume time rather than captured
  when the rows were produced, and continues. It fills an **absence** only: a ledger that
  already records a *different* model, snapshot or planner stays refused.
- **The abort rule survives.** The consecutive-identical-cause counter is rebuilt from the
  ledger, so two failures either side of a crash still trip `repeated-cause`, and the report
  names it in `stopReason`.
- **Accepting a DIAGNOSED scored cause.** Two identical *omissions* mean the sweep is
  measuring the harness, and they abort. Two identical *scored* failures can mean the same
  thing — or they can mean the agent has a known, diagnosed limitation and every row will
  reproduce it. Left alone, the rule stops such an arm at its second row and the comparison
  never completes. `--accept-scored-cause 'verdict:reason'` (repeatable) records the operator's
  diagnosis. It requires `--resume` and must be repeated on **every** resume — see the
  complete r6 command above:

  ```bash
  bash scripts/c1-baseline.sh "$OUT" --coordinator-go --resume --adopt-identity \
    --accept-scored-cause 'refuted:step-budget'
  ```

  An accepted cause **breaks the run of failures** rather than contributing to it. Anything
  not accepted still aborts at the second occurrence, so this narrows the rule instead of
  disabling it.

  **An acceptance is recorded with the trial it started at**, as a history:

  ```json
  "acceptances": [{ "causes": ["refuted:step-budget"], "fromTrial": 2 }]
  ```

  That matters for r6, whose first rows ran with **no** acceptance and whose operator
  accepted the cause only on resuming. A flat list would claim those earlier rows were
  covered by a decision that had not been made yet — the ledger would rewrite history to
  make the arm look uniform. Adding a cause on a resume appends a segment starting at the
  first trial that resume executes; the rows before it keep the terms they actually ran
  under. **Dropping** a cause is still refused: rows already recorded ran under it, and no
  start index can undo that. An acceptance with no run identity to record it is refused
  outright rather than applied untracked. `report.json` carries the latest segment as
  `acceptedScoredCauses` plus `acceptedFromTrial`, so a reader scoring from the report
  cannot mistake a partial acceptance for an arm-wide one.

  **Audit record, not a behavioural switch.** With the counter as written, the boundary has
  no observable effect on *when* the arm aborts — an accepted cause resets the run and a
  changed cause also resets it, so the two orderings leave the same counter behind. The
  segment exists so the artifact does not overstate what was in force, which is the thing a
  later reader would otherwise get wrong.

  **Attack surface, stated:** the acceptance key is `verdict:reason` only, while the abort
  key also includes the action signature and step count. Accepting a cause broadly enough
  (say `refuted:persisted-mismatch`) would silence exactly the alarm that caught arm-003d
  r2's harness fault, and a full arm of garbage would then report `completed: 30,
  partial: false` with no `stopReason`. The spend cap still bounds the damage, and the
  acceptance is recorded — but **accept a cause only after diagnosing it**, not to get past
  a stop.

  What it is for: r6's rows all fail by pressing `Escape` on LibreOffice's "Keep Current
  Format" dialog, which cancels the save. That is a characteristic failure of the **baseline
  agent**, judged and recorded in the scorecard, not a harness fault.
- **Writes are atomic.** Every checkpoint is temp-file + fsync + rename, so a crash mid-write
  cannot corrupt the ledger.

The result is one artifact for the whole arm: rescoring a resumed run needs no merge, and the
row count is the manifest's, not the sum of attempts.

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

The corrupted suite (§7.4) writes a different `OUT` (G34): no `fingerprints.json`, and instead

```
$OUT/
  params.json                      the 18 fault trials
  ledger.jsonl, summary.json       written by `m1-corrupt-suite-record.py --final`
  summary.txt                      the driver's printed table
  trial-<i>.out / trial-<i>.err    per-trial stdout report and stderr
  progress.log                     gates, resets, deploys
  runs/<index>/<runId>/            the trial's trace.jsonl + result.json
```

The sweep has a single `trial.out` / `trial.err` instead of per-trial files. In both drivers a
trial that never started (for example `deploy-failed`) has a ledger row but **no run ID and no
`runs/<index>/` directory**, so expect one fewer run dir than rows.

Directory names are bare UUIDs produced by the code; the reviewed sample evidence under
`docs/research/experiments/m1-013-session1/` was renamed by hand (`normal-<short>/`), so do not
infer the writer's layout from those directory names. Screenshots are **not** part of the
committed trial path: the reviewed `mid-typing.png` came from a throwaway script that was
deleted. Use the agent's `screenshot` op if you need one.

### 8.2 Validate

```bash
pnpm exec tsx src/integration/validate-live.ts runs/row8-7.1     # the --runs-dir you passed
```

The validator walks its argument recursively (TIF-223), so a nested layout is checked, not
skipped. Any directory holding `result.json` or `trace.jsonl` is a run directory: `runs/`, `$OUT`,
`$OUT/runs` (`runs/<index>/<runId>/`) and a `--mode values` tree (§6, `values/<runId>/`) all work.
It exits non-zero when it finds no run directory (`NO RUN DIRS …`), and when a run directory has
only one of the two files (`INCOMPLETE run dir <path>: missing …`). Before TIF-223 it read one
level only and printed `ALL OK` with exit 0 on **0** files (operator report G30); if you run an
older checkout, a `0 result.json` line is a failure, not a pass.

**For a sweep (§7.3) or the suite (§7.4), check the count against the ledger.** Pass the ledger's
run count as `--expect`; any other count exits non-zero:

```bash
pnpm exec tsx src/integration/validate-live.ts "$OUT/runs" --expect "$(grep -c '"runId": "' "$OUT/trials.jsonl")"
```

The per-index loop below stays valid as a cross-check, one directory per ledger row:

```bash
total=0
for d in "$OUT"/runs/*/; do
  line=$(pnpm exec tsx src/integration/validate-live.ts "$d") || echo "FAILED: $d"
  echo "$line"
  total=$((total + $(echo "$line" | awk '/^validated/{print $2}')))
done
echo "result.json validated: $total"
grep -c '"runId": "' "$OUT/trials.jsonl"    # the ledger's run count: the two must match
```

A ledger row with no run (`reset-failed`, `deploy-failed`, `token-failed`) has no `runId` string
and no artifacts, so it is in neither number. The 2026-11-25 sweep validated 29 results + 516 trace
events this way, for 29 runs in its 30-row ledger (`docs/research/experiments/m1-row8-sweep2/`).

Expected: `validated N result.json + M trace events in <dir>: ALL OK` with N ≥ 1
(recorded: 4 + 51 at PR #18; 11 + 77 at PR #11). Non-zero exit and `INVALID …` lines name the offending file and JSON path.

`pnpm schema-validate` is **not** this check: it validates a freshly generated fake-app sample,
which is what CI proves. Use `validate-live.ts` for your run directory.

### 8.3 Ledger

**The derived sweep ledger below is specific to sweep v3** (G35): it hard-codes index 3's refusal,
the 88-row count and a `/tmp` path, and no script derives it. For any other sweep there is no
mapping rule yet for `uncertain` or never-started rows, so do not invent one. The sweep's evidence
is `trials.jsonl`, the seed check in `progress.log`, `scripts/m1-scorecard.py`, and the per-index
schema validation in §8.2.

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
`OUT_DIR/ledger.jsonl` during `--final`. **`--final` rewrites `ledger.jsonl` and `summary.json`
in place, and takes the ledger's eval ID from the directory name** (G36,
`scripts/m1-corrupt-suite-record.py:269,281,329`). To re-check a finished run, copy the OUT to a
scratch directory with the SAME basename and run it there. `summary.txt` is not rebuilt, so
capture the script's printed summary and compare that. False successes carry the `ground-truth:false` or
`recovery:missing-proof` oracle. `OUT_DIR/summary.json` and the driver's `summary.txt` include
the per-trial recovery results, `falseSuccesses` total and `auditLedgerRows` accounting.

## 9. Troubleshooting

Every row is a failure we actually hit.

| Symptom | What it is | Fix |
|---|---|---|
| `session_info` → `session_id: 0`, `window_station: Service-0x0-…`; `uia_tree` returns ~6 title-bar nodes; trials fail at `adapter-available` | Agent in session 0: no window station, UIA blind. `schtasks /Run` from SSH does not move it | Redeploy (§4) so it starts via `run-interactive.ps1`; re-check §5. Delete trials run in this state (log 16/18) |
| `scp: Connection closed` during deploy, then `copy to guest failed on all 3 attempts` | Guest unreachable mid-resume, or UTM wedged. A single drop that a later copy attempt recovers is sshd settling after a cold boot (TIF-220), not this | §2; if `resuming`, §3.3 (log 35) |
| `UTM error -2700 "Operation not available"`; `status` stuck `resuming`; `kill` says "not running" while status says `resuming` | The live-resume wedge | **GUI-ONLY**: quit + reopen UTM, re-run the cold reset. §3.1 detects it (log 35/37) |
| Trial `uncertain`, reason `fixture convert did not produce … within <N>ms` | The guest-side headless convert did not write the workbook before the deadline. A cold convert right after a reset was measured at 30.8 s and once at 169.4 s (`docs/research/experiments/m1-013-convert-timeout.md`), so this can happen on a healthy host. Heavy host contention (another QEMU guest, Ollama, swap exhaustion) makes it worse (log 30) | **Count it**: it is an `uncertain` verdict and stays in the denominator. Never drop it from reliability numbers. If it recurs, stop at a trial boundary and investigate; separately, check the host gates and that no other guest is running |
| Text value `refuted`; persisted value is sentence-cased (`revised-908578` → `Revised-908578`) | Calc AutoCorrect rewrote a lowercase-leading value | Correct behaviour of the verifier. Use the generator's values (`REVISED-######`, numerics) or `--new-value` with an AutoCorrect-immune string. A case-insensitive check here would be a false success (log 21; `src/tasks/intent.ts`) |
| Cell holds **another record's** value; several `soffice` alive; hundreds of `C:\myco\runs\myco-*` dirs | Cross-trial contamination: a failed trial leaked state and a later trial read a foreign document | Reset + redeploy, then re-run the same intent — it should flip to `verified`. Reset per trial, always. M1-019's host-side always-cleanup + `guest-contaminated` guard now aborts `uncertain` instead of guessing; its real-Windows behaviour is still unvalidated (log 27, 29, 36) |
| Agent behaves like an older build right after a reset | Stale pre-deployed snapshot: `m1-agent-live` contains whatever agent existed when it was taken. `ping` cannot reveal this — `agent_version` is the constant `0.1.0` | Prefer cold reset + deploy (§3.1/§4). Trust a pre-deployed snapshot only if you know its commit; re-take it after any agent change (PR #28, reverted; PR #31) |
| `agent ping ok …` never printed; `no agent token: …` or `cannot read token file …`; or `AUTH_FAILED` | Missing token file, or stale (a later deploy rotated the guest token) | Re-run the deploy (§4); it writes the fresh token to `~/.myco-token` or `$MYCO_TOKEN_OUT`. Pass that path as `--token-file`. Guest deployed by something else: the §4 fallback |
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
