# Finding M2-04 — Learning a desktop procedure from one demonstration and replaying it reliably

> **Status: research input, not a product decision.**
> The earlier "M2 = MCP/API" direction is **retracted** pending MVP Discovery
> (Linear P-TIF-5). This finding feeds Discovery's choice between
> **A** (verified desktops for coding agents), **B** (verified ops for software
> without APIs), and **C** (branchable desktops). Where this doc recommends a
> surface or a build, read it as *one option's requirements*, not as the decided
> wedge. Task-design implications route to the Evaluation Foundry (P-TIF-6).

Date: 2026-11-21. Branch: `myco/m2-research`. Level: L2 (primary sources read; each claim traced to the section that owns it).

## Question

Given **one** successful desktop run, what is the state of the art in (a) compiling it into a
reusable procedure, (b) replaying it reliably, and (c) **verifying** the replay — and what does
Myco already get for free from ADR-0004 (programs as data, per-step pre/postconditions) and
ADR-0006 (known-good `stateVersion`, recovery ladder), versus what it still needs for vision
step 4, "compile a successful run into a reusable, self-healing procedure"?

## Evidence

### 1. Classic RPA recorders and selector fragility

| Source | Claim (verbatim substance) | Limitation / what it does *not* say |
|---|---|---|
| UiPath, *About Selectors* (§intro) — `docs.uipath.com/activities/other/latest/ui-automation/about-selectors` | Selectors are "an XML fragment" of the element **and all its parents**; they are auto-generated "especially if the apps … have a static user interface"; "some software programs have changing layouts and attribute nodes with volatile values, such as some web-apps. Studio **cannot predict these changes** and, therefore, you might have to manually generate some selectors." | States the failure mode; publishes **no** breakage rate. "Cannot predict" is a design admission, not a measurement. |
| UiPath, same §Supported Tags | Per-attribute capability matrix: `idx`, `pid`, `tid`, `tableRow`, `tableCol`, `sapScreen`, `sapSession` are **not** fuzzy/regex-capable; fuzzy + regex + case-sensitivity are opt-in per attribute. | Fixes *what can be fuzzed*, not *when fuzzing saves a bot*. |
| UiPath, same §Selection Options | Selector **Validate** has three states (valid / invalid / modified-revalidate). **Repair** "does not completely replace the previous selector" and "is available only when the selector is invalid." | Repair is a **human, in-Studio, per-selector** action. There is no runtime self-heal and no stored postcondition. |
| Power Automate desktop, *Record desktop flows* §"Recording vs building" | "Certain types of actions, like conditionals and loops, **can't be recorded**"; "there might be redundant actions in a recording that should be removed"; "most recorded tasks should be modified." | The recorder produces a draft, not a verified procedure. |
| Power Automate, *Automate using UI elements* §UI elements properties | "Users can create multiple selectors for a UI element. **Whenever a selector fails, Power Automate uses the following selector in the defined order.**" Text-based selectors (Name/Text attr) "are more reliable and resilient to possible future changes" — but are **unavailable during recording**. | A **static fallback chain** decided at authoring time. Nothing checks whether the element the fallback matched is the *right* element. |
| Power Automate, *Record desktop flows* §Image-based recording | When an app exposes no accessibility API, the recorder falls back to image recognition + OCR, with a manual "anchor area that isn't expected to change". Known issue: "the click might be sent to the wrong place … decrease the tolerance parameter". | One published **silent-wrong-target** failure mode with a human-tuned workaround. |

**Synthesis.** Classic RPA replay is *open-loop*: the stored artifact is a selector, replay asserts only
"a node matched", and every repair path is a human in an IDE. Nothing in either vendor's documentation
describes a **postcondition** on the state the step was supposed to produce. This is precisely the gap
ADR-0004 closes.

### 2. Agent skill / workflow induction, 2024–2026 (arXiv ids and titles verified via arXiv API)

