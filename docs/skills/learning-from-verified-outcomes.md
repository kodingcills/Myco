# Learning from verified outcomes (capability track M)

Status: built, $0-tested, not measured. Tier 2. Code: `src/skills/`. Tests: `test/skills/`.
The measurement bar below is a proposal for `docs/product/capability-spec.md` to adopt; that
spec is a parallel PR and had not landed when this was written.

## What it adds

Myco's gate tells an agent whether a task is done. Track M lets later runs reuse what worked.
When a run is **verified by the gate** and **passed by the independent grader**, the harness
stores the procedure the agent followed as a **skill**. Later runs on the same or a similar
task can retrieve that skill as advice.

- **Skill record** (`src/skills/record.ts`): the task family, abstract similarity features
  (`app:calc`, `column-type:date`, ...), preconditions, a bounded list of steps (at most 12
  steps of at most 160 printable ASCII characters each), and provenance: run id, task id, an
  attempt-ledger reference, the gate verdict digest, the grade digest, the persisted-document
  digest and the planner.
- **Admission** (`src/skills/admission.ts`): the only way into the store (rules below).
- **Store** (`src/skills/store.ts`): an append-only, hash-chained `skills.jsonl` on local disk.
- **Retrieval** (`src/skills/retrieve.ts`, `src/skills/mcp-server.ts`): the `myco-skills` MCP
  server, with one read-only tool, `myco_skills_retrieve`.
- **Warm-vs-cold arm** (`src/skills/arm.ts`): wiring for the measurement, on the frozen task set
  `skills-rs-v1`.

Everything is local-only. Nothing here touches billing, accounts or hosting.

## Admission: verified AND graded, or nothing

A procedure is stored only when every rule holds. Each rule fails closed with a stable code.

| Rule | Refusal code |
| --- | --- |
| A gate result exists | `NO_GATE_RESULT` |
| Gate `verdict` is `verified` (refuted and uncertain are refused) | `GATE_NOT_VERIFIED` |
| Gate `accepted` is true | `GATE_NOT_ACCEPTED` |
| Gate reason codes include `ORACLE_PASS` | `GATE_NO_ORACLE_PASS` |
| The gate result names this run and this task | `GATE_RUN_MISMATCH`, `GATE_TASK_MISMATCH` |
| The gate's oracle family is the skill's task family | `GATE_FAMILY_MISMATCH` |
| The independent grader graded the run | `UNGRADED` |
| The grader passed it (`fail` and `ungradable` are refused) | `GRADE_NOT_PASS` |
| The grader and the gate read the same bytes | `GRADE_BYTES_MISMATCH` |
| The run was not assisted (track N); it must be stated as `false` | `ASSISTED_OR_UNKNOWN` |
| Gate corrections were off, and stated as off | `CORRECTIONS_ON` |
| The gate delivered no corrections | `CORRECTIONS_DELIVERED` |
| The ledger reference is well formed | `LEDGER_REF_INVALID` |
| The operator supplied the task's forbidden values | `NO_FORBIDDEN_VALUES` |
| The procedure passes the content rules | `FORBIDDEN_*`, `TEXT_*`, `PROCEDURE_*` |
| One skill per run | `DUPLICATE` |

The admission record keeps both outcomes as digests (`verdictSha256`, `gradeSha256`). It never
keeps the raw results.

## Retrieval

`myco_skills_retrieve` takes `{ taskFamily, features?, limit? }` and nothing else. Unknown fields
are refused.

- The operator binds the server to one task family. A request for another family gets
  `SCOPE_MISMATCH`, and nothing is served.
- Skills are ranked by Jaccard similarity of their features. A skill is served only at
  similarity 0.5 or more. At most 5 are served; the default is 3.
- Revoked and quarantined skills are never served.
- Every reply is labelled `advisory: true, evidence: false`. Refusals carry codes only.
- If the store fails verification when the operator opens it, the server is started with no
  store. Every call then answers `STORE_UNAVAILABLE` with no skills.

## Security model

**Skills are advice, never evidence.** The gate is unchanged. myco.gate/v1 still takes only
`taskId`, `runId` and `claim`. A warm run is checked by the same sealed gate and the same
independent grader as a cold run. Nothing a skill says can reach the gate or the grader:

- No module under `src/gate`, `src/benchmark` (grader included), `src/m2`, `src/integrity`,
  `src/verify` or `src/core` imports `src/skills`.
- `src/skills` imports the gate and the grader for types only. From `src/benchmark` it imports
  only the published task set at runtime. `test/skills/isolation.test.ts` enforces both.

**Separate server.** `myco-skills` is its own MCP server and process. It is not part of the
gate's server. It has no tool that checks, acts on the desktop, reads files or takes a path.
For the launch audit it is classified `agent-local` (`SKILLS_SERVER_CLASS`).

`runGatedTrial` audits launches with the gate's class only. A gated launch that grants the
skills tool is therefore refused today (unclassified tool, fail closed); a test pins this. Until
a reviewed change lets the gated trial classify `myco-skills`, the warm arm retrieves on the
harness side, through the same `callRetrieve` code the server runs, and hands the agent the
advice as text. The agent's task instruction is unchanged.

**What a record never holds.** The content rules refuse a procedure outright. They never redact
it and keep the rest. A procedure is refused if any precondition or step contains:

- secret-shaped text: API keys, tokens, private keys, `key=`/`token=` assignments, long opaque
  blobs;
- host paths: POSIX roots, `~/`, Windows drives, UNC shares, `file://`, `$HOME`-style variables;
- oracle internals: words like oracle, verifier, grader, fixture, pristine, expected value,
  ground truth, vault, seal, receipt; gate reason codes; `soffice`/UNO;
