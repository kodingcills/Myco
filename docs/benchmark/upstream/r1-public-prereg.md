# Pre-registration (DRAFT, not frozen): confirmatory R1 on the OSWorld LibreOffice subset

> **Status: draft.** Not frozen. No data exists for it, and no run is allowed until every
> pending ruling below is settled. The canonical record is
> [`r1-public-prereg.json`](r1-public-prereg.json). Its hash, the SHA-256 of its canonical
> JSON (keys sorted, no whitespace; `preregSha256` in `src/benchmark/upstream/prereg.ts`), is
> `0a805a02130e6b29a04926e0466fe61b2c9a961d2152f6af46ed20985eca6e43`.
> `test/benchmark/upstream-prereg.test.ts` recomputes it.
>
> `src/benchmark/upstream/prereg.ts` refuses "shown" if any of these holds (#652 rule):
> - the record misses a field the harness ruling requires;
> - the status is draft;
> - any lead ruling is pending;
> - any field still says PENDING.

**The ruling.** Lead ruling 2026-11-27 ~13:55Z, approved at 14:00Z
([#700, comment 7220110528](https://github.com/kodingcills/Myco/pull/700#issuecomment-7220110528)):
- Use each benchmark's own environment, action server and evaluators, unmodified.
- The agent is Claude, run by the benchmark's standard computer-use agent runner.
- Myco adds only the completion gate, before DONE is accepted.

## What this draft fixes (before any results)

| Item | Value |
|---|---|
| **Task set** | `osworld-office-v1`, OSWorld @ `0ad41bee56565efe7bb3c3a5ebc67590a1b8276f` |
| **Harness** | OSWorld's own `DesktopEnv` (`desktop_env/desktop_env.py`), its provider, and its in-VM controller (`desktop_env/controllers/python.py#PythonController`), at that commit. Providers the pinned runner accepts: `aws`, `virtualbox`, `vmware`, `docker`, `azure`, `pyromind`. Which one is used is pending (`host`). Every harness file is pinned by SHA-256 (`src/benchmark/upstream/pins.ts`, `OSWORLD_HARNESS`). |
| **Agent runner** | `scripts/python/run_multienv_claude.py` at that commit. It runs `lib_run_single.py#run_single_example` with `mm_agents/anthropic/main.py#AnthropicAgent`. The only change is the DONE gate hook, wired through the documented patch surface ([gate-hook.md](gate-hook.md)). |
| **Model** | PENDING: the exact Claude model id passed as `--model`. |
| **Action layer** | Action space `claude_computer_use`, observation `screenshot`, executed by `PythonController`. **The action layer is identical across arms:** the same runner, environment, controller, action space, observation type and budget. The hook never touches the environment. It changes one thing only: a refused DONE becomes upstream's own `WAIT` (a no-op in the guest). |
| **Gate interception** | In `run_single_example`'s loop, between `agent.predict` and `env.step`. On DONE, the hook calls `myco.gate/v1` (`myco_gate_check`) with `taskId`, `runId` and `claim` only. A `verified` verdict with `accepted: true` lets DONE through. Anything else replaces DONE with WAIT and sends the agent the verdict and reason codes only. A gate that cannot be reached, or a malformed reply, counts as not accepted (fail closed). |
| **Arms** | (a) `no-gate`: the standard runner, no gate. (b) `gate-before-done`: DONE is accepted only on a verified gate verdict. (c) `self-check`: the strongest honest self-check baseline, a prompt-level self-verification text through AnthropicAgent's own `system_prompt_suffix`, with no gate. All three use the same runner, controller, action space and budget. |
| **Budget** | PENDING: one budget shared by all arms. It covers `--max_steps`, `--max_tokens`, `--thinking`, `--max_trajectory_length` and a wall-clock cap. A refused DONE uses the step it was emitted in. |
| **Subset rule** | Every task id that OSWorld's `evaluation_examples/test_all.json` lists at the pin under `libreoffice_calc`, `libreoffice_writer` and `libreoffice_impress`. Every task runs in OSWorld's own DesktopEnv. There is no Myco placement filter. No task is added or dropped for difficulty, outcome or evaluator type. |
| **Subset size, n** | 117 (calc 47, writer 23, impress 47; 2 of them `infeasible`). Exclusions: none. One trial per task, per arm. |
| **Grader** | `osworld-desktopenv-evaluate@0ad41bee…`: upstream's evaluation path, unmodified. `DesktopEnv.evaluate()` runs the postconfig, its own getters (through the controller) and its own metrics, applying the FAIL-action rule. `run_single_example` then writes the score to `result.txt`. Myco only reads that file (`src/benchmark/upstream/r1-grade.ts`). It refuses any run whose harness bytes differ from the pin. Pass means a score of exactly 1.0. |
| **Gate oracle** | PENDING: this is the main build item. **Constraint:** the gate's oracle must be independent of the upstream evaluator. It may not import or share code with it, and it may not read evaluator output (`result.txt`, scores) or gold files. `test/benchmark/independence.test.ts` enforces this for `src/gate` and `src/gate-hooks`. |
| **False done** | The agent says DONE, and OSWorld's evaluate path scores the end state below the threshold, or the run is ungradable. In arm (b), the gate either caught it (did not accept) or did not (accepted: a false accept). |
| **Primary outcome** | False accepts in arm (b). The bar is 0, reported with the Wilson 95% upper bound. An accepted claim that the evaluator cannot grade counts against the bar. |
| **Secondary outcomes** | Each arm's false-done rate and success rate, under the same grader. Paired tables, (b) vs (a) and (b) vs (c), each with an exact sign test (called underpowered below 6 discordant pairs). Cost per verified task per arm (the R7 rule). |
| **Evidence rules** | Only LIVE rows count, and only when OSWorld's evaluate path at the pin graded them. MOCK, scripted and simulated rows are refused, and so are rows from the MOCK metric runner (`upstream-metric-mock/1`). Every result line states the task set, n, model, baseline, grader, and whether it is live or mock. |
| **Phase 2** | WAA office subset (64 tasks @ eb220c4dcf64) via WAA's own Windows 11 image, in-VM server, evaluators and runner: deferred, not dropped. |

## Pending lead rulings (the analysis refuses "shown" while any remain)

1. **`asset-license`.** OSWorld's own setup downloads the seed and gold files from
   `xlangai/ubuntu_osworld_file_cache`, whose terms are unclear (README §1).
2. **`model`.** The exact Claude model id.
3. **`budget`.** The shared step, token, thinking and wall-clock budget.
4. **`n`.** 117 is proposed (every task, one trial each). It is not ratified, and whether to
   add repetitions is open.
5. **`pass-threshold`.** A score of exactly 1.0 is proposed as a pass.
6. **`gate-oracle`.** The gate's oracle family for these end states, independent of the
   upstream evaluator.
7. **`host`.** Which provider and machine run OSWorld's VM. A second VM or any paid box needs
   Tiffany's OK. See [host-requirements.md](host-requirements.md).
8. **`model-access`.** The pinned runner calls the Anthropic API (or Bedrock or Vertex) with
   a key. M2's rule is $0 API spend, on the Claude Ultra plan.

The namespace-desktop `harness` item from the #700 draft is gone. Under the ruling, OSWorld's
own environment provides the display, the postconfig and the getters.

## Known property of the ground truth (a finding, not a fix)

Upstream evaluators can be lenient. On MOCK input, WAA's `compare_table` accepts the unpadded
id `45678` where the gold file has `0045678` (`test/benchmark/upstream-evaluator.test.ts`).
A false done that the upstream evaluator scores as a pass cannot be seen by this R1. Using
the upstream evaluator as ground truth means accepting that limit.