| arXiv | Verified title | Representation | Learned from | Verified at induction? | Verified at replay? |
|---|---|---|---|---|---|
| 2305.16291 | *Voyager: An Open-Ended Embodied Agent with Large Language Models* | executable **code skills** in a growing library | self-exploration + self-verification (LLM critique) | self-verification is an **LLM judgement**, not an environment check | no — skills are invoked *through* the agent loop |
| 2409.07429 | *Agent Workflow Memory* | **free-form text** workflows in memory | successful episodes filtered by an LLM evaluator | no (text) | no |
| 2504.06821 | *Inducing Programmatic Skills for Agentic Tasks* (ASI) | **Python programs** added to the *action space* | LLM-judged correct episodes | yes — three checks: task solved (LLM judge), skill used, "all skill-calling actions cause environment changes" | partial — replay is an ordinary agent run that may or may not call the skill; ASI notes agents "may not always use new skills" |
| 2504.07079 | *SkillWeaver: Web Agents can Self-Improve by Discovering and Honing Skills* | reusable **APIs** | autonomous discovery + practice | practice-based | no independent evaluator described |
| 2605.15215 | *SkillSmith: Compiling Agent Skills into Boundary-Guided Runtime Interfaces* | skills compiled offline into **minimal executable interfaces** | existing skill packages (not a trace) | no | no; a token/latency optimisation |
| 2602.20502 | *ActionEngine: From Reactive to Programmatic Web Agents via State Machine Memory* | **app-level state machine** (states + operations + transitions) built by an offline **Crawling Agent** | **crawling the application**, not a demonstration | memory repaired on failure | reactive fallback "repairs the failed action and updates the memory" |
| 2505.17716 | *Get Experience from Practice: LLM Agents with Record & Replay* (AgentRR) | multi-level "experience" + a **check function** as "a trust anchor to ensure completeness and safety during replay" | recorded agent trace | check function | yes (check function) — abstract; paper is a position/analysis, not a measured system |
| 2606.17929 | *PreAct: Computer-Using Agents that GetFaster on Repeated Tasks* | **state-machine program**: states carry screen predicates, transitions carry actions; trace values lifted to **parameters** | **one successful run** | yes — verify-before-store gate | yes — predicate checked **before each** action |
| 2609.36927 | *Neuro-Symbolic Computer Use: Learning Reusable Policies for Reliable and Efficient Execution* | **neuro-symbolic policy**: code fixes control flow; grounding and state checks delegated to neural primitives | **one agent trajectory** (need not be successful), then NSPI iteration | judged by a **VLM judge pair** (task-completion + step-level localizer) | yes — a VLM **pre-action verifier** gates each state-mutating primitive |
| 2605.21082 | *AutoRPA: Efficient GUI Automation through LLM-Driven Code Synthesis from Interactions* | synthesized **RPA functions** in code | RAG over **multiple** trajectories | "hybrid repair strategy during code verification … combining RPA execution with ReAct-based fallback" | not stated |
| 2610.02932 | *When to Compile a Computer-Use Agent? Measuring Payback and Making Compilation Decisions for Token Efficiency* (PACE) | compiled programs (AutoRPA-style) | k=3 completed agent traces | "run the generated program on its source tasks and check whether it completes them" | measured failure fraction `q` per program (§3.1) |
| 2608.20319 | *Inducing Task Models from Computer-Use Traces* (TMI) | hierarchical **objective model** + **procedure model** (sequence / for-each / while) | an unconstrained, interleaved **trace** | "formal validity constraints" on structure (Appendix A) — structure only, not behaviour | no replay; skills are *derived* and evaluated downstream |

**Claims vs limitations — the load-bearing ones.**

