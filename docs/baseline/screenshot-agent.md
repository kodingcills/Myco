# Screenshot-agent baseline — design (M1-015 / TIF-19)

Status: **proposal**, 2026-11-21. Nothing here has been executed: the M1 Coordinator holds
`myco-win11` for the M1-013 sweep (coordination "EXCLUSION RULE"), so every VM-dependent
statement is marked **UNVERIFIED** and every model statement is either cited to
`docs/research/eval-frameworks.md` or marked as an estimate with its basis.

Owner: baseline workstream, branch `myco/m1-baseline` (PR-reviewable; no code until the sweep
host is released).

Scope: M1 acceptance row 7 — *the same tasks, initial states, and model settings, compared against
a screenshot-based agent*. ADR-0009 fixes the baseline architecture (Agent S3 + UI-TARS-1.5-7B).
It does **not** fix which model runs it. This document covers:

1. the harness that makes the comparison fair;
2. the metrics, measured identically on both sides and aligned with M1-013's 30-trial sweep;
3. the fairness rules that distinguish "the screenshot agent lost" from "we handicapped it";
4. a candidate model shortlist with **estimated** cost per 30 trials, for Tiffany to choose.

It deliberately chooses nothing that costs money. §9 is the escalation the outer loop owns.

---

## 1. What the baseline is, precisely

A baseline that cannot be grounded will lose for reasons unrelated to Myco's thesis. The measured
evidence for that is already in the repo (eval-frameworks §3.8): two local 7.6 GB / 6.4 GB VLMs
scored **2 hits in 16 attempts** at locating a named Calc cell. So the baseline is a two-stage
agent, not one model:

| Stage | Role | Input | Output |
|---|---|---|---|
| **Planner** | decides the next action from the instruction and the screen | task text + screenshot(s) + step history | one action in a closed vocabulary |
| **Grounder** | turns a described element into a screen point | screenshot + element description | normalized coordinates (0–1000 or pixels) |
| Transport | executes the action on the Windows desktop | one action | new screenshot + ack |

ADR-0009 fixes the planner+harness as **Agent S3 (`gui-agents`)** and the grounder as
**UI-TARS-1.5-7B**. `gui-agents`' CLI makes the grounder mandatory (`--ground_provider`,
`--ground_url`, `--ground_model`, `--grounding_width`, `--grounding_height` are all *Required*),
and its `engine_type` accepts `openai`, i.e. any OpenAI-compatible endpoint — which is what a
local Ollama proxy exposes. Grounding therefore can be swapped without touching the loop, and
§4 treats it as a first-class choice.

**What the baseline must not do.** It gets no structural state: no UIA tree, no UNO, no file
access, no `calc-record-edit` program. It sees pixels and types. Its success is decided by the
*same* UNO + persisted-file verifier as Myco (§3.3), so a "done" message on screen never counts.

---

## 2. Conditions that must be identical

"Identical tasks, initial states, and model settings" is the acceptance wording. Concretely, both
arms must share all of the following. Anything that differs is a documented deviation (§3.5).

| Condition | How it is held constant |
|---|---|
| Task family and parameters | The sweep's final 30 parameter sets, copied verbatim into the baseline run (§4.4a) — same `{fixtureSeed,rowKey,column,newValue}` per trial. The generator that produced them (`generateParameterSets`, `src/tasks/intent.ts`) is the family definition; the *list used* is data, recorded with its hash in both reports. |
| Initial state | Per-trial reset from `clean-base` via `scripts/reset-trial-vm.sh` (cold disk restore), identical for both arms. Reset wall time recorded per trial. |
| Fixture file | Host-generated CSV → guest `.xlsx` by `WindowsFixtureConverter` (isolated throwaway profile). The **same fixture bytes** for trial *i* in both arms: the baseline gets fixture *i*, not a re-generated one. |
| Guest software | Same VM, same LibreOffice 26.8.3 ARM64, same Windows build. No LibreOffice settings are changed for either arm (AutoCorrect stays on — see §3.4). |
| Desktop geometry | Both arms run at the same display resolution; the baseline's `--grounding_width/height` equal the captured screenshot size. Resolution recorded. |
| Agent isolation | One trial per guest state, no concurrent sessions. After either arm's trial: cleanup + reset before the next trial (M1-019 semantics). |
| Trial order | The Myco arm's 30 trials must come from the M1-013 sweep. **As of 2026-11-21 that artefact does not exist**: `/tmp/m1-013/sweep/` holds only `progress.log` (trial 0 in flight) and an empty `runs/`; the prior attempts are classified host-sleep and external-interference aborts and are never counted. The join in §4.4 is therefore **contingent on the sweep completing and the Coordinator declaring it final**; nothing in this doc presumes a sweep number. The baseline arm runs **the same parameter sets, in the same order**, as the sweep's final parameter list — not a re-derived index (§4.4a). |
| Attempts | One attempt per trial. A retry is a new trial row, not a hidden re-run. |

