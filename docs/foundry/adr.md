# Myco Evaluation Foundry — architectural decision records

Companion to [contract.md](contract.md) and [docs/backlog/foundry.md](../backlog/foundry.md).
ADRs continue M1's numbering (ADR-0001..0010 in
[docs/architecture/m1.md](../architecture/m1.md)) and the runtime's (ADR-0011..,
[docs/architecture/runtime.md](../architecture/runtime.md)). Consequential decisions
are flagged **[CONSEQUENTIAL]**.

---

## ADR-0017 — The Foundry is a separate owner, and its answers live in a separate root **[CONSEQUENTIAL]**

**Decision.** Task fixtures, state oracles, ground truth, fault schedules, and scoring
are owned by the Evaluation Foundry (project P-TIF-6), not by the runtime or M1
workstreams. Answers live under `src/foundry/oracles/` and future `src/foundry/hidden/`;
everything an implementer receives lives under `src/foundry/tasks/`. No file outside the
hidden roots may import them (`test/foundry/split.test.ts` enforces this on every CI run).

**Why.** M1 built its evaluator and its runtime in the same workstream. That is correct
for proving a demo works and wrong for a scoreboard: whoever writes the runtime also
decides what counts as success, and the runtime is the first thing optimised against the
metric. The separation is organisational (different owner thread, different Linear
project) *and* mechanical (a path rule CI can check), because an organisational promise
alone survives only until someone is in a hurry.

**Rejected.** Same-owner separation with a written code of conduct (unenforceable, and
already the status quo that produced the defect). Separate git repository (costs the
monorepo's shared CI and type-checking for a boundary that a path rule already gives).

**Cost.** Duplicated vocabulary between `src/core/` and `src/foundry/`; one extra owner
in review cycles for `src/foundry/**`.

## ADR-0018 — Two oracles per task: persisted state decides, the screen is only a trap

**Decision.** Every Foundry task carries a state oracle (primary, decides the verdict) and
a screen oracle (records what an agent could believe). State `verified` is necessary for a
pass; a visible screen claim is what makes a refusal attributable to "the agent trusted the
UI" rather than a mystery. Both are recorded per trial.

**Why.** The failure M1 exists to kill is a GUI self-report being mistaken for ground truth.
Scoring the screen as a second *deciding* oracle would re-import that failure whenever a
task's screen happens to be right; scoring it as a *trap* keeps the state oracle
authoritative while making the false success legible in the report. The M1 verifier already
does one half of this (UNO + file parse, ADR-0002); the screen half is what was missing.

**Cost.** Two readers per task, and a screen-read implementation per app. The screen oracle
is deliberately coarse (substring match over declared trap strings) so that a change to an
app's status text breaks a fixture loudly rather than silently passing it.

## ADR-0019 — The no-leak rule is a type rule, not a review habit

**Decision.** A state oracle's `expected()` may take `(TaskIntent, InitialState)` and nothing
else. It cannot take an `ActualState`, a screen view, or a trace. The violation does not
compile.

**Why.** "Don't let the verifier read the agent's output" is easy to state and easy to
break in a refactor that adds a convenience parameter. Encoding it in the signature makes
the breakage a type error. The mutation audit in `test/foundry/oracle.test.ts` then proves
the other direction — that a hand-written near-miss of a correct run is refused — so the
oracle cannot be simultaneously leaky and permissive.

**Cost.** Oracles cannot peek at intermediate states to produce better error messages; the
report loses some diagnostic detail in exchange for an answer that cannot drift.

## ADR-0020 — The trace guard lives with the task, not with the runtime

**Decision.** The "was this solved without the GUI?" check is a property of the fixture,
applied identically to every arm, and it can only *refuse* a run — never pass one.

**Why.** A runtime-owned guard would be absent for the screenshot baselines (whose results
must be comparable) and would be written by the team whose shortcut it detects. A task-owned
guard is the same rule for Myco, C1, C2, HCU, Orgo and Sai, and it cannot inflate anyone's
score. Making it refuse-only keeps its bugs conservative: a guard bug costs a visible false
refutation, never a false success.

**Cost.** The guard needs trace events the M1 schema already emits (`action`, plus two
Foundry-era additions: `save-observed`, `file-write`). Those additions are additive to
ADR-0007's `trace.jsonl` and are meant to land as an M1-012 schema extension, not a
rewrite.

## ADR-0021 — The app under test is modelled, and the model is not the verifier

**Decision.** `src/foundry/tasks/app-model.ts` is a deterministic model of the seed app's
observable contract (listbox render, status line, save path, the planted defect). The state
oracle deliberately does **not** import it, and re-implements the app's *persistence*
normalisation independently.

**Why.** Proving traps fire requires running the app, and Tkinter cannot run in CI. A model
gives that proof for free. Sharing the model with the oracle would be worse than pointless:
app bugs and verifier bugs would cancel out, and the verifier would agree with the app
about a wrong answer. Two independent implementations of the same contract is exactly the
redundancy M1's UNO + file-parse pair already relies on.

**Cost.** The model and the real app can drift. Mitigation: `bootApp` serialises through
`buildTodoInitialState`, so the model's starting bytes are the fixture's bytes, and a drift
test fails loudly rather than producing a quiet pass.

## ADR-0022 — Version triple on every score

**Decision.** Every scored result carries `fixtureVersion`, `oracleVersion`, and (for the
faulted suite) `faultVersion`. A report that cannot name its triple is not reportable.

**Why.** Benchmarks that edit prompts or checkers between runs and publish one number are
the reason "we beat X on Y" claims are unverifiable. The triple costs three integers per
trial and makes every published number reproducible or visibly unreproducible.