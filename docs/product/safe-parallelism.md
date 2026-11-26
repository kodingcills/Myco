# Safe parallelism: N isolated, disposable desktops with verified results

Capability track L (Tier 2, M2 scope). Linux path first. Code: `src/parallel/`. CLI:
`pnpm myco-parallel`. Tests: `test/parallel/`. CI: the `safe parallelism (ubuntu-latest)` job.

Myco should give desktop agents more capability, not only check them. Track L adds
throughput. One host runs N trials at once. Each trial gets its own fresh desktop, which is
destroyed afterwards. Each trial gets its own verdict vault and gate, and no trial can
contaminate another. Parallelism must never raise a verdict. It can only withhold one: a
trial that breaks any isolation rule is not counted as verified, whatever the gate said.

No model is called anywhere in this track. The agents are scripted, so every run here costs
$0. Measurement runs with a real agent are out of scope for this PR. They need the integrity
fixes in flight and the lead's GO, and they run on Claude Ultra only (§7).

---

## 1. Quick start

```sh
pnpm install --frozen-lockfile
pnpm myco-parallel --probe                       # what isolation this host can give
pnpm myco-parallel --n 1,2,4 --trials 8          # $0, scripted file agent
pnpm myco-parallel --n 1,2,4 --trials 8 --agent calc --display xvfb   # real headless Calc
```

`--agent calc` needs LibreOffice Calc, Python-UNO and Xvfb (`sudo apt-get install -y
--no-install-recommends libreoffice-calc python3-uno xvfb`). On Ubuntu 24.04, unprivileged
user namespaces are restricted by AppArmor. Lift the restriction with
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Otherwise the strict default
refuses every trial (§3).

