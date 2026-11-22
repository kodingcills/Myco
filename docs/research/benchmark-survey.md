# How desktop and computer-use agents are benchmarked

Research date: 2026-11-19. Level: L1 (four parallel extractions, primary sources only).
Scope: what Myco M1 can learn from existing benchmarks about task format, success
checking, known flaws, reported reliability, and agent scores — and what M1's own
acceptance criteria are statistically worth.

Every claim carries a source. Numbers not present in a primary source are written
`not_reported`, never estimated. `[INFERENCE]` marks my reading rather than a source's
statement. Statistics in §7 are computed here and reproducible from the formulas given.

---

## 0. Summary for M1

1. **Execution-based grading is the norm, not the exception.** OSWorld, Windows Agent
   Arena, AndroidWorld, OfficeBench, OfficeEval and WorkArena all grade by reading real
   state. LLM judges appear only in WebArena/VisualWebArena answer tasks and in
   OSWorld's *agent* loop, not its evaluator. Myco's ADR-0002 choice is mainstream.
2. **Nobody reports variance.** Of the ten suites surveyed, only AndroidWorld reports
   CIs (Wilson, 95%, on a 5-task robustness subset) and only OfficeEval reports
   multi-run means (3 runs). Every other headline number is a single pass. Myco
   reporting CIs would be unusual and is a cheap credibility win.
3. **Reset is the weakest link, and it is worse than assumed.** Windows Agent Arena's
   `reset()` has the snapshot revert *commented out* and logs
   `"Not implemented! Reverting to snapshot is not supported for remote VMs!"` before
   closing apps instead. AndroidWorld resets per-app data, not the device. WebArena
   resets per batch, not per task. Myco's per-trial snapshot reset (M1-017, measured
   8.3–8.6 s) is genuinely ahead of the field.
4. **M1's 27/30 criterion is statistically weak.** 27/30 gives a 95% CI of
   [0.735, 0.979]; a system that is truly 80% reliable passes the bar 12.3% of the
   time. See §7.1.
5. **M1's "0 false successes in ≥10 corrupted trials" is also weak.** Zero events in
   10 trials bounds the true false-success rate only below 26% (95% upper). See §7.2.
6. **A public benchmark subset is possible but must be labelled "adapted".** The only
   Calc-relevant public suites are OfficeBench (openpyxl, Linux, non-GUI) and Windows
   Agent Arena's 24 LibreOffice Calc tasks (MIT, x64-only). Neither can be run as
   shipped on Windows 11 ARM64. See §8.

---

## 1. OSWorld and OSWorld-Verified

Already covered in depth in [eval-frameworks.md](eval-frameworks.md) §1; summarised here
for completeness of the comparison table.

- **Task format.** One JSON per task: `snapshot` (VM image label), `config` (typed setup
  steps), `instruction`, `evaluator {func, postconfig, result, expected, options}`.
  369 tasks in the paper; 47 are `libreoffice_calc`.
- **Success check.** Execution-based. `evaluate()` = result getter → metric → float.
  The Calc metric `compare_table` does whole-sheet `DataFrame.equals` after rounding.
  Gold is computed **outside** the guest (`employee_age_reference` regenerates the
  reference workbook on the host) — the single most transferable idea.
- **Known flaws.** `postconfig` may mutate the guest before evaluation and depends on a
  GUI keystroke landing (`pyautogui.hotkey("ctrl","s")`). A missing result file scores
  0, so "agent did nothing", "agent corrupted the file" and "harness broke" are
  indistinguishable. Whole-sheet equality gives no partial credit and no per-cell
  diagnostic.
- **OSWorld-Verified (2025-07-28).** 300+ community issues fixed; infrastructure moved
  to AWS; evaluator-only fixes preferred to preserve score continuity. The maintainers
  state plainly that "providing reliable rewards consumes more human resources than we
  imagined" and that decentralized evaluation makes scores "increasingly opaque and
  incomparable".
- **Reliability reported.** `not_reported` — no CI, no seeds, no trial counts in the
  v1 paper. OSWorld 2.0 reports 27.25 average scoring checkpoints per task but still no
  variance statistic.
- **Agent scores.** OSWorld 2.0: ~318 tool calls with Claude Opus 4.7 vs ~30 in v1.
  OpenCUA reports the only 3-run CIs in this literature (e.g. OpenCUA-32B 34.8
  +0.9/−1.0 at 100 steps on OSWorld-Verified).

## 2. Windows Agent Arena (WAA)

- **Paper/repo.** arXiv 2409.08264 v2 (2024-09-13), `microsoft/WindowsAgentArena`,
  MIT, 918 stars. No successor repo found.