- **PreAct (2606.17929) is the closest existing system to M2 step 4.** Two commitments, both quoted:
  (i) "*at each step PreAct checks that the screen matches what the program expects before acting, and
  hands control back to the agent the moment something is off*"; (ii) "*a freshly compiled program enters
  the store only if, re-run from a clean state, an independent evaluator confirms it solved the task*".
  Numbers (all measured, not asserted): warm replays **8.5–13×** faster wall-clock, no per-step model
  calls; the store gate is worth **1.75–2.6 tasks per benchmark** (gate ON vs OFF: Android
  `+1.2±0.45` vs `−1.4±0.89`; OSWorld `+0.2±0.45` vs `−2.4±0.55`; WebArena `−4.0±2.94` vs
  `−5.75±1.71`); one-time compile+verify premium **+162 %** wall time on Android, **+217 %** on OSWorld.
  Limitation it states itself: the gate "verifies by *re-running* the program … it presumes a resettable
  or otherwise idempotent task; tasks with irreversible side effects (sending a message, charging a card)
  would need a side-effect-free verification path instead" (§3.3, limitation L6).
- **NSPI (2609.36927) is the strongest *verification* of a compiled policy, and the least Myco-shaped.**
  Its verification is a **VLM**, not a typed postcondition: `J_task` "is not a ground-truth oracle, because
  its verdict is only as good as the probes it chooses to run"; an abstention "counts as a failure"; and
  the deployed guard is a **calibrated VLM classifier** on `p_no` with a threshold set on a calibration
  set. It also starts from *any* trajectory (failed seeds recover: 62/356 Pass^3), and its
  variant-generation loop (parameter + initial-state variants) is the only published recipe for turning a
  single-run policy into a *reusable* one. Pass^1→Pass^3 degradation: **3.4 points for NSPI vs 12.4 for the
  base agent** (avg. of four settings).
- **AutoRPA (2605.21082) requires *multiple* trajectories** (RAG over several) — it is not a one-demonstration
  method, and its reported win is token reduction **82–96 %**, not reliability.
- **ASI (2504.06821) is the strongest evidence that programs beat text for skills**: +11.3 % success over the
  text-skill counterpart (AWM), attributed to programmatic verification at induction; and its ablation
  `unverified,text 32.6 → verified,program 36.4 → verified,text 39.0 → add-as-actions 40.1` SR on the
  shopping site separates *induction verification* from *representation*.
- **Voyager-style skill libraries are the wrong shape for desktop.** Voyager's self-verification is an LLM
  critique of code in a simulated Minecraft environment with a deterministic executor; it has no UI, no
  state predicates, and no drift surface. PreAct's Table 1 classifies this whole family as
  "LLM-bound (skill called by agent)" — reuse re-pays the per-step model cost, which is the cost M2 is
  trying to remove.

### 3. Workflow / state-machine induction from demonstrations — what guarantees actually exist

| Source | Object learned | Guarantee |
|---|---|---|
| 2606.17929 PreAct | state machine `<S,T,M,V>` | **No formal guarantee.** §3.2: corpus "grows monotonically *in expectation*"; "a stored program can still fail on a later parameter binding — so this is an expectation, not a guarantee." |
| 2608.20319 TMI | objective + procedure model under "formal validity constraints" | **Structural** validity only (node/operator consistency, reconciliation of objective vs control flow). Not behavioural. Reconstructs **74.9 %** of observed execution steps (vs 30.3 % for the strongest workflow-induction baseline); operator correctness **88.5 %** vs 52.7 %. It explicitly notes selection is "usually latent, since the trace shows the strategy the user enacted rather than the unchosen alternatives" — hence only `sequence`, `for-each`, `while` are induced. |
| 2609.36927 NSPI | neuro-symbolic program | No guarantee; empirical Pass^k improvement only. |
| 2602.20502 ActionEngine | app-level state machine | Repaired by a reactive fallback on failure; no formal guarantee. |
| 2511.08431 *Learning DFAs from Positive Examples Only via Word Counting* | minimal DFA from **positive-only** traces | **The theoretical ceiling.** Passive DFA learning with positive *and* negative examples is **NP-complete since the 1970s**; the paper proves that even computing *the minimal number of words* up to a length accepted by a given-size DFA that accepts all positives is **NP-complete**. One demonstration is the positive-only, single-word case. |
| 2402.07051 *L\*LM: Learning Automata from Examples using Natural Language Oracles* | DFA from demonstrations + NL membership queries | Demonstrations alone "are generally **not sample efficient**"; L*LM recovers efficiency only by asking an **LLM oracle** membership queries — i.e. by importing negative examples from a model's prior. |
| 2408.02999 *LLMs as Probabilistic Minimally Adequate Teachers for DFA Learning* | DFA under a noisy (`pMAT`) oracle | Handles hallucinating oracles with a query cache refinement; the *oracle* is the LLM, so correctness inherits LLM error. |

