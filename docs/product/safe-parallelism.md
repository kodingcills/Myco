# Safe parallelism: N isolated, disposable desktops with verified results

Capability track L (Tier 2, M2 scope). Linux path first. Code: `src/parallel/`. CLI:
`pnpm myco-parallel`. Tests: `test/parallel/`. CI: the `safe parallelism (ubuntu-latest)` job.

Myco should give desktop agents more capability, not only check them. Track L adds
throughput. One host runs N trials at once. Each trial gets its own fresh desktop, which is
destroyed afterwards. Each trial gets its own verdict vault and gate, and no trial can
contaminate another. Parallelism must never raise a verdict. It can only withhold one: a
trial that breaks any isolation rule is not counted as verified, whatever the gate said.

> **Scope of this PR (round 2, narrowed).** Strict namespace isolation (`linux-ns`: per-trial
> user, mount, network and pid namespaces) is **NOT in this PR**. Its round-1 form gave a false
> VERIFIED: a trial could unmount the "hidden" run root and write another trial's saved file.
> It also needs privileges cloud sessions lack. It is being rebuilt in **#551** ("L2 strict
> linux-ns isolation"). What ships here is the pool, its guards, and the unprivileged
> `linux-plain` backend. `linux-plain` leaves other trials' roots writable, so **no
> `linux-plain` trial is ever counted as verified** (`shared-host-dirs`, §2). It measures the
> harness and checks every gate verdict, but it produces no counted result. Counted results
> need a backend that really hides other trials: strict `linux-ns` (#551) or a microVM
> (track U, §6).

No model is called anywhere in this track. The agents are scripted, so every run here costs
$0. Measurement runs with a real agent are out of scope for this PR. They need the integrity
fixes in flight and the lead's GO, and they run on Claude Ultra only (§7).

---

## 1. Quick start

```sh
pnpm install --frozen-lockfile
pnpm myco-parallel --probe                       # what isolation this host can give
pnpm myco-parallel --n 1,2,4 --trials 8 --allow-weak-isolation          # $0, scripted file agent
pnpm myco-parallel --n 1,2,4 --trials 8 --agent calc --display xvfb --allow-weak-isolation
```

`--agent calc` needs LibreOffice Calc, Python-UNO and Xvfb (`sudo apt-get install -y
--no-install-recommends libreoffice-calc python3-uno xvfb`). No privilege and no sysctl is
needed. Without `--allow-weak-isolation`, the strict default refuses every `linux-plain`
trial (`isolation`, §3), because no backend in this PR meets it.

A real-Calc run on a 4-CPU Linux container (8 trials per level, half of them honest). These
numbers are **simulated, not evidence**: scripted agents, `linux-plain`, nothing counted.

```
   N  trials  wall s  trials/h  gate-ok  counted  counted/h  correct  contaminated  peak  speedup
   1      8    5.4   5347.2        4        0          0       8            0    1      1x
   2      8    2.5    11557        4        0          0       8            0    2   2.16x
   4      8    1.7  17204.3        4        0          0       8            0    4   3.22x
```

`gate-ok` is how many trials the gate said `verified` for. `counted` is how many may be
counted, and it is always 0 on `linux-plain`. `correct` means the gate verdict matched the
scripted behaviour, with no disqualifier other than `shared-host-dirs`.

The report is stamped `simulated: true`, `evidence: false`, `costEstimate: null`. Scripted
agents measure the harness: isolation overhead and scaling. They never measure an agent's
capability, so these numbers are not evidence and never enter R7.

Exit codes: 0 means every trial got its expected verdict with no blocking disqualifier. 1 means a
mismatch, a contamination, a refused pool or an unavailable backend. 3 means a usage error.

## 2. What one trial does

`runPool` (`src/parallel/pool.ts`) runs these steps for every trial. Each step fails closed.

1. **Claim the run id by its case-folded form.** `Run-A` and `run-a` are the same trial on a
   case-insensitive filesystem. A run id ending in `.` is refused (NTFS drops the dot, so
   `run-a.` is `run-a`), and so is a Windows device name (`con`, `nul.txt`, `COM1`, …). A batch with both is refused before anything starts. Two
   pools that share a lock dir refuse each other's folded-equal ids while either holds one
   (`open(…, "wx")` on a lock named by the folded id's sha256). A stale lock is a refusal
   too: an operator removes it by hand.
2. **Create a fresh desktop** in an empty private root under `<run>/trials/<runId>`. The dir
   must not exist yet, so a root is never reused.
3. **Check isolation.** The pool compares the desktop's `IsolationReport` with the operator's
   requirements. A shortfall destroys the desktop before anything is sealed. Separately, and
   whatever the requirements say, a desktop whose report does not say `hostDirsHidden:
   true` gets `shared-host-dirs`: the trial runs, but it is never counted.
4. **Plant the trial's marker.** This is a random nonce known only to the harness and this
   trial. It goes in `workspace/.myco-trial-marker` and `$MYCO_TRIAL_MARKER`. The task's
   fixture is laid down next to it. Both are harness writes (see "Harness writes" below).
5. **Run the existing gated path, unchanged** (`runGatedTrial`): launch audit, then seal into
   a vault for this trial only. The vault has its own root under `<run>/vaults/<runId>`, a
   fresh key, and the desktop's root as its agent root. The gate is bound to
   `{ runId, receipt }`. Then the agent runs, stops, its output is captured, and the gate
   decides from the sealed capture. The agent still sends only taskId, runId and claim
   (`myco.gate/v1`). Track L adds no gate input.
6. **Capture without following links, and without blocking.** The saved file is read for the
   vault only if it is a regular file with exactly one link and at most 16 MiB, inside the
   workspace the harness resolved before the agent ran. The file is `lstat`ed first and
   opened `O_NONBLOCK | O_NOFOLLOW`, then re-checked on the open fd, so a FIFO, socket,
   directory or device planted as the state file is refused at once instead of freezing the
   pool. A symlink or hard link to another trial's saved file, or to a host file with the
   right content, is refused too. Every refusal has a code (`missing`, `outside-workspace`,
   `symlink`, `not-regular`, `hard-linked`, `too-large`). The trial gets `capture-refused`
   and no verdict. The marker scan opens files the same non-blocking way.
7. **Scan, then destroy.** The pool scans the desktop's tree for every other trial's marker,
   then destroys the desktop. It then checks the destroy report: no process left and the
   root removed.
8. **Write evidence** to `<run>/evidence/<runId>/`: `record.json` and `agent-output.txt`.

**Harness writes never block, and refuse anything planted (round-3 B1).** On `linux-plain`
every dir the harness writes into (the trial's workspace and home, its evidence dir, the
run root) is reachable by every trial, and a plain blocking write onto a planted FIFO
would freeze the whole event loop: every trial, timeout and watchdog. So every
harness-written file (marker, fixture, `mcp.json`, `agent-output.txt`, `record.json`) goes
through `writeHarnessFile`:

- the target dir must still be its own realpath, taken before any agent ran (and the
  workspace and home must resolve inside the trial's root), so a dir swapped for a symlink
  is refused, not written through (`outside-dir`);
- the file is created `O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK`. Each harness file is
  written once, so any entry already there (FIFO, socket, symlink, dir, or a planted
  regular file) is refused at once (`exists`) and nothing that could block is opened;
- the write runs off the event loop and is raced against a hard timeout (10 s,
  `timeout`).

A refusal gives the trial `evidence-refused`. A refused `record.json` withholds the count
even when the gate said `verified`. The pool report is written to a fresh random name and
`rename`d over `pool-report.json` (a regular file from an earlier run in a reused run root
is replaced); a target that is not a regular file rejects the whole run with
`HarnessWriteRefused`: no report, no count.

After all trials finish, the pool scans each trial's evidence root, its vault dir and its
gate records (the agent-seen result, the final result and the claim) for the other trials'
markers.

A trial counts as verified (`countedVerified`) only when the gate's verdict is `verified`,
the gate `accepted` it, and none of these disqualifiers applies:

| Disqualifier | Meaning |
| --- | --- |
| `run-id` | The folded run id was already claimed, or the id is malformed |
| `isolation` | The desktop's isolation report falls short of the requirements |
| `shared-host-dirs` | The backend leaves other trials' roots writable (`hostDirsHidden` is not `true`). Always set on `linux-plain`. Not configurable |
| `contaminated` | Another trial's marker was found in this trial's workspace, evidence, vault or gate records |
| `leaked` | This trial's marker was found in another trial |
| `own-marker-missing` | This trial's own marker was gone at scan time, so the scan proves nothing |
| `scan-incomplete` | A tree was too large (over 64 MiB) or unreadable |
| `teardown` | A process survived destroy, or the root was not removed |
| `resource-cap` | The watchdog killed the desktop for exceeding memory or CPU time |
| `timeout` | The trial ran past its wall-clock cap |
| `capture-refused` | The saved file was a link, a special file (FIFO, socket, dir), too large, or outside the workspace |
| `evidence-refused` | A harness write (marker, fixture, `mcp.json`, agent output, record) found something planted at its target, a swapped dir, or timed out |
| `agent-error`, `harness-error` | The agent or the setup threw |

## 3. The Linux backend (`linux-plain` only)

`linuxBackend()` (`src/parallel/linux-backend.ts`) has one mode in this PR, `linux-plain`.
It needs no privilege. Every desktop's report says exactly what it got:

| | `linux-plain` |
| --- | --- |
| Root | private, under the run root |
| Other trials, vaults, evidence, locks | **visible and writable** (`hostDirsHidden: false`) |
| `/tmp` | shared (only `TMPDIR` points into the root) |
| Network | shared |
| Processes | one process group per exec, killed at destroy (a `setsid` child escapes) |
| Display | its own Xvfb on a display Xvfb picks (`-displayfd`), with its own random MIT-MAGIC-COOKIE-1 (`-auth`, `-noreset`); `XAUTHORITY` is set in that trial's env only. A client without the cookie is refused, but the cookie file sits in the trial's root, which other trials can read (same uid) |
| Env | allowlist only: `PATH`, `LANG`, plus the desktop's own `HOME`, `TMPDIR`, `XDG_*`, `DISPLAY`, `XAUTHORITY` and the marker |
| Memory and CPU caps | a /proc watchdog on the exec'd process groups |

The default requirements are strict: an own network, a private `/tmp`, and hidden host dirs.
Under them, `linux-plain` is refused trial by trial with `isolation`.
`--allow-weak-isolation` lowers all three to best-effort so the trials run. A private root
and processes that die with the desktop are always required. Even then, every
`linux-plain` trial carries `shared-host-dirs` and is never counted (§2).

**Why the count rule, and not the marker scan.** A hostile trial on a shared filesystem can
write another trial's saved file with the right bytes and write no marker at all. The
victim's gate then reads forged bytes and says `verified`, and the marker scan sees
nothing. That is round-1 D1 in a new form. Both shapes are tests in
`test/parallel/linux-backend.test.ts`: two trials running at once, and a `setsid` process
left behind by trial 1 that forges trial 2's file in a serial pool. In both, the victim's
gate says `verified` and the pool does not count it.

**Strict namespace isolation is not in this PR.** It is being rebuilt in **#551** ("L2
strict linux-ns isolation"). That PR must make the hide mounts impossible for the agent
to undo: lock them by setting them up in an outer user namespace and starting the agent in
a nested one, or drop the agent's capabilities. It must also add the round-1 regression
tests: `umount` of every hide dir fails from inside, and the pool-level forgery is not
counted.

## 4. Resource caps

`resolveCaps` (`src/parallel/caps.ts`) validates the caps before a pool starts and refuses
on any problem:

- every cap must be a positive integer;
- `maxConcurrent ≤ 64`;
- `memoryBudgetMb ≤ host memory` (default: 75% of host memory);
- `cpuBudget ≤ host CPUs`;
- `maxConcurrent × memoryMbPerTrial ≤ memoryBudgetMb`;
- `maxConcurrent × cpusPerTrial ≤ cpuBudget`.

At run time:

- **Concurrency:** a fixed number of workers, with a guard on the live count.
  `peakConcurrent` is reported.
- **Memory and CPU time:** the watchdog samples every 200 ms. It destroys the desktop when
  the trial's resident memory exceeds `memoryMbPerTrial`, or its CPU seconds exceed
  `cpuSecondsPerTrial`.
- **Wall clock:** the desktop is destroyed at `trialTimeoutMs`.

The watchdog caps sustained use. It is not a hard limit, because a spike shorter than one
sample can pass. Hard limits are a backend's job: cgroups in a container, or the VM size in
a microVM (§6).

## 5. Security model

The threat is a hostile or buggy agent in trial A. Each row is a goal it might have, the
defence against it, and the test that proves the defence:

| Goal of the agent in A | Defence | Proved by |
| --- | --- | --- |
| Write trial B's saved file so B is counted on forged bytes | NOT prevented on `linux-plain`. Prevented from being COUNTED: every `linux-plain` trial is `shared-host-dirs` | `linux-backend.test.ts` "D1 shape" and "serial too"; `pool.test.ts` "never counted" |
| Get verified on B's work through its own capture | B has its own vault (own key and receipt); A's gate is bound to A's run id; capture refuses links and special files | `pool.test.ts` capture and special-file tests; `test/gate/sealed-gate.test.ts` (unchanged) |
| Hang the pool with a FIFO or another special file as its state file | `lstat` first, `O_NONBLOCK` open, re-check on the fd, size cap; coded refusal | `pool.test.ts` "special file as the state file" and "B3: a file swapped for a FIFO between the lstat and the open" (in a child with a hard limit) |
| Hang the pool with a FIFO at a harness write (its own or another trial's evidence dir, workspace or home, or the pool report) | `writeHarnessFile`: `O_EXCL \| O_NOFOLLOW \| O_NONBLOCK` create, realpath'd dir, off-loop write with a hard timeout; `evidence-refused` / run rejected | `pool.test.ts` "B1: harness writes" (real pool in a child with a hard KILL limit, per site, honest sibling still counted) |
| Leak something into B that changes B's outcome | Markers are scanned in workspace, evidence, vault and gate records; a hit disqualifies both trials | `pool.test.ts` contamination tests; `linux-backend.test.ts` "planted markers" |
| Talk to B over the network or a socket | NOT prevented on `linux-plain` (shared network). Covered by the count rule | — |
| Connect to B's X display (read its screen, inject input) | A blind connect is refused: each Xvfb requires its own random cookie, set only in its own trial's env. NOT prevented against a trial that reads B's cookie file (same uid, B's root is readable on `linux-plain`). Covered by the count rule | `linux-backend.test.ts` "B2: a trial cannot connect to another trial's X display" (A's processes are refused on B's filesystem and abstract sockets, with no cookie and with A's own; B's client is accepted) |
| Leave a process behind to affect a later trial | NOT prevented for a `setsid` child (it leaves the process group). Covered by the count rule | "serial too" |
| Read the operator's secrets from the env | Env allowlist | "passes no host env var" |
| Starve its siblings | Caps checked at admission, plus the per-trial watchdog | watchdog and cap tests |
| Alias another run through case folding | Folded-id claims, in-process and on disk | `units.test.ts`; the "two pools sharing a lock dir" test |

The gate guarantees are unchanged and are not weakened here:

- The agent supplies only taskId, runId and claim.
- The gate is bound to one trial.
- The grader stays independent: `src/benchmark/grade` is not imported by `src/parallel/`.
- Persisted bytes are captured per trial.
- The gate fails closed.
- Agent-facing reasons carry codes only.
- Calc stays CSV-only.
- R1 is untouched.
- Simulated rows never count as evidence.

Residual risks:

- **Same uid, nothing hidden.** On `linux-plain` the agent runs as the operator's uid and can
  read and write any host file the operator can, other trials' roots included. This is why
  the strict default refuses it and why its trials are never counted. Use a microVM
  (track U) for agents you do not trust.
- **X cookies are readable by other trials.** The per-trial cookie stops a blind connect to
  another trial's display, not a trial that reads the cookie file from B's root (or B's
  process memory) as the same uid. Covered by the count rule; strict isolation (#551) is
  the real fix.
- **`setsid` escapes and harness death.** A process that leaves its process group survives
  `destroy()`, and `processesGone` only covers the desktop's own process groups. If the
  harness itself dies, the desktops' processes are not killed. Neither can produce a
  counted result, because of the count rule.
- **No pids or CPU-affinity cap.** `cpusPerTrial` is only used at admission; only CPU
  seconds are enforced at run time, and there is no pids cap (fork bomb). cgroups are a
  follow-up.
- **Scan timing.** A trial's workspace is scanned just before its own destroy. A write that
  lands in a finished trial's tree after its scan is not seen. The evidence-root and vault
  scans after all trials still cover what the gate read, and the count rule covers the
  rest.

## 6. Interface for track U (microVM backend)

A microVM backend implements `DesktopBackend` (`src/parallel/backend.ts`). The pool needs
nothing else from it (lands with U).

- `probe()`: `available` is false when the VM tooling or kernel support is missing.
- `create(spec)`: `spec.root` is an empty host dir for this trial alone. The backend must:
  - expose `paths.workspace` as a host-readable dir, at least after the agent stops (a
    virtiofs share or a copy-out before destroy), because the pool captures from it;
  - set every env entry of `spec.env`, including the marker, inside the VM;
  - report truthfully, for example `{ kind: "microvm", tmp: "vm", network: "none" | "netns",
    processes: "vm", display: { kind: "vm" } }`.
- `exec(cmd, args, opts)`: run inside the VM and resolve when the command exits.
- `breach()`: report a cap kill, for example from cgroups or the VM memory limit.
- `destroy()`: never throws, is idempotent, and reports `processesGone` (the VM is gone) and
  `rootRemoved`.

`isolationShortfalls` already accepts the VM values, so a microVM backend passes the strict
requirements unchanged. It may report `hostDirsHidden: true` only if the agent cannot see or
write other trials' roots by any means, unmounting included: that one field decides whether
its trials can be counted. Anything VM-specific (images, snapshots, the Windows guest) belongs
to track U and the VM lock, not to this PR.

## 7. Proposed pre-registered measurement bar (for `docs/product/capability-spec.md`)

`docs/product/capability-spec.md` is a parallel PR and has not landed. This is track L's
proposal for the spec to adopt. Its form follows R2 in `docs/m2-scorecard.md`.

**Claim.** With N isolated desktops, Myco's verified results per wall-clock hour scale with
N. Running in the pool changes no arm's grader-verified outcome, and no trial contaminates
another.

**Arms.** All three run through the same pool, on the same Linux task set (the Calc family;
CSV-only until the xlsx replacement lands), with the same fixtures, model settings,
instruction-text hash, planner and output ceiling:

- `C1` (screenshot only);
- `hcu+shell`;
- Myco (the gate).

**Grader.** The independent grader (`src/benchmark/grade`), which shares no code with the
gate. The gate's verdict is not the outcome measure.

**Design.**

- Paired: every (task, seed) runs once at N = 1 and once at N = 4, for every arm, in
  randomized order.
- 30 pairs per arm, matching R2.
- The host has at least 4 CPUs and the strict isolation requirements. No backend in this PR
  meets them, so the measurement waits for strict `linux-ns` (#551) or track U.

**Endpoints:**

1. **Non-interference (per arm).** Grader success at N = 4 versus N = 1, on the paired table.
   Test: exact two-sided sign test on the discordant pairs, α = 0.05. Pass if it is not
   significant AND the paired difference in success rate is at most 10 percentage points.
   Below 6 discordant pairs the test is labelled underpowered, as in R2.
2. **Scaling (Myco arm).** Grader-verified results per wall-clock hour, N = 4 versus N = 1.
   Report the ratio with a 95% bootstrap CI over batches. Pass if the lower bound is at least
   2.0×.
3. **Contamination (all arms).** Zero `contaminated` or `leaked` disqualifiers across every
   trial. With n trials and 0 events, report the rule-of-three 95% upper bound, 3/n.
4. **Cost.** R7 is the total cost of ALL trials divided by the verified count, per arm and
   per N. A null cost is never 0. Cost is a token-derived ESTIMATE, never billed USD.

**Exclusions.** Only trials with harness-side disqualifiers (`harness-error`, `teardown`,
`isolation`) may be re-run, using the topped-up rule (#511): the faulted attempt is kept and
linked. Every other outcome counts.

Not part of this PR: the runs themselves (they need the integrity fixes first: #518, the
xlsx replacement for #503, the #494 follow-up), the lead's GO, and Claude Ultra. There is no
public leaderboard.

## 8. Files

| File | What |
| --- | --- |
| `src/parallel/backend.ts` | The backend interface, isolation report and requirements, `isolationShortfalls` |
| `src/parallel/linux-backend.ts` | The `linux-plain` desktop, the watchdog, teardown |
| `src/parallel/pool.ts` | `runPool`, the marker scan, `captureRegularFile`, disqualifiers |
| `src/parallel/runid.ts` | Folded run-id claims (in-process and lock files) |
| `src/parallel/caps.ts` | Cap validation |
| `src/parallel/agents.ts` | Scripted agents: the real-Calc actuator and the hermetic file writer |
| `src/parallel/throughput.ts` | The throughput harness and its report |
| `src/parallel/cli.ts`, `scripts/parallel-run.ts` | `pnpm myco-parallel` |

## 9. TO FILE (Linear limit)

- **L strict linux-ns isolation: #551.** Removed from this PR in round 2. Needs
  locked hide mounts (outer user namespace plus a nested one for the agent, or dropped
  capabilities), the holder tied to the harness's lifetime (`--pdeathsig`), and the round-1
  D1 regression tests (`umount` from inside fails; the pool-level forgery is not counted).