- **Task format.** 154 tasks across 11 apps, one JSON per task with the OSWorld schema
  (`id, snapshot, instruction, config, trajectory, related_apps, evaluator`). 24 are
  `libreoffice_calc`. Per-domain human steps: Calc 15.3 average, the highest of any
  domain.
- **Success check.** Execution-based, **no LLM judge anywhere in the evaluator path**.
  `postconfig` → result getter (`vm_file`) → expected getter (`cloud_file` or `rule`) →
  metric. Calc uses `compare_table` with `sheet_data`/`sheet_print` rules, and the
  postconfig runs `soffice --convert-to csv` before comparison. Ground truth is fetched
  from a **personal GitHub repo** (`rogeriobonatti/winarenafiles`), not pinned to a
  commit.
- **Known flaws.**
  - **Reset is not implemented.** `desktop_env.reset()` logs
    `"Not implemented! Reverting to snapshot is not supported for remote VMs! Closing all
    applications instead"` and calls `_close_all_setup()`. `savevm`/`loadvm` exist in
    `VMController` but are never called from the env path. The paper's Fig. 3 describes
    a "VM controller snapshot (30GB)" — **the paper and the shipped code disagree**.
  - Many tasks hit live third-party sites (Amazon, Steam, Google Play), so results are
    time-varying.
  - ~two thirds of tasks were adapted from OSWorld Linux configs, advantaging
    OSWorld-tuned models (stated in the paper).
  - No evaluator-quality study: no human-agreement audit, no injected-fault test.
- **Reliability reported.** `not_reported`. No CI, no seeds, no trial count; `run.py`
  exposes no `--seed` and no repeat count. Table 4 is a single pass over 154 tasks.
  [INFERENCE] binomial noise at p=0.195, n=154 is roughly ±3 points.
- **Agent scores.** Navi best 19.5% (UIA + OmniParser + GPT-4V-1106); range across
  configurations ~2.0–19.5%; human 74.5% (n=1 participant, so no CI). SeeAct is
  reported only on Mind2Web, not WAA.
- **ARM64.** **Cannot run.** `run.sh` hardcodes `--platform linux/amd64`, only
  `win11x64-*` unattend files ship, KVM is required for sane speed, and Microsoft's own
  FAQ says no-KVM → use Azure. The QEMU base (`dockur/windows`) explicitly redirects
  ARM64 users to a different repo WAA does not use.

## 3. AndroidWorld

- **Paper/repo.** arXiv 2405.14573, ICLR 2025, `google-research/android_world`.
- **Task format.** 116 tasks across 20 apps. A task is a **Python class**, not JSON:
  `TaskEval` with `template`, `params`, `generate_random_params()`,
  `initialize_task(env)`, `is_successful(env) -> float`, `tear_down(env)`. 25
  information-retrieval tasks are protobuf-defined (`tasks.textproto`). Per-instance
  seed = `sha256(f'{seed}_{name}_{i}') % 2**32`.
- **Success check.** Execution-based. `is_successful()` inspects real device state over
  adb: SQLite rows, filesystem, system settings, UI hierarchy. IR tasks grade the
  agent's `ANSWER` string deterministically (type-cast then compare; `STRING_MATCH` uses
  `difflib` ratio ≥ 0.9). Composite tasks return the mean of subtasks.
- **Known flaws.**
  - **False negatives:** `agent_successful = task_successful if interaction_results.done
    else 0.0` — a completed task where the agent never declares done scores 0.
  - **False positives:** fuzzy string match at ratio ≥ 0.9 on short answers.
  - Exceptions during a task cause it to be **skipped and excluded from the tally** —
    silent task loss.
  - 7 phone tasks are disabled as "flaky and the root cause is not known".
  - Pre-release human annotation "resulted in the discovery and resolution of over 30
    bugs"; no post-release grader audit.
- **Reliability reported.** **The best in the field.** 3 seeds: 27.6 / 26.3 / 33.2
  (mean 29.0) for M3A+GPT-4 Turbo. A robustness study on 5 tasks × 20 trials reports
  **Wilson binomial 95% CIs** with `p < 0.05` significance marks, and concludes
  "performance is best represented by the mean across seeds". No CI is given for the
  headline 30.6% single-seed number.
- **Agent scores.** M3A+GPT-4 Turbo 30.6% (a11y tree), 25.4% (SoM); SeeAct 15.5%;
  human 80.0%.
- **Reset.** Per-app data snapshot restore (`/data/data/<pkg>` copy) plus a pinned device
  clock (15 Oct 2023 15:34 UTC). The emulator runs with `-no-snapshot`, so there is no
  device-level snapshot. This is the cheapest reproducible pattern in the survey.

