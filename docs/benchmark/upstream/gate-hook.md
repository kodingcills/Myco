# The DONE gate hook for OSWorld's Claude runner

> Code and design only. No run has used this hook, and it has never touched a VM or a model.
> Tests use scripted fakes (MOCK).

Under the lead's 13:55Z ruling, Myco adds only the completion gate, before DONE is accepted.
Everything else is OSWorld's own: `DesktopEnv`, the controller and its server, the evaluator
and the standard Claude runner, at `0ad41bee56565efe7bb3c3a5ebc67590a1b8276f`. Since the 14:05Z
ruling the desktops are the Myco Linux fleet (the `myco-fleet` provider, the same in every arm;
[host-requirements.md](host-requirements.md)). This page covers:

- where the gate hooks in;
- what changes between arms, including the primary self-check arm the lead ruled at 15:26Z
  and 18:11Z, and its labelled ablations;
- the exact change the pinned runner needs, and what it hands the hook (18:11Z, B2);
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

`DoneGate` wraps the agent object. It is never given the environment or the evaluator. Only
the self-check arms are given a controller, and only as a `ControllerHandle` (below), whose one
call is `run_bash_script`.

| | `no-gate` (a) | `gate-before-done` (b) | `self-check` (c) |
|---|---|---|---|
| Actions handed to `env.step` | the agent's, unchanged | the agent's, unchanged, except a refused DONE | the agent's, unchanged, except the first DONE |
| Observations handed to the agent | the environment's | the environment's | the environment's |
| On DONE | accepted as upstream accepts it | `myco_gate_check` called with `taskId`, `runId` and `claim` only; DONE passes only on `verified` with `accepted: true` | first DONE: the pinned dump runs once through the handle's `run_bash_script`, and the DONE becomes the re-verify turn; any later DONE passes unchanged (the model has judged) |
| On a refused DONE | — | DONE becomes upstream's own `WAIT` (a no-op in the guest); the next turn starts with one user message giving the verdict and reason codes only | the same `WAIT`; the next turn starts with one user message: the fixed re-verify text and the dump |
| Prompt | upstream's | upstream's | upstream's |
| Step budget | `--max_steps` | `--max_steps` (a refused DONE uses its turn) | `--max_steps` (the re-verify DONE uses its turn) |
| Checks per episode | — | one per DONE | exactly one `run_bash_script` call, on the first DONE |
| One check's time allowance | — | 120 s (the gate client's timeout, one subprocess call, no retry) | 120 s per attempt (20 s script timeout + the controller's fixed 100 s HTTP margin); upstream retries a non-200 or connection error, so at most 375 s if the desktop is unreachable |

**Fail closed.** These all count as "not accepted" in arm (b):

- an unreachable gate;
- a malformed reply, or a stdio result with no `structuredContent`;
- a reply without `apiVersion: "myco.gate/v1"`;
- `accepted: true` with any verdict other than `verified`;
- `verified` with `accepted` anything but exactly `true` (`1` and `"true"` are refused).

**Fail closed in arm (c).** A controller that raises or returns nothing, a non-zero exit, or
output without the dump's final `END` record gives no dump. The first DONE still becomes the
re-verify turn, with the dump marked `DUMP_UNAVAILABLE`: a first DONE never passes unchecked.

**Arms by configuration only.** A gate object passed to any arm but (b) raises an error, and so
does arm (b) without a gate. A controller passed to arm (a) or (b) raises an error, and so do
the self-check arms without a `ControllerHandle` (a plain callable, such as the round-2
`lambda: env.controller`, is refused). The runner patch passes the same handle in every arm,
and `wrap_agent` keeps it for the self-check arms only.

**Batches.** Actions after a refused DONE in the same batch are dropped. Upstream would have
ended the episode at the DONE, so none of them would have run.

**One trial per gate.** `wrap_agent` is called once per task, with that task's `taskId` and
`runId`. The operator's gate command is bound to that trial.

`test/benchmark/osworld-gate-hook.test.ts` proves, with fakes, that:

- the actions and observations are byte-identical across arms, except arm (c)'s one re-verify
  `WAIT`, which sits exactly where arm (b)'s refusal sits;
- the request has exactly three keys;
- the agent gets codes only from the gate, and only the fixed text and the dump from the
  self-check;
- the hook fails closed;
- the budget is unchanged, and the self-check makes one call per episode;
- the self-check touches nothing but the guest home (see below).

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
1. **Imports.** It imports upstream's own `PythonController` (as `MycoPythonController`), and
   `RUNNER_ARMS`, `ControllerHandle` and `wrap_agent` from `myco_done_gate` (with the hook's
   directory on `PYTHONPATH`), and `shlex`.
2. **Flags.** It adds three: `--myco_arm` (required; one of the three arms or the ablation
   `self-check-rules`), `--myco_gate_cmd` (the operator's gate server command; `{taskId}` and
   `{runId}` are filled in per task) and `--myco_run_prefix` (required).
3. **Wrapping.** Inside the per-task loop, `lib_run_single.run_single_example(agent, ...)`
   becomes `run_single_example(myco_wrap_agent(agent, args.myco_arm, ...,
   controller=MycoControllerHandle(env.provider.get_ip_address, env.path_to_vm,
   MycoPythonController)), ...)`.

**What the hook gets (lead ruling 18:11Z, B2).** The round-2 patch passed `controller=lambda:
env.controller`. That lambda closed over `env`, so a self-check could climb to the whole
`DesktopEnv` (its evaluator, task configuration and cache directory) through
`__closure__[0].cell_contents`. The patch no longer passes anything that closes over `env`:

- `env.provider.get_ip_address` is a bound method of the provider. The provider holds its
  region, its docker and HTTP helpers, its container name and ports, and nothing of the
  environment, its task configuration, its evaluator or its cache directory.
- `env.path_to_vm` is the image reference (a string).
- `MycoPythonController` is upstream's controller class.

`ControllerHandle` keeps those three in `__slots__` (no `__dict__`, no closure) and exposes one
call, `run_bash_script(script, timeout)`. Each call asks the provider for the desktop's current
address, builds a `PythonController` from it exactly as `DesktopEnv._start_emulator` builds
`env.controller` (`rsplit(':', 4)`, port 5000 if none), and calls its `run_bash_script`. So the
dump goes to the same `desktop_env/server` every arm's actions go to, through the same
controller class, even after the environment restarts a desktop on new ports.

Nothing else changes: not the environment, not the controller, not the loop, not the
evaluator. All arms run this same patched runner. The patched runner's SHA-256 is pinned
(`OSWORLD_HARNESS.patchedAgentRunnerSha256`,
`6fa7c1e83e99d6eee444cb69f907be79aff0933516b6400bf491f230aa858694`), and the R1 grader refuses a
run whose recorded runner digest is anything else. The CI job checks that the patch applies to
a fresh pinned clone and produces exactly that digest (`test/benchmark/upstream-r1-grade.test.ts`).

A second patch,
[`src/benchmark/upstream/fleet/desktop_env_providers.patch`](../../../src/benchmark/upstream/fleet/desktop_env_providers.patch),
registers the providers: it adds `myco-fleet` and `utm-reference` (parity reference only) to
`desktop_env/providers/__init__.py`, and adds the two names to `DesktopEnv`'s clean-start and
dirty-start provider sets in `desktop_env/desktop_env.py`. It changes nothing else; the CI job
checks that `DesktopEnv.evaluate` is byte-identical after it. Both patched digests are pinned
(`OSWORLD_HARNESS.patchedFiles`), and so are the fleet's own files (`MYCO_FLEET.files`): the R1
grader refuses a run on any other bytes, any other provider, or an image not pinned by digest.

## Arm (c): the primary self-check (lead rulings 15:26Z and 18:11Z)

15:26Z made arm (c) a structural re-check on DONE, not a prompt suffix. 18:11Z fixed its form:
the model, not a rule, judges, from the real saved content. So (b) against (c) compares an
independent oracle with the model's own re-verification, at the same budget.

**On the first DONE.** The hook runs one fixed command, `SELF_CHECK_DUMP` in
`myco_done_gate.py`, through `ControllerHandle.run_bash_script`. Its SHA-256 is pinned in the
pre-registration (`arms[2].selfCheck.dumpSha256`). OSWorld's server runs it in the fleet desktop
as the guest user. Its only input is `elapsed`, the whole seconds since the episode started,
measured by the hook from the agent's reset (no guest clock is trusted). It runs `python3 -I`
on a fixed program (standard library only) that walks the guest home and prints:

- each document file (xlsx, xls, csv, ods, docx, doc, odt, rtf, txt, pptx, ppt, odp, pdf)
  modified during the episode, at most 4 levels deep, never in a hidden directory, never a
  hidden file, a link or another mount, at most 20 files;
- for each, its path under `~`, size and save time, then its content: spreadsheet cells by
  reference with their formulas, document paragraphs, slide text, the leading text of csv, txt
  and rtf; binary formats are named, not dumped;
- at most 2,000 characters per file and 6,000 in all;
- or `NOT SAVED: no document file under the home directory was saved during this episode.`

**The re-verify turn.** The first DONE becomes `WAIT`, and the next turn starts with one user
message: "Self-check: before your DONE is accepted, re-verify your work against the task using
this dump of the saved state. It lists the document files under your home directory that were
saved during this episode, with their cell values or text, or says that none were saved. Check
every requirement of the task against it and against the screen. If anything is wrong or
missing, fix it. When you are satisfied the task is complete, finish again. This re-check
happens once per task." Then the dump, between `<dump>` markers.

**The model judges.** Its next DONE goes through unchanged. The hook decides nothing from the
dump's content.

**Nothing saved is never a refusal.** On 107 of the 117 tasks OSWorld's own postconfig saves
the open document after the episode. ef9d12bd (restore Impress's slide panel, graded from the
accessibility tree) and the tasks graded from `~/.config/libreoffice` have no document at all.
On such a task the dump says "NOT SAVED" and a correct DONE passes after the one re-verify turn
(tested in the local loop and in upstream's real loop, where Myco's R1 grader reads the pass).

**Budget parity.**
- Steps: the re-verify turn is the first DONE's own turn, which becomes `WAIT` and uses that
  step, as a refused DONE does in arm (b). The self-check takes it once per episode; the gate
  takes one on each refusal. Everything comes out of the same `--max_steps`.
- Model tokens: the dump makes no model call. The message and the dump (at most 6,000
  characters) enter the next turn's input, as the gate's feedback does, under the same
  `--max_tokens` and `--max_trajectory_length`.
- Calls: exactly one `run_bash_script` call per episode, on the first DONE; none on later DONEs
  or other turns (tested).
- Time: the call runs inside the DONE's turn and counts against the shared wall-clock cap. One
  attempt is allowed 120 s: a 20 s script timeout plus the controller's fixed 100 s HTTP margin,
  the gate client's timeout. Upstream's `run_bash_script` retries a non-200 reply or a
  connection error (`retry_times` 3, `retry_interval` 5 s, a pause after every failed attempt),
  so an unreachable desktop can hold the call for at most 3 × (120 + 5) = 375 s before it fails
  closed to `DUMP_UNAVAILABLE`. A read timeout returns at once, without a retry. The extra time
  can fall only on arm (c), and only when the desktop is unreachable. The clone-backed test reads
  these numbers from upstream's source at the pin.

**May read:** the guest home directory as above (names, sizes, modification times, the content
of documents modified during the episode); the hook's own clock.

**May never read:**
- the gate or any oracle;
- OSWorld's task configuration (the example JSON: its evaluator, expected values, setup or
  postconfig);
