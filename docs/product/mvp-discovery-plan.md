# MVP Discovery — plan, wedge hypothesis, and bounded proofs

Status: working plan, 2026-11-21. Owner: MVP Discovery. Backlog:
[../backlog/mvp-discovery.md](../backlog/mvp-discovery.md). State and sub-threads:
[../coordination/mvp-discovery-state.md](../coordination/mvp-discovery-state.md).
Competitor evidence: [../research/mvp-competitive-teardown.md](../research/mvp-competitive-teardown.md).

This document exists to be falsified. Every claim below is either sourced or marked
`[INFERENCE]`, and every direction has a kill criterion written before its run.

---

## 1. The question, stated so it can lose

M1 proved Myco can execute a desktop operation, verify the persisted outcome, and
recover from a failure. That is a technical foundation, not a product. The question
is narrower than "can agents use computers":

> **Would a developer choose Myco over an existing computer-use tool for a job they
> already have, and can we name the job and the number that proves it?**

The candidate answer, tested here: **a coding agent changed a desktop app; Myco
proves the user-visible flow still works, and produces a verdict a CI job can gate
on — even when the app's own UI lies about it.** Existing tools help an agent *do*
the flow. None of them, in the sources examined, turns the outcome into an
independent, machine-checkable result that survives failure.

If that answer is wrong, the evidence will say so (see §7).

---

## 2. What the competition actually is (from primary sources)

Full citations in `docs/research/mvp-competitive-teardown.md`. Summary of what
matters for the decision:

| Tool | What it is | What it gives a coding agent | What it does not claim |
|---|---|---|---|
| **Microsoft HCU** (MIT) | Go MCP server; AX + GUI channels; cross-OS; layout guard rejects a plan made on a changed desktop | Structured observation, batched actions, screenshot fallback, live-target checking | No persisted-state verdict, no recovery protocol, no durable test artifact, no procedure learning |
| **Orgo** | Cloud VMs for agents; API/CLI/MCP; fork/clone/suspend | A disposable machine, and a place to run your own agent | No task outcome verification; the agent's loop is yours |
| **Simular Sai** | Hosted computer-use agent; MCP; run-once → replay-as-code with model fallback | A finished task and a reusable skill; publishes OSWorld 2.1 numbers | "Done" is the agent's; replay is code + model fallback, not an independent oracle |
| **Screenshot-only control** | Pixels in, clicks out (e.g. Cua Driver pixel rung) | Baseline capability | Nothing structural; errors compound silently |
| **M1 / Myco** | Host runtime + guest agent, guarded programs, UNO/persisted-file verifier, recovery, evidence schema | A verdict from persisted state: `verified / refuted / uncertain` | Coverage is one adapter at a time; setup is heavier than an MCP install |

The honest competitive picture:

- **Transport is solved, or being solved by others.** HCU already ships a
  cross-OS MCP server with the exact observation/action vocabulary Myco's runtime
  is building. Competing there is a coverage race Myco loses on time and adoption.
- **The verification layer is not solved.** A web search of the primary docs found
  no independent, persisted-state outcome verdict in HCU, Orgo, or Sai. HCU checks
  that the *action target* is live; Sai checks that the *agent* says it is done;
  Orgo does not check.
- **The strongest counter-argument is agent competence.** A coding agent with shell
  access can inspect a JSON store or SQLite file itself. Therefore Myco cannot sell
  "verification exists". It must sell "the verdict is produced without agent
  discipline, is reproducible when the agent is gone, and is the same object in local
  and CI runs". The head-to-head adds an **HCU + agent shell** arm to test exactly this.

[INFERENCE] The durable-test framing is the difference between an agent that happens
to check and a test suite that always checks. This is the hypothesis MVD-004 decides.

---

## 3. Recommended starting wedge (provisional)

**Direction A, narrowed: "verified GUI tests for coding agents."**

Not "a desktop runtime", not "a computer-use API". The product is the thing a
developer commits to a repo: a task, the state oracle behind it, and a run report.
The agent writes and repairs the procedure; Myco guarantees the verdict.

Why A first:

1. **Distribution.** The user is already in a coding-agent environment with a repo,
   CI, and an app to test. No sales motion, no business-software integration.
2. **The seeded-bug demo is the argument.** `myco-todo` shows "saved 3 item(s)" while
   the store holds 2. A screenshot or transcript-based tool reports success. Myco
   reports `refuted` and names the missing item. That is a 60-second, reproducible
   proof of a property nobody else sells.
