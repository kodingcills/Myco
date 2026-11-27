# Public benchmark subsets: OSWorld and WindowsAgentArena

> **Status: import and plumbing only.** No task here has been run by an agent. Nothing on
> this page is a result. Verdicts shown in tests are **MOCK**: scripted end states that prove
> the plumbing and are never reported as results (lead ruling, REAL-NUMBERS RULES, #675).

Issue #675 (lead ruling, 2026-11-27): primary evidence comes from public benchmarks, graded by
their own evaluators. This page covers the import (#682): licenses, pins, what is recorded,
how grading works, and where each task can run.

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
- per-domain and per-placement counts;
- `evaluatorFiles`: the SHA-256 at the pin of every evaluator file any task needs. That covers
  each metric module and the sibling modules it imports.

`tasks.jsonl` holds one row per task:

- `taskId`: the upstream id, verbatim;
- `instruction`: verbatim;
- `domain` and `relatedApps`;
- `taskFile`, with `taskFileSha256` of its raw bytes at the pin;
- the evaluator functions, their modules, `conj`, files and getter types;
- assets, by URL only;
- the placement.

Upstream quirk: two WAA task files spell their id `…-wos` inside the file, while the file name
and `test_all.json` say `…-WOS`. `taskId` is the listed id, because upstream's runner selects
by it. The in-file spelling is kept verbatim as `idField`.

### Selection rule (stated before any results)

| Task set | Rule | Tasks |
|---|---|---|
| `osworld-office-v1` | Every id in `evaluation_examples/test_all.json` under `libreoffice_calc`, `libreoffice_writer` and `libreoffice_impress`, plus every `multi_apps` id there whose `related_apps` names a LibreOffice app | 173 (calc 47, writer 23, impress 47, multi_apps 56) |
| `waa-office-v1` | Every id in `evaluation_examples_windows/test_all.json` under `libreoffice_calc`, `libreoffice_writer`, `notepad` and `file_explorer`. WAA's office apps are LibreOffice on Windows; it has no Microsoft Office tasks | 64 (calc 24, writer 19, notepad 2, file_explorer 19) |

No task is dropped for difficulty, feasibility, evaluator type or placement.

### Rebuild

```sh
git clone https://github.com/xlang-ai/OSWorld osworld && git -C osworld checkout 0ad41bee56565efe7bb3c3a5ebc67590a1b8276f
git clone https://github.com/microsoft/WindowsAgentArena waa && git -C waa checkout eb220c4dcf64babefc1bfc287edda91ab04132ed
npx tsx scripts/upstream-import.ts --osworld osworld --waa waa --check
```

## 3. Grading: the upstream evaluator is the ground truth

`src/benchmark/upstream/evaluate.ts` grades one task's end state. Each step:

1. **Check the bytes.** It checks the task file and every evaluator file against the manifest.
   One moved byte makes the task `ungradable`.
2. **Read the evaluator config from the upstream task file.** That is the functions, options,
   `conj` and getters, so nothing about the check is restated in Myco.
3. **Run the upstream metric functions unmodified** (`run_upstream_metric.py`, under
   `python3 -I`, with no host environment). Two things are not upstream code:
   - The package parents are registered as bare packages. This skips upstream's
     `__init__.py`, which eagerly imports every app's metrics (OCR, browsers) and their heavy
     dependencies. No upstream function is replaced.
   - The getters, which talk to the VM, are not run. The captured end state stands in for what
     they return: a local file path per `vm_file` result, `None` when the file was not captured
     (as upstream's `get_vm_file` returns), and the task's own `rules` per `rule` expectation.
4. **Follow `DesktopEnv.evaluate()` at the OSWorld pin.**
   - The FAIL-action rule: an `infeasible` task passes only on a final FAIL action; any other
     task fails on one.
   - The `and`/`or` combination of several metrics.
5. **Map the score to a verdict.** `pass` if the upstream score is exactly 1.0, `fail`
   otherwise. It is `ungradable`, with a code, when the evaluator could not run. The threshold
   is a pending ruling (`pass-threshold`).

**Supported getters today:** `vm_file`, `cloud_file`, `local_file`, `rule`. Any other getter
(`vm_command_line`, `accessibility_tree`, `vm_file_exists_in_vm_folder`, …) is `ungradable` with
`GETTER_NOT_SUPPORTED:<type>` until the harness captures it.

**Independence.** The grader never receives the agent's claim or the gate's verdict.
`src/benchmark/upstream/` imports nothing from `src/gate/`, `src/verify/`, `src/tasks/` or the
gating oracle, and the gate never imports it. `test/benchmark/independence.test.ts` checks both
directions.

**Dependencies.** The evaluator's Python dependencies are pinned with hashes in
`scripts/upstream-evaluator-requirements.txt`. The versions are OSWorld's own `uv.lock` at the
pin, for CPython 3.12.

### MOCK plumbing check (not a result)

`test/benchmark/upstream-evaluator.test.ts` runs the real upstream evaluators, at the pins, on
scripted end states. It checks that Myco's verdict equals the upstream evaluator's own verdict,
computed by a separate direct call, in four cases:

- an end state that matches the gold file;
- a deliberately broken end state;
- an uncaptured file;
- an `infeasible` task where the agent says done.

It also pins one upstream leniency as mirrored, not corrected. WAA's `compare_table` reads
sheets through `pandas.read_excel`, which turns `"0045678"` and `"45678"` into the same number.
So the upstream evaluator passes an unpadded id on task `0bf05a7d-…-WOS`, whose whole point is
the padding, and Myco reports that pass unchanged. This is a finding for #671, not a fix.

The gold files in these tests are written by the test, not upstream's (§1). The tests are MOCK
and prove plumbing only. The `upstream evaluators` CI job runs them against fresh pinned clones,
and they must not skip.

## 4. Placement

See [`placement.md`](placement.md): every imported task, its placement target, and the reason
and requirement codes. It is generated by the importer. Summary at the pins:

| Task set | Linux namespace desktop | Linux, needs another app | Linux, needs a guest probe | Windows VM |
|---|---|---|---|---|
| `osworld-office-v1` (173) | 130 | 35 | 8 | 0 |
| `waa-office-v1` (64) | 0 | 0 | 0 | 64 |

The 130 desktop-ready tasks still need three things from the run harness:

- the seed files (blocked on §1);
- a display;
- a postconfig executor (upstream presses Ctrl+S and activates the window before grading).

## 5. Pre-registration

[`r1-public-prereg.md`](r1-public-prereg.md) is a **draft, not frozen**. It covers the
confirmatory R1 on the public subset. Every value that needs a lead ruling is listed as
pending, and `src/benchmark/upstream/prereg.ts` refuses "shown" while any are pending.
