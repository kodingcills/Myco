# Pre-registration (DRAFT, not frozen): confirmatory R1 on the OSWorld LibreOffice subset

> **Status: draft.** Not frozen. No data exists for it, and no run is allowed until every
> pending ruling below is settled **and parity has passed**. The canonical record is
> [`r1-public-prereg.json`](r1-public-prereg.json). Its hash, the SHA-256 of its canonical
> JSON (keys sorted, no whitespace; `preregSha256` in `src/benchmark/upstream/prereg.ts`), is
> `c80f4e4f4cce7170d3ec947a02b614581b0bb428f34a29fb1d3354b64f24abf2`.
> The parity sample [`r1-parity-sample.json`](r1-parity-sample.json) is pinned in the record by
> its hash, `b1329c467cf3a07f1e12ff7ece5cb6e76ad0d57a4441b56cc9e51a3ece692e35`.
> `test/benchmark/upstream-prereg.test.ts` recomputes both; `npx tsx
> scripts/upstream-prereg-hash.ts` prints them.
>
> `src/benchmark/upstream/prereg.ts` refuses "shown" if any of these holds (#652 rule):
> - the record misses a field the rulings require (the fleet provider, the parity section, a
>   provider that differs between arms, an arm with a changed prompt, a self-check arm not
>   pre-registered as the 18:11Z dump and model re-verify, ablations that are not labelled or
>   do not state their extra trials, the six ruling citations, and the rest);
> - the record's hash is not one of a committed pre-registration;
> - the status is draft, any lead ruling is pending, or any field still says PENDING;
> - the image is not pinned by digest;
> - there is no passed parity assessment for this record's sample;
> - any row is not LIVE, is simulated (`simulated` present and not exactly `false`), was not
>   graded by the upstream evaluate path, or any arm does not cover exactly the n tasks.

**The rulings** (all 2026-11-27, recorded in the record's `rulings` field):
- **13:55Z** ([#700, comment 7220110528](https://github.com/kodingcills/Myco/pull/700#issuecomment-7220110528), approved 14:00Z):
  each benchmark's own task configs, action server and evaluators, unmodified; Claude via the
  benchmark's standard computer-use runner; Myco adds only the completion gate, before DONE.
- **14:05Z** ([#741, comment 7220313158](https://github.com/kodingcills/Myco/pull/741#issuecomment-7220313158)):
  RETARGET to the Myco Linux fleet. OSWorld's own task configs, setup, controller and evaluators
  on lightweight Linux desktops, through a DesktopEnv provider adapter that every arm uses.
  Parity against OSWorld's reference environment before any live run. WAA stays phase 2.
- **14:37Z** ([#741, comment 7220987945](https://github.com/kodingcills/Myco/pull/741#issuecomment-7220987945)):
  the accessibility tree (GTK3 VCL plugin, AT-SPI bus before Calc) and pyautogui with
  python-xlib go into the fleet image and provider, with tests; re-measure, also actively
  driven; keep the parity harness, do not run it.
- **15:21Z** ([#741, comment 7221935698](https://github.com/kodingcills/Myco/pull/741#issuecomment-7221935698)):
  UTM is approved as the hypervisor for the parity reference run, recorded as a stated
  deviation from OSWorld's VMware reference. Never a Broadcom/VMware account.
- **15:26Z** ([#741, comment 7222035806](https://github.com/kodingcills/Myco/pull/741#issuecomment-7222035806)):
  N3, which settles `self-check-form`. Arm (c) is the stronger honest baseline: on DONE it runs
  its own shell-based re-verification of the end state through the same OSWorld controller,
  with no gate, no oracle and no Myco verdict. A found problem turns DONE into a continue on the
  same budget, mirroring the gate arm's second chance. The prompt-suffix variant may stay only as
  a secondary ablation that costs nothing extra.
- **18:11Z** (#741, relayed in the round-3 builder brief; not posted as its own comment):
  B1 fixes the self-check's form. On DONE a fixed shell command, run through the same OSWorld
  controller (`run_bash_script`), dumps the real saved content: cells or text of the files
  changed during the episode, or "not saved". The WAIT turn hands that dump back with a fixed,
  oracle-free "re-verify your work against the task using this dump" message, and the model
  judges, on the same turn, token and time budget as the gate arm. Nothing saved is not a
  refusal; ef9d12bd and the config-graded tasks must be able to pass a correct DONE. The
  round-2 fixed-probe rules and the prompt-suffix variant become labelled ablations only, with
  their extra trials stated. B2: the runner patch must not close over `env`; the hook gets a
  narrow controller handle, with tripwires on the environment and a guest-side check that does
  not rely on the probe hash.

## What this draft fixes (before any results)

| Item | Value |
|---|---|
| **Task set** | `osworld-office-v1`, OSWorld @ `0ad41bee56565efe7bb3c3a5ebc67590a1b8276f` |
| **Harness** | OSWorld's own `DesktopEnv` (`desktop_env/desktop_env.py`) and controller (`PythonController`), talking to OSWorld's own `desktop_env/server` at the pin, run unmodified inside each fleet desktop. Every harness file is pinned by SHA-256 (`src/benchmark/upstream/pins.ts`, `OSWORLD_HARNESS`). |
| **Provider (14:05Z)** | `myco-fleet`: `src/benchmark/upstream/fleet/myco_fleet_provider.py`, one container per desktop from the image `src/benchmark/upstream/fleet/Dockerfile`, a fresh container per task. Image digest: PENDING (the coordinator builds it). Registered by a documented patch (`desktop_env_providers.patch`) that adds the name to OSWorld's provider registry and clean-start set, nothing else. The fleet files are pinned (`MYCO_FLEET`), and a run on any other provider, image or bytes is ungradable. |
| **Agent runner** | `scripts/python/run_multienv_claude.py` at that commit. It runs `lib_run_single.py#run_single_example` with `mm_agents/anthropic/main.py#AnthropicAgent`. The only changes are the DONE gate hook and the `myco-fleet` provider choice, through the documented patch surface ([gate-hook.md](gate-hook.md)). |
| **Model** | PENDING: the exact Claude model id passed as `--model`. |
| **Action layer** | **OSWorld controller, identical across arms.** Action space `claude_computer_use`, observation `screenshot`, executed by `PythonController`. The same runner, environment, provider, image digest, controller, action space, observation type and budget in every arm. The hook never touches the environment. It changes one thing only: a refused DONE becomes upstream's own `WAIT` (a no-op in the guest). |
| **Gate interception** | In `run_single_example`'s loop, between `agent.predict` and `env.step`. On DONE, the hook calls `myco.gate/v1` (`myco_gate_check`) with `taskId`, `runId` and `claim` only. A `verified` verdict with `accepted: true` lets DONE through. Anything else replaces DONE with WAIT and sends the agent the verdict and reason codes only. A gate that cannot be reached, or a malformed reply, counts as not accepted (fail closed). |
| **Arms** | (a) `no-gate`: the standard runner, no gate. (b) `gate-before-done`: DONE is accepted only on a verified gate verdict. (c) `self-check`, the primary self-check arm (18:11Z, below): on the first DONE, a fixed dump of the saved content through the same controller, handed back on the WAIT turn for the model to re-verify; its next DONE goes through. No gate, no oracle, no Myco verdict. All three use the same runner, prompt, provider, controller, action space and budget. |
| **Self-check arm (18:11Z)** | **What it runs:** `SELF_CHECK_DUMP` in `src/gate-hooks/osworld/myco_done_gate.py` (SHA-256 pinned in `arms[2].selfCheck.dumpSha256`), sent once per episode, on the first DONE, through `ControllerHandle.run_bash_script`. The runner patch builds the handle from the provider's address getter, the image reference and upstream's `PythonController` class; each call builds that controller from the address the provider reports, as `DesktopEnv` builds `env.controller`, so it reaches the same `desktop_env/server`. Nothing in the handle closes over `env`. **Input:** the seconds since the episode started. **The dump:** each document file under the guest home modified during the episode (no hidden directory or file, no link, no other mount, at most 4 levels deep, at most 20 files), with path, size and save time, then its content: cells by reference with formulas, paragraphs, slide text, leading text of csv/txt/rtf; binary formats named only. At most 2,000 characters per file, 6,000 in all. Or "NOT SAVED". **On the first DONE:** WAIT, then one user message: the fixed re-verify text and the dump. **The model judges:** its next DONE goes through. **Nothing saved** is never a refusal, so ef9d12bd and the tasks graded from `~/.config/libreoffice` pass a correct DONE (tested). **Fail closed:** if the dump cannot be produced, the re-verify turn still happens with the dump marked `DUMP_UNAVAILABLE`. **May read:** the guest home directory as above, and the hook's own clock. **May never read:** the gate or any oracle, OSWorld's task configuration, gold files or the cache, fixtures or any ground truth, the evaluator's code or output (`result.txt`, scores), the environment object or anything reached through it, the provider beyond its address getter, or any controller method but `run_bash_script`. Enforced statically and at runtime (`test/benchmark/independence.test.ts`, `test/benchmark/osworld-gate-hook.test.ts`). **Budget parity:** the re-verify turn is the first DONE's own turn (WAIT, one step), as a refused DONE in (b); taken once per episode. The dump makes no model call; its text (at most 6,000 characters) enters the next turn's input, as the gate's feedback does. Exactly one `run_bash_script` call per episode. One attempt is allowed 120 s (a 20 s script timeout plus the controller's fixed 100 s HTTP margin), the gate client's timeout. Upstream retries a non-200 reply or a connection error 3 times with 5 s pauses, so an unreachable desktop can hold the call for at most 375 s before it fails closed; that time counts against the shared wall clock and can fall only on (c). |
| **Ablations (18:11Z)** | Labelled ablations, never the headline baseline, never in the analysis (rows from them are refused): `self-check-rules`, the round-2 fixed probe (probe SHA-256 `e12a3208…`, implemented as a runner arm; its `NOTHING_SAVED` rule refuses correct DONEs where OSWorld's postconfig saves, and no DONE can pass on ef9d12bd), and `self-check-prompt-suffix`, the round-1 prompt paragraph (not implemented at this head). **Each costs 117 extra trials if run**; neither runs unless separately approved. |
| **Budget** | PENDING: one budget shared by all arms. It covers `--max_steps`, `--max_tokens`, `--thinking`, `--max_trajectory_length` and a wall-clock cap. A refused DONE uses the step it was emitted in, in arms (b) and (c) alike. |
| **Subset rule** | Every task id that OSWorld's `evaluation_examples/test_all.json` lists at the pin under `libreoffice_calc`, `libreoffice_writer` and `libreoffice_impress`, run in OSWorld's own DesktopEnv on the `myco-fleet` provider. There is no Myco placement filter. No task is added or dropped for difficulty, outcome or evaluator type. |
| **Subset size, n** | 117 (calc 47, writer 23, impress 47; 2 of them `infeasible`). Exclusions: none. One trial per task, per arm. |
| **Grader** | `osworld-desktopenv-evaluate@0ad41bee…`: upstream's evaluation path, unmodified. `DesktopEnv.evaluate()` runs the postconfig, its own getters (through the controller) and its own metrics, applying the FAIL-action rule. `run_single_example` then writes the score to `result.txt`. Myco only reads that file (`src/benchmark/upstream/r1-grade.ts`). Pass means a score of exactly 1.0. |
| **Parity (14:05Z, 15:21Z)** | **Parity must pass before any live run.** Five pre-declared tasks ([r1-parity-sample.json](r1-parity-sample.json): calc 2, writer 2, impress 1), each with a scripted known-good and known-bad action sequence, scored by upstream `DesktopEnv.evaluate()` on the fleet and on the reference, recorded per task (`src/benchmark/upstream/fleet/osworld_parity.py`; analysis `src/benchmark/upstream/parity.ts`). Reference: OSWorld's own `Ubuntu-arm.zip`, its controller and evaluator unchanged, booted in **UTM (QEMU with HVF)**. **Stated deviation** from OSWorld's VMware reference: only the hypervisor differs. Not run: it waits for Tiffany's OK and the ~40 GB disk question ([host-requirements.md](host-requirements.md)). |
| **Gate oracle** | PENDING: this is the main build item. **Constraint:** the gate's oracle must be independent of the upstream evaluator. It may not import or share code with it, and it may not read evaluator output (`result.txt`, scores) or gold files. `test/benchmark/independence.test.ts` enforces this for `src/gate` and `src/gate-hooks`. |
| **False done** | The agent says DONE, and OSWorld's evaluate path scores the end state below the threshold, or the run is ungradable. In arm (b), the gate either caught it (did not accept) or did not (accepted: a false accept). |
| **Primary outcome** | False accepts in arm (b). The bar is 0, reported with the Wilson 95% upper bound. An accepted claim that the evaluator cannot grade counts against the bar. |
| **Secondary outcomes** | Each arm's false-done rate and success rate, under the same grader. Paired tables, (b) vs (a) and (b) vs (c), each with an exact sign test (called underpowered below 6 discordant pairs). Cost per verified task per arm (the R7 rule). Every arm must cover all n tasks. |
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
7. **`parity-reference-run`.** The reference run waits for Tiffany's OK and the ~40 GB disk
   question (15:21Z).
8. **`model-access`.** The pinned runner calls the Anthropic API (or Bedrock or Vertex) with
   a key. M2's rule is $0 API spend, on the Claude Ultra plan.

The `host` item is settled by the 14:05Z ruling: the Myco fleet is the R1 host. The
`self-check-form` item is settled by the 15:26Z ruling (N3), and its form by the 18:11Z
ruling. The namespace-desktop `harness` item from the #700 draft is gone.

## Known property of the ground truth (a finding, not a fix)

Upstream evaluators can be lenient. On MOCK input, WAA's `compare_table` accepts the unpadded
id `45678` where the gold file has `0045678` (`test/benchmark/upstream-evaluator.test.ts`).
A false done that the upstream evaluator scores as a pass cannot be seen by this R1. Using
the upstream evaluator as ground truth means accepting that limit.