**Ordering of the two arms.** The baseline arm runs *after* the Myco arm produces its 30-trial
result, on the same VM, because M1-013 owns the host first. If the Myco sweep is re-run (e.g. a
reset defect invalidates it), the baseline arm re-runs as well — mixing a baseline run against a
different VM state with a different Myco run would void the comparison.

---

## 3. Harness

### 3.1 Placement and transport

```
macOS host                                         Windows guest (myco-win11)
┌──────────────────────────────┐                   ┌───────────────────────────────────┐
│ baseline driver (Node, host) │                   │ myco-agent (existing, session 1)  │
│  ├ AgentClient over SshTunnel│──── ssh -L ──────►│   op screenshot  → PNG bytes      │
│  ├ planner client (HTTP)     │                   │   op kill/launch → process control│
│  ├ grounder client (HTTP)    │                   │   *NO* UIA tree, *NO* UNO read-   │
│  └ verifier (UNO + file)     │                   │    back, *NO* read_file for the   │
└──────────────────────────────┘                   │    trial's xlsx                   │
                                                   └───────────────────────────────────┘
```

- **Screenshots** come from the existing agent `screenshot` op (`windows_backend.py:526`, GDI
  capture of the Calc window) — already used and reviewed for M1-013 evidence. No new guest code.
