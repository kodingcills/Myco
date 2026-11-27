# The DONE gate hook for OSWorld's Claude runner

> Code and design only. No run has used this hook, and it has never touched a VM or a model.
> Tests use scripted fakes (MOCK).

Under the lead's 13:55Z ruling, Myco adds only the completion gate, before DONE is accepted.
Everything else is OSWorld's own: `DesktopEnv`, the controller and its server, the evaluator
and the standard Claude runner, at `0ad41bee56565efe7bb3c3a5ebc67590a1b8276f`. Since the 14:05Z
ruling the desktops are the Myco Linux fleet (the `myco-fleet` provider, the same in every arm;
[host-requirements.md](host-requirements.md)). This page covers:

- where the gate hooks in;
- what changes between arms, including the self-check arm the lead ruled at 15:26Z (N3);
- the exact change the pinned runner needs;
- the design constraint on the gate's oracle.

## Where DONE happens upstream

The runner drives each task through `lib_run_single.run_single_example(agent, env, ...)`, at
the pin. That function runs a loop, then grades:

1. **Predict.** `agent.predict(instruction, obs)` returns a list of actions.
   `AnthropicAgent` (`mm_agents/anthropic/main.py`) returns
   `[{"action_type": "DONE", ...}]` when Claude ends its turn without a tool call.
2. **Step.** Each action goes to `env.step(action)`. A DONE or FAIL action ends the episode.
3. **Grade.** After the loop, `result = env.evaluate()`. The score is written to `result.txt`.

## The hook (`src/gate-hooks/osworld/myco_done_gate.py`)

`DoneGate` wraps the agent object. It never sees the environment or the evaluator. Only arm
(c) is given the controller, as a getter, and it calls only `run_bash_script` on it.

| | `no-gate` (a) | `gate-before-done` (b) | `self-check` (c) |
|---|---|---|---|
| Actions handed to `env.step` | the agent's, unchanged | the agent's, unchanged, except a refused DONE | the agent's, unchanged, except a refused DONE |
| Observations handed to the agent | the environment's | the environment's | the environment's |
| On DONE | accepted as upstream accepts it | `myco_gate_check` called with `taskId`, `runId` and `claim` only; DONE passes only on `verified` with `accepted: true` | the pinned probe runs through the controller's `run_bash_script`; DONE passes only if it reports no problem |
| On a refused DONE | — | DONE becomes upstream's own `WAIT` (a no-op in the guest); the next turn starts with one user message giving the verdict and reason codes only | the same: `WAIT`, then one fixed user message with the probe's codes only |
| Prompt | upstream's | upstream's | upstream's |
| Step budget | `--max_steps` | `--max_steps` (a refused DONE uses its turn) | `--max_steps` (a refused DONE uses its turn) |
| One check's time allowance | — | 120 s (the gate client's timeout) | 120 s (20 s script timeout + the controller's fixed 100 s HTTP margin) |

**Fail closed.** These all count as "not accepted":

- an unreachable gate;
- a malformed reply;
- a reply without `apiVersion: "myco.gate/v1"`;
- `accepted: true` with any verdict other than `verified`;
- `verified` with `accepted` not `true`.

**Fail closed in arm (c).** A controller that raises or returns nothing, a non-zero exit, or
output without the probe's final records is `RECHECK_UNAVAILABLE`, and the DONE is refused.

**Arms by configuration only.** A gate object passed to arm (a) or (c) raises an error, and
so does arm (b) without a gate. A controller passed to arm (a) or (b) raises an error, and so
does arm (c) without one. The runner patch passes the same controller getter in every arm, and
`wrap_agent` keeps it for arm (c) only.

**Batches.** Actions after a refused DONE in the same batch are dropped. Upstream would have
ended the episode at the DONE, so none of them would have run.

**One trial per gate.** `wrap_agent` is called once per task, with that task's `taskId` and
`runId`. The operator's gate command is bound to that trial.

`test/benchmark/osworld-gate-hook.test.ts` proves, with fakes, that:

- the actions and observations are byte-identical across arms;
- the request has exactly three keys;
- the agent gets codes only;
- the hook fails closed;
- the budget is unchanged;
- arm (c)'s self-check refuses DONE at the same place the gate does, sends only the pinned probe
  and touches nothing else (see below).

With a pinned OSWorld checkout (the `upstream evaluators` CI job), it proves the same
through upstream's real `run_single_example`. There, `env.evaluate()`'s return value is what
upstream writes to `result.txt`, and that is what `src/benchmark/upstream/r1-grade.ts` reads.

## Patch surface (documented, not applied)

The pinned runner constructs `AnthropicAgent` inline and passes it straight to
`run_single_example`. There is no hook point, so the agent cannot be wrapped without
changing upstream code. This repository vendors and modifies no upstream code. The change
is therefore recorded as a patch,
[`src/gate-hooks/osworld/run_multienv_claude.gate.patch`](../../../src/gate-hooks/osworld/run_multienv_claude.gate.patch),
to be applied to a pinned checkout only when a run is approved. It makes four changes to
`scripts/python/run_multienv_claude.py`:

0. **Provider choice.** `--provider_name` also accepts `myco-fleet`, the Myco Linux fleet
   provider every arm uses (14:05Z ruling).

1. **Imports.** It imports `ARMS` and `wrap_agent` from `myco_done_gate`, with the hook's
   directory on `PYTHONPATH`, and imports `shlex`.
2. **Flags.** It adds three: `--myco_arm` (required; one of the three arms),
   `--myco_gate_cmd` (the operator's gate server command; `{taskId}` and `{runId}` are filled
   in per task) and `--myco_run_prefix` (required).
3. **Wrapping.** Inside the per-task loop, `lib_run_single.run_single_example(agent, ...)`
   becomes `run_single_example(myco_wrap_agent(agent, args.myco_arm, ..., controller=lambda:
   env.controller), ...)`. The getter is the same in every arm. `wrap_agent` keeps it for arm
   (c) only, which reads the environment's current controller at check time (the environment
   rebuilds it when it restarts a desktop). Nothing else of the environment, and never the
   task configuration (`example`), reaches the hook.