- prompt-injection shapes: "ignore previous instructions", raw `mcp__` tool names;
- the task's expected value, its record key, or any fixture cell of 3 characters or more
  (whole-token, case-insensitive match);
- non-printable or non-ASCII characters (no look-alike Unicode).

Provenance holds plain ids and digests only. It never holds the agent's claim, evidence paths,
the oracle spec digest or document bytes. The planted-marker tests in
`test/skills/record-markers.test.ts` cover each class, and they scan the stored bytes on disk.

The rules are deliberately strict. A false positive costs one skill that is not stored; a false
negative could leak an expected value into a later run's advice.

**Poisoning defences.**

- **Revocation.** An operator can revoke a skill with a closed set of reasons: `operator`,
  `poisoned`, `superseded`, `provenance-doubt`. A revoked skill is never served again.
- **Quarantine.** Every warm run records a `use` event for each skill it retrieved. The event
  carries that run's outcome: `verified` only when the gate verified AND the grader passed;
  `refuted` when either refuted, which includes a false VERIFIED caught by the grader. A skill
  with at least `quarantineAfter` refuted uses (default 1) is quarantined. Quarantine is
  sticky: later verified uses do not lift it.
- **Tamper evidence.** Each event carries a sequence number, the previous event's digest and
  its own digest. Each record carries its own digest, and the skill id is derived from it. On
  open, the store verifies the whole chain and every record's digest. It also re-runs every
  record shape and content rule, so a hand-written line with recomputed digests still cannot
  plant forbidden content or a non-verified provenance. Any failure refuses the whole store.
- **Head pin.** The operator can pin the head digest outside the store, for example beside the
  run ledger. A truncated or rolled-back log is then refused (`STORE_HEAD_MISMATCH`). Without a
  pin, someone who can rewrite the file and recompute every digest is not detected. The content
  and provenance rules still apply to anything that loads.
- **Concurrent edits.** Writes re-verify the file first. A change by anyone else since the last
  read refuses the write (`STORE_CHANGED`).

## The warm-vs-cold arm

The frozen task set `skills-rs-v1` (`skillTaskPairs()`, digest pinned in
`test/skills/arm.test.ts`) has 30 pairs. Each pair is built from published, satisfiable,
no-fault fc-v1 tasks with the same target column type:

- the **seed** task runs cold to fill the store;
- its later re-run is the **repeat** task;
- the **similar** task is a different fc-v1 task of the same family and column type, with a
  different record, value and fixture.

Protocol, as wired:

1. **Seed phase.** Every seed task runs cold with `learn: true`. Only outcomes that the gate
   verified and the grader passed become skills. Pin the store head.
2. **Measurement phase.** Every pair's repeat task and similar task run in both arms:
   - cold: no store at all;
   - warm: skills retrieved from the pinned store.

   Learning is refused outside the seed phase, so every measured trial sees the same store.
3. **Scoring.** A row is `verified` only when the gate verified AND the grader passed.

Rows use the schema `myco.skills.arm-row/1`. They are never R1 evidence:

- they fail the benchmark ledger schema;
- the R1 task-set binding does not know `skills-rs-v1`;
- they carry `evidence: "never-r1"`.

`summarizeSkillArms` refuses rows that break any of the arm's invariants. Cost per verified
follows R7: the total estimated cost of ALL trials divided by the verified count. A null cost
makes the cell null, never 0. The cost is a token-derived ESTIMATE, never billed USD.

## Proposed pre-registered measurement bar (for the capability spec)

Adopt this before any measured run. Measurement needs the integrity fixes (#518, the xlsx
replacement for #503, the #494 follow-up) and the lead's GO, and runs on Claude Ultra only.

- **Task set:** `skills-rs-v1` as frozen (digest
  `130217f6346860724f06deee276e01a3c1129d0a9cab58835c525bb06472d51c`): 30 repeat + 30 similar
  = 60 measured pairs per baseline arm.
- **Baselines:** the two M2 baseline arms, screenshot-only (C1) and hcu+shell. Each is run cold
  and warm, with the same model, harness, budgets and output ceiling. The only difference is
  the advice.
- **Endpoint:** verified rate. Verified means the gate verified AND the independent grader
  (`src/benchmark/grade`) passed, on the same captured bytes.
- **Test:** for each baseline, a one-sided exact McNemar test on the 60 paired outcomes, warm
  versus cold (`mcnemarOneSided`). The significance level is α = 0.025 per baseline (Bonferroni
  over the two baselines).
- **Power:** at the planned size, power is about 0.80 if 25% of pairs succeed warm-only and 5%
  succeed cold-only (a net gain of 20 points). It is about 0.58 at 20%/5%. Computed exactly
  over the multinomial of discordant pairs.
- **Bar (all must hold):**
  1. for at least one baseline, McNemar p ≤ 0.025, with the warm verified rate higher than the
     cold rate;
  2. **zero** stored skills from any outcome that was not gate-verified and grader-passed (the
     summary's invariant errors list is empty);
  3. the warm arm's false VERIFIED count (gate verified, grader not pass) is no higher than the
     cold arm's;
  4. R7 is reported per arm as an estimate. No claim is made from cost.
- **Secondary, reported but not claimed:** repeat and similar separately; per-column-type
  rates; quarantine and revocation counts.
- **Exclusions:** a pair whose cold or warm trial is harness-faulted is re-run in place
  (topped-up, #511). The faulted attempt is kept and linked; it is not dropped.

## What is out of this PR

- Measurement runs (VM, paid model).
- Extracting procedures from real hcu+shell and C1 traces. Today the harness, or a scripted
  agent in tests, supplies the steps.
- Letting the gated trial classify `myco-skills`, so the agent can call the tool itself.
- Checking a skill's `ledgerRef` against the append-only attempt ledger (lands with #518).
