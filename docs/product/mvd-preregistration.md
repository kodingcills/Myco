# MVP Discovery — pre-registration, VM slot request, and wedge status

Status: written **before any run**, 2026-11-21. Owner: MVP Discovery. Supersedes the
sample sizes and decision rules in `mvp-discovery-plan.md` §4–§7 where they differ
(see §1). Companion docs: [mvp-discovery-plan.md](mvp-discovery-plan.md),
[../backlog/mvp-discovery.md](../backlog/mvp-discovery.md),
[../foundry/contract.md](../foundry/contract.md),
[../research/mvp-competitive-teardown.md](../research/mvp-competitive-teardown.md),
[../research/findings/](../research/findings/).

Nothing here was run on a VM. No account was created and no money was spent. Every
number below is either computed in this document, quoted from a cited file, or marked
`[INFERENCE]`.

---

## 1. Correction to the plan: its sample sizes were underpowered

`mvp-discovery-plan.md` §4 declared pass rules over **10 runs** ("0 false successes",
"≥90% verified"). Foundry's contract §7a says a point estimate over so few trials is
not reportable. Computed here (Wilson 95%, two-sided):

| Observed | n | 95% interval | Reading |
|---|---:|---|---|
| 0 false successes | 10 | [0.000, 0.278] | cannot rule out a 27.8% false-success rate |
| 0 false successes | 30 | [0.000, 0.114] | rules out >11.4% |
| 0 false successes | 100 | [0.000, 0.037] | rules out >3.7% |
| 9 verified | 10 | [0.596, 0.982] | "≥90%" is not established |
| 27 verified | 30 | [0.744, 0.965] | matches Foundry §7a |

So the rules in §4 below use Foundry's policy: **≥30 corrupted/refutable trials per arm
for any false-success claim, ~100 normal trials over 3 seeds for any completion-rate
claim**, and anything smaller is reported as a **demonstration, not a rate**. The
10-run developer-experience checks stay, but they only support "it can be done in N
minutes", never a rate.

Paired comparison between arms (same task, same seed, same fault): exact two-sided sign
test on discordant pairs. With all discordant pairs in one direction, p<0.05 needs **at
least 6** discordant pairs (p=0.031 at 6, 0.063 at 5; matches the M1-015 threshold). If
fewer than 6 trials are discordant the report says **underpowered** and makes no
superiority claim.

---

## 2. Task set (Foundry-owned; Discovery does not write fixtures or oracles)