3. **M1 already built the hard half** (guarded execution, independent verification,
   recovery, evidence). The missing half is the developer surface, not the science.

Why B is the long-term execution abstraction, not the first experience:

1. B's value is higher per operation, but each app needs a state oracle. Coverage is
   slow, and the first proof would be another spreadsheet — not a business system.
2. B's buyer is an operations owner, not the agent developer. The product criterion
   for this milestone names an ordinary coding-agent environment; A tests that
   directly. B is tested after A, on the same host window, with the same evidence.

Why C is deferred:

1. Orgo already ships cloning and live forking; "branching exists" is not a
   differentiator.
2. The open question is whether branching beats replay-from-known-good enough to
   pay for memory snapshots. Nothing in the sources answers it; the cheap substitute
   (intent-log replay, research finding Q4) must be measured first.

**The positioning sentence to test:** *"Myco is the test runner for desktop apps
your agent can't otherwise trust: it drives the real GUI and returns a verdict from
persisted state, so a green run means the work landed."*

### 3.1 What this implies for the product surface

The developer experience is a **task package + run report**, not a new protocol:

```
myco test tasks/todo-save.yaml        # one command; exit code 0 verified, 1 refuted, 2 uncertain
```

```
tasks/todo-save.yaml
  app:      dogfood/apps/myco-todo
  desktop:  linux-x11          # or an existing transport adapter
  task:     DF-S01 (public)
  oracle:   foundry:df-s01-persisted-store   # Foundry-owned, not written here
  steps:    generated/recorded by the agent, guarded at run time
  evidence: runs/<runId>/{trace.jsonl,result.json}
```

Two surfaces, one core: a CLI (for humans and CI) and an MCP tool (for the agent).
The runtime already has both; the new part is the task/oracle contract and the
report. Exit codes matter: `uncertain` is not `0`.

### 3.2 The 60-second experience (the demo to build)

1. A coding agent is told: *"A user says todo items beginning with BUG disappear
   after saving. Reproduce it in the real app, fix it, and prove the fix."*
2. The agent asks Myco for a desktop, launches `myco-todo`, adds
   `fix login page`, `BUG: crash on save`, `update docs`, `Bugfix release notes`, saves.
   The status bar says **"saved 4 item(s)"**.
3. Myco reads the persisted store: two items are missing. Report: **refuted**, with
   the two missing names and the exact check that failed. The agent did not get to
   decide it was done.
4. The agent fixes `save_items`, reruns the same task. Report: **verified**.
5. The report is a page: claim, observed state, per-step guards, verdict, recovery
   events, artifact paths. It can be attached to a PR.

The contrast arm is the same agent with a screenshot-only tool, and the same agent
with HCU + shell access. The demo is only convincing if those arms are run, not asserted.

---

## 4. Bounded proofs

Each proof is one task family, one oracle (Foundry-owned), a fixed agent, and a
pre-declared decision rule. No proof expands into a product.

### A — verified desktop for a coding agent (TIF-53 / MVD-001)

- **Task:** DF-S01 (happy path) and DF-S02 (find the seeded bug), unchanged.
- **Agent:** one OMP agent, plus one Codex/Claude Code run for the "ordinary
  environment" criterion.
- **Oracle:** host-side parse of the persisted JSON store (Foundry). The agent's
  transcript is scored separately and never used as ground truth.
- **Evidence:** trace, result, report; screenshots of the report.
- **Decision rule (pre-declared):**
  - Pass if: 0 false successes on DF-S02; ≥90% `verified` on DF-S01 over 10 runs;
    time-to-first-verified-result ≤ 15 min from a clean checkout; the run is
    reproducible from the README by a second agent.
  - Fail if: the setup cannot reach 15 min on a developer machine, or the HCU+shell
    arm also gets 0 false successes **and** a comparable time — then A's only
    remaining value is the durable artifact, and the wedge moves to B.
- **Kill:** if the verdict requires Foundry's oracle to read the app's private
  files in a way a normal developer could not, the test is not portable; record it.

### B — verified operation on business software (TIF-54 / MVD-002)

- **Task:** one create/update-record operation with an interrupted write, on a
  surface with a real persisted oracle. First candidate is LibreOffice Calc with the
  existing UNO/file verifier; the second is chosen only if a business app can be
  driven locally without an account.