## 4. ScreenSpot, ScreenSpot-v2, ScreenSpot-Pro (grounding)

- **Task format.** One instruction + one screenshot → one click point. Scored by whether
  the point falls inside the annotated bbox. **No execution, no app state, no task
  outcome.**
- **Counts.** ScreenSpot ~1,272 items (derived from OS-Atlas App. C: 436 web + 334
  desktop + 502 mobile). ScreenSpot-v2 re-annotates 11.32% of ScreenSpot, same 1,272
  count. ScreenSpot-Pro: 1,581 instructions / 23 apps / 5 industries / 3 OSes, >1080p,
  targets average 0.07% of screenshot area vs 2.01% for ScreenSpot. **Count conflict:**
  the HF `eval.yaml` says 1,585 images / 26 tools. Both reported, not reconciled.
- **Success check.** Geometric containment only. ScreenSpot-Pro's harness has a
  negative-instruction variant (`eval_sample_negative_gt`) but the leaderboard reports
  positive-only.
- **Known flaws.**
  - A point on a disabled, occluded, or wrong-but-adjacent control scores identically to
    a correct one.
  - ScreenSpot-Pro's own error analysis has a "Near Miss" class (within 3× box size),
    i.e. the metric cannot separate a near miss from a random guess.
  - **No contamination analysis** in ScreenSpot-Pro's paper, repo, or dataset card.
    OS-Atlas explicitly removed ScreenSpot/Mind2Web/OmniAct from its training data,
    which shows contamination was a live concern.
  - Prompt style is not standardized by the benchmark; each model wrapper carries its
    own prompt, and resolution policy varies (Qwen2.5-VL wrapper sets
    `max_pixels=99999999`).
- **Reliability reported.** `not_reported` for all three. Single greedy pass.
- **Agent scores.** ScreenSpot-Pro leaderboard (2026-11-10): GroundCascade 85.14,
  Indeed-UI-32B-zoomin 82.73, UI-TARS-1.5 61.61, OpenCUA-72B 60.8, UI-TARS-72B 38.14,
  Claude Computer Use 17.10, GPT-4o 0.82. ScreenSpot-v2 is **saturated**: UI-TARS 7B
  91.6 vs 72B 90.3; OpenCUA 7B 92.3 vs 32B 93.4.
- **Why grounding cannot substitute for success.** The evaluator never executes the
  click; there is no multi-step loop; there is no persistence check. OpenCUA states it
  directly: "Grounding alone is not enough" — Qwen2.5-VL-32B matches or beats OpenCUA on
  ScreenSpot-v2 while losing badly on OSWorld success. UI-TARS-2 says these datasets
  "reached saturation". Note the false-success direction is **inverted**: grounding can
  only produce false negatives (tight bbox), never the false positives M1's criterion is
  about.

## 5. OfficeBench and office-app suites

- **OfficeBench** (arXiv 2407.19056, Apache-2.0). 300 tasks (93 single-app, 95 two-app,
  112 three-app) across Word, Excel, PDF, Calendar, Email, OCR, ChatGPT, Shell, System.
  **Correction to the brief: it is not LLM-judge based.** Evaluators are ten Python
  predicates (`exact_match`, `contain_text`, `not_contain`, `file_exist`,
  `diff_contain_text`, `excel_cell_value`, `excel_cell_comparator`,
  `calendar_no_overlap`, …). "Fuzzy matching" in the paper means substring containment.
  - Flaws: `contain_text` passes if keywords appear anywhere (quoting the instruction
    satisfies it); `file_exist` passes on a zero-byte file; no negative assertions;
    `openpyxl` reads with `data_only=False` so a correct `=SUM()` is compared as a
    formula string and fails a numeric expectation [INFERENCE from code];
    `excel_cell_comparator`'s regex captures only `\w+`, so decimals and negatives cannot
    match [INFERENCE from code].
  - Reliability: `not_reported` (single evaluation per task per model).
  - Scores: GPT-4o 47.00% overall, GPT-4 Turbo 38.00%, Gemini-1.5-Pro 26.00%, human
    93.33%.
- **OdysseyBench** (arXiv 2508.09124, MIT). 602 tasks (300 OfficeBench-derived + 302
  synthesized), adds long dialogue history. Inherits OfficeBench's graders. Scores: o3
  56.19/61.26, GPT-5 54.00/55.96. Reliability `not_reported`.
