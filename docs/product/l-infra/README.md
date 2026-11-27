# L-infra: the zero-contamination result on the Linux path

Track L (safe parallelism), measurement stage 1 (`docs/product/capability-spec.md` §L).
§5 says L's measurement needs the disposable Linux desktop **and L-infra's zero-contamination
result** first. This folder holds that result. It was produced in public CI, and anyone can
recompute it.

**SIMULATED. Not evidence of agent capability.** L-infra uses no model. Its rows come from a
scripted agent, so they never count toward a capability bar (§3 item 5). On `linux-plain`
no trial is ever counted as verified (`shared-host-dirs`). L-infra measures contamination,
not a verified rate.

## What runs

- **Task set.** All 90 satisfiable fc-v1 tasks, read from the committed bundle
  (`benchmark/false-completion/fc-v1`). The run is refused unless all three agree:
  - the manifest's hash of `tasks.jsonl`;
  - each committed fixture's hash;
  - the fixture the pool lays down.
- **Agent.** The Linux path's deterministic scripted agent (`calcActuatorAgent("honest")`).
  It drives real headless LibreOffice Calc inside each desktop, under its own Xvfb, and
  saves the edit.
- **Backend.** `linux-plain`, unprivileged: no root, no sysctl, no user namespaces. Each trial
  gets:
  - its own root, HOME and Xvfb (with its own cookie);
  - its own vault, key and gate;
  - an env allowlist, a /proc watchdog, and verified teardown.
- **Levels.** N = 1, 2, 4 and 8, each running every task once through the unchanged `runPool`.
  A level the host's caps refuse is recorded as not admitted, with the cap's own reason. It
  is never forced, and the cap checks are not weakened.
- **Canary.** Each desktop gets a unique canary: the pool's per-trial marker (128 random
  bits), planted in its workspace and env. The pool scans every other trial's workspace (live,
  before teardown), evidence, vault and gate records for it.
- **Positive control.** At N = 2, one trial writes its own canary into the other trial's
  workspace while both run. The scan must flag the victim `contaminated` and the leaker
  `leaked`. Without this, "0 events" could come from a scan that sees nothing. The control's
  rows are kept, but never in the event count.

## What "meets" means

`pnpm myco-l-infra-analyze` recomputes the result from `run.json` and `rows.jsonl` alone
(`src/parallel/l-infra-analysis.ts`). The result **meets** only when all of these hold:

| Check | Rule |
| --- | --- |
| Trials | at least 200 L-infra trials (§L stage 1) |
| Contamination events | 0. An event is a trial holding another trial's canary, or whose canary was found elsewhere (`contaminated`, `leaked`, or a non-empty `foreignMarkers`) |
| Unscanned trials | 0. Every trial's own canary was seen and its scan was complete |
| Coverage | every admitted level ran every satisfiable task exactly once |
| Run ids | disjoint (case-folded) |
| Fixtures | every row's fixture SHA-256 is its task's |
| Teardown | no process left and the root removed, for every desktop |
| Outcomes | every trial got `verified` (the honest scripted save), with no disqualifier except `shared-host-dirs` |
| Positive control | ran, and was detected on both sides |
| Task set | the run's task set is the committed bundle's (version, manifest and `tasks.jsonl` hashes) |

**`meetsAsSpecified`** also needs all four specified levels (1, 2, 4 and 8) to have been
admitted. A level the runner could not admit is listed under `deviations`.

With 0 events in n trials, the result also gives the rule-of-three 95% upper bound on the
per-trial contamination rate, 3/n.

## Recompute it

```sh
pnpm install --frozen-lockfile
pnpm myco-l-infra-analyze docs/product/l-infra/linux-plain-v1 --check
```

`--check` requires the recomputed `result.json` to match the committed one byte for byte.
`test/parallel/l-infra.test.ts` runs the same check in `pnpm test`.

To check that the committed rows are the CI run's rows, open the run URL in
`run.json` → `provenance.runUrl`. In the `safe parallelism (ubuntu-latest)` job, the step "L-infra
zero-contamination run" prints `run.json` and `rows.jsonl` between `BEGIN`/`END` markers,
with their SHA-256. These must equal `runSha256` and `rowsSha256` in `result.json`. CI also
runs `myco-l-infra-analyze --check` on its own fresh output in every run.

To produce a new run yourself (Linux, with LibreOffice Calc, Python-UNO and Xvfb installed):

```sh
pnpm myco-l-infra --allow-weak-isolation --agent calc --display xvfb --out /tmp/l-infra --print-rows
pnpm myco-l-infra-analyze /tmp/l-infra --check
```

## The committed result: `linux-plain-v1/`

| File | What |
| --- | --- |
| `run.json` | The run: backend, agent, host, task set and hashes, levels (admitted or not, and why), control, CI provenance |
| `rows.jsonl` | One row per trial, control rows included (`myco.parallel-l-infra-row/1`) |
| `result.json` | The analysis of the two files above, plus their SHA-256 (`myco.parallel-l-infra-result/1`) |

The headline numbers and the provenance are in the PR that committed this folder, and in
`result.json`.

## Limits (stated, not hidden)

- **N = 8 needs 8 CPUs.** Admission requires `maxConcurrent × cpusPerTrial ≤ cpuBudget ≤ host
  CPUs`. The public `ubuntu-latest` runner has 4 CPUs, so N = 8 is not admitted there. It is
  recorded as a deviation, so the result is `meets` at N = 1, 2, 4 but not
  `meetsAsSpecified`. Closing the gap needs a lead ruling: accept 1, 2 and 4, or run N = 8
  on a host with at least 8 CPUs.
- **`linux-plain` is weak isolation.** Trials share the uid, `/tmp` and the network, and
  other trials' roots are visible. A hostile agent can forge another trial's file without a
  canary (round-1 D1). That is why no `linux-plain` trial is counted, and why L-infra's agent
  is scripted and honest. L-infra shows that the harness never carries one trial's canary into
  another. It does not show that a hostile agent cannot. Strict isolation (`strict-linux-ns`,
  #551) has no pool adapter yet; that is a follow-up.
- **Faults are not injected.** Faulted fc-v1 tasks (`kill-app`, `delayed-save`,
  `focus-change`) run as their plain intent. L-infra concerns isolation, not recovery.