**What this means for "one demonstration".** The identifiability result is decisive: a single positive trace
constrains exactly one path through the app's state space. Any procedure consistent with that path is
equally supported by the evidence. Therefore **any procedure compiled from one demonstration is a hypothesis,
and only execution against a real postcondition can promote it to a belief.** This is an argument for
Myco's design, not against it: ADR-0004's per-step postconditions are the *negative examples* that a
one-shot induction otherwise lacks.

### 4. How is the replay verified in each approach?

| Approach | Verification signal | Postcondition or "re-run and hope"? |
|---|---|---|
| UiPath / Power Automate | selector matched / activity returned | **Neither.** Element-match only; no end-state claim. |
| AgentRR (2505.17716) | abstract "check function" | Postcondition in intent; unmeasured. |
| ASI (2504.06821) | LLM episode judge + "skill-calling actions cause environment changes" + **rewritten trajectory prefix with trailing actions truncated** to avoid "spurious successes in skill verification" | partial postcondition; the truncation trick is the notable design detail |
| PreAct (2606.17929) | per-state screen predicate **before** each action; double gate at store time = `replay.reported_success ∧ evaluator_score ≥ 1.0` | **Yes** — and explicitly two-channel, because each half alone lets a failure through |
| NSPI (2609.36927) | `J_task` (read-only probes of end state) ∧ `J_loc` (step-level localiser); abstention = failure | Yes, but **VLM-judged**, so "only as good as the probes it chooses to run" |
| ActionEngine (2602.20502) | reactive fallback on failure | no independent end-state check |
| Myco M1 (ADR-0002, ADR-0007) | UNO live readback **and** host-side parse of the persisted `.xlsx`, three-valued verdict | **Yes** — typed, two independent channels, `verified\|refuted\|uncertain` |

**The one novel verification insight in the literature that Myco lacks** is PreAct's *double gate* and its
named failure mode: the "**lossy replay**", `cov == 100 % / score == 0` — a program that "executes every
action to completion … yet the end state does not satisfy the evaluator: the contact form was filled and
'Save' was tapped, but a stale field meant no contact was written" (§3.3). Myco's per-step postconditions
would catch most of these, but M1 has no *admission* gate at all — nothing decides whether a run's program
is allowed into a registry.

### 5. Drift: what published work measures procedure breakage when the app updates

