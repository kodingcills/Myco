# F1 — Fault taxonomy for GUI-specific failure injection

Question: which failure modes should EF-003 (TIF-52) inject so that the faults are
*application- and GUI-specific* rather than generic file corruption?

Date: 2026-11-21. Level: L1 (primary-source reads; no experiment run). Owner:
Evaluation Foundry. Feeds: [docs/backlog/foundry.md](../../backlog/foundry.md) EF-003.

## Evidence

### OpenComputer (arXiv 2605.19769)

Fetched live from the arXiv API on 2026-11-21. Title: *OpenComputer: Verifiable Software
Worlds for Computer-Use Agents* (Wei, Ma, Zhao, Zhou, Ni, Gan, Cohan; 2026-05-19).
Abstract, verbatim on the parts that matter here:

> "app-specific state verifiers that expose structured inspection endpoints over real
> applications"; "a self-evolving verification layer that improves verifier reliability
> using execution-grounded feedback"; "an evaluation harness that records full trajectories
> and computes auditable partial-credit rewards". Coverage: "33 desktop applications and
> 1,000 finalized tasks". Finding: "hard-coded verifiers align more closely with human
> adjudication than LLM-as-judge evaluation, especially when success depends on fine-grained
> application state"; "open-source models exhibit sharp drops from their OSWorld-Verified
> scores".

**What this gives EF-003:** the verification *shape* (state endpoints per app), not a fault
taxonomy. The abstract names no failure classes. Anything claiming a specific fault list
"from OpenComputer" would be an invention — recorded here so a later reader does not
mistake a plausible taxonomy for a sourced one. The local finding
[q2-independent-verification.md](q2-independent-verification.md) already establishes the
same paper's verifier shape and the three hardening deltas M1 adopted.

### OSWorld 2.0 (arXiv 2606.29537; <https://osworld-v2.xlang.ai/>)

Fetched 2026-11-21 from the arXiv API and the project page. This is where the fault
families come from — the benchmark annotates tasks with the phenomena that break agents:

| Phenomenon (site §3 table) | Tasks | Share |
|---|---|---|
| Cross-source reasoning | 46 | 42.6% |
| Visual-spatial precision | 45 | 41.7% |
| Implicit-state inference | 43 | 39.8% |
| Multi-item state tracking | 43 | 39.8% |
| Conflict disambiguation (stale/noisy/contradictory sources) | 39 | 36.1% |
| Multimodal editing | 30 | 27.8% |
| Tutorial following | 22 | 20.4% |
| Dynamic environment (new info arrives mid-execution) | 10 | 9.3% |
| Streaming interaction (visual state changes between observation and action) | 6 | 5.6% |
| Proactive interaction (must ask the user) | 6 | 5.6% |

Headline finding, verbatim: agents "lose track of constraints, miss information that arrives
mid-task, guess rather than ask the user, and skip verification, struggling most when a task
hinges on hidden state they must recover."

Three published failure cases are directly usable as fault *shapes*:

1. **Task035 (purchase requests)** — late messages change the source of truth; the agent
   keeps executing a stale decision table. Failure naming on the page: "Old Decisions Are
   Executed Without Revalidation"; "Self-Check Misses the Absent Row".
2. **Task103 (FreeCAD)** — "Uncertainty Becomes an Arbitrary Coordinate"; "File Existence
   Replaces Geometric Validation".
3. **Task008 (reimbursement)** — "Deadline Verification Becomes UI Reverse Engineering";
   preparation consumes the horizon before submission.

## Decision

**Adopt the OSWorld 2.0 phenomena as the vocabulary, and derive five GUI-specific fault
classes for EF-003.** Each one must make the screen and the persisted state disagree in a
way that no file-level corruption produces, and each one maps to a phenomenon above:

| EF-003 class | What is injected | Phenomenon it stresses | Why a screenshot-only agent mishandles it |
|---|---|---|---|
| `stale-ui` | The app repaints (or leaves the old row) while the store holds a different value; refresh is required to see the truth | Conflict disambiguation; streaming interaction | The screen is *self-consistent* and wrong. Only a re-read through the app's own state channel reveals it. |
| `interrupted-write` | Save begins, the process is killed after the items pass but before the companion pass | Multi-item state tracking | Status bar already said "saved". The agent must detect the half-written document set. |
| `partial-persistence` | Two-file write where one file lands and the other does not | Implicit-state inference | The rendered list looks complete; only reading the second file shows the inconsistency. |
| `crash-mid-save` | Process death during the save with the window gone | Dynamic environment | Nothing to look at. Recovery requires a relaunch **and** a fresh state read, not a retry of a click. |
| `permission-denied` | Store path unwritable at save time; the app reports success anyway or silently swallows the error | Proactive interaction; "guess rather than ask" | The honest response is `uncertain`/blocked, not "done". Screenshot-only agents report success. |

The mapping table is the acceptance surface for EF-003: a fault that cannot be tied to a
phenomenon above is either generic file corruption (already covered by M1-010) or noise.

**Reject:** deriving any fault list from OpenComputer's abstract. The paper is cited for
verifier shape only; asserting it ships a fault taxonomy would be unverifiable from the
material read.

## Proposed smallest experiment

For each of the five classes, one fixture and one golden trace, run against the app model
in CI (no VM), proving (a) the fault arms, (b) the persisted end state differs from the
screen in the class's stated way, and (c) the state oracle refuses. Budget: host-only,
no guest time. Deferred until EF-001/EF-002 are verified (dependency rule).

## Next action

After EF-001/EF-002 verification: implement the five fault injectors against
`FixtureManifest` + the app model, add `faultVersion` to the score triple.

## Reopen-if

- EF-005's baseline arms turn out to have no file tool at all and no persistence channel —
  then `partial-persistence` cannot be observed by them and must be re-scoped or dropped.
- A fault class produces the same oracle output as `none` on every arm (i.e. it is not a
  fault, just a slower run).

## Cost spent

2 network reads (arXiv API ×2, project page ×1), no experiments, no VM.