- gold files or the DesktopEnv cache;
- fixtures or any other ground truth;
- the evaluator's code (`desktop_env` evaluators, metrics, getters, `DesktopEnv.evaluate`) or
  its output (`result.txt`, scores);
- the environment object or anything reached through it, the provider beyond its address
  getter, the setup controller, or any controller method other than `run_bash_script`.

**Enforcement:**
- Statically, `test/benchmark/independence.test.ts` checks the hook's imports (`json`, `re`,
  `shlex`, `subprocess`, `time` only); that its host code names no environment, evaluator, task
  configuration, gold, fixture, oracle or score file, no host file or network access, and no
  introspection route (`__closure__`, `cell_contents`, `__globals__`, `__self__`, `__dict__`,
  `gc`, `sys`, `inspect`, `ctypes`, and others); that every controller call is
  `run_bash_script`; and that both guest scripts start from `$HOME` and name no ground truth,
  parent hop, absolute path or network.
- At runtime, `test/benchmark/osworld-gate-hook.test.ts`:
  - builds the handle by evaluating the patch's own `controller=` expression against a fake
    environment that holds a task configuration, a cache directory and a score;
  - walks the handle's object graph: it reaches none of the three, and exposes only
    `run_bash_script`; the round-2 getter, walked the same way, reaches all three;
  - runs the verifier's W2c2 (read the evaluator config through the closure) and W2b2 (read the
    score through the closure) attacks: blocked on the handle, successful on the old getter;
  - runs the dump under real bash and python3 against prepared homes, with a Python audit hook
    recording any host file open, listing, launch or connect; attribute tripwires on the
    environment (every attribute), the provider (all but `get_ip_address`) and the controller
    (all but `run_bash_script`); and an inotify watch on every directory that holds ground
    truth and on the homes' parent, which records any guest read there whatever the script's
    text or hash (N1). All must be empty for every self-check run, and planted reads (the
    verifier's W3 line among them) show each tripwire bites;
  - checks every command that reaches the controller equals the pinned dump with only
    `elapsed` filled in.

**Known limits** (pre-registered, not fixed): pdf, xls, doc and ppt content is not dumped (no
guest tool is assumed for it); unsaved changes in an open document are not in the dump (the
model still sees the screen); a document saved deeper than 4 levels or in a hidden directory is
not listed. Each limit can only give the model less to check against; none widens what the
dump reads. The dump has not yet run on a real fleet desktop; that check belongs with the
measurement run (follow-up).

## Labelled ablations (lead ruling 18:11Z), never the headline baseline

Both are in the pre-registration's `ablations`, each with `headline: false` and its cost. Rows
from them never enter the pre-registered analysis (`analyzePublicR1` refuses any arm but the
three).

- **`self-check-rules`**: the round-2 fixed probe, `SELF_CHECK_PROBE` (SHA-256
  `e12a3208fb5c40cd691e6c6b58be4a70abbf80365433cad7c0146d20193e6dcb`, unchanged). It is a
  runner arm: on every DONE one probe call through the same `ControllerHandle` reports
  `SAVED_FILE_MISSING`, `SAVED_FILE_FORMAT_MISMATCH`, `NOTHING_SAVED` or `RECHECK_UNAVAILABLE`,
  and any code refuses the DONE with a fixed codes-only message; the hook, not the model,
  decides. Known bias, and why it is not the headline: `NOTHING_SAVED` refuses a correct DONE
  wherever OSWorld's postconfig saves, and on ef9d12bd and the config-graded tasks no DONE can
  pass (tested). **117 extra trials if run.**
- **`self-check-prompt-suffix`**: the round-1 prompt paragraph through `system_prompt_suffix`.
  Not implemented at this head (removed in round 2); running it needs that arm restored and
  re-tested. **117 extra trials if run.**

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