| Source | Measurement | Number |
|---|---|---|
| 2610.02932 PACE, Appendix A.7 "Program failures under GUI changes" | Verified programs re-run **without model calls** under 9 GUI changes (font scale 1.3 / 0.85, density 0.85, French locale, dark theme; notification, low battery, permission dialog, update prompt). Failure fraction among bindings that passed clean. | **Appearance changes**: 0 / 0 / **0.100** (GLM / DeepSeek / Qwen). **Interruptions**: **0.842 / 1.000 / 0.833**. Worst case near-total failure. |
| PACE, same appendix — the crucial corollary | "Across all test failures, including failures in the clean condition, **detectable execution errors account for about 58, 87, and 71 percent** … The remaining failures reach an incorrect task state **without an execution error**, which limits error-triggered fallback … the detected-failure assumption of the cost model … does not always hold." | **29–42 % of drift failures are silent.** This is the strongest published argument for postcondition-based replay verification over exception-based. |
| 2511.20766 *OpenApps: Simulating Environment Variations to Measure UI-Agent Reliability* | >10,000 evaluations, 7 multimodal agents, 6 configurable apps | "Task success rates for many agents can fluctuate by **more than 50 %** across app variations. For example, Kimi-VL-3B's average success … fluctuates from **63 % to just 4 %**." |
| 2405.03710 *Automating the Enterprise with Foundation Models* (ECLAIR) | Case studies of two enterprises on RPA | "high set-up costs (**12–18 months**), unreliable execution (**60 % initial accuracy**), and burdensome maintenance (**requiring multiple FTEs**)". |
| 2611.03853 *Performance, Scalability and Maintenance: An Experimental Study of RPA vs. Autonomous Agents in the Healthcare Domain* | Playwright RPA vs browser-use APA, two rounds (T, T+7) on a **stable** interface | RPA 98.90 % accuracy / 98.27 % F1, 16.07 s and USD 0.030 per report; APA 96.49 % / 94.48 %, 207.21 s, USD 0.187. "APA varied more over time." **This measures a stable interface, so it does not measure drift** — it measures the price of choosing the adaptive path when drift is absent. |
| 2609.36927 NSPI §3.2.2 | Drift response: a blocked pre-action verifier "may choose among handing the task to a stateful agent to continue, running NSPI, or escalating to a human" | no breakage rate published |
| 2606.17929 PreAct §4.3 | Per-step predicate failure → hand back to agent, recompile, replace by dedup signature | no breakage rate published; OOD section states programs "do not transfer across task families" |

**Not found.** No published study measures Myco's actual drift surface: *procedure breakage as a function of
app version number for a desktop office suite*. The nearest quantitative anchors are PACE's synthetic
configuration-change matrix (mobile) and OpenApps (purpose-built mock apps). Both are `[INFERENCE]`-only
transferable to LibreOffice Calc. Treat "compiled workflows drift as apps update" (vision §Tradeoffs) as
**unquantified**.

## Decision

**Adopt three things; investigate one; reject one.**

**Adopt 1 — PreAct's two-timescale discipline, because Myco has both halves already and is missing only the seal.**
- *Per-step check before acting* = ADR-0004 `preconditions`, evaluated by `runner.ts` before `adapter.act()`. Already built.
- *Store-time gate* = **not built, and the single highest-value addition to M2.** Myco must never admit a
  program compiled from a trial into the registry without re-running it from a clean fixture and requiring
  `verdict == verified` from the *independent* verifier (ADR-0002), exactly as PreAct requires
  `replay.reported_success ∧ score ≥ 1.0`. Myco is better placed than PreAct here: PreAct's evaluator is
  the benchmark's own script, which Myco does not have in production — but Myco's postconditions *are* the
  evaluator, and ADR-0002's two-channel verifier is strictly stronger than PreAct's single evaluator.
- Reject PreAct's re-run-the-program gate verbatim: §3.3 states it "performs the task's actions a second
  time", which Myco cannot do after `save` (ADR-0006 already refuses relaunch-and-retry once the save has
  been dispatched — `recovery.ts` `relaunch:skipped-not-reversible`). Myco's admission gate must re-run on
  a **fresh fixture instance**, never on the trial's own document.

**Adopt 2 — ASI's induction-verification ablation as the reason programs-as-data beats text skills.**
`unverified,text 32.6 → verified,program 36.4` SR. Programs are the right representation *because they are
executable, hence verifiable* — this is ADR-0004's justification with a measurement attached, and it
directly supports the "reusable procedures" deliverable. Do not adopt ASI's skill-in-action-space design:
its own paper reports agents "may not always use new skills", and its Pass^3 (26.0–31.9) is *worse* than
the base agent's on three of four NSPI settings.

**Adopt 3 — TMI's `for-each` / `while` induction is out of scope for M2, and its negative finding is worth
recording.** A single demonstration admits at most `sequence`: `for-each` requires "at least two aligned
occurrences of the same activity pattern" and `while` requires repetition "until a condition on the
objective state is satisfied". **A one-shot compiler cannot infer loops; it can only infer a
straight-line guarded program.** M2 should therefore compile straight-line procedures and derive
loops/parameters from the *task family* (which M1's parameterised `calc-record-edit` already has via
`fixtureSeed` / `CalcRecordEditParams`), not from a single trace.