Nothing else changes: not the environment, not the controller, not the loop, not the
evaluator. All three arms run this same patched runner. The patched runner's SHA-256 is
pinned (`OSWORLD_HARNESS.patchedAgentRunnerSha256`), and the R1 grader refuses a run whose
recorded runner digest is anything else. The CI job checks that the patch applies to a fresh
pinned clone and produces exactly that digest (`test/benchmark/upstream-r1-grade.test.ts`).

A second patch,
[`src/benchmark/upstream/fleet/desktop_env_providers.patch`](../../../src/benchmark/upstream/fleet/desktop_env_providers.patch),
registers the providers: it adds `myco-fleet` and `utm-reference` (parity reference only) to
`desktop_env/providers/__init__.py`, and adds the two names to `DesktopEnv`'s clean-start and
dirty-start provider sets in `desktop_env/desktop_env.py`. It changes nothing else; the CI job
checks that `DesktopEnv.evaluate` is byte-identical after it. Both patched digests are pinned
(`OSWORLD_HARNESS.patchedFiles`), and so are the fleet's own files (`MYCO_FLEET.files`): the R1
grader refuses a run on any other bytes, any other provider, or an image not pinned by digest.

## Arm (c): the self-check, the stronger honest baseline (lead ruling 15:26Z, N3)

The lead ruled `self-check-form` at 15:26Z
([#741, comment 7222035806](https://github.com/kodingcills/Myco/pull/741#issuecomment-7222035806)).
Arm (c) is no longer a prompt suffix. It mirrors arm (b)'s structural second chance with a
best-effort check of its own, so (b) against (c) compares an independent oracle with honest
self-verification at the same budget.

**On DONE.** The hook runs one fixed bash script, `SELF_CHECK_PROBE` in
`myco_done_gate.py`. Its SHA-256 is pinned in the pre-registration
(`arms[2].selfCheck.probeSha256`). The script goes through upstream's own
`PythonController.run_bash_script`, which posts to the controller's `/run_bash_script`
endpoint. OSWorld's server runs it in the fleet desktop as the guest user. Only two lines of
the script differ between tasks:
- `elapsed`: the whole seconds since the episode started, measured by the hook from the
  agent's reset (no guest clock is trusted);
- `names`: up to 10 file names with a document extension that the instruction mentions. In
  the pre-registered task set, 3 of the 117 instructions name one (`pre.pptx`,
  `age-reference-date.txt`, `4.3-Template_4.29.2016.pptx`).

The script reads only `$HOME` in the guest, at most 4 levels deep, never inside a hidden
directory. It prints one record per finding, and the hook turns the records into codes:

| Code | When |
|---|---|
| `SAVED_FILE_MISSING` | A file named in the instruction is not under the home directory. |
| `SAVED_FILE_FORMAT_MISMATCH` | A named file that was found, or a document saved during the episode, does not match its extension. `.xlsx`/`.docx`/`.pptx` must be an Office Open XML container (listed with `python3 -m zipfile -l`), `.ods`/`.odt`/`.odp` an OpenDocument container, `.pdf` must start with `%PDF-`, and other document types must be readable. |
| `NOTHING_SAVED` | No document under the home directory was modified during the episode. |
| `RECHECK_UNAVAILABLE` | The probe could not run or did not finish (fail closed, as the gate arm fails closed). |

**On a problem.** No codes means DONE passes unchanged. Any code means DONE becomes `WAIT`,
and the next turn starts with one fixed message: "Self-check: your DONE was not accepted. A
re-check of the saved files in your home directory found a problem (codes ...). Continue
working; when you believe the task is done, finish again." The check runs on every DONE, as
the gate does.

**Budget parity.** The re-verification is counted exactly as the gate's check is counted:
- it runs inside the turn of the DONE it checks, and a refused DONE uses that turn;
- the probe costs no step and no model tokens, and the message's tokens count in the next
  turn, as the gate's feedback does;
- its time counts against the shared wall-clock cap;
- one check is allowed 120 s in both arms. For the probe, that is a 20 s script timeout plus
  the controller's fixed 100 s HTTP margin; for the gate, the client's 120 s timeout.

**May read:** the instruction's file names; the guest home directory outside hidden
directories (names, modification times, leading bytes, container listings); the hook's own
clock.

**May never read:**
- the gate or any oracle;
- OSWorld's task configuration (the example JSON: its evaluator, expected values, setup or
  postconfig);
- gold files or the DesktopEnv cache;
- fixtures or any other ground truth;
- the evaluator's code (`desktop_env` evaluators, metrics, getters, `DesktopEnv.evaluate`) or
  its output (`result.txt`, scores);
- the environment object, or any controller method other than `run_bash_script`.

**Enforcement:**
- Statically, `test/benchmark/independence.test.ts` checks the hook's imports and that its code,
  probe included, names none of those and calls only `run_bash_script` on the controller.
- At runtime, `test/benchmark/osworld-gate-hook.test.ts` runs the probe under real bash against
  prepared homes. A Python audit hook records any host file open, directory listing, process
  launch or socket connect during a self-check turn. Tripwires sit on the agent's `env` and on
  every controller attribute except `run_bash_script`. Every script that reaches the controller
  must equal the pinned probe, with only the two inputs filled in. Planted gold, score-file and
  evaluator reads show that the tripwires bite.

**Known limits** (pre-registered, not fixed):
- the format rule checks the container type, not the ODF mimetype value, so an ODF text
  document saved as `.ods` passes;
- a name with spaces is cut at the last space (`Q3 data.xlsx` is looked for as `data.xlsx`);
- a document saved deeper than 4 levels or in a hidden directory is not seen.

Each limit can only make the check miss a problem or flag one that is not there; none widens
what it reads. A wrong
`SAVED_FILE_MISSING` costs turns, as a wrong gate refusal does. The probe has not yet run on
a real fleet desktop; that check belongs with the measurement run (follow-up).

**No secondary ablation.** The prompt-suffix variant could stay only if it cost nothing extra.
It would need its own arm, which is 117 more trials at n = 117 (351 to 468), so it is dropped.
No arm changes the prompt.

## The gate's oracle (pending ruling `gate-oracle`; the main build item)

Today the gate has no oracle family for OSWorld LibreOffice end states. The constraint,
whatever family is chosen:

- **No import** of OSWorld's evaluator: the `desktop_env` package, its metrics, its getters
  or `DesktopEnv`.
- **No shared code** with Myco's upstream modules (`src/benchmark/upstream/`).
- **No reading** of evaluator output (`result.txt`, scores) or of gold files (`cloud_file`
  expected assets).

`test/benchmark/independence.test.ts` enforces this both ways. No file under `src/gate` or
`src/gate-hooks` may import or name the evaluator, its output or gold files, and the hook may
import only `json`, `re`, `shlex`, `subprocess` and `time`. No file under `src/benchmark/upstream` may name the gate
or the hook.

**Open design question for the oracle:** how the gate reads the persisted document. The
agent's file lives in OSWorld's guest. The gate's evidence reader needs a copy of it that
the agent cannot write and that does not pass through the evaluator's getters. One option is
the controller's own file endpoint, which is the action server, not the evaluator. That
choice belongs with the oracle ruling.
