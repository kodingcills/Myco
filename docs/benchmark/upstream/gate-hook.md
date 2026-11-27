# The DONE gate hook for OSWorld's Claude runner

> Code and design only. No run has used this hook, and it has never touched a VM or a model.
> Tests use scripted fakes (MOCK).

Under the lead's 13:55Z ruling, Myco adds only the completion gate, before DONE is accepted.
Everything else is OSWorld's own: `DesktopEnv`, the controller and its server, the evaluator
and the standard Claude runner, at `0ad41bee56565efe7bb3c3a5ebc67590a1b8276f`. Since the 14:05Z
ruling the desktops are the Myco Linux fleet (the `myco-fleet` provider, the same in every arm;
[host-requirements.md](host-requirements.md)). This page covers:

- where the gate hooks in;
- what changes between arms;
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

`DoneGate` wraps the agent object and nothing else. It never sees the environment, the
controller or the evaluator.

| | `no-gate` (a) | `gate-before-done` (b) | `self-check` (c) |
|---|---|---|---|
| Actions handed to `env.step` | the agent's, unchanged | the agent's, unchanged, except a refused DONE | the agent's, unchanged |
| Observations handed to the agent | the environment's | the environment's | the environment's |
| On DONE | accepted as upstream accepts it | `myco_gate_check` called with `taskId`, `runId` and `claim` only; DONE passes only on `verified` with `accepted: true` | accepted as upstream accepts it |
| On a refused DONE | — | DONE becomes upstream's own `WAIT` (a no-op in the guest); the next turn starts with one user message giving the verdict and reason codes only | — |
| Prompt | upstream's | upstream's | upstream's, plus the pre-registered self-check text, set through AnthropicAgent's own `system_prompt_suffix` |
| Step budget | `--max_steps` | `--max_steps` (a refused DONE uses its turn) | `--max_steps` |

**Fail closed.** These all count as "not accepted":

- an unreachable gate;
- a malformed reply;
- a reply without `apiVersion: "myco.gate/v1"`;
- `accepted: true` with any verdict other than `verified`;
- `verified` with `accepted` not `true`.

**Arms by configuration only.** A gate object passed to arm (a) or (c) raises an error, and
arm (b) without a gate raises an error.

**Batches.** Actions after a refused DONE in the same batch are dropped. Upstream would have
ended the episode at the DONE, so none of them would have run.

**One trial per gate.** `wrap_agent` is called once per task, with that task's `taskId` and
`runId`. The operator's gate command is bound to that trial.

`test/benchmark/osworld-gate-hook.test.ts` proves, with fakes, that:

- the actions and observations are byte-identical across arms;
- the request has exactly three keys;
- the agent gets codes only;
- the hook fails closed;
- the budget is unchanged.

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
   becomes `run_single_example(myco_wrap_agent(agent, args.myco_arm, ...), ...)`.

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

## Arm (c)'s form: pending ruling `self-check-form` (round-1 verdict N3)

Arm (c) today is a prompt suffix: the pre-registered self-verification text, appended through
AnthropicAgent's own `system_prompt_suffix`. Arm (b) differs from it in two ways at once: (b)
has an oracle, and (b) also gets a structural second chance (a refused DONE becomes WAIT, plus
one feedback turn). So (b) vs (c) mixes "an oracle" with "an extra forced turn after DONE".

**The structural alternative**, for the lead to rule on (not built):
- intercept the agent's **first** DONE exactly as the gate does (DONE becomes WAIT), with no
  gate and no oracle;
- give the agent one fixed, oracle-free user message, the same every time: "Re-check the saved
  file against every requirement of the task, then finish again";
- accept the next DONE unconditionally; the same `--max_steps` budget in every arm.

**Trade-offs:**
- *For:* it isolates the oracle's contribution. (b) vs structural (c) differ only in whether
  the second-chance turn is triggered by an oracle verdict (with codes) or always. It is the
  stronger honest baseline (REAL-NUMBERS rule 2): any model gets the same forced re-check.
- *Against:* it is a Myco-designed intervention, like the suffix, and it costs one extra turn
  on every episode, including ones that were already correct (the gate costs a turn only on a
  refusal). Upstream's runner has no such mode, so it adds to the patch surface. And it changes
  the meaning of (c)'s false-done rate: a false done must survive a forced re-check.
- *Option:* run both forms (four arms). That raises trials from 351 to 468 at n = 117.

The current pre-registration keeps the prompt-suffix arm and lists `self-check-form` as a
pending ruling, so "shown" is refused until the lead decides.

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
import only `json` and `subprocess`. No file under `src/benchmark/upstream` may name the gate
or the hook.

**Open design question for the oracle:** how the gate reads the persisted document. The
agent's file lives in OSWorld's guest. The gate's evidence reader needs a copy of it that
the agent cannot write and that does not pass through the evaluator's getters. One option is
the controller's own file endpoint, which is the action server, not the evaluator. That
choice belongs with the oracle ruling.
