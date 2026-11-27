# Public benchmark subsets: OSWorld and WindowsAgentArena

> **Status: import and plumbing only.** No task here has been run by an agent. Nothing on
> this page is a result. Verdicts shown in tests are **MOCK**: scripted end states that prove
> the plumbing and are never reported as results (lead ruling, REAL-NUMBERS RULES, #675).

Issue #675 (lead ruling, 2026-11-27): primary evidence comes from public benchmarks, graded by
their own evaluators. This page covers the import (#682): licenses, pins, what is recorded,
how grading works, and what each task needs from its benchmark's own harness.

**Harness ruling (lead, 2026-11-27 ~13:55Z; #700 comment 7220110528).** The public R1 runs
in each benchmark's OWN environment, action server and evaluators, unmodified, with Claude
via the benchmark's standard computer-use runner. Myco adds only the completion gate before
DONE is accepted. OSWorld comes first; WAA is phase 2 (deferred, not dropped). See
[`gate-hook.md`](gate-hook.md) and [`host-requirements.md`](host-requirements.md).

**Retarget (lead, 2026-11-27 14:05Z; #741 comment 7220313158), scope (14:37Z) and reference
hypervisor (15:21Z).** The environment is now the **Myco Linux fleet**: one lightweight
container desktop per task (`src/benchmark/upstream/fleet/Dockerfile`) running OSWorld's own
controller server at the pin unmodified, with the AT-SPI accessibility stack (LibreOffice's GTK3
VCL plugin) and pyautogui/python-xlib, driven by OSWorld's own `DesktopEnv` through the
`myco-fleet` provider (`myco_fleet_provider.py`), the same in every arm. OSWorld's task configs,
setup steps, controller and evaluator are unchanged. OSWorld's own VM image is only the
**parity reference** (OSWorld's `Ubuntu-arm.zip` in UTM, a stated deviation from its VMware
reference): a pre-declared sample ([`r1-parity-sample.json`](r1-parity-sample.json)) must score
the same on both before any live run (`osworld_parity.py`, `src/benchmark/upstream/parity.ts`).
Nothing in this repository builds, pulls or starts the image or the VM.

## 1. Licenses and attribution

| Item | Where | License | What Myco does |
|---|---|---|---|
| OSWorld code, task definitions, evaluators | `xlang-ai/OSWorld` @ `0ad41bee56565efe7bb3c3a5ebc67590a1b8276f` | Apache-2.0 (`LICENSE`, SHA-256 `a8d1d88a…c9e0ec`) | Reproduces task ids and instructions verbatim in `benchmark/upstream/osworld-office-v1/`, with attribution in `NOTICE`. Runs the evaluator code from a pinned checkout. Vendors no code. |
| WindowsAgentArena (WAA) code, task definitions, evaluators | `microsoft/WindowsAgentArena` @ `eb220c4dcf64babefc1bfc287edda91ab04132ed` | MIT (`LICENSE`, SHA-256 `9906940f…75cd5f2b`) | The same, in `benchmark/upstream/waa-office-v1/`. The MIT notice is reproduced in `NOTICE`. WAA's evaluator code is derived from OSWorld's. |
| OSWorld per-task files (seed documents, gold files) | Hugging Face dataset `xlangai/ubuntu_osworld_file_cache` | **Unclear.** The dataset's terms could not be read from the build environment (`huggingface.co` is blocked there). Many tasks cite third-party sources (forums, videos) for their content. | **Not vendored and not fetched.** Each URL is recorded with `license: "unclear"`. |
| WAA per-task files | GitHub `rogeriobonatti/winarenafiles` | **Unclear.** The repository has no LICENSE file (checked at `2b8a27c3b561381e6f25cada0f97a8fd5ed95a75`), so it grants no redistribution right. | **Not vendored and not fetched.** Each URL is recorded with `license: "unclear"`. |

**Stop-and-report (per the brief):** the asset licenses are unclear, so the import stops at
references. Live runs need the seed and gold files. Before any fetch, a lead ruling must pick
one of:

- (a) confirm the Hugging Face dataset's terms and get the WAA asset author's permission, then
  fetch at build time from a pinned revision with a SHA-256 check (never vendor);
- (b) fetch for private, non-redistributed evaluation only, under a ruling that this is
  allowed;
- (c) leave the assets out, which leaves the public R1 blocked.

This is `asset-license` in the draft pre-registration's pending list.

## 2. Pins and what is recorded

Pins live in `src/benchmark/upstream/pins.ts`. A new pin means a new task-set version; a
published one never changes. `scripts/upstream-import.ts` refuses a checkout whose HEAD is not
the pin, or whose license bytes differ.

For each task set, `benchmark/upstream/<version>/manifest.json` records:

- the upstream name, repo, commit, license and license SHA-256;
- the selection rule, in words;
- per-domain, infeasible and excluded counts, the harness environment and the exclusion list
  (empty);
- `evaluatorFiles`: the SHA-256 at the pin of every evaluator file any task needs. That covers
  each metric module and the sibling modules it imports.

`tasks.jsonl` holds one row per task:

- `taskId`: the upstream id, verbatim;
- `instruction`: verbatim;
- `domain` and `relatedApps`;
- `taskFile`, with `taskFileSha256` of its raw bytes at the pin;
- the evaluator functions, their modules, `conj`, files and getter types;
- assets, by URL only;
- what the task needs from its benchmark's own harness (`requirements`: getters, setup and
  postconfig step types, and codes). This never selects or drops a task.

Upstream quirk: two WAA task files spell their id `…-wos` inside the file, while the file name
and `test_all.json` say `…-WOS`. `taskId` is the listed id, because upstream's runner selects
by it. The in-file spelling is kept verbatim as `idField`.

### Selection rule (stated before any results)

| Task set | Rule | Tasks |
|---|---|---|
| `osworld-office-v1` | Every id in `evaluation_examples/test_all.json` under `libreoffice_calc`, `libreoffice_writer` and `libreoffice_impress`, run in OSWorld's own DesktopEnv | 117 (calc 47, writer 23, impress 47; 2 `infeasible`) |
| `waa-office-v1` | Every id in `evaluation_examples_windows/test_all.json` under `libreoffice_calc`, `libreoffice_writer`, `notepad` and `file_explorer`. WAA's office apps are LibreOffice on Windows; it has no Microsoft Office tasks | 64 (calc 24, writer 19, notepad 2, file_explorer 19). Phase 2 |

No task is dropped for difficulty, feasibility, evaluator type, the apps it needs or the
getters its evaluator uses. There is no Myco placement filter any more (the #700 draft
filtered to 130 "namespace-desktop" tasks and imported 56 `multi_apps` tasks; both are gone).
Exclusions: none. An exclusion needs a reason code decided before any run, never difficulty
or outcome.

### Rebuild

```sh
git clone https://github.com/xlang-ai/OSWorld osworld && git -C osworld checkout 0ad41bee56565efe7bb3c3a5ebc67590a1b8276f
git clone https://github.com/microsoft/WindowsAgentArena waa && git -C waa checkout eb220c4dcf64babefc1bfc287edda91ab04132ed
npx tsx scripts/upstream-import.ts --osworld osworld --waa waa --check
```

## 3. Grading

### 3a. R1 ground truth: OSWorld's own evaluate path, unmodified

For the public R1, the grade is what `DesktopEnv.evaluate()` returns inside OSWorld's own
runner at the pin. That call does three things:

- it runs the task's postconfig through its setup controller;
- it runs its own getters through the in-VM controller;
- it runs its own metrics, with the FAIL-action rule.

`lib_run_single.run_single_example` writes the score to `result.txt`.
`src/benchmark/upstream/r1-grade.ts` only reads that file:

- **Pass.** A score of exactly 1.0 passes (pending `pass-threshold`).
- **Fail.** Any other finite score fails.
- **Ungradable.** A missing score or a malformed one is ungradable, never a pass.
- **Harness check first.** It refuses (as ungradable) any run whose recorded harness differs
  from `OSWORLD_HARNESS` in `pins.ts`: a different repo, a different commit, or a harness
  file with different SHA-256. The runner file must carry the digest of the documented
  gate-hook patch.

It never runs a getter, a postconfig step or a metric itself. It imports neither the MOCK
runner below nor any process launcher (`test/benchmark/upstream-r1-grade.test.ts`). Rows
carry the grader version `osworld-desktopenv-evaluate@<commit>`. `prereg.ts` refuses any
other version as evidence.

### 3b. MOCK plumbing only: the pinned metric code on scripted files

`src/benchmark/upstream/evaluate.ts` and `run_upstream_metric.py` stay as a no-VM plumbing
proof, restricted by type to `MOCK` end states and stamped `upstream-metric-mock/1`. They
are **never R1 evidence**. Each step:

1. **Check the bytes.** It checks the task file and every evaluator file against the manifest.
   One moved byte makes the task `ungradable`.
2. **Read the evaluator config from the upstream task file.** That is the functions, options,
   `conj` and getters.
3. **Run the upstream metric functions unmodified**, under `python3 -I` with no host
   environment. The package parents are registered as bare packages, so upstream's eager
   `__init__.py` is skipped. **Scripted files stand in for the getters.** R1 grading must
   never do this, and that is why this path is MOCK-only.
4. **Follow `DesktopEnv.evaluate()`'s FAIL-action rule** and its `and`/`or` combination.
5. **Map the score:** `pass` iff exactly 1.0.

`test/benchmark/upstream-evaluator.test.ts` runs the real upstream evaluators, at the pins,
on scripted end states. It checks that Myco's verdict equals a direct upstream call in four
cases:

- an end state that matches the gold file;
- a deliberately broken end state;
- an uncaptured file;
- an `infeasible` task where the agent says DONE.

It also pins one upstream leniency as mirrored, not corrected. WAA's `compare_table`, through
`pandas.read_excel`, passes the unpadded id `45678` on task `0bf05a7d-…-WOS`, whose whole
point is the padding. This is a finding for #671, not a fix.

**Independence.** Neither path ever receives the agent's claim or the gate's verdict.
`src/benchmark/upstream/` imports nothing from `src/gate/`, `src/gate-hooks/`, `src/verify/`
or `src/tasks/`, and none of those reaches it. `test/benchmark/independence.test.ts` checks
both directions, and checks that the gate side never imports or names the upstream evaluator,
its output or gold files.

**Dependencies.** The MOCK path's Python dependencies are pinned with hashes in
`scripts/upstream-evaluator-requirements.txt`: OSWorld's own `uv.lock` versions at the pin,
for CPython 3.12.

## 4. What each task needs from its benchmark's harness

[`requirements.md`](requirements.md) is generated by the importer. It lists every imported
task with:

- its environment (`osworld-desktopenv` or `waa-windows-arena`);
- its getters;
- its setup and postconfig step types;
- requirement codes.

Nothing in it selects or drops a task. The fleet image has the three LibreOffice apps, OSWorld's
controller serves the getters, and its evaluate path runs the postconfig.

## 5. Pre-registration, gate hook, host

- [`r1-public-prereg.md`](r1-public-prereg.md) is a **draft, not frozen**.
  `src/benchmark/upstream/prereg.ts` checks that the record states what the ruling requires.
  It refuses "shown" while anything is pending.
- [`gate-hook.md`](gate-hook.md) covers the DONE gate hook, the three arms (arm (c) is the
  primary self-check the lead ruled at 15:26Z and 18:11Z: a dump of the saved content that the
  model re-verifies against), the two labelled ablations, the documented runner patch and the
  narrow controller handle it passes, and the constraint on the gate's oracle.
- [`host-requirements.md`](host-requirements.md) covers the fleet (the R1 host), the
  coordinator's measured numbers, how to re-measure with `measure.sh`, and the exact host
  requirement for the parity reference run. Nothing has been pulled or started.
- [`r1-parity-sample.json`](r1-parity-sample.json) is the pre-declared parity sample: five
  tasks (calc 2, writer 2, impress 1) with scripted known-good and known-bad sequences.