Public bank `src/foundry/tasks/bank.ts` (merged, PR #54):

| taskId | fixtureId | Defect class (per Foundry) | Intent |
|---|---|---|---|
| ef-t01-add-four-items | ef-todo-silent-drop-v1 | silent drop at save | add 4 items incl. `bug:`/`BUG:` prefixed |
| ef-t02-rename-row | ef-todo-stale-row-v1 | stale persisted row | rename `Draft release notes` |
| ef-t03-whitespace-value | ef-todo-wrong-value-v1 | wrong-value normalization | add `Release: review the Q3 metrics` |
| ef-t04-delete-row | ef-todo-partial-write-v1 | partial multi-file write | delete `archive Q1 invoices` |
| ef-t01b-add-four-items-noverify *(merged, PR #75)* | ef-todo-silent-drop-v1 (unchanged) | silent drop at save | same prompt as ef-t01 minus the final sentence |

- `ef-t01`'s prompt ends "Then confirm everything you added is actually persisted."
  That is deliberate and important for the head-to-head: every arm is **asked** to
  verify. The question is whether the arm's own check is reliable, and whether the
  verdict exists when the agent does not check.
- The dogfood DF-S01/DF-S02 remain the 60-second demo narrative (plan §3.2). Foundry
  confirmed the mapping at the defect/oracle level, **not** the prompt level: the silent-drop
  fixture is DF-S02's seeded bug (BUG-prefix, case-insensitive; the listbox shows it, save
  drops it, status says saved N), but DF-S02 is a 'find the seeded bug' investigation prompt
  while ef-t01 is 'add four items then confirm persisted'. Cite as: *ef-t01 (silent-drop
  defect = DF-S02's seeded bug; Foundry-scored)*. DF-S02's own prompt is not a Foundry task.
- Oracles live under `src/foundry/oracles/` (hidden by path). **Discovery must not
  import them**, and a live arm must run with the hidden root absent from its
  environment (contract §6).

---

## 3. Arms and what is actually runnable

From `src/foundry/baseline/registry.ts` on main (after PR #75) plus the Myco arm:

| Arm | Registry | Status / blocker | Needs |
|---|---|---|---|
| screenshot-only (Cua Driver C1 pixel rung) | channel `screenshot-only`, planner `claude-sonnet-5-5` | not-run: needs coordinated VM time | extension slot (§6) |
| hcu (Microsoft Hybrid Computer Use, GUI channel) | `gui`, planner `claude-sonnet-5-5` | not-run: needs coordinated VM time | extension slot (§6) |
| **hcu+shell** (HCU plus the agent's own shell/file access to the store) | `gui+shell`, planner `claude-sonnet-5-5` | not-run: needs coordinated VM time, trusted live evidence ingestion, complete tool-call audits, independently observed save snapshots | the decisive arm (§4.1) |
| myco (verdict from persisted state via the Myco runtime) | **not in the registry** | RT-011/RT-015/RT-016 and a slot | runtime first path |
| orgo | `gui`, planner `unknown` | blocked: account creation and card/credit | outer-loop decision |
| simular-sai | `gui`, planner `unknown` | blocked: Google sign-in, API key, phone verification; hosted cloud computer is not our fixture host | outer-loop decision; even if allowed the environment differs, so no like-for-like |

**Decision eligibility (Foundry `docs/foundry/contract.md`, "Discovery comparison evidence").**
Discovery's public grader output is **descriptive**: every row is ineligible for the
pre-registered decisions. Eligibility needs a grader-owned hidden commitment, distinct
seeded hidden task/fault pairs matched across arms, evidence of the actual delivered
prompt bound to each run, and a trusted ingest that binds planner settings, trace,
recorder closure and effect audits, independent save observations and final persisted
bytes to the same run. That trusted ingest does not exist on main as of PR #75 (`contract.md`: "no trusted ingress"). So the §4.1 rule table
**cannot be applied to any result until it does**; anything earlier is reported as
descriptive and never moves the wedge.

**Planner (decided by the outer loop, 2026-11-21): Claude `claude-sonnet-5-5`, the same
version and settings for every arm.** `trace.jsonl` is a closed schema with no model-id
field, so (per the Foundry owner) the exact model id is recorded in each trial's evidence
bundle and baseline row, and the report rejects mixed planner ids within an arm. If Claude
usage limits interrupt a run, the arm gets status `paused` (reason recorded), **never a
model swap**; a resumed arm must present the same model id or its rows are rejected.
(HCU is a computer layer, not an agent, so a result without its planner named would not be
a result; f2-ef-baseline-arms.md.) The registry already sets `plannerName` to this id for the live arms.

The trace guard (contract §5) applies identically to every arm. Reads of the store are
allowed; writes to persistence files without a GUI act are refuted. Its documented
limits (unrecorded writes; no `save-observed` event means `clean`) apply to the
head-to-head too, so the report must say which trials the guard could not constrain.

---

## 4. Pre-declared hypotheses, measures, and decision rules

### 4.1 Head-to-head (MVD-004 / TIF-59)

**Primary endpoint (one number per arm):** false successes among *refutable* trials,
i.e. trials where the Foundry state oracle says `refuted` but the arm reported
success. Counted by the oracle, never by the arm's transcript. `uncertain` outcomes are
counted separately and never folded into success or failure.

**Secondary:** correct completion rate (oracle `verified`) on normal trials; recovery
after a forced interruption (`verified`/`uncertain`/false success, and whether a
post-recovery verification happened); first-use setup (wall-clock and commands from
a clean checkout to the first oracle-checked result, by a fresh agent reading only
public docs); wall-clock, tokens and cost per trial; repeat after an app edit.

**Design:** the four tasks × fault schedule × ≥3 seeds, same initial state and step
budget across arms, paired by (task, seed, fault). Per Foundry §7a: ≥30 refutable
trials per arm before any false-success claim; ~100 normal trials before any
completion-rate claim.

**Why hcu+shell decides the wedge.** A competent coding agent with HCU and shell access
can read `store.json` and notice a dropped item itself, and `ef-t01` literally asks it
to. If that arm also produces ≈ 0 false successes (defined below) at similar cost and setup, then
"verification exists" is not Myco's product (plan §2).

**Definitions fixed before any data.**

- **"≈ 0 false successes"** means **0 observed in ≥30 refutable trials** (Wilson upper
  bound 11.4%). One observed false success is "not ≈ 0".
- **"Checks every trial"** means a **trace-recorded** read of the persisted store before
  the arm finishes, in ≥95% of refutable trials. If shell calls are not trace-recorded
  this fraction is **unmeasurable** and row 3 cannot be asserted.
- **Refutable trials per arm** are determined by the fixture (the fault fires), not by
  the arm. Pairs are (task, seed, fault); every arm sees the identical pairs.
- **Prompt confound.** `ef-t01` asks the agent to confirm persistence; `ef-t02..t04` do
  not. The head-to-head therefore reports each task and prompt variant separately, and
  the pre-declared **no-verify variant** `ef-t01b-add-four-items-noverify` (the same task with the final
  sentence removed, Foundry-owned) is the discriminating comparison for rows 2 and 3.
  Pooling across prompt variants is not done.

**Superiority needs power.** Any claim that one arm is better than another (row 2 below,
and the §4.5 criterion) additionally requires **≥6 discordant pairs** in its favour
(exact sign test, §1). Fewer than 6 means **underpowered**: no superiority claim either
way, and the rows below say what is reported instead. Rows 1 and 3 are evaluated on
counts and need no pairing.

**Unit of analysis.** Claims are made **per (task, prompt variant)**, never pooled
across variants. The wedge-deciding comparison is `ef-t01b` (no-verify); it needs **≥30
refutable pairs per arm** on that variant, drawn by the grader as **seeded variants of the
silent-drop family from the hidden split** (repeating the one public fixture gives repeats,
not independent samples). Decision-row trials therefore come only from the grader-supplied
hidden source; Discovery sees the commitment root and counts, never the fixtures (and never
reads `src/foundry/oracles/` or the hidden directory). Screenshot-only and hcu evidence counts
toward §4.1 **only if produced on the same grader-supplied hidden pairs**; otherwise the
"identical pairs for every arm" rule cannot be checked and that arm is reported descriptively. `ef-t01` with the verify sentence needs its own ≥30. The ≥30-pair unit is a
**comparison unit, not a reliability claim**: reliability claims still need Foundry §7a's
≥100 known trials over ≥3 seeds, and the report labels the two differently.
`ef-t02..t04` are reported at whatever n they reach, descriptively, with the interval,
and make no rate claim below 30.

**Rule table (evaluated top to bottom; first row that applies wins).**

| # | Condition (≥30 refutable pairs per arm on `ef-t01b`, no-verify) | Consequence for the wedge |
|---|---|---|
| 1 | Myco is not ≈ 0 (≥1 false success) | Myco's own verdict has a hole: fix and re-run before any wedge claim; A is not supported. |
| 2 | Myco ≈ 0, and hcu+shell has **≥6** discordant pairs worse than Myco | The differentiator is the independent verdict without agent discipline; A stands as written. |
| 3 | Myco ≈ 0, hcu+shell ≈ 0 on both prompt variants, "checks every trial" holds, and hcu+shell setup and cost are within 1.5× of Myco's | A's differentiation reduces to the durable artifact and recovery; re-open B-first or reframe A as "CI for GUI" (plan §7). |
| 4 | Myco ≈ 0, hcu+shell has ≥1 false success, but **<6** discordant pairs worse than Myco | Underpowered / inconclusive: add trials; no wedge change. |
| 5 | anything else (e.g. hcu+shell ≈ 0 but not within 1.5×, or shell calls not trace-recorded) | No wedge change; report the table as measured. |

Rows for the `hcu` (GUI-only) and `screenshot-only` arms are reported against Myco the
same way (the power rule above, then the false-success counts), but they do not decide the wedge.

**hcu+shell must run under the Foundry trace guard, which constrains what it can mean.**
The guard sees only what the trace records (contract §5 limit (a)). Therefore:

1. The arm's shell and file calls **must be recorded into `trace.jsonl`**; an arm that
   cannot record them is run as an unmeasured exploratory arm and excluded from rows 2-3.
2. Any recorded `shell-exec`/`write_file` touching a persistence file is refuted by the
   guard, so **a trial where the arm "fixes" the store through the shell counts as
   refuted, not as a success**, even if the resulting file is correct. Foundry's PR #75
   tightened the Discovery guard (contract "Discovery comparison evidence": one ordered
   `tool-call` marker and a complete effect audit per inventory entry; saved-bytes
   reconciliation with an `unreconciled-change` status in `guard.ts`); a run with missing
   audit evidence is not eligible. The repo is authoritative on the exact behaviour; this
   document does not restate it beyond what the contract says.
3. Reads are allowed and counted for the "checks every trial" fraction; an unrecorded
   read is invisible, which is exactly why (1) is required.

The thresholds in this section (≥6 discordant, ≥95%, 1.5×, 0-in-30) are declared here, before any data.

### 4.2 Direction A (MVD-001 / TIF-53)

- Pass: `refuted` with the missing items named from persisted state on the seeded-bug
  task (DF-S02, or `ef-t01`: silent-drop defect = DF-S02's seeded bug, Foundry-scored);
  an agent that claims success on that run is recorded as a false success by the
  oracle; schema-valid `trace.jsonl`+`result.json`; the same flow from OMP and one of
  Codex/Claude Code; the v0 Myco Viewer (PR #69) opens the run's evidence offline and
  shows the verdict, claimed vs persisted. `[INFERENCE]` The Viewer can be demonstrated
  today on Foundry's synthetic fixtures; the A claim needs a real run.
- **Rate claims are not made from 10 runs.** The DX numbers (time-to-first-verified,
  ≤15 min) are reported with n and dispersion as a demonstration; false-success rate
  comes from the head-to-head's ≥30 refutable trials.
- Fail / reopen: setup cannot reach ≤15 min on the development host, or the §4.1 third row.

### 4.3 Direction B (MVD-002 / TIF-54)

- Surface: LibreOffice Calc with the M1 UNO/persisted-file oracle; second surface
  Writer (m2-03: rubric score 23/25, not a trial rate; same UNO read, only the address changes; persisted-file check
  parses `word/document.xml` host-side, `[INFERENCE]` per m2-03). Writer's AutoCorrect
  is its native silent-rewrite hazard (contract §7b). Foundry owns the Writer family;
  Discovery builds none.
- Pass: ≥30 interrupted trials (not 10) for any "0 silent duplicates / 0 silent
  losses" claim (0/30 ⇒ upper bound 11.4%); outcome after recovery is `verified` or
  `uncertain`; persisted record count checked host-side; `uncertain` rate reported
  separately; cost per operation and per retry recorded.
- Kill: Writer or Calc cannot be driven locally without an account → B is documented
  as unproven on this host.

### 4.4 Direction C (MVD-003 / TIF-55)

- Design only: the runtime has no `snapshot()`/`fork()`.
- Reset costs are budgeted at the measured default, **~21 s warm** (not the 8.3 s live
  path, which wedges; m2-05, contract §7a). Orgo's documented fork/clone/suspend
  (fork pauses the source ~2 s; $0.023–$0.368 per running hour) is the incumbent.
- Kill criterion written now: if fork does not beat intent-log replay by **≥X
  attempts-to-verified at equal or lower cost** (X to be fixed with the Runtime owner
  before the run, because it depends on a measured fork cost), C is deferred.
  `[INFERENCE]` Per m2-04, one demonstration cannot identify a loop-bearing procedure,
  so any "reusable procedure" claim needs a verify-before-store gate; none of C's
  proof depends on that and none is asserted here.

### 4.5 Product criterion (MVD-005 / TIF-60), as a protocol

| Slot | Value |
|---|---|
| Who | 3 fresh agents/developers, no Myco-specific setup |
| Environment | plain OMP, Codex, or Claude Code (no Grok Bot, no custom harness) |
| Task set | Foundry `ef-t01..ef-t04` (public), plus one volunteer app only if available |
| Metric | minutes from a clean checkout to an oracle-checked `verified`/`refuted`; false successes |
| Threshold | 3/3 complete; median ≤15 min; **0 false successes where an alternative arm has ≥1** |
| Sample | n=3 is a feasibility test of the experience, not a rate; stated as such |
| "Meaningfully better" | §4.1 row 2 holds at n≥30 refutable trials per arm with ≥6 discordant pairs. **Both** this row and the n=3 row above must hold; the n=3 row alone proves only that the experience is feasible |

---

## 5. What is verified now, and what is not

| Claim | Status | Basis |
|---|---|---|
| None of the products surveyed in m2-01 (§1-§7) returns a persisted-state verdict | **supported (vendor primary docs)** | m2-01 and `mvp-competitive-teardown.md`; a verifier pass on the teardown is in the repo history (commit 974389e), not re-run here |
| Viewer v0 renders verdict, claimed-vs-persisted, evidence offline and degrades damaged evidence to Unknown | **checked by independent reviewer passes recorded in the PR #69 thread (not in the repo)**; not signed off by Tiffany | PR #69 body and `viewer/DEVIATIONS.md` on the PR #69 branch list what was and was not checked |
| Foundry has task bank, state oracles, trace guard, host harness for scripted reference policies | **merged on main** | `src/foundry/` and `docs/foundry/baseline-status.md`; it exercises the grader and gives **no live-desktop measurements** (baseline-status.md) |
| Myco beats an alternative on false successes | **not measured** | needs the slot |
| HCU+shell is as good as Myco | **not measured**; this is the decisive unknown | needs the slot, the trusted ingest (§3) and a live run |
| Setup ≤15 min | **not measured** | needs the slot |
| Orgo/Sai behaviour | **not run** (blocked) | accounts |
| Branching improves verified completion | **not measured**; design only | no runtime fork |

The wedge recommendation therefore stays **provisional**: Direction A, narrowed to
verified GUI tests for coding agents, with Viewer v0 as its human artifact. It is
promoted to a recommendation only if §4.1 row 2 holds (and row 1 is not triggered). The plan's §7 overturn table is
unchanged and now has numbers attached.

---

## 6. VM slot request (to the M1 Coordinator, via the outer loop). A request, pending an explicit GO. Not a start.

No VM, VM script, or stub exercising one runs from Discovery until the Coordinator grants
a slot with an explicit GO (m1-state log 57), the sweep paused or finished and host gates
healthy.

**Agreed queue (m1-state.md, log 57):** (1) M1 sweep v3 → (2) M1 live corrupted suite →
(3) Runtime RT-020, 45 min → (4) Screenshot Baseline Cua C1, **the only C1 run, Foundry
reuses its evidence** → (5) Foundry TIF-58 Microsoft Hybrid Computer Use GUI channel.
Slots 4-5 install into the Windows guest on a **new snapshot**; `clean-base` and
`clean-base-live` are preserved.

**Slot 6: tentatively granted as S0+S1 only (Coordinator's message; not in the repo).** After
slots 1-5, with: an explicit GO; the shared host lock; host gates (memory pressure not critical,
swap free ≥300 MB — AC power is recorded, never a gate); and the preconditions below. S2-S4 are
requested separately after S1.

- **Host lock.** The Coordinator's condition is that S0 takes the shared host lock because
  only one heavy guest may run on this Mac at a time. Today `scripts/vm-lock.sh` (PR #73,
  default `/tmp/myco-win11.vm.lock`) is sourced only by the Windows trial drivers
  (`m1-sweep.sh`, `m1-corrupt-suite.sh`, `reset-trial-vm.sh`); a contender that finds it held
  exits 10. The Linux backend has its own one-session lockfile (`docs/env/linux-runtime.md`).
  So the Linux guest needs a lock integration or a manual hold before S0; that is an open
  item for the Coordinator and Runtime Owner, not something Discovery implements.
- **Snapshots.** A new snapshot is required for any change to the *Windows* guest
  (`clean-base`/`clean-base-live` never modified; 6 GB / 6 vCPU). The S0 guest is a per-run
  overlay and has no snapshot id.

**Slots 4-5 do NOT meet the head-to-head minimums.**

- **Slot 4 (the only Cua C1 run, TIF-19)** (Coordinator): runs the M1 calc-record-edit family
  on exactly the 30 v3 parameter sets, **not** `ef-t01..t04`; normal trials only (no refutable
  pairs by this document's definition); hard spend cap $9.00 total, $4.50 per arm by default
  (also in `m1-state.md`), so coverage may be partial.
- **Slot 5 (Foundry HCU GUI channel)** (Foundry owner; not in the repo): HCU GUI channel only,
  30 normal Calc record-edit trials on the final M1 v3 parameter list in the same order as
  slot 4, same fixture hashes, cold restore and blind judge, planned spend cap **$0** until an
  approved budget exists, paused if the pinned planner cannot run within authorization or hits
  quota. No EF hidden pairs and no `myco-todo` trials.
- Results are joined on v3 trial id and fixture hash, omissions reported, and are
  **descriptive Calc-family references** only. Therefore **the `screenshot-only` and `hcu` arms
  on the EF tasks are not available from slots 4-5 and must be requested as extension slots**,
  with their own GO and an explicit spend decision (no money is spent or assumed here).
  M1 evidence for the 30 v3 trials and the 18-trial corrupted suite is usable as a reference
  arm for the calc family only; pairs across families are never made.

**Guest for S0 (Coordinator and Runtime Owner messages; the repo shows the guest, not the
assignment): the Runtime Owner's Linux guest, not `myco-win11`.** A disposable ARM64 QEMU+HVF
guest (2 vCPU, 2048 MB) on a fresh qcow2 overlay of Ubuntu Server 24.04
`noble-server-cloudimg-arm64.img` (SHA-256
`50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e`,
`docs/env/linux-runtime.md`; verified there). Per the owners, M1's Windows guest runs only
LibreOffice Calc (and Writer where noted) and no Windows port of `myco-todo` is planned.

- **S0 prerequisite (open):** a reproducible `myco-todo` deploy and launch with live
  verification on that guest, plus an uninterrupted RT-011 MCP run through reset. The guest
  currently seeds the runtime smoke app `/opt/myco/myco-tk-app.py`, and the repo shows no
  `myco-todo` deploy there. Per the Runtime Owner/Coordinator (not in the repo), the RT-020
  window (queue slot 3) includes a `myco-todo` deploy check whose result is S0's readiness
  signal. Dates and readiness come from the Runtime Owner.
- **S0 app merged candidate:** `dogfood/apps/myco-todo/myco_todo.py` merged in PR #89 (`1f4619a`), SHA-256
  `c9671a046ecd1cc4c21475d570bbef029e4ee32e2d85c9ff85c720b24f379b57`.
  Headless self-test passed. This candidate fixes Tk startup, adds opt-in ADR-0016
  publication using the traced Tk variable, and retains the seeded persistence bug. Live Linux deployment and GUI verification remain required.
- **Arms runnable on the Linux guest.** `myco` once RT-011, RT-015 (host-side file read) and the `myco-todo` deploy are done. `hcu+shell`
  only if HCU runs on that guest, which is **unverified**: the Cua C1/HCU installs described in
  the repo are on the Windows guest (`m1-state.md`). Until shown, S0/S1 cover the Myco arm
  alone, and a cross-arm S2 needs a stated guest for every arm (otherwise arms differ in
  environment and the comparison is invalid).

**Timing, honestly.** Windows/Calc family (Coordinator, M1 v3; descriptive only): cold
`clean-base` restore ≈ 25 s, agent deploy ≈ 20 s, cold first LibreOffice launch slow and
variable (headless convert 25-140 s, once 169 s; the UNO bridge once missed a 15 s window right
after a 94 s convert); the warm ~21 s figure is only a lower bound. **These do not transfer to
the Linux guest.** For the Linux guest the repo itself is inconsistent: `docs/env/linux-runtime.md`
records reset 19.7 s (RT-006; create 14.0 s, destroy 4.1 s, cold boot to app-up 23 s), while
`docs/coordination/runtime-state.md` records a "3-4 minutes" reset in the RT-011 check. The
uninterrupted RT-011 run settles which holds; `myco-todo` cold start is unmeasured. The stage
table therefore shows **bounds**, using 19.7 s and 240 s per reset, until S1 measures.

| Stage | Purpose | Preconditions | Trials | Reset time, lower-upper bound | Yields |
|---|---|---|---|---|---|
| S0 | smoke: one `ef-t01` trial per ready arm (Myco; others only if runnable on the guest) | RT-011; `myco-todo` deployed and verified on the guest; lock integration; GO | 1 per arm | 20 s - 4 min | setup commands, time-to-first-result; no rates |
| S1 | measure real per-trial wall-clock and cost | S0 | ≥5 per arm | 1.6 - 20 min | the number that sizes S2-S4 |
| S2 | refutable-trial head-to-head (myco, hcu+shell; screenshot-only/hcu via extension slots) | trusted ingest and hidden commitment (§3 eligibility); shell calls trace-recorded; planner fixed (Claude `claude-sonnet-5-5`); one stated guest per arm | ≥30 refutable pairs per arm on `ef-t01b` no-verify (decides rows 1-4) plus ≥30 on `ef-t01` verify variant | 60 trials: 20 min - 4 h per arm | primary endpoint with Wilson interval; sign test |
| S3 | normal-trial head-to-head | S2 | ~100 per arm | 33 min - 6.7 h per arm | completion-rate with CI |
| S4 | Direction B interrupted-write trials | RT-016, RT-015, Foundry Calc/Writer family | ≥30 interrupted | **not bounded here**: Calc/Writer runs on the Windows guest (25 s restore + 20 s deploy + 25-169 s cold-launch variance per trial); sized after S1 | duplicate/loss bound |

The request is for S0+S1 first; S2-S4 are requested after S1 gives real durations.

Hard rules honoured: no kimi-k3; no spending; no account creation; Orgo and Sai not run;
never quit Tiffany's apps; M1 retains host priority.

---

## 7. Asks and status (each blocks a specific number)

1. **Foundry owner:** DONE and merged (PR #75): the `hcu+shell` arm is in the registry
   (not-run), `ef-t01b-add-four-items-noverify` is in `bank.ts` (`DISCOVERY_TODO_TASKS`), and `plannerName` is set. The
   `ef-t01` ≈ DF-S02 mapping is confirmed at the defect level. **Open:** the trusted ingest and
   hidden commitment that make any live result decision-eligible (§3); sizing of any extension
   slot for screenshot-only and hcu on EF tasks.
2. **Planner:** decided: Claude `claude-sonnet-5-5` for all arms; the id is recorded in the
   registry `plannerName` and in each trial's evidence bundle and baseline row (not in
   `trace.jsonl`); an interruption pauses the arm.
3. **Coordinator:** answered. Slot 6 tentatively S0+S1 only after slots 1-5, explicit GO
   (§6). Open: host-lock integration for the Linux guest; whether HCU can run on the Linux
   guest.
4. **Runtime owner:** answered where the guest lives (above). **Open:** RT-011/RT-015/RT-016
   dates; the `myco-todo` deploy and verification on the Linux guest; fix X (§4.4) once a fork
   cost is measured.
5. **Tiffany:** sign-off on Viewer v0 (PR #69) tokens/decisions; an explicit spend decision
   before any extension slot that uses Cua C1 or other paid planner calls; Orgo/Sai/Details
   accounts remain unapproved and unrun.