- **Actions** are the hard part. The agent's op union is exactly ten ops — `ping`,
  `session_info`, `launch`, `uia_tree`, `uia_invoke`, `screenshot`, `read_file`, `write_file`,
  `kill`, `uno_eval` (`src/win/agent-client.ts:19-29`) — and of those:
  - **No coordinate-only click exists.** Clicks are UIA-only: `uia_invoke` needs a
    `runtime_id` that came from `uia_tree` (`agent/myco_agent/ops.py:30-43`), and the backend
    clicks that control.
  - **A raw keystroke channel does exist**, contrary to an earlier draft of this doc:
    `uia_invoke` with `action: "keys"` sends an arbitrary SendKeys string
    (`ops.py:30-43`; `windows_backend.py:515-519` — `auto.SendKeys(keys)` after
    `control.SetFocus()`). It is **not** goal-free input, because it still requires a
    UIA-resolved `runtime_id`, i.e. it needs `uia_tree`, which §5.5 forbids the baseline from
    using to locate the target. It is therefore usable for *blind* keys only (Ctrl+S, Enter,
    Escape) on a control the baseline has no legitimate way to identify.

  A screenshot agent needs coordinate input (it must click where the grounder said), so the
  options are narrower than an earlier draft claimed:
  - **(a) in-guest PyAutoGUI runner** — PyAutoGUI is the reference synthetic-input path on
    Windows (`pyautogui==0.9.54` in UFO's pinned requirements, `docs/research/adapters.md:153-160`)
    but is **not** in the guest image today (P5 installs `pywinauto uiautomation comtypes pywin32
    pillow`, `docs/env/windows.md:481`). A small script launched through the existing `launch`
    op reads a JSON action from a file and executes it; installing PyAutoGUI is a guest
    provisioning change (outer loop, §9).
  - **(b) new agent ops** `mouse/click/key` — cleaner and typed, but touches `agent/`, a shared
    component mid-sweep.
  - **(c) `uia_invoke action=keys` only + grounder-free navigation** — no coordinate input at all.
    Rejected: without a click it is not a screenshot agent as M1 defines one, and the comparison
    would be measuring a different baseline.
  Preference: **(a)** for M1 (baseline-only code, zero blast radius on the Myco path), (b)
  recorded as the follow-up if the baseline is kept as a standing harness.
- **Isolation discipline.** The baseline driver must not import anything from `src/tasks/`
  except the *parameter generator and ground truth* (host-side, never guest state). It must not
  call `WindowsCalcAdapter`, `unoVerifierOverAgent`'s live-read, or any guarded program. This is
  enforced by a unit test on the import graph (§3.6), not by review.

### 3.2 The loop

```
for trialIndex in 0..29:
  reset(prep) ─► deploy agent ─► place fixture_i in the guest (known path + known window title)
  planner.reset(instruction_i)
  t0 = now
  for step in 0..MAX_STEPS:                     # MAX_STEPS = 30 (recorded per trial)
      shot = agent.screenshot()
      action = planner.act(instruction_i, shot, history)    # text only
      if action needs grounding: point = grounder(shot, action.target)
      transport.execute(action)                 # click / type / key / scroll
      history.push(action)
      if planner said "done": break
  close the document via the UI (Ctrl+W, discard if prompted) — or force-kill Calc if it will
  not close, recorded as such (§3.4)
  t1 = now
  verdict = verifier(fixture_i path, intent_i)  # identical to Myco's UnoVerifier + file parse
```

There is **no recovery, retry, or replanning that Myco does not also get**. The comparison is
screenshot-agent-as-shipped versus Myco, so the baseline's step budget must be generous enough
that a loss is a loss of capability, not of budget: 30 steps is ~1 step per UI element touched in
the guarded program (open/locate/set/save/close is 5 actions) times six. Recorded and reported.

**The budgets are not symmetric and that is a deviation, not a neutral choice.** Myco's program is
a fixed 5 guarded steps (`src/tasks/calc-record-edit.ts` `programFor()`), and the runner has no
step-budget concept at all (`grep -rn 'MAX_STEPS\|maxSteps\|stepBudget' src/` is empty). The
baseline gets 30. The generous direction is deliberate — a capped baseline is a straw man — but it
goes in the deviations register (§3.5), and `steps` is reported per arm only, never as a
side-by-side "fewer is better" column (§4.3).

**Budget exhaustion is `refuted`, and cause is attributed first.** If the loop runs out of steps
the trial is `refuted` with `reason: step-budget`. The one collision with §3.3's dead-app row is
a baseline that killed Calc by its own budget actions: the harness attributes cause (our driver
acted → `refuted`/`step-budget`) before applying the "could not look" rule, so a dead Calc is
`uncertain` only when the baseline did **not** cause the death.

### 3.3 Verification, shared with Myco

Verdict comes from `unoVerifierOverAgent` + the persisted-file parse, on host-side ground truth
`groundTruth(params_i)` (ADR-0002, ADR-0005). Nothing in the screenshot agent's transcript feeds
the verdict. This is the only way the two arms are comparable: both are scored by a judge that
does not know who acted.

Edge case for the baseline, because it can leave the app in states Myco never does:

| Observed guest state at scoring time | Verdict | Why |
|---|---|---|
| Document closed, file parses, cell == expected | `verified` | intent satisfied and persisted |
| Document closed, file parses, cell != expected | `refuted` | intent not satisfied |
| Document open but UNO reports `isModified() == true` | `refuted` | the agent believed it saved; it did not. This is the OpenAdapt failure mode |
| Document open, unmodified, file parses | scored from the file | equivalent to closed |
| Calc dead / UNO unreachable / no file | `uncertain` | could not look (ADR-0002) — **not** `refuted` |
| Dialog blocking the app at timeout | `refuted` after the close attempt | the agent left the app in a state that did not persist the edit; recorded with the dialog text |

A save-dialog or overwrite prompt left on screen is a *baseline* failure, not a harness error: no
part of either arm is allowed to click it for the agent.

### 3.4 AutoCorrect and other app-level traps

AutoCorrect sentence-cased a lowercase test value and produced a legitimate `refuted` during
M1-013 (log 21). The generator is now AutoCorrect-immune (PR #21, 20/20 guest-side proof), so the
shared parameter sets already sidestep that trap for **both** arms. No arm gets the setting
changed or disabled, because M1 asks about the app as installed.

### 3.5 Deviations register

Anything that cannot be held identical is recorded here per trial, not left to prose. Initial
entries (to be kept current in the report):

| Deviation | Both arms? | Mitigation |
|---|---|---|
| Baseline uses a host-side driver; Myco uses its runtime | by design | scoring judge is shared and blind |
| Baseline may need a PyAutoGUI runner in the guest | baseline only | runs through the reviewed `launch` op; no UIA/UNO |
| **Step budget is asymmetric**: baseline 30 model actions, Myco a fixed 5-step program with no budget concept in the runner | by construction | generous direction, stated in §3.2; `steps` never compared side by side (§4.3) |
| **Reset hygiene may differ in practice**: the baseline gets a scripted `clean-base` cold restore; the Myco rows inherit whatever the sweep did, including degraded resets under load | both intend identical, neither guaranteed | `resetMs` + AC/battery state recorded per row; a row whose `resetMs` exceeds 2× the 152 s measured maximum (log 39) is flagged and the comparison table reports how many were flagged |
| Screenshot capture is GDI window-capture, not full-desktop | both capture, baseline-only consumer | same op, same rect policy |
| VM reset cost differs by time of day (cold restore 134–152 s measured, log 39) | both | reset timing is a metric, not a deviation |
| Host load changes task wall time | both | host load + battery state recorded from `pmset` |

### 3.6 What the baseline harness must prove in CI (host-side, no VM)

- Import-graph test: the baseline driver cannot reach `WindowsCalcAdapter`, `runTrial`, or
  `unoVerifierOverAgent`'s live read. A deliberate import must fail the test.
- Verdict test: a fake transcript ending "done" with a wrong persisted value yields `refuted`; a
  transcript ending "sorry" with the right persisted value yields `verified` (the judge is blind
  to the agent's claims, in both directions).
- Step-budget test: exceeding `MAX_STEPS` ends the trial as `refuted` with `reason:
  step-budget`, never `uncertain`; and a trial where the driver's own action killed Calc is
  attributed `refuted`/`step-budget`, while a Calc that died for an unrelated reason is
  `uncertain` (§3.2).
- False-success test: an audit that throws yields `falseSuccess: null`, **not** `false` — an
  unaudited `verified` must never read as a pass (§4).
- Cost accounting test: token counts from the stub HTTP clients are summed per trial and land in
  the row.

---

## 4. Metrics

Every row of `baseline/trials/<arm>/<index>.json` carries the same schema for both arms, so the
side-by-side table is a join, not a manual reconciliation.

```jsonc
{
  "arm": "myco" | "screenshot",
  "index": 0,                       // 0..29, index into generateParameterSets(SEEDS)
  "params": { "fixtureSeed": "…", "rowKey": "EMP-0038", "column": "name", "newValue": "…" },
  "cellRef": "B39",
  "expected": "REVISED-…",
  "previousValue": "Cleo Larsen",
  "verdict": "verified" | "refuted" | "uncertain",
  "verdictReason": "…",
  "falseSuccess": false,            // boolean | null — see below
  "audited": true,                  // false when the independent audit could not run
  "elapsedMs": 34_300,              // task wall time: fixture present → scoring time
  "steps": 5,                       // Myco: program steps; baseline: model actions
  "modelCalls": 5,                  // baseline only
  "tokens": { "in": 0, "out": 0 },  // baseline only
  "resetMs": 140_000,               // per-trial reset, both arms
  "resumed": false,                 // the app or harness was interrupted and resumed
  "recoveryEvents": 0,
  "hostLoad": { "battery": "AC", "loadAvg1": 2.1 },
  "deviations": []
}
```

**`falseSuccess` is tri-state, not boolean.** The driver's `independentValuePresent` is
`boolean | null`: `null` when the audit conversion throws (`/tmp/m1-013/trial-one.ts`, the
`catch` around the headless re-convert) or when the row is a harness error. Collapsing `null` to
`false` would record an **unaudited `verified`** as a clean pass, which is precisely the silent
success the whole milestone is about. So:

| `verdict` | `independentValuePresent` | `falseSuccess` |
|---|---|---|
| `verified` | `true` | `false` |
| `verified` | `false` | **`true`** |
| `verified` | `null` | `null` — **not a pass** |
| `refuted` / `uncertain` | any | `false` |

An unaudited `verified` is counted in its own metric row (§4.1) and must be **0 for both arms**.
If it is non-zero, the trial is re-run — the defect is in the audit, not in either agent, and the
row is never quietly folded into the pass rate.

### 4.1 Primary metrics (the comparison table)

| Metric | Definition | M1 target |
|---|---|---|
| **Pass rate** | `verified / 30` | Myco ≥ 27/30 (row 3) |
| **False successes** | rows with `falseSuccess === true` | 0 |
| **Unaudited `verified`** | rows with `verdict === verified && falseSuccess === null` | 0, both arms |
| **Time per trial** | median and p95 of `elapsedMs` | reported, no target |
| **Recovery** | rows with `resumed: true` that ended `verified` | Myco: interruption + invalid target both recovered |

### 4.2 Secondary metrics

- `refuted` / `uncertain` split, with reason classes (wrong value / unsaved / dialog / dead app /
  harness).
- Cost per 30 trials in model calls, tokens, and dollars (§8) — a first-class part of the baseline
  claim, because "Myco is more expensive" is the obvious objection to verified execution.
- Steps per trial and wasted steps after the edit actually landed (a screenshot agent that keeps
  clicking after success burns tokens without changing the verdict).
- Screenshot count per trial (the baseline's observation cost).

### 4.3 What is NOT a metric

Myco emits step-level verification (per-action pre/postconditions). The baseline cannot. Reporting
"checks passed" side by side would compare a capability to its absence, so it is left out of the
table and cited in prose only.

### 4.4 Alignment with M1-013

The Myco arm of the table **is** the M1-013 sweep's JSONL, not a re-run — once that artefact
exists and the Coordinator declares the sweep final (§2, trial order). Field map:

| M1-013 sweep JSONL field | Comparison row field |
|---|---|
| `index`, `runId` | `index` |
| `rowKey`, `column`, `typed`, `cellRef`, `expected` | `params`, `cellRef`, `expected` |
| `verdict`, `verdictReason` | `verdict`, `verdictReason` |
| `independentValuePresent`, `auditError` | `falseSuccess` (tri-state, §4 above) |
| `elapsedMs`, `completed` | `elapsedMs` |
| — | `steps`, `modelCalls`, `tokens` are baseline-only and left `null` for Myco rows |

The sweep's `falseSuccess` is `verified && independentValuePresent === false`; the comparison
loses nothing by using the same predicate, and gains the tri-state `null` the sweep's boolean
collapses. The baseline's row is produced by the same predicate against the same independent audit
(the driver's headless re-convert), so neither arm can be excused by a different definition of
success. If the sweep is invalidated and re-run, the comparison is regenerated, never patched.

### 4.4a The parameter list is data, not an index

An earlier draft said "same index → same parameter set". **That is not achievable from the current
in-repo entrypoint** and the assumption is retracted:

- `generateParameterSets(seeds)[i]` cycles the column by index — `DATA_COLUMNS[i % 4]` — so set
  *i* is `name`, `qty`, `joined`, `salary` by turn (`src/tasks/intent.ts:117-141`).
- But `src/integration/run-live.ts:51-57` always takes `generateParameterSets([seed])[0]`, i.e.
  **set 0, column `name`**, whatever `i` the sweep thinks it is running. The sweep driver that
  actually ran (`/tmp/m1-013/trial-one.ts`) instead built 30 sets from
  `SEEDS = [m1-013-live, seed-b … seed-f]` and indexed that array — a *third* list, neither of the
  above.
- Runbook §7.3 flags the same defect for the `--seed` form.

So there is no single canonical "index". The comparison therefore treats the **sweep's final
parameter list as the input**: the Coordinator's `params.json` (or the sweep JSONL's
`rowKey/column/typed/cellRef` fields) is copied into the baseline run, and the baseline runs those
exact sets in that exact order. If that list covers only `name`, the report says so and the
comparison is honest about it; the baseline does **not** substitute a broader list to look
thorougher. If the Coordinator instead re-runs the sweep through a fixed in-repo entrypoint, the
list is whatever that entrypoint emits, recorded by hash in both reports.

---

## 5. Fairness rules

The point of a baseline is to lose for the right reason. These are constraints on us:

1. **Same judge, blind.** Verdict never reads the agent's own claims (§3.3). Both arms go through
   one verifier call site.
2. **Same fixture bytes, same intent, same list.** No re-generation of a fixture for the second
   arm "because the first one was awkward". The parameter list is copied from the sweep's final
   output (§4.4a), not re-derived from an index that three different code paths disagree about.
3. **No prompt engineering after a trial.** Prompts are frozen before trial 0 and hashed into the
   report. A prompt written after seeing trial failures turns the baseline into a straw man.
4. **No retries, no step-budget stretching mid-run.** A step budget set before trial 0; a raised
   budget after a loss is a deviation entry and a re-run of all 30.
5. **The baseline gets the same information the user would.** Task instruction, current screenshot,
   its own action history. Not: the cell address resolved by UIA, not the UNO tree, not the file.
   (Resolving the cell *is part of the task*.)
6. **No model shopping after the fact.** The planner and grounder are chosen before trial 0; the
   report names them with versions. A second model pair is a second reported arm, not a replacement.
7. **Host conditions are the same and disclosed.** Both arms record reset time, host load, and
   battery/AC state. A baseline run on a contended Mac is not comparable to a quiet Myco run —
   log 30/41 show resets varying 45 s → 1879 s under load, so this is a real hazard.
8. **Honest count.** No re-runs to reach a better number; every started trial is a row, including
   harness failures (recorded as such, and excluded from the pass rate but listed).
9. **The baseline may win.** If the screenshot agent passes 30/30, the report says so. The
   measured claim then moves to time, cost, false successes under corruption, and recovery — the
   M1-014 corrupted suite is where the difference is expected to appear, and the baseline should
   be run against a subset of corrupted trials too (§7).

---

## 6. Determinism and reproducibility

- Temperature 0 for both planner and grounder where the endpoint honours it; the seed recorded.
  Ollama honours `seed` + `temperature: 0` for local models; a hosted endpoint that does not is a
  deviation entry.
- The report embeds: model ids + versions, prompt hashes, `MAX_STEPS`, grounding width/height,
  the reset snapshot name, VM UUID, LibreOffice version, and the parameter list hash.
- Every trial keeps its transcript (actions + screenshots + model responses) under
  `baseline/transcripts/<arm>/<index>/`, so a disputed verdict can be re-adjudicated without
  re-running.

---

## 7. The corrupted-trial arm (scope, not commitment)

M1 row 4 needs ≥10 corrupted trials. Row 7 says "identical tasks"; the strongest reading of the
comparison is that the screenshot agent also faces interruption and invalid targets. Plan:

- **Minimum**: 10 corrupted trials, 4 classes (`kill-app`, `invalid-target`, `delayed-save`,
  `focus-change`), given to both arms. The baseline needs no special code — it just gets the same
  fault schedule.
- Expected outcome, stated as a prediction so the report can be honest about being wrong: the
  screenshot agent reports success on trials whose save failed while the screen said "Saved",
  i.e. the OpenAdapt 54/72 shape. A corruption that is invisible on screen is exactly where a
  screenshot agent cannot self-detect, and exactly where Myco's UNO check is decisive.
- Cost: this arm is where the baseline's model spend multiplies. It is priced separately in §8.

This section is **not** committed scope for M1-015; it is what M1-014 should include if Tiffany
wants the comparison to cover row 4 too.

---

## 8. Candidate models and estimated cost per 30 trials

**No choice here is final; §9 escalates it.** The estimates below are arithmetic over published or
locally measured prices, with every assumption stated. Where a number is unknown it is marked
`unknown`, not guessed.

### 8.1 What actually drives cost

Per trial, on the Myco task family:

| Component | Count per trial | Note |
|---|---|---|
| Planner calls | ≈ 5–8 | one per UI action; Myco's guarded program is 5 actions, a screenshot agent typically takes more (open, wait for load, locate, click name box, type address, click cell, type value, Ctrl+S, close ≈ 9–12) |
| Grounder calls | ≈ 2–5 | one per click/keypress needing a target; the edit is mostly typed into a known cell, so few |
| Image tokens per call | large | 1280×800 screenshot. At the common ~1 image-token per 28×28 patch rule: (1280/28)×(800/28) ≈ 46×29 ≈ **1330 tokens**; a UI-tuned model with a finer patch (14 px) is ~5300. History re-sends add a fraction of this |
| Text tokens | small | instruction + history, ≈ 200–800 per call |

So a trial is roughly **8–14 calls × (1.3–5.3k image tokens + ~0.5k text)** ≈ **15k–80k input
tokens** and **0.3k–1.5k output tokens**. Use 30k in / 0.8k out per trial as the central estimate
and 80k / 1.5k as the pessimistic one. **30 trials ≈ 0.44M–2.5M input, 25k–45k output**
(recomputed: 8 calls × 1834 ≈ 14.7k; 14 calls × 5836 ≈ 81.7k; × 30 = 0.44M / 2.45M).

### 8.2 Shortlist

Legend: **Local** = runs on this Mac, no account, no marginal cost. **Free-tier** = no account
needed today, but rate-limited. **Paid** = needs credits/account → §9 only.

| # | Planner | Grounder | Where it runs | Vision evidence | Cost per 30 trials | Verdict |
|---|---|---|---|---|---|---|
| **A** | `qwen3.8-uncensored` (9.2B, **installed**, `vision` capability) | same model, grounding-only prompt | Local Ollama, this Mac | **2/4 on cell grounding in the measured test (§3.8)**; fails as a grounder | $0 marginal; ~9.4 GB RSS + ~9 GB model load during a run | **Do not use as the grounder.** Usable as the *planner* in a CPU-only fallback |
| **B** | ShowUI-2B as grounder + hand-rolled planner loop (replaces `gui-agents`) | ShowUI-2B (`showlab/ShowUI-2B`, MIT, 2B) | Local, needs a one-time download (~4 GB) + `pip install`; CPU-viable per eval-frameworks §3.5 | Not measured locally. It is a *grounding* model by design; eval-frameworks rates effort **low** | $0 marginal (download is not a purchase) | **Best local grounding path.** Needs the download authorised as non-commercial? No — weights are MIT, no account, no payment. Only disk and time |
| **C** | Agent S3 planner on a local model (bounded by A's limits) + **B** as grounder | UI-TARS-1.5-7B (`ByteDance-Seed/UI-TARS-1.5-7B`, apache-2.0, not gated) | Local, one-time ~15 GB download; needs GPU-friendly run (Ollama/llama.cpp) | UI-TARS is the ADR-0009 grounder; not measured on this host | $0 marginal; ~7-8 GB load, competes with the 8 GB VM for RAM | **The ADR-0009 configuration, locally.** RAM is the risk: VM 8 GB + model 8 GB + Chrome on a 24 GB Mac already caused the pressure in log 15 |
| **D** | CheaperInference vision models (`deepseek-v4.1-flash`, `glm-5.3`) | same | CheaperInference cloud | **Unknown**: the catalog lists both as models but does not publish vision capability, and the codebase's only prior check returned a credits error (eval-frameworks §3.8). A vision-less planner cannot run this baseline at all | `unknown` — cannot be priced without a paid probe | **Needs a paid probe before it can be considered.** Not in the plan without Tiffany's approval |
| **E** | Hosted UI-TARS-1.5-7B | HF Inference Endpoint / similar | Hosted | The Agent-S README recommends it | `unknown`; a small dedicated endpoint is metered by GPU-hour, not per token | Escalation item (§9) |

Excluded by rule: **kimi-k3 and all `*:cloud` Ollama aliases** (banned on this project; also they
returned a credits error, i.e. paid). Also excluded as planners: **any general chat VLM as the
grounder** — that is measurement B in reverse, and §3.8 already shows it fails.

### 8.3 Cost, stated plainly

- **A, B, C cost $0 in marginal spend.** They cost disk (4–20 GB), RAM during the run, and host
  time. On this Mac RAM is the binding constraint (log 15: Ollama at 9.1 GB + the VM at 8 GB
  starved the guest). A baseline run must therefore happen when the VM is the only heavy guest and
  the Mac is on AC power.
- **D and E cannot be priced from here.** D needs a credit balance to answer "does it see at all".
  E needs a provider quote. Both are §9 items.
- **Time is not $0 to the project.** A cold reset is 134–152 s (log 39) and a Myco trial is 35–90 s.
  A 30-trial baseline run is ≈ 1.5–2 h of VM time at Myco's step count, and a screenshot agent's
  higher step count pushes it toward 2.5–3 h. It is VM time the M1-013 sweep and M1-014 also need.

---

## 9. Escalation to the outer loop (Tiffany decides)

Only these questions need a human, and none of them is answered here:

1. **Grounder download**: is downloading a 4 GB (ShowUI-2B) or ~15 GB (UI-TARS-1.5-7B) model to the
   Mac acceptable? No account, no payment, MIT/apache-2.0 weights — but it is disk and a multi-hour
   download.
2. **Vision probe on CheaperInference** (`deepseek-v4.1-flash`, `glm-5.3`): may a *single* minimal
   request be spent to establish whether either model accepts an image? The result decides whether
   option D exists at all. Until it does, D is not in the plan.
3. **Hosted UI-TARS** (option E): only if 1 and 2 both fail. Needs a provider and a budget.
4. **VM time after the M1-013 sweep**: roughly 2–3 h of `myco-win11` for the baseline arm, plus
   the same for the corrupted arm if §7 is in scope. Scheduling is the M1 Coordinator's.

Recommended default if nobody answers: **B** (ShowUI-2B grounder, local, eval-frameworks §3.5's
"GPU budget is zero" path) with **A**'s model as the planner fallback, because it spends nothing
and needs no account. Its ceiling is lower than UI-TARS — that gets stated in the report.

---

## 10. Open questions

| # | Question | Blocks | Owner |
|---|---|---|---|
| 1 | PyAutoGUI runner via `launch` (a) vs new agent ops (b) | harness implementation | baseline workstream |
| 2 | Does Agent S3 run on Windows-hosted Python against a remote desktop, or is the loop run on the Mac against the guest? | harness implementation | baseline workstream, after §1 transport is chosen |
| 3 | Grounding model choice (escalation §9.1/2) | any run | Tiffany via outer loop |
| 4 | VM time slot after the sweep | any run | M1 Coordinator |
| 5 | Does the Myco sweep keep 30 columns varied, or only `name`? (runbook §7.3) | comparison honesty | M1 Coordinator (owner of the sweep) |

---

## 11. Definition of done for M1-015

- `docs/baseline/screenshot-agent-report.md` with the §4 table filled from artefacts, both arms,
  30 rows each, plus the deviations register and the prompt/model hashes.
- Every row reproducible from `baseline/transcripts/` without re-running.
- The report states what the baseline **beat** Myco at, if anything, in plain numbers.
- CI covers §3.6; the baseline driver is code-reviewed and merged through the standing rule
  (independent verifier PASS at head SHA + green CI, then merge).

---

## 12. Sources

| Claim | Source |
|---|---|
| Agent S3 + `gui-agents`, mandatory grounding CLI args, OpenAI-compatible endpoint | `docs/research/eval-frameworks.md` §3.2 |
| UI-TARS-1.5-7B apache-2.0, not gated; repo archived; parsing package | §3.3 |
| ShowUI-2B MIT, 2B, CPU-viable, "GPU budget zero" path | §3.5, §3.9 |
| Local VLMs score 2/16 at cell grounding; Ollama `/v1` accepts `image_url` | §3.8 [measured] |
| CheaperInference vision unknown; credits error | §3.8, §3.9 |
| OpenAdapt 54/72 and 30/30 false-success shape | §3.7 |
| Agent op surface: 10 ops, no coordinate click, keystrokes only via `uia_invoke action=keys` (needs a UIA `runtime_id`) | `src/win/agent-client.ts:19-29`, `agent/myco_agent/ops.py:30-43`, `agent/myco_agent/windows_backend.py:515-519` |
| Myco's program is 5 fixed steps; no step budget exists in `src/` | `src/tasks/calc-record-edit.ts` `programFor()`; `grep -rn 'MAX_STEPS\|maxSteps\|stepBudget' src/` empty |
| `run-live.ts` always takes parameter set 0 (`name`); the sweep driver used its own 6-seed list | `src/integration/run-live.ts:51-57`, `src/tasks/intent.ts:117-141`, `/tmp/m1-013/trial-one.ts`, runbook §7.3 |
| `pyautogui==0.9.54` is UFO's pinned input path, **not** in the guest image | `docs/research/adapters.md:153-160`; guest pip line `docs/env/windows.md:481` |
| Cold reset 134–152 s, 5/5 no wedge | `docs/coordination/m1-state.md` log 39 |
| Host contention distorts reset timing 45 s → 1879 s | logs 30, 41 |
| AutoCorrect immunity of the generator; 20/20 proof | PR #21, `docs/research/experiments/m1-013-generator-proof.md` |
| Sweep row schema and the independent audit | `/tmp/m1-013/trial-one.ts` (throwaway), runbook §7.3 |
| Installed local vision models | `ollama list` on this host, 2026-11-21: `eriktonon/gemma4-uncensored:12b`, `eriktonon/qwen3.8-uncensored:latest`, both `vision` |