A real-Calc run on a 4-CPU Linux container (8 trials per level, half of them honest; numbers
from this PR's test run):

```
   N  trials  wall s  trials/h  verified  verified/h  correct  contaminated  peak  speedup
   1       8     4.8    5956.6         4      2978.3        8             0     1       1x
   2       8     2.3   12592.9         4      6296.5        8             0     2    2.11x
   4       8     1.1   25285.3         4     12642.7        8             0     4    4.24x
```

The report is stamped `simulated: true`, `evidence: false`, `costEstimate: null`. Scripted
agents measure the harness: isolation overhead and scaling. They never measure an agent's
capability, so these numbers are not evidence and never enter R7.

Exit codes: 0 means every trial got its expected verdict with no disqualifier. 1 means a
mismatch, a contamination, a refused pool or an unavailable backend. 3 means a usage error.

## 2. What one trial does

`runPool` (`src/parallel/pool.ts`) runs these steps for every trial. Each step fails closed.

1. **Claim the run id by its case-folded form.** `Run-A` and `run-a` are the same trial on a
   case-insensitive filesystem. A batch with both is refused before anything starts. Two
   pools that share a lock dir refuse each other's folded-equal ids while either holds one
   (`open(…, "wx")` on a lock named by the folded id's sha256). A stale lock is a refusal
   too: an operator removes it by hand.
2. **Create a fresh desktop** in an empty private root under `<run>/trials/<runId>`. The dir
   must not exist yet, so a root is never reused.
3. **Check isolation.** The pool compares the desktop's `IsolationReport` with the operator's
   requirements. A shortfall destroys the desktop before anything is sealed.
4. **Plant the trial's marker.** This is a random nonce known only to the harness and this
   trial. It goes in `workspace/.myco-trial-marker` and `$MYCO_TRIAL_MARKER`. The task's
   fixture is laid down next to it.
5. **Run the existing gated path, unchanged** (`runGatedTrial`): launch audit, then seal into
   a vault for this trial only. The vault has its own root under `<run>/vaults/<runId>`, a
   fresh key, and the desktop's root as its agent root. The gate is bound to
   `{ runId, receipt }`. Then the agent runs, stops, its output is captured, and the gate
   decides from the sealed capture. The agent still sends only taskId, runId and claim
   (`myco.gate/v1`). Track L adds no gate input.
6. **Capture without following links.** The saved file is read for the vault only if it is
   a regular file with exactly one link, inside the workspace the harness resolved before
   the agent ran. A symlink or hard link to another trial's saved file, or to a host file
   with the right content, is `capture-refused`, and the trial has no verdict.
7. **Scan, then destroy.** The pool scans the desktop's tree for every other trial's marker,
   then destroys the desktop. It then checks the destroy report: no process left and the
   root removed.
8. **Write evidence** to `<run>/evidence/<runId>/`: `record.json` and `agent-output.txt`.

After all trials finish, the pool scans each trial's evidence root, its vault dir and its
gate records (the agent-seen result, the final result and the claim) for the other trials'
markers.

A trial counts as verified (`countedVerified`) only when the gate's verdict is `verified`
and none of these disqualifiers applies:

| Disqualifier | Meaning |
| --- | --- |
| `run-id` | The folded run id was already claimed, or the id is malformed |
| `isolation` | The desktop's isolation report falls short of the requirements |
| `contaminated` | Another trial's marker was found in this trial's workspace, evidence, vault or gate records |
| `leaked` | This trial's marker was found in another trial |
| `own-marker-missing` | This trial's own marker was gone at scan time, so the scan proves nothing |
| `scan-incomplete` | A tree was too large (over 64 MiB) or unreadable |
| `teardown` | A process survived destroy, or the root was not removed |
| `resource-cap` | The watchdog killed the desktop for exceeding memory or CPU time |
| `timeout` | The trial ran past its wall-clock cap |
| `capture-refused` | The saved file was a link, or was outside the workspace |
| `agent-error`, `harness-error` | The agent or the setup threw |

## 3. The Linux backend and its two modes

`linuxBackend()` (`src/parallel/linux-backend.ts`) probes the host and picks a mode. Every
desktop records the mode it actually got.

| | `linux-ns` (user namespaces available) | `linux-plain` (fallback) |
| --- | --- | --- |
| Root | private, under the run root | private, under the run root |
| Other trials, vaults, evidence, locks | hidden: a tmpfs over the run root, then the trial's own root bound back | visible |
| `/tmp` | a private tmpfs | shared (only `TMPDIR` points into the root) |
| Network | its own network namespace with loopback only (abstract unix sockets are per namespace too) | shared |
| Processes | a pid namespace: SIGKILL to its init kills all of them, including `setsid` children | one process group per exec (a `setsid` child escapes) |
| Display | Xvfb `:99`, private to the namespace, so every trial can use `:99` | Xvfb on a display it picks (`-displayfd`) |
| Env | allowlist only: `PATH`, `LANG`, plus the desktop's own `HOME`, `TMPDIR`, `XDG_*`, `DISPLAY` and the marker | same |
| Memory and CPU caps | a /proc watchdog on all the namespace's processes | a /proc watchdog on the exec'd process groups |

The default requirements are strict: an own network, a private `/tmp`, and hidden host dirs.
Under them, `linux-plain` is refused trial by trial with `isolation`.
`--allow-weak-isolation` lowers all three to best-effort. The report still records what
each trial got. A private root and processes that die with the desktop are always required.

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
| Read or write trial B's workspace | `linux-ns`: B's root does not exist inside A's mount namespace | `linux-backend.test.ts` "hides other trials' roots", and the pool cross-write test |
| Get verified on B's work | B has its own vault (own key and receipt); A's gate is bound to A's run id; capture refuses links | `pool.test.ts` capture tests; `test/gate/sealed-gate.test.ts` (unchanged) |
| Leak something into B that changes B's outcome | Markers are scanned in workspace, evidence, vault and gate records; a hit disqualifies both trials | `pool.test.ts` contamination tests; the `linux-plain` positive control |
| Talk to B over the network or a socket | A network namespace with loopback only; Xvfb is private to the namespace | "has loopback only"; "runs a private Xvfb per trial" |
| Leave a process behind to affect a later trial | pid-namespace teardown, checked after destroy | "destroy kills every process" |
| Read the operator's secrets | Env allowlist; `--hide $HOME` puts a tmpfs over the operator's home | "passes no host env var"; "an operator --hide dir" |
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

- **Same uid.** Inside `linux-ns` the agent is "root" in its own user namespace, mapped to
  the operator's uid. It can read any host file that is neither hidden nor protected by
  permissions. This matches the existing trust model for Claude Code on the host. Use
  `--hide` for sensitive dirs. Use a microVM (track U) for agents you do not trust.
- **`linux-plain` is weak** (shared network, shared `/tmp`, visible roots, `setsid`
  escapes). That is why the strict default refuses it.
- **Scan timing.** A trial's workspace is scanned just before its own destroy. A write that
  lands in a finished trial's tree after its scan is not seen. Under `linux-ns` such a write
  cannot happen, because the tree is not visible. Under `linux-plain`, the evidence-root and
  vault scans after all trials still cover what the gate read.
- **The namespaced `/tmp` is not scanned.** It is private to the trial and dies with it, so
  it cannot reach another trial.

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
requirements unchanged. Anything VM-specific (images, snapshots, the Windows guest) belongs
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
- The host has at least 4 CPUs and the strict isolation requirements.

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
| `src/parallel/linux-backend.ts` | `linux-ns` and `linux-plain` desktops, the watchdog, teardown |
| `src/parallel/pool.ts` | `runPool`, the marker scan, `captureRegularFile`, disqualifiers |
| `src/parallel/runid.ts` | Folded run-id claims (in-process and lock files) |
| `src/parallel/caps.ts` | Cap validation |
| `src/parallel/agents.ts` | Scripted agents: the real-Calc actuator and the hermetic file writer |
| `src/parallel/throughput.ts` | The throughput harness and its report |
| `src/parallel/cli.ts`, `scripts/parallel-run.ts` | `pnpm myco-parallel` |