- **Decision rule:** over 10 trials with ≥3 interrupted, 0 false successes, 0 silent
  duplicates, and either `verified` or `uncertain` afterwards. Median cost per
  operation recorded.
- **Kill:** if every candidate needs an account or a vendor API, B is documented as
  unproven on this host — not asserted.

### C — branchable desktops (TIF-55 / MVD-003)

- **Design only until the runtime has `snapshot()`/`fork()`** (research finding Q3).
- **Experiment when unblocked:** one task with an ambiguous branch point; arm (a)
  retry from last verified step, arm (b) fork 2–3 candidate states. Paired per-trial
  table, sign test, overhead measured.
- **Kill:** if fork does not beat replay by the pre-declared margin at equal or lower
  cost, C is deferred. Do not build fork to fill a roadmap.

---

## 5. Head-to-head protocol (TIF-59 / MVD-004)

Arms: screenshot-only; HCU (MIT, no account); **HCU + agent's own shell
verification**; Myco; Orgo and Sai only if accounts are approved (otherwise
documented, marked "not run", with the exact blocker).

Same task parameters, initial state, step budget, and model settings. Score:

| Axis | Measurement |
|---|---|
| First-use setup | wall-clock and number of commands from a clean environment to the first `verified`/`refuted` result, by a fresh agent reading only public docs |
| Independently verified correctness | per-trial oracle verdict vs the arm's reported success; false-success count is the headline, not the reported success rate |
| Failure recovery | forced interruption: `verified`/`uncertain`/false success, and whether a post-recovery verification happened |
| Repeatability | second run after an app edit: agent turns, human interventions, repair steps |
| Economics | wall-clock, tokens/cost, infrastructure overhead per trial |

Statistics follow M1-015 §4.5: per-trial paired table, exact sign test, Wilson
intervals, and an explicit "underpowered at n=30" sentence when the discordant count
is too small. No public leaderboard claim.

---

## 6. Product criterion, restated as a test

The milestone's product criterion becomes:

> A developer with no Myco-specific setup, in a plain OMP/Codex/Claude Code
> environment, follows the public README and gets a verified result on their app in
> ≤15 minutes; on the seeded-bug task, Myco reports `refuted` where at least one
> alternative reports success; and the same task reruns without an agent in under a
> minute with the same verdict.

Sample: 3 developers/agents, 2 apps (myco-todo + one volunteer app if available).
Threshold: 3/3 complete, 0 false successes, median ≤15 min. If the threshold fails,
the criterion is not met, whatever the demos look like.

The technical criterion stays with M1/Runtime: reliably complete, verify, recover a
supported workflow with reproducible evidence. Discovery does not restate it.

---

## 7. What would overturn this plan

| Evidence | Consequence |
|---|---|
| HCU+shell arm gets 0 false successes at similar cost and setup | A's differentiation is the durable artifact and recovery only; test B first or reframe A as "CI for GUI" |
| Setup cannot get under 15 minutes on a developer machine | A is not a developer wedge; the transport becomes the product problem, and a hosted/one-command path must be chosen before A |
| Foundry's oracle cannot be made portable | The demo is a lab result; re-scope to B or to a narrower app class |
| Interrupted-operation trials produce duplicates or silent losses | B's guarantee is not reached; fix before claiming it |
| Fork overhead is small and success gain is large | C moves up; but only with the measured comparison |

---

## 8. What Myco should not build now

- A second accessibility/transport stack to compete with HCU/Cua. [INFERENCE:
  integrate or adopt; the runtime owner decides, this thread does not change scope.]
- A workflow registry / procedure compiler before the verified-test loop is proven.
- A job board, fleet controls, or "agent OS" surfaces.
- Any competitor comparison number we did not run or cite precisely.
- Fork/branch search before the replay comparison.

---

## 9. Open dependencies and escalations

1. **Foundry** — public task set ids + oracle paths for DF-S01/S02 and the B
   interruption task; scoring procedure. Discovery will not write them.
2. **Runtime** — RT-011 (first path), RT-015 (host-side file read), RT-016 (process
   control). Direction A's oracle depends on RT-015; B's interruption depends on RT-016.
3. **M1 Coordinator** — a bounded host window after the M1 sweep. No VM before sign-off.
4. **Tiffany** — Details MCP (account + paid plan) is not purchased; Orgo/Sai arms
   need an account/paid plan and are marked "not run" until approved.