**Investigate experimentally — the store-time gate's marginal value on Myco's own trials.** PreAct's gate is
worth 1.75–2.6 tasks; the equivalent measurement for Myco is: compile the M1-013/M1-014 successful trials
into programs, re-run each from a clean fixture, and count `verified | refuted | uncertain`. If any
`refuted` appears, Myco has a lossy-replay problem and the gate is mandatory, empirically. If the
false-admission rate is 0/N, the gate is still mandatory (PreAct's argument) but its cost (+162 % / +217 %
wall time) should be measured before shipping.

**Reject — sourcing "self-healing" from an LLM judge, and sourcing verification from VLM probes.**
NSPI's `J_task` is not a ground-truth oracle by its own admission and an abstention counts as failure; a
VLM pre-action verifier with a calibration threshold is a reasonable guard, but it is strictly weaker than
a typed predicate over an object model. M2 must not replace ADR-0002's verifier with a VLM to gain
generality. Use the VLM *only* where Myco has no typed adapter (the perceived-structure gap vision §1
already names).

### Myco: free vs still needed

| Capability | Status | Basis |
|---|---|---|
| Executable, diffable, inspectable procedure representation | **Free** | ADR-0004 (`src/core/program.ts`, `ProgramStep`) |
| Per-step preconditions evaluated before acting (PreAct's observe-then-act) | **Free** | `runner.ts` evaluates `step.preconditions` before `adapter.act()` |
| Per-step postconditions evaluated after acting | **Free** | `runner.ts` → `postconditionResults`, and the known-good point advances only when all hold |
| Three-valued verdict, two independent channels, no `eval()` | **Free** | ADR-0002, ADR-0007 |
| Known-good `stateVersion` + recovery ladder (re-observe → retry → relaunch) | **Free** | ADR-0006, `src/core/recovery.ts` |
| Machine-readable trace of *why* each guard passed/failed (`observed` string) | **Free** — and **stronger than any paper surveyed**: none of PreAct, NSPI, ASI, TMI publishes a per-step observed-value trace as a first-class artifact | `PredicateResult.observed`, evidence-schema §PredicateResult |
| Never-false-success discipline as a contract | **Free** — ADR-0006 "recovery never reports success without a post-recovery verification pass" | `recovery.ts` header comment |
| **Store-time admission gate** (compile → re-run clean → require `verified` → then store) | **Missing** | no registry exists; no code path re-runs a program before persistence |
| **Parameter lifting** (trace-specific values → procedure parameters) | **Missing** — M1's program is *built from* `CalcRecordEditParams` (`programFor(adapter, params)`), never *compiled from* a trace | `src/tasks/calc-record-edit.ts` |
| **Trace → program compiler** (`StepRecord[]` → `ProgramStep[]` with predicates synthesised from `stateVersionBefore/After`) | **Missing** | program construction is hand-written per task |
| **Program registry / library with dedup identity** | **Missing** | PreAct's `dedup_signature` (task family + app context + parameter schema) is the shape to borrow |
| **Drift detector** — per-step `observed` mismatch when a postcondition fails *without* an action error (PACE's 29–42 % silent class) | **Missing**, but nearly free: `GuardFailure{phase:"postcondition"}` already exists and distinguishes this case from a dispatch error (`act:*` predicate name) | `program.ts` `GuardFailure` |
| Selector resilience beyond typed refs | **Free at the ref layer** (`StaleRefError`, `issuedRef` bound to `stateVersion`), **missing at the adapter layer** for apps where the UIA/UNO path degrades | `src/core/adapter.ts` |

**The gap in one sentence.** Myco already has the *runtime* half of PreAct (per-step preconditions) and a
*stronger verifier* than any surveyed system; it lacks the *compile-time* half — lifting a trace into a
parameterised program, and the verify-before-store gate that decides what is worth keeping. Vision step 4
is therefore **~2 components, not a research programme**.

## Proposed smallest experiment

**M2-04-E1: compile-then-gate on M1's existing trials (no new VM work).**

1. Take the successful trials already recorded in `docs/research/experiments/m1-013-session1/` (and
   M1-014 when it lands). For each, read `result.json` → `steps[]` (`action`, `stateVersionBefore`,
   `stateVersionAfter`, `preconditionResults`, `postconditionResults`).
2. Write a *pure function* `compileTrace(steps, params) → ProgramStep[]` offline (throwaway script; it is
   the experiment, not a deliverable): actions verbatim, preconditions = the observed postconditions of
   step *i−1*, postconditions = the recorded results of step *i*, parameters lifted from
   `taskParams` where the value appears in `setValue`.
3. Replay the compiled program **against a fresh fixture** with the existing `runner.ts` and the existing
   UNO + file-parse verifier. Count `verified / refuted / uncertain`.
4. Report: (a) admission rate; (b) any `refuted` (a lossy replay — the finding that would make the gate
   mandatory by demonstration); (c) wall-clock cost of the gate, to compare with PreAct's +162 %/+217 %.

**Pass condition:** ≥ 27/30 compiled programs re-verify `verified` on a fresh fixture, and **0** false
`verified`. **Cost:** one VM session, no model calls — the compiler is a pure function and the verifier is
already built. This is cheaper than any paper's evaluation because Myco already records the trace.

**Explicitly *not* in E1:** loop induction (TMI shows one trace cannot support it), VLM step judging (NSPI),
and any LLM in the replay loop (PreAct shows none is needed for warm replays).

## Next action

1. Write M2-04-E1 as a backlog item under the M2/procedure heading, blocked on nothing (M1-013 evidence
   already exists), sized S.
2. Open an ADR stub — **ADR-0017 "Procedure admission gate"** (0017 because ADR-0011..0016 are already taken in docs/architecture/runtime.md) — recording the decision above: a compiled
   program enters the registry **only** after re-running from a clean fixture and returning `verified` from
   the independent verifier; `uncertain` never admits; the gate never re-runs against the trial's own
   document when a save has been dispatched (ADR-0006 `relaunch:skipped-not-reversible`).
3. Record the drift measurement gap into `docs/product/vision.md` §Tradeoffs: "compiled workflows drift as
   apps update" is currently **unquantified for desktop apps**; the only numbers are PACE A.7 (mobile
   configuration changes) and OpenApps (mock apps).

## Reopen-if

- M2-04-E1 produces **≥ 1 `refuted`** on a clean-fixture re-run → the lossy-replay class is real for Calc,
  and the admission gate becomes a hard requirement with a measured cost, not a borrowed one.
- The procedure family expands to tasks with **irreversible external effects** (send, submit, pay) → PreAct's
  L6 and ADR-0006 both say re-run verification is invalid there; the design needs a side-effect-free
  verification path and this section must be rewritten.
- A published study appears that measures **desktop office-suite** procedure breakage across app versions →
  replaces the `not_reported` in §5.
- M2's second app exposes UIA trees deep enough that typed refs survive UI updates → the selector-fragility
  argument in §1 stops applying to Myco and `[INFERENCE]` can be dropped.

## Cost spent

- Tool calls: **38** (arXiv API queries 9; arXiv abs/HTML reads 20; vendor-docs reads 5; repo reads 4).
- Web search: **unavailable** (`web_search` returned HTTP 402 on both attempts) — all discovery via
  `export.arxiv.org/api/query`, all verification via `arxiv.org/abs/<id>`. Recorded because it bounds how
  much of the 2024–2026 space was actually swept.
- Token estimate: ~180 K input, ~14 K output. Not reported precisely.
- Papers cited with verified id + title: **18**. Marked UNVERIFIED: **0**. Wrong-id collisions caught and
  discarded rather than cited: 3 (`2502.05914` → superconducting-film physics, not workflow induction;
  `2505.10610` → MMLongBench, not workflow induction; `2309.00938` → human-parsing robustness, not
  golden-ticket tampering).