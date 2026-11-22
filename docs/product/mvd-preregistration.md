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

- `ef-t01`'s prompt ends "Then confirm everything you added is actually persisted."
  That is deliberate and important for the head-to-head: every arm is **asked** to
  verify. The question is whether the arm's own check is reliable, and whether the
  verdict exists when the agent does not check.
- The dogfood DF-S01/DF-S02 remain the 60-second demo narrative (plan §3.2).
  `[INFERENCE]` ef-t01 is the Foundry-owned scored equivalent of the DF-S02 seeded bug;
  confirm the mapping with the Foundry owner before citing it as the same task.
- Oracles live under `src/foundry/oracles/` (hidden by path). **Discovery must not
  import them**, and a live arm must run with the hidden root absent from its
  environment (contract §6).

---

## 3. Arms and what is actually runnable

From `src/foundry/baseline/registry.ts` (merged) plus the arm this plan adds:

| Arm | Registry status | Blocker | Needs |
|---|---|---|---|
| screenshot-only (Cua Driver C1 pixel rung) | not-run | VM time, named planner | slot (§6), planner |
| hcu (Microsoft Hybrid Computer Use, GUI channel) | not-run | VM time, named planner | slot (§6), planner |
| **hcu+shell** (HCU plus the agent's own read access to the store) | **not in the registry** | none technical | **Foundry must add it** (§4 explains why it is the decisive arm) |
| myco (verdict from persisted state via the Myco runtime) | not in the registry | RT-011/RT-015/RT-016, slot | runtime first path |
| orgo | blocked | account creation and card/credit | outer-loop decision |
| simular-sai | blocked | Google sign-in, API key, phone verification; hosted cloud computer is not our fixture host | outer-loop decision; even if allowed the environment differs, so no like-for-like |

Planner: every arm uses **one** named planner model at identical settings, recorded
per trial. HCU is a computer layer, not an agent (f2-ef-baseline-arms.md), so a result
without the planner named is not a result. Planner choice is an outer-loop decision;
the registry currently says `planner: unknown`.

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
to. If that arm also produces ~0 false successes at similar cost and setup, then
"verification exists" is not Myco's product (plan §2). The rule:

| Outcome (n≥30 refutable trials per arm) | Consequence for the wedge |
|---|---|
| hcu+shell false successes ≥ screenshot-only's, and Myco ≈ 0 | Independent verdict is a real differentiator; A stands as written. |
| hcu+shell ≈ 0 false successes, but its verdict depends on the agent choosing to read the store (measure: fraction of trials where it did, and where it was wrong when it did) | A's differentiator is *the verdict without agent discipline* plus the durable artifact; test with a prompt that does **not** ask for verification (an extra, pre-declared prompt variant) before claiming it. |
| hcu+shell ≈ 0 false successes **and** it checks on every trial regardless of prompt **and** setup/cost within 1.5× of Myco | A's differentiation reduces to the durable artifact and recovery; re-open B-first or reframe A as "CI for GUI" (plan §7). |
| fewer than 6 discordant pairs between any two arms | underpowered; no superiority claim for that pair. |

The "1.5×" and "every trial" thresholds are declared here, before any data.

### 4.2 Direction A (MVD-001 / TIF-53)

- Pass: `refuted` with the missing items named from persisted state on the seeded-bug
  task; an agent that claims success on that run is recorded as a false success by the
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
  Writer (m2-03: 23/25, same UNO read, only the address changes; persisted-file check
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
| "Meaningfully better" | the §4.1 first row holds at n≥30 refutable trials per arm with ≥6 discordant pairs |

---

## 5. What is verified now, and what is not

| Claim | Status | Basis |
|---|---|---|
| None of nine surveyed products returns a persisted-state verdict | **supported (primary docs)** | m2-01 and the competitive teardown, independently verified |
| Viewer v0 renders verdict, claimed-vs-persisted, evidence offline and degrades damaged evidence to Unknown | **verified by an independent reviewer** (not yet signed off by Tiffany) | PR #69 verifier reports |
| Foundry has task bank, state oracles, trace guard, host harness for scripted reference policies | **merged** | PR #54/#70; it exercises the grader and gives **no live-desktop measurements** (baseline-status.md) |
| Myco beats an alternative on false successes | **not measured** | needs the slot |
| HCU+shell is as good as Myco | **not measured**; this is the decisive unknown | needs the slot and Foundry's new arm |
| Setup ≤15 min | **not measured** | needs the slot |
| Orgo/Sai behaviour | **not run** (blocked) | accounts |
| Branching improves verified completion | **not measured**; design only | no runtime fork |

The wedge recommendation therefore stays **provisional**: Direction A, narrowed to
verified GUI tests for coding agents, with Viewer v0 as its human artifact. It is
promoted to a recommendation only if §4.1 row 1 holds. The plan's §7 overturn table is
unchanged and now has numbers attached.

---

## 6. VM slot request (to the M1 Coordinator, via the outer loop). Not a start.

No VM, VM script, or stub exercising one runs from Discovery until the Coordinator
grants a slot with the sweep paused or finished and host gates healthy. Current queue
(Coordinator, 2026-11-21): sweep → corrupted run → Runtime Owner window.

Ordered stages, each independently useful and stoppable. Reset floor is 21 s per
trial (contract §7a); trial wall-clock beyond reset is **unmeasured** and must be
measured in stage S1 before the later stages are scheduled.

| Stage | Purpose | Preconditions | Trials | Reset floor | Yields |
|---|---|---|---|---|---|
| S0 | smoke: one `ef-t01` trial per arm that is ready | RT-011 first path; planner named | 1 per arm | ~21 s each | setup commands, time-to-first-result, harness wiring check; no rates |
| S1 | measure per-trial wall-clock and cost with the real planner | S0 | ≥5 per arm | ~2 min each arm | the number that sizes S2–S4 |
| S2 | head-to-head on refutable trials | Foundry adds hcu+shell; Foundry confirms blind scoring path; planner fixed | ≥30 refutable per arm, 3 seeds | ~10.5 min per arm | primary endpoint with Wilson interval; sign test |
| S3 | head-to-head normal trials | S2 | ~100 per arm | ~35 min per arm | completion-rate with CI |
| S4 | Direction B interrupted-write trials | RT-016 (process control), RT-015 (file read), Foundry Calc/Writer family | ≥30 interrupted | ~10.5 min | duplicate/loss bound |

Reset floors are lower bounds on VM time; real slot length is the S1 measurement times
the trial counts. The request is for S0+S1 first (smallest useful slot); S2–S4 are
requested after S1 gives real durations.

Hard rules honoured: no kimi-k3; no spending; no account creation; Orgo and Sai not run;
never quit Tiffany's apps; M1 retains host priority.

---

## 7. Asks (each blocks a specific number)

1. **Foundry owner:** add the `hcu+shell` arm and a no-verification-prompt variant of
   `ef-t01` to the registry/bank; confirm `ef-t01` ≈ DF-S02 mapping.
2. **Outer loop:** name the planner (one model, fixed settings) for all arms.
3. **Coordinator (via outer loop):** S0+S1 slot after the Runtime Owner window; RT-011
   first path completed beforehand.
4. **Runtime owner:** fix X (§4.4) once a fork cost is measured; RT-015/RT-016 dates.
5. **Tiffany:** sign-off on Viewer v0 (PR #69) tokens/decisions; Orgo/Sai/Details
   accounts remain unapproved and unrun.