- **OfficeEval / NCRE** (arXiv 2606.10956). 200 tasks, 7,118 deterministic criteria,
  graded by a Windows Open XML SDK engine with Office COM for some checks. **The only
  suite with Windows-native, per-criterion, partial-credit, judge-free grading** — the
  closest structural match to what Myco wants. Scores: Codex 68.8%, Claude Code 53.0%,
  community reference 95.5%. Reliability: 3 runs, per-task score SD 6.8–25.7 pp.
  **Blocker:** NCRE task material is copyrighted and deliberately not redistributed, and
  the engine needs Office COM on Windows x86.
- **WordEval** (arXiv 2611.10475). 642 Word tasks with "preservation conditions" — assert
  the requested change *and* that everything else is untouched. That is exactly the
  negative-assertion pattern M1 needs. Word-only.
- **WebArena / VisualWebArena.** 812 / 910 browser tasks, **zero spreadsheet tasks**.
  Hybrid grading: programmatic locators for state tasks, string match or GPT-4 judge for
  answer tasks. The Agentic Benchmark Checklist audit (arXiv 2507.02825) measured
  WebArena **overestimating performance by 1.4–5.2%**, with a worked example of a
  45+8=53-minute answer judged correct against a 63-minute gold, and "N/A" tasks passing
  on an empty reply. Neither can host a Calc subset.
- **WorkArena verifier audit** (arXiv 2610.09142). Mutation testing found WorkArena's
  form verifier **passed all 36 edited runs that filled an unrequested field**, and
  still passed 8/8 when the extra field was filled last. The cleanest published
  demonstration of side-effect blindness — the exact false-success class M1 claims to
  eliminate. Its method (hand-written mutations of correct runs + end-state
  confirmation) is directly reusable as Myco's own verifier self-test.

## 6. Cross-benchmark comparison

| Suite | Tasks | Success check | Judge? | Reset | Variance reported | ARM64? |
|---|---|---|---|---|---|---|
| OSWorld v1 | 369 | execution (getter→metric) | no | VM snapshot | no | no |
| OSWorld 2.0 | 108 | execution, weighted partial | no | VM snapshot | no | no |
| Windows Agent Arena | 154 | execution (getter→metric) | no | **not implemented** | no | **no (x64 only)** |
| AndroidWorld | 116 | execution (adb state) | no | per-app data snapshot | **yes (Wilson 95%, 3 seeds)** | n/a |
| ScreenSpot / -v2 | 1,272 | point-in-bbox | no | n/a (static) | no | n/a |
| ScreenSpot-Pro | 1,581 | point-in-bbox | no | n/a (static) | no | n/a |
| OfficeBench | 300 | execution (Python predicates) | no | committed tree | no | no (Linux Docker) |
| OdysseyBench | 602 | execution (inherited) | no | committed tree | no | no |
| OfficeEval (NCRE) | 200 | execution (Open XML + COM) | no | temp dir | **3 runs, SD reported** | no (x86 .NET) |
| WebArena | 812 | hybrid (locator / string / judge) | **yes** | per batch | no | no |
| VisualWebArena | 910 | hybrid (locator / SSIM / VLM) | **yes** | per batch | no | no |
| WorkArena | 33 / 682 | execution (form state) | no | not examined | no | no |

## 7. What M1's acceptance criteria are statistically worth

Computed here; exact binomial (Clopper–Pearson) intervals, no approximation.

### 7.1 The 27/30 reliability criterion

Observed 27/30 = 0.900, **exact 95% CI = [0.735, 0.979]**.

| True reliability | P(passing ≥27/30) |
|---|---|
| 0.80 | **0.123** |
| 0.85 | 0.322 |
| 0.90 | 0.647 |
| 0.95 | 0.939 |
| 0.99 | 1.000 |

Two consequences:

- A system that is genuinely 80% reliable **passes M1's bar 12.3% of the time**. The
  criterion does not establish 90% reliability; it establishes "not obviously worse than
  90%".
- Even a truly 90% system fails the bar 35% of the time. A single 27/30 run is a coin
  flip for a system at the target reliability.

**Recommendation (does not change M1 scope, changes only reporting):** keep 27/30 as the
gate, and additionally report the exact CI and the trial count needed for a tighter
claim. At ~90% observed, a CI lower bound ≥ 0.80 needs n≈100 (90/100 → CI low 0.824);
n=30 gives 0.735. If M1 wants to *claim* ≥80% reliability rather than merely pass a gate,
it needs ~100 trials. AndroidWorld's precedent (3 seeds, mean reported) is the cheapest
defensible middle ground: run the 30-trial suite 3 times and report the mean and spread.

### 7.2 The zero-false-success criterion

Zero false successes in n corrupted trials bounds the true rate at `1 − 0.05^(1/n)`:

| n | 95% upper bound on false-success rate | P(missing a true 10% rate) |
|---|---|---|
| 10 | **0.259** | 0.349 |
| 15 | 0.181 | 0.206 |
| 30 | 0.095 | 0.042 |
| 60 | 0.049 | 0.002 |
| 100 | 0.030 | 0.000 |

M1's "≥10 corrupted trials, 0 false successes" bounds the rate only below **26%**. That
is a weak claim against OpenAdapt's published 54/72 (75%) and 30/30 (100%) baselines —
it does beat them, but it does not establish that Myco's rate is near zero. **30
corrupted trials** would bound it below 9.5% and is the smallest n that makes the claim
meaningful. This is a reporting recommendation, not a scope change.

### 7.3 Baseline comparison power

At n=30, a two-sided sign test needs **≥6 discordant trials all favouring Myco** for
p<0.05: 5 of 5 gives p = 2·(1/2)^5 = **0.0625**, which is not significant; 6 of 6 gives
p = 2·(1/2)^6 = **0.0312**, the smallest significant count. So the baseline comparison is
only meaningful if Myco and the screenshot agent disagree on at least 6 of 30 trials.
*(Corrected 2026-11-21: this section previously said 5. The error was caught while folding
this survey into the baseline design, whose §4.5.2 carries the corrected table; fixed here
at source so the two documents agree.)*

Given the measured 2/16 cell-grounding rate for cheap VLMs (eval-frameworks.md §3.8),
that is plausible but not guaranteed — the comparison should be reported as a paired
table (both outcomes per trial), not two independent rates.

## 8. Can Myco report on a public benchmark subset?

| Suite | Calc tasks | Public? | Runnable on Win11 ARM64? | Verdict |
|---|---|---|---|---|
| Windows Agent Arena | 24 LibreOffice Calc | yes (MIT) | **no** (x64 container, KVM) | **Adapted subset only.** Take the 24 task JSONs, re-run under Myco's own verifier, label "adapted WAA Calc subset", never "WAA score". |
| OfficeBench | Excel present, count unpublished | yes (Apache-2.0) | no (Linux Docker, Python ops) | Adapted subset only; its substring graders would import the false successes M1 exists to disprove. |
| OfficeEval (NCRE) | 65 Excel tasks | **no** (copyrighted) | no (x86 .NET + COM) | Not reportable. |
| ScreenSpot-Pro | 64 Excel items (macOS Excel 365) | yes (MIT) | n/a (static) | Grounder sanity check only; not a reliability metric. |
| WebArena / VisualWebArena / WorkArena | none | yes | no | Not applicable. |

**Recommendation.** The defensible public claim is: *"Myco ran an adapted subset of
Windows Agent Arena's 24 LibreOffice Calc tasks under its own ARM64 verifier, with
per-trial snapshot reset and exact CIs; results are not comparable to published WAA
scores because WAA's reset is not implemented and its scores are single-run."* That
sentence is honest, checkable, and stronger than a leaderboard number nobody can
reproduce.

## 9. What M1 should copy, and what it should not

**Copy:**
- AndroidWorld's `is_successful()`-reads-the-database pattern → M1 already does this via
  UNO + file parse.
- AndroidWorld's variance discipline: 3 seeds, Wilson CIs, mean reported.
- OSWorld's "compute the gold outside the guest" discipline → already adopted.
- OfficeEval's per-criterion partial credit → M1-012's weighted `partial_scores` already
  matches.
- WordEval's preservation conditions and WorkArena's mutation-testing audit method →
  **not yet in M1**; both are cheap additions to the verifier self-test.
- WAA's task JSON schema (MIT) as a public task source.

**Do not copy:**
- WAA's reset (not implemented) or its unpinned golden-file host.
- OfficeBench's substring graders or its `data_only=False` formula read.
- WebArena's unvalidated LLM judge for answer tasks.
- Any single-run headline number without a CI.

## 10. Open questions / unverified

- ScreenSpot-Pro item count: paper 1,581/23 apps vs HF `eval.yaml` 1,585/26 tools.
  Unreconciled.
- Whether any community member has run WAA on Windows 11 ARM64 via `dockur/windows-arm`.
- Whether WAA's golden-file host is commit-pinned (the raw URLs are branch-based).
- OfficeBench venue (arXiv only in metadata).
- No published contamination audit exists for ScreenSpot-Pro or OfficeBench.

## Cost spent

4 scout extractions (deepseek-v4.1-flash; 4m43s, 5m49s, 5m29s, 11m37s), 1 statistics
pass (this thread), 1 synthesis pass. No L2 run — the decision-relevant questions were
answerable from primary sources plus arithmetic.
