# Evaluation frameworks: prior art for Myco M1

Research date: 2026-11-18. Scope: how existing systems define desktop tasks, verify
app state, and score runs — and which screenshot-agent baseline Myco can actually
run today.

Every claim below carries a source URL. Claims marked **[measured]** were produced
by experiments run during this research; the method is given inline so they can be
reproduced.

---

## 1. OSWorld v1 and OSWorld-Verified

### 1.1 How the benchmark works

OSWorld is a VM-hosted benchmark: a task is a JSON file, the harness boots a
snapshot, runs setup steps, hands control to an agent, then calls an evaluator that
reads state out of the VM.

- Repo: <https://github.com/xlang-ai/OSWorld> — Apache-2.0
  (<https://api.github.com/repos/xlang-ai/OSWorld>).
- 369 tasks in the paper; 368 example JSONs in the tree today, of which **47 are
  `libreoffice_calc`** (counted from
  <https://api.github.com/repos/xlang-ai/OSWorld/git/trees/main?recursive=1>).
- Paper: <https://arxiv.org/abs/2404.07972>. Project page:
  <https://osworld-v1.xlang.ai/>.

The environment is a `gym.Env` subclass. `DesktopEnv.step()` executes an action and
returns an observation; `DesktopEnv.evaluate()` returns the score
(<https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/desktop_env.py>).

### 1.2 How a Calc task is defined

Concrete example, `evaluation_examples/examples/libreoffice_calc/4e6fcf72-daf3-439f-a232-c434ce416af6.json`
(<https://github.com/xlang-ai/OSWorld/blob/main/evaluation_examples/examples/libreoffice_calc/4e6fcf72-daf3-439f-a232-c434ce416af6.json>):

```json
{
  "id": "4e6fcf72-daf3-439f-a232-c434ce416af6",
  "snapshot": "libreoffice_calc",
  "instruction": "Please calculate the ages of the employees according to their birthday, as of the reference date recorded in /home/user/age-reference-date.txt (UTC). Finish the work and don't touch irrelevant regions, even if they are blank.",
  "config": [
    { "type": "host_reference_date",
      "parameters": { "path": "/home/user/age-reference-date.txt" } },
    { "type": "download",
      "parameters": { "files": [ { "url": "https://huggingface.co/datasets/xlangai/ubuntu_osworld_file_cache/resolve/main/libreoffice_calc/4e6fcf72-daf3-439f-a232-c434ce416af6/Employee_Age_By_Birthday.xlsx",
                                   "path": "/home/user/Employee_Age_By_Birthday.xlsx" } ] } },
    { "type": "open",
      "parameters": { "path": "/home/user/Employee_Age_By_Birthday.xlsx" } }
  ],
  "related_apps": ["libreoffice calc"],
  "evaluator": {
    "postconfig": [
      { "type": "activate_window",
        "parameters": { "window_name": "Employee_Age_By_Birthday.xlsx - LibreOffice Calc", "strict": true } },
      { "type": "sleep", "parameters": { "seconds": 0.5 } },
      { "type": "execute",
        "parameters": { "command": ["python", "-c", "import pyautogui; pyautogui.hotkey(\"ctrl\", \"s\");"] } },
      { "type": "sleep", "parameters": { "seconds": 0.5 } }
    ],
    "func": "compare_table",
    "expected": { "type": "employee_age_reference",
                  "source": "evaluation_examples/hf_patches/libreoffice_calc/4e6fcf72-daf3-439f-a232-c434ce416af6/Employee_Age_By_Birthday.xlsx",
                  "reference_date_path": "/home/user/age-reference-date.txt",
                  "dest": "Employee_Age_By_Birthday_gold.xlsx" },
    "result": { "type": "vm_file", "path": "/home/user/Employee_Age_By_Birthday.xlsx",
                "dest": "Employee_Age_By_Birthday.xlsx" },
    "options": { "rules": [ { "type": "sheet_data", "sheet_idx0": 0, "sheet_idx1": "EI0" } ] }
  },
  "proxy": false,
  "fixed_ip": false,
  "possibility_of_env_change": "low"
}
```

Four things matter for Myco:

1. **`snapshot`** names a VM image, not a file. Initial state = image + `config`
   steps. `SetupController.setup()` dispatches each `config` entry to a
   `_<type>_setup` method by name
   (<https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/controllers/setup.py>).
   There is no per-task filesystem diff; the snapshot is coarse.
2. **`postconfig`** runs *before* evaluation and is allowed to mutate the guest —
   here it activates the window and presses Ctrl+S. The evaluator therefore
   depends on a GUI keystroke landing. The code comments on this:
   `# Postconfig can also mutate the guest before failing.`
   (<https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/desktop_env.py>).
3. **`result`** is a *getter* config, not a path. `vm_file` copies the file out of
   the VM to the host cache.
4. **`expected`** is also a getter. `employee_age_reference` regenerates the gold
   workbook on the host from a repo fixture plus the episode's date, and the
   docstring is explicit about why:

   > "Never open/recalculate the answer workbook in the evaluated guest. Refresh
   > the generated reference on every call so legacy guest-controlled caches
   > cannot supply the answer."

   (<https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/evaluators/getters/calc.py>)

That last point is the single most transferable idea in OSWorld for M1: **the
expected value must be computed outside the system under test.**

### 1.3 Evaluator architecture: `func` + getters + metrics

`DesktopEnv._set_evaluator_info()` resolves three names by string lookup
(<https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/desktop_env.py>):

```python
self.metric: Metric = [getattr(metrics, func) for func in self.evaluator["func"]] \
    if isinstance(self.evaluator["func"], list) \
    else getattr(metrics, self.evaluator["func"])
self.metric_conj: str = self.evaluator.get("conj", "and")
...
self.result_getter: Getter = [getattr(getters, "get_{:}".format(res["type"])) for res in
                              self.evaluator["result"]] ...
```

`evaluate()` then does getter → metric → float:

```python
try:
    result_state = self.result_getter(self, self.evaluator["result"])
except FileNotFoundError:
    logger.error("File not found!")
    return 0
if "expected" in self.evaluator and self.expected_getter and self.evaluator["expected"]:
    expected_state = self.expected_getter(self, self.evaluator["expected"])
    metric: float = self.metric(result_state, expected_state, **self.metric_options)
else:
    metric: float = self.metric(result_state, **self.metric_options)
return metric
```

Note the failure mode: **a missing result file scores 0, not "unknown"**. There is
no third state. For M1's "0 false successes" criterion this is fine (0 is safe),
but it means OSWorld cannot distinguish "agent did nothing" from "agent corrupted
the file" from "the harness broke".

There is **no `verify_with_python` function** in OSWorld. The brief's hypothesis is
wrong; the closest analogues are `get_python_test_suite_result`
(`desktop_env/evaluators/getters/python.py`) and `compare_python_pure_text`
(`desktop_env/evaluators/metrics/general.py`). See §5.

### 1.4 The Calc metric: `compare_table` and the `sheet_data` rule

`compare_table` is a rule interpreter over openpyxl/pandas workbooks
(<https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/evaluators/metrics/table.py>).
Rule types: `sheet_name`, `sheet_data`, `sheet_print`, `preserve_cells`, and more.

The `sheet_data` rule — the one every Calc task uses — is a whole-sheet
`DataFrame.equals` after rounding:

```python
elif r["type"] == "sheet_data":
    # sheet_idx0: 0 == "RI0" == "RNSheet1" | "EI0" == "ENSheet1"
    # sheet_idx1: as sheet_idx0
    # precision: int as number of decimal digits, default to 4
    error_limit: int = r.get("precision", 4)
    sheet1: pd.DataFrame = _load_sheet(*parse_idx(r["sheet_idx0"], pdworkbookr, pdworkbooke))
    ...
    sheet1 = sheet1.round(error_limit)
    sheet2 = sheet2.round(error_limit)
    metric: bool = sheet1.equals(sheet2)
```

Consequences Myco should not copy:

- **All-or-nothing per sheet.** One wrong cell in a 500-row sheet scores 0. There
  is no partial credit and no per-cell diagnostic.
- **`sheet_idx1: "EI0"`** means "expected workbook, sheet index 0" — the gold file
  must have identical shape, so any extra row the agent adds fails the task.
- **`preserve_cells`** was added in Verified to catch agents that "fix" the answer
  by rewriting untouched regions. Its comment states the design intent:

  > "Explicit result-to-reference mapping supports legitimate sheet renames. Never
  > infer protection from which sheets other rules happen to mention: a task can
  > edit its source and its output."

  (<https://github.com/xlang-ai/OSWorld/blob/main/desktop_env/evaluators/metrics/table.py>)

`preserve_cells` is the closest thing in OSWorld to a *negative* assertion — "you
must not have changed this" — and it is directly relevant to M1's corrupted-trial
design.

### 1.5 What OSWorld-Verified changed (2025-07-28)

Source: <https://xlang.ai/blog/osworld-verified>.

- 300+ community-reported issues fixed over ~2 months by a ~10-person team.
- Infrastructure moved VMware/Docker → AWS, "up to 50 environments simultaneously",
  evaluation "10+ hours → minutes".
- New task fields: `proxy`, `fixed_ip`, `possibility_of_env_change` (all three
  appear in the Calc task above).
- Evaluator-only fixes preferred over instruction changes, "to minimize changes to
  the tasks themselves and maintain score continuity".
- Public evaluation platform: results only count as verified if the maintainers run
  your agent (<https://github.com/xlang-ai/OSWorld#public-evaluation>).
- Explicit admission of the core problem:

  > "providing reliable rewards consumes more human resources than we imagined"

  and, on decentralized evaluation:

  > "everyone has their own environment, or even modifies tasks for evaluation to
  > achieve higher scores, making scores increasingly opaque and incomparable."

- Spreadsheet-specific fixes listed: "Cell format tolerance", "Range
  specifications", "Formula vs value comparison", and "Different but functionally
  equivalent spreadsheet formulas marked incorrect" as a false-negative class.

### 1.6 What OSWorld 2.0 changed (2026-06-26)

Sources: <https://osworld-v2.xlang.ai/>, <https://arxiv.org/abs/2606.29537>,
<https://github.com/xlang-ai/OSWorld-V2> (Apache-2.0).

- **108 tasks**, not 369. Median ~1.6 h of human work; 69.6% of tasks >1 h;
  ~318 tool calls with Claude Opus 4.7 vs ~30 in v1.
- **27.25 average scoring checkpoints per task** — the headline change for Myco.
  Scoring moved from one boolean to weighted partial credit.
- **31 self-hosted websites.** This is the contamination answer: instead of
  pointing at live sites that drift and get scraped, v2 hosts the sites. It also
  removes the "website changed under the benchmark" failure class that dominated
  the Verified fix log.
- New task fields in `desktop_env/task_base.py`: `user_simulator`,
  `intermediate_eval_safe`, `disable_vnc`, `disable_recording`, `platform`
  (<https://github.com/xlang-ai/OSWorld-V2/blob/main/desktop_env/task_base.py>).
- **`evaluate()` may return a dict** with weighted `partial_scores`
  (<https://github.com/xlang-ai/OSWorld-V2/blob/main/docs/EVALUATE_RESULT_JSON.md>):

  ```python
  partial_scores = {
      "subtask1": {"score": 0.4, "weight": 0.5, "description": "..."},
      "subtask2": {"score": 0.6, "weight": 0.5, "description": "..."},
  }
  return {"score": final_score, "partial_scores": partial_scores}
  ```

  with the constraint "All weights should sum to 1.0" and the runner writing both
  `result.txt` (float) and `result.json` (full dict).
- Separate **safety reports** auditing safety-sensitive execution.
- Challenge tags include `Streaming Interaction` (6 tasks, 5.6%) — "environments
  whose visual state changes between observation and action, making discrete
  screenshot-based interaction insufficient". That is a direct argument for
  Myco's structural-state approach.
- Failure analysis names the exact gap Myco targets: agents "skip verification,
  struggling most when a task hinges on hidden state they must recover."

### 1.7 Is OSWorld the relevant prior art? (Tiffany's claim)

**Partly — as a task/evaluator format, not as a verification design.**

Supported:
- It is the de facto desktop-agent benchmark, and its Calc tasks are the natural
  held-out set for Myco's long-term RL bet (vision.md §"Long-term paradigm bets").
- Its `func`/getter/metric split and its "compute the gold outside the guest"
  discipline are worth copying.
- OSWorld 2.0's weighted `partial_scores` is the right evidence shape for M1.

Not supported:
- OSWorld has **no per-action verification**. Verification happens once, at the
  end, on a file. There is no notion of "this step succeeded", no recovery, no
  retry-from-known-good. M1's core claim is orthogonal to OSWorld's design.
- OSWorld's Calc evaluator is whole-sheet equality — the opposite of the
  per-checkpoint, per-cell, diagnosable verification M1 needs.
- OSWorld's initial state is a VM snapshot plus GUI keystrokes, not a reproducible
  file-level fixture. M1 needs the latter.

The genuinely relevant prior art for M1's *verification* claim is OpenComputer
(§2) and OpenAdapt (§4.7), not OSWorld.

---

## 2. OpenComputer — the one with state verifiers

### 2.1 Identifying the right project

Four projects use the name. Only one has state verifiers.

| Repo | What it is | License | Verdict |
|---|---|---|---|
| `echo0715/OpenComputer` | "Verifiable Software Worlds for Computer-Use Agents", Yale NLP | Apache-2.0 | **The one.** App-specific state verifiers. |
| `diggerhq/opencomputer` | "open-source, faster Devin alternative" — Slack coding agent | Apache-2.0 | Not it. No desktop state verification. |
| `andykr1k/OpenComputer` | Electron local-first CUA, "fresh visual verification after every desktop action" | MIT | Not it. Verification is a screenshot re-read, not app state. |
| `OthersideAI/opencomputer` | **Does not exist.** OthersideAI's repo is `self-operating-computer` | MIT | Not it. Screenshot loop, no verifiers. |

Sources: <https://api.github.com/orgs/OthersideAI/repos>,
<https://github.com/diggerhq/opencomputer>,
<https://github.com/andykr1k/OpenComputer>,
<https://github.com/echo0715/OpenComputer>.

The correct project: **`echo0715/OpenComputer`**, paper
<https://arxiv.org/abs/2605.19769> (Jinbiao Wei, Qianran Ma, Yilun Zhao, Xiao Zhou,
Kangqi Ni, Guo Gan, Arman Cohan; 2026-05-19). License header in the repo:

> ```
> Copyright 2026 Yale NLP Lab
>
> Licensed under the Apache License, Version 2.0 (the "License");
> you may not use this file except in compliance with the License.
> ```

(<https://github.com/echo0715/OpenComputer/blob/main/LICENSE>)

Abstract, verbatim:

> "OpenComputer integrates four components: (1) app-specific state verifiers that
> expose structured inspection endpoints over real applications, (2) a
> self-evolving verification layer that improves verifier reliability using
> execution-grounded feedback, (3) a task-generation pipeline that synthesizes
> realistic and machine-checkable desktop tasks, and (4) an evaluation harness that
> records full trajectories and computes auditable partial-credit rewards. In its
> current form, OpenComputer covers 33 desktop applications and 1,000 finalized
> tasks..."

And the finding that matters most for M1:

> "OpenComputer's hard-coded verifiers align more closely with human adjudication
> than LLM-as-judge evaluation, especially when success depends on fine-grained
> application state."

### 2.2 What "independent verification of app state" means there

A verifier is a **CLI program inside the guest** that reads live app state over the
app's own IPC and prints JSON. It is not a screenshot reader and not an LLM.

From `verifiers/libreoffice_calc/README.md`
(<https://github.com/echo0715/OpenComputer/blob/main/verifiers/libreoffice_calc/README.md>):

> "Programmatic state inspection for LibreOffice Calc spreadsheets in E2B sandbox.
> Used by a **check agent** to generate reward signals for RL/evaluation."

Three channels, explicitly ranked:

| Channel | When to use | Needs running LO? |
|---|---|---|
| **UNO API** | Live cell values, formatting, formulas, sheet structure | Yes |
| **ODF parsing** | Saved file content, offline verification | No |
| **File checks** | File existence, save state | No |

The UNO channel connects to a socket listener started with:

```bash
soffice --calc --accept="socket,host=localhost,port=2002;urp;" --norestore &
```

and resolves it in code
(<https://github.com/echo0715/OpenComputer/blob/main/verifiers/libreoffice_calc/libreoffice_calc.py>):

```python
UNO_HOST = "localhost"
UNO_PORT = 2002
...
local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx
)
ctx = resolver.resolve(
    f"uno:socket,host={UNO_HOST},port={UNO_PORT};urp;StarOffice.ComponentContext"
)
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
```

**This is exactly Myco's "read state from the app's object model" thesis, already
implemented for Calc, in Apache-2.0 code.** It is the single most reusable artifact
found in this research.

### 2.3 The verifier endpoint surface (Calc)

Read endpoints: `sheets`, `active-sheet`, `doc-info`, `cell-value`,
`range-values`, `sheet-data`, `cell-format`, `merged-cells`, plus offline
`parse-sheets`, `parse-cell`, `parse-range` over `.ods`.

Check endpoints, each returning a dict with a **primary boolean key that maps
directly to a reward signal**:

| Endpoint | Reward key |
|---|---|
| `check-cell-value <cell> <expected> [sheet]` | `match` |
| `check-sheet-exists <name>` | `exists` |
| `check-sheet-count <n>` | `match` |
| `check-cell-formula <cell> <formula> [sheet]` | `match` |
| `check-cell-formatted <cell> [bold]` | `match` |
| `check-column-sorted <col> [asc/desc] [start]` | `sorted` |
| `check-file-exists <path>` | `exists` |
| `check-file-saved [path]` | `saved` |
| `check-merged-cells <range> [sheet]` | `merged` |
| `check-calc-pref <key> <expected>` | `match` |
| `check-conditional-format <range> [sheet]` | `match` |
| `check-named-range <name> [content]` | `match` |
| `check-data-validation <cell> [sheet]` | `match` |
| `check-autofilter [sheet]` | `match` |
| `check-frozen-rows <n> [sheet]` | `match` |
| `check-csv-rows <path> <n> [has_header]` | `match` |

The comparison semantics are deliberately forgiving in the right places
(`check_cell_value`, same file):

```python
# Smart comparison: try numeric, then string
match = False
try:
    expected_num = float(expected)
    if actual is not None:
        match = float(actual) == expected_num
except (ValueError, TypeError):
    # String comparison (case-insensitive)
    actual_str = str(actual) if actual is not None else ""
    match = actual_str.lower() == expected.lower() or display.lower() == expected.lower()
```

and `check_cell_formula` normalizes `=` and case:

```python
norm_expected = expected_formula.lstrip("=").upper().strip()
norm_actual = actual.lstrip("=").upper().strip()
```

Note the fallback chain in `check_cell_value`: UNO first, then ODF file parse. That
is the right shape for M1 — live state is authoritative, persisted state is the
fallback, and the two are distinguishable in the output.

### 2.4 Task format

`task_generator/tasks/<task_id>/task.json` — 900 task files, 29 for Calc
(`calc_*`). Example,
<https://github.com/echo0715/OpenComputer/blob/main/task_generator/tasks/calc_employee_data_cleanup/task.json>:

```json
{
  "id": "calc_employee_data_cleanup",
  "app": "libreoffice_calc",
  "task": "Open /home/user/Documents/employees.xlsx in LibreOffice Calc. ...",
  "env": { "files": [ { "filename": "employees.xlsx",
                        "sandbox_path": "/home/user/Documents/employees.xlsx" } ] },
  "verification": [
    { "command": "check-cell-value G1 \"Full Name\" Staff",
      "key": "match", "expected": true,
      "description": "Staff G1 = 'Full Name'" },
    { "command": "cell-value G2 Staff",
      "eval": "result.get('formula') is not None and ('CONCATENATE' in result.get('formula','').upper() or '&' in result.get('formula',''))",
      "description": "G2 contains a CONCATENATE or & formula" },
    { "command": "check-file-saved", "key": "saved", "expected": true,
      "description": "File has been saved" }
  ],
  "metadata": { "complexity": 5, "data_generatability": 5,
                "verification_determinism": 5, "estimated_difficulty": 5 }
}
```

Three design choices worth copying:

1. **`env.files` is a file-level fixture**, not a VM snapshot. Reproducible and
   diffable.
2. **Each check is an independent assertion with a human description.** 17 checks
   for this one task. This is the partial-credit unit.
3. **`eval` escape hatch** for checks that need logic beyond key equality.

### 2.5 Verification runtime

`evaluation/runtime/verification.py`
(<https://github.com/echo0715/OpenComputer/blob/main/evaluation/runtime/verification.py>):

```python
def run_verifier(sandbox, app_name, command, timeout=30):
    app_spec = get_app_spec(app_name)
    verifier_command = f"python3 {app_spec.verifier_remote}"
    parts = shlex.split(command)
    quoted_cmd = " ".join(shlex.quote(part) for part in parts)
    try:
        result = sandbox.commands.run(f"{verifier_command} {quoted_cmd}", timeout=timeout)
        return json.loads(result.stdout)
    except CommandExitException as exc:
        try:
            return json.loads(exc.stdout)
        except Exception:
            return {"error": exc.stderr[:300]}
    except Exception as exc:
        return {"error": str(exc)}
```

and the pass decision:

```python
if "eval" in check:
    result = data
    passed = eval(check["eval"])  # noqa: S307
    ...
key = check["key"]
expected = check["expected"]
actual = data.get(key)
results[index] = {..., "passed": actual == expected, "result": data}
```

Two weaknesses to avoid:

- **`eval()` on a string from the task file.** Arbitrary code execution from task
  data. Fine for a trusted benchmark, unacceptable for a runtime that ingests
  third-party procedures.
- **A verifier error becomes `{"error": ...}`, so `actual` is `None`, so
  `passed` is `False`.** A broken verifier is indistinguishable from a failed
  task. M1 must separate `FAILED` from `UNVERIFIED`.

The LLM-judge path is opt-in per check (`"judge": "llm"`) and two-phase: an LLM
picks relevant trajectory steps, then judges criteria against those screenshots
plus verifier output. The paper's own result is that hard-coded verifiers beat
this. Treat the judge as a last resort, not a default.

### 2.6 Partial credit and reporting

`evaluation/runtime/reporting.py`
(<https://github.com/echo0715/OpenComputer/blob/main/evaluation/runtime/reporting.py>)
computes `reward = passed_checks / total_checks` per task and emits `report.json`
with `summary`, `per_app`, and `task_results`:

```python
"summary": {
    "total_tasks": total_tasks,
    "full_pass": total_full_pass,
    "success_rate": round(total_full_pass / total_tasks, 4) if total_tasks else 0,
    "avg_reward": round(total_reward / total_tasks, 4) if total_tasks else 0,
    "total_checks": total_checks,
    "passed_checks": total_passed_checks,
    "check_pass_rate": round(total_passed_checks / total_checks, 4) if total_checks else 0,
    ...
}
```

`full_pass` requires `reward == 1.0`. This is the right two-number reporting shape
for M1: **binary success rate** (the 27/30 criterion) plus **check pass rate**
(diagnostic).

### 2.7 Assessment

OpenComputer is the closest published match to Myco's verification thesis, and it
is Apache-2.0. What it does **not** have:

- No per-action verification during execution. Checks run after the agent stops.
- No recovery, retry, or rollback. A failed check is a score, not a signal to act.
- No fork.
- No compiled/reusable procedure. Tasks are generated, not learned from runs.
- Linux/E2B only. No Windows, no UIA, no COM.
- `eval()` on task-supplied strings.

So: **adopt the verifier endpoint design and the task/check schema; do not adopt
the harness.** Myco's differentiator survives intact.

---

## 3. Screenshot-agent baselines

### 3.1 What a baseline must do for M1

M1 requires "compared against a screenshot-based agent on identical tasks, initial
states, and model settings". Minimum viable baseline: screenshot in → one action
out → repeat, with no structural state and no verification. It must run against a
remote Windows desktop.

### 3.2 Agent S / S2 / S3 / S4 (Simular)

- Repo: <https://github.com/simular-ai/Agent-S> — Apache-2.0
  (<https://api.github.com/repos/simular-ai/Agent-S>), 13k stars, pushed
  2026-11-13.
- Install: `pip install gui-agents`. Platforms: "Linux, Mac, and Windows"
  (<https://github.com/simular-ai/Agent-S/blob/main/gui_agents/s3/README.md>).
- **Requires a separate grounding model.** From the S3 README:

  > "For optimal performance, we recommend UI-TARS-1.5-7B hosted on Hugging Face
  > Inference Endpoints or another provider."

  and the CLI makes it mandatory:

  ```
  agent_s --provider openai --model gpt-5-2025-08-07 \
      --ground_provider huggingface --ground_url http://localhost:8080 \
      --ground_model ui-tars-1.5-7b \
      --grounding_width 1920 --grounding_height 1080
  ```

  `--ground_provider`, `--ground_url`, `--ground_model`, `--grounding_width`,
  `--grounding_height` are all listed as **Required**.
- Model providers: "OpenAI, Anthropic, Gemini, Azure OpenAI, vLLM for local models,
  and Open Router" (<https://github.com/simular-ai/Agent-S/blob/main/models.md>).
  `engine_type` accepts `'openai' | 'anthropic' | 'gemini' | 'azure_openai' |
  'vllm' | 'open_router'`. An OpenAI-compatible endpoint is therefore supported —
  which is what a CheaperInference/Ollama proxy exposes.
- Remote desktop: the OSWorld harness is a thin loop over OSWorld's `DesktopEnv`
  (<https://github.com/simular-ai/Agent-S/blob/main/osworld_setup/s3/lib_run_single.py>):

  ```python
  env.reset(task_config=example)
  time.sleep(60)  # Wait for the environment to be ready
  obs = env._get_obs()
  while not done and step_idx < max_steps:
      response, actions = agent.predict(instruction, obs)
      for action in actions:
          obs, reward, done, info = env.step(action, args.sleep_after_execution)
  result = env.evaluate()
  ```

  So it does not ship its own remote transport — it borrows OSWorld's. For a
  Windows VM you either run Agent-S inside the guest, or write a ~100-line
  `env` shim over VNC/screenshot+pyautogui.
- Effort: **medium.** `pip install gui-agents` + a grounding endpoint + a transport
  shim. The grounding model is the real cost.

### 3.3 UI-TARS (ByteDance)

- Repo: <https://github.com/bytedance/UI-TARS> — **archived**
  (`"archived": true` from <https://api.github.com/repos/bytedance/UI-TARS>),
  Apache-2.0, last push 2026-01-27.
- Weights: `ByteDance-Seed/UI-TARS-1.5-7B`, license `apache-2.0`, not gated,
  229,668 downloads (<https://huggingface.co/api/models/ByteDance-Seed/UI-TARS-1.5-7B>).
- Action parsing is a published package: `pip install ui-tars`, then
  `parse_action_to_structure_output(response, factor=1000, ...)` and
  `parsing_response_to_pyautogui_code(...)`
  (<https://github.com/bytedance/UI-TARS>).
- Coordinate convention: normalized 0–1000, `factor=1000`.
- Effort: **low for grounding, medium for a full agent.** It is a model, not a
  loop. Best used as the grounder inside Agent-S or a hand-rolled loop.

### 3.4 OpenCUA (XLANG)

- Repo: <https://github.com/xlang-ai/OpenCUA> — MIT
  (<https://api.github.com/repos/xlang-ai/OpenCUA>).
- Weights: `xlangai/OpenCUA-7B`, license `mit`, not gated
  (<https://huggingface.co/api/models/xlangai/OpenCUA-7B>). 32B and 72B also exist;
  72B "ranks #1 on the OSWorld-Verified leaderboard" per the README.
- **Loading caveat, from the README:**

  > "M-RoPE has been replaced with 1D RoPE. Using the same Tokenizer and ChatTemplate
  > as Kimi-VL. Do not use the default transformers and vllm classes to load the
  > model."

  vLLM support landed 2026-01-17, so this is now tractable but not a one-liner.
- Effort: **medium-high.** Custom loading path, GPU required, no turnkey loop.

### 3.5 ShowUI

- Repo: <https://github.com/showlab/ShowUI> — Apache-2.0.
- Weights: `showlab/ShowUI-2B`, license `mit`, 2,578 downloads
  (<https://huggingface.co/api/models/showlab/ShowUI-2B>).
- 2B params, vLLM inference notebook, Gradio API mode ("you don't need a GPU to
  deploy the model locally"), and an OOTB computer-use integration
  (<https://github.com/showlab/computer_use_ootb>).
- Effort: **low** for grounding-only; it is a grounding model, not a planner.

### 3.6 OS-Atlas

- Repo: <https://github.com/OS-Copilot/OS-Atlas> — Apache-2.0, last push
  2025-04-20 (stale).
- Weights: `OS-Copilot/OS-Atlas-Base-7B` (Qwen2-VL-7B base) and `-4B`
  (InternVL2-4B base), both `apache-2.0`
  (<https://huggingface.co/api/models/OS-Copilot/OS-Atlas-Base-7B>).
- Output: "normalized to relative coordinates within a 0-1000 range".
- Effort: **low** for grounding. Stale but functional.

### 3.7 OpenAdapt — reclassify: competitor, not baseline

The brief lists OpenAdapt as a baseline candidate. It is not. It is the closest
existing implementation of Myco's thesis.

- Repo: <https://github.com/OpenAdaptAI/OpenAdapt> — MIT, "Copyright (c) 2023
  MLDSAI Inc., Richard Abrich, and contributors"
  (<https://github.com/OpenAdaptAI/OpenAdapt/blob/main/LICENSE>).
- Tagline: **"Give your agent a program, not a mouse. The open-source, verified
  execution layer for computer-use agents."**
- It records a run, compiles it to a program, and on replay "confirms the right
  record before each save, reads the save back from the system of record after it,
  and returns a plain outcome. When anything doesn't match, it stops and tells your
  agent instead of guessing."
- **Published false-success numbers** — the exact measurement M1 needs to make:

  | How the save was checked | Bad saves reported as saved |
  |---|---|
  | The app's "Saved" message on screen | 54 of 72 |
  | A read of the record over the app's REST API | 9 of 72 |
  | A read of every table in the database | 0 of 72 |

  and, for an agent working alone: "Claude Sonnet 5.5, using computer use, did a
  task on a test app whose server broke the save in 6 ways, 5 times each. The agent
  reported all 30 bad saves as done."

  (<https://github.com/OpenAdaptAI/OpenAdapt>)
- Backends: `web`, `windows` (UI Automation via an in-guest agent server), `macos`
  (AX), `linux` (AT-SPI), `rdp` (pixels, Aardwolf/FreeRDP), `citrix` (pixels)
  (<https://github.com/OpenAdaptAI/OpenAdapt/blob/main/packages/flow/docs/BACKEND_PARITY.md>).
- Verification: SQL / FHIR / REST read-back of the system of record, plus
  `desktop_readback` which "reads Windows through UI Automation and other surfaces
  by OCR". Windows read-back is **TESTED**, not QUALIFIED — the test uses a fake
  `uiautomation` module.
- Also has: `openadapt verify effect` (judge any agent's write), a reward worker
  for training, rollback/undo, self-repair, approval gates, MCP server.

**Implication for M1:** Myco cannot claim "verified execution" as novel. It must
differentiate on (a) LibreOffice/UNO object-model state rather than HTTP/DB
read-back, (b) per-action verification with recovery rather than post-hoc
read-back, (c) fork, (d) compiled procedures that self-heal. And M1's write-up
should cite OpenAdapt's 54/72 and 30/30 numbers as the baseline failure rate it is
trying to beat.

### 3.8 Measured: can a cheap local VLM ground a Calc cell? **[measured]**

This is the decisive practical question for a cheap baseline, so it was tested
rather than assumed.

Method:
1. Render a synthetic 1280×800 LibreOffice-Calc-like screenshot (column headers
   A–H, row numbers 1–15, 4 columns of data) with Pillow.
2. Ground truth: cell C3 center = (335, 211), bbox x∈[280,390], y∈[198,224];
   cell D2 center = (445, 185), bbox x∈[390,500], y∈[172,198].
3. Ask each model for the center of a named cell, two prompt styles (absolute
   pixels; normalized 0–1000), two trials per cell.
4. Hit = returned point inside the cell bbox.

Models: the two vision-capable models installed locally
(`ollama list`): `eriktonon/gemma4-uncensored:12b` (7.6 GB) and
`eriktonon/qwen3.8-uncensored:latest` (6.4 GB), served by Ollama's
OpenAI-compatible endpoint at `http://127.0.0.1:11434/v1/chat/completions`.

Result:

| Model | Prompt style | Hits | Pixel error (px) |
|---|---|---|---|
| gemma4-uncensored:12b | absolute pixels | 0/4 | 82, 82, 100, 100 |
| gemma4-uncensored:12b | normalized 0–1000 | 0/4 | 24, 24, 40, 40 |
| qwen3.8-uncensored | absolute pixels | 2/4 | 121, 121, 16, 16 |
| qwen3.8-uncensored | normalized 0–1000 | 0/4 | 210, 210, 116, 116 |

**2 hits out of 16 attempts.** Both models can describe an image correctly (both
answered "Red" for a solid red PNG, verified separately), but neither can localize
a grid cell. Grounding, not reasoning, is the bottleneck.

Consequence: a baseline built on a general-purpose cheap VLM will fail for reasons
that have nothing to do with Myco's thesis, which makes the comparison worthless.
**The baseline must use a dedicated grounding model** (UI-TARS-1.5-7B, ShowUI-2B,
or OS-Atlas-Base-7B) and the report must name it.

Also verified: Ollama's `/v1/chat/completions` accepts `image_url` with a
`data:image/png;base64,...` URI and returns a normal OpenAI-shaped response, so
Agent-S's `engine_type: 'openai'` path can point at it directly.

Not verified: the CheaperInference cloud models (`deepseek-v4.1-flash:cloud`,
`glm-5.3-flash:cloud`, `kimi-k3.1-pro:cloud`) — every call returned
`Add usage credits or subscribe and save up to 66%`. Their vision capability is
therefore **unknown**, and a baseline plan must not assume it.

### 3.9 Recommended baseline

**Agent S3 (`gui-agents`) + UI-TARS-1.5-7B grounding + a ~100-line transport shim
over the Windows VM.**

Rationale:
- Apache-2.0 on both the framework and the weights; no gating on either.
- The only candidate that ships a complete screenshot→action loop with a
  documented OSWorld harness, so the loop is known-good and the shim is the only
  new code.
- Grounding is a solved, swappable component; §3.8 shows this is the part that
  must not be improvised.
- Runs on Windows natively, so it can also run *inside* the guest if a remote
  transport proves flaky — a useful fallback for reproducibility.

Cheaper alternative if GPU budget is zero: **ShowUI-2B** (2B, MIT weights, Gradio
API mode) as grounder with a hand-rolled ~150-line loop. Lower ceiling, but it runs
on CPU-ish hardware and removes the endpoint dependency.

Do **not** use a general-purpose chat VLM as the baseline agent. §3.8 is the
evidence.

---

## Dead ends

Things checked that do not exist or do not fit.

1. **`OthersideAI/opencomputer` does not exist.** The org's repos are listed at
   <https://api.github.com/orgs/OthersideAI/repos>; the closest is
   `OthersideAI/self-operating-computer` (MIT, 10,313 stars), which is a
   screenshot→pyautogui loop with no state verification. The brief's guess was
   wrong; the real project is `echo0715/OpenComputer` (§2.1).

2. **`diggerhq/opencomputer` is not a desktop-verification project.** It is a
   Slack-driven coding agent ("open-source, faster Devin alternative"), Apache-2.0.
   Its "state" is a git-backed session store, not app state
   (<https://github.com/diggerhq/opencomputer>).

3. **`andykr1k/OpenComputer` verifies with screenshots, not state.** Its README
   claims "Fresh visual verification after every desktop action", which is a
   re-screenshot, not an independent read of app state
   (<https://github.com/andykr1k/OpenComputer>). Not the project the brief meant.

4. **OSWorld has no `verify_with_python`.** Grepped the full tree: no such symbol.
   The evaluator surface is `func` (metric) + `result`/`expected` (getters) +
   `options`. Closest analogues are `get_python_test_suite_result` and
   `compare_python_pure_text`.

5. **`bytedance/UI-TARS` is archived.** `"archived": true` from the GitHub API,
   last push 2026-01-27. The weights remain available and Apache-2.0, and the
   `ui-tars` PyPI action parser still works, but there is no upstream maintenance.
   Plan for the model, not the repo.

6. **OS-Atlas is stale.** Last push 2025-04-20
   (<https://api.github.com/repos/OS-Copilot/OS-Atlas>). Usable as a grounder,
   not as a maintained dependency.

7. **CheaperInference cloud models could not be evaluated.** All three
   (`deepseek-v4.1-flash:cloud`, `glm-5.3-flash:cloud`, `kimi-k3.1-pro:cloud`)
   returned a credits error from the local Ollama proxy. Vision support is
   unverified. Do not put them in the baseline plan without a paid check first.

8. **OSWorld's Calc evaluator cannot express M1's failure taxonomy.** `sheet_data`
   is `DataFrame.equals`; a missing file and a wrong file both score 0. There is no
   `UNVERIFIED` state, so OSWorld's format cannot represent "the harness broke" vs
   "the agent failed" — which M1's 0-false-success criterion needs.

9. **OpenAdapt is not a baseline.** It is a verified-execution layer with published
   false-success measurements (§3.7). Using it as the "screenshot agent" baseline
   would understate the baseline and misrepresent the competitive landscape.

---

## Recommendations for M1

1. **Adopt OpenComputer's verifier shape, not its harness.** A per-app CLI that
   prints JSON with a primary boolean key per check, reading live state over the
   app's own IPC (UNO for Calc) and falling back to persisted-file parsing. Copy
   `verifiers/libreoffice_calc/libreoffice_calc.py` semantics; it is Apache-2.0 and
   already covers `cell-value`, `cell-formula`, `cell-format`, `sheet-exists`,
   `file-saved`, `column-sorted`, `merged-cells`, `named-range`, `autofilter`,
   `frozen-rows`, `conditional-format`, `data-validation`.

2. **Adopt OpenComputer's task/check schema.** `env.files` as a file-level fixture
   (not a VM snapshot), and a flat `verification[]` list of independent assertions,
   each with `command`, `key`, `expected`, and a human `description`. That list is
   the partial-credit unit and the evidence artifact in one.

3. **Adopt OSWorld 2.0's weighted `partial_scores` for the evidence file.** Emit
   both a binary `success` and a weighted `score` with per-criterion
   `{score, weight, description}`, weights summing to 1.0. Report `success_rate`
   and `check_pass_rate` separately, as OpenComputer's `report.json` does.

4. **Add the state OSWorld and OpenComputer both lack: `UNVERIFIED`.** A verifier
   error, a timeout, or an unreachable app must not collapse to `False`. M1's
   "0 false successes across 10+ corrupted trials" is only meaningful if the
   harness can distinguish "we proved it failed" from "we could not look". This is
   the single most important divergence from both prior designs.

5. **Compute the expected value outside the system under test.** Copy OSWorld's
   `employee_age_reference` discipline verbatim: regenerate the gold from a repo
   fixture plus the episode's parameters on the host, never read a gold file the
   guest could have touched. Its docstring is the rationale.

6. **Never `eval()` task-supplied strings.** OpenComputer does
   (`passed = eval(check["eval"])  # noqa: S307`). For a runtime that will
   eventually ingest third-party compiled procedures, that is a remote-code hole.
   Use a small declarative predicate language or a sandboxed expression evaluator.

7. **Do not use a general-purpose VLM as the baseline agent.** Measured: 2/16 cell
   grounding hits across two 12B-class local VLMs (§3.8). Use Agent S3 with
   UI-TARS-1.5-7B grounding, and name the grounder in the report. A baseline that
   fails on grounding proves nothing about verification.

8. **Cite OpenAdapt's numbers, and differentiate explicitly.** OpenAdapt measured
   54/72 bad saves reported as saved from the on-screen "Saved" message, and 30/30
   from a computer-use agent. M1's corrupted-trial suite should reproduce that
   shape for LibreOffice Calc and beat it with UNO read-back. Without this, M1
   reads as a reimplementation of an MIT-licensed project.

9. **Borrow OSWorld's `preserve_cells` idea as a negative assertion.** "You must
   not have changed this region" is a check type both OSWorld and OpenComputer
   under-use, and it is exactly what catches an agent that "fixes" a task by
   rewriting the sheet.

10. **Keep the Calc task family parameterized over a file fixture, and keep the
    evaluator independent of the agent's transport.** OSWorld's `postconfig` presses
    Ctrl+S via pyautogui before evaluating — the evaluator depends on a GUI
    keystroke landing. M1 should save through the app's own API or verify the
    persisted file directly, so the evaluator cannot be broken by a focus change.
