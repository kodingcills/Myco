# Issue specs — filed (2026-11-22)

The Foundry has no Linear connector (`docs/agents/issue-tracker.md`: agents do not have
Linear credentials), so these were written as specs for the outer loop to file. **All three
have now been filed**; ids below. Kept in the repo because the acceptance criteria are the
record of what was asked for.

| Spec | Linear id | State |
|---|---|---|
| Backlog reconciliation | **TIF-112** | open; branch `tif-112-reconcile` |
| EF-008 slot 5 HCU | **TIF-113** | filed |
| EF-007 attestation placement decision | **TIF-114** | decided: option 1, implemented in PR #211 |
| EF-009 in-process brand forgeability | **TIF-115** | filed; known limit recorded in PR #211 |

---

## 1. Reconciliation: backlog vs Linear on TIF-52 / TIF-58 / TIF-74 — **TIF-112**

- **Title:** `Foundry backlog: reconcile TIF-52, TIF-58 and TIF-74`
- **Project:** P-TIF-6 Myco Evaluation Foundry
- **Type:** Task · **Priority:** Medium · **Tier:** 0 (docs only)
- **Description:** `docs/backlog/foundry.md` disagreed with Linear in two places. (a) EF-003
  was described as "partial" in prose but had no `linear status` field, so the doc and Linear
  could drift silently. (b) EF-005 (TIF-58) absorbed all later work, while Linear tracks that
  work as TIF-74. The doc now states the Linear status word explicitly on every entry, splits
  the later work into EF-006 (TIF-74), and adds EF-007 (attestation placement decision) and
  EF-008 (slot 5 HCU) as entries awaiting ids.
- **Acceptance:** every Foundry entry carries a `linear status` line that matches Linear;
  EF-006 is attributed to TIF-74; no entry claims work that belongs to another id; the
  contract's Linear list matches the backlog.
- **Branch:** `tif-NN-reconcile` · **PR title:** `TIF-NN: reconcile Foundry backlog with Linear`

## 2. Slot 5: Microsoft Hybrid Computer Use GUI arm — **TIF-113**

- **Title:** `EF-008: slot 5 HCU GUI arm on the 30 Calc trials`
- **Project:** P-TIF-6 Myco Evaluation Foundry
- **Type:** Task · **Priority:** Medium · **Tier:** 2 (live run, evidence)
- **Description:** Slot 5 is documented only inside TIF-58's handoff note
  (`docs/foundry/hcu-slot-5.md`). A run that needs its own GO, its own $0 spend cap and its
  own evidence has no issue to be tracked against. Scope: HCU's `GUI` channel only (no `AX`,
  no shell) over the 30 normal Calc record-edit trials in the finalized M1 v3 parameter
  order, as a descriptive reference alongside C1. HCU is a computer layer, not an agent, so
  the planner must be named in every row.
- **What exists:** adapter boundary and offline acceptance checks written; evidence schema
  accepts an `hcu` sub-arm identity (PR #102); frozen v3 inputs verified offline (both
  SHA-256 hashes matched, all 30 rows joined).
- **What is missing:** a Windows ARM64 bundle with a pinned revision and hash; a live
  GUI-only transport; a planner confirmed within the $0 cap; the Coordinator's GO.
- **Acceptance:** spike result recorded with evidence (a screenshot and a typed value
  persisted, or the exact structured refusal code); 30 trials scored by the shared blind
  judge on independently captured workbook evidence; skipped and unfinished trials reported
  separately; the report names the planner and states that HCU is a layer, not an agent.

## 3. Decision: where the attestation gate runs — **TIF-114**

**Decided 2026-11-22:** option 1. Implemented in PR #211.

- **Title:** `EF-007: decide where the attestation gate runs (fixture identity)`
- **Project:** P-TIF-6 Myco Evaluation Foundry
- **Type:** Decision · **Priority:** High (blocks the eligibility flip) · **Tier:** 2
- **Description:** `attest()` (merged, PR #192) takes the fixture and the observations as
  arguments. A caller can pass the real `fixtureId` with a benign `persistenceFiles`, or
  supply observations and final bytes together, and a match between two things the caller
  controls proves nothing. This is not fixable inside the function — no code can verify its
  own inputs' provenance. Two options, both about *where* the gate runs:
  1. **Resolve the fixture from the hidden commitment.** The ingest looks the fixture up
     itself and rejects any whose hash does not match `foundry/hidden-commitment.json`.
     Cheaper, testable offline.
  2. **Run the ingest out of the arm's reach.** A separate process the arm cannot call, with
     `attest()` not exported to arm code. Stronger guarantee, more moving parts.
- **Why it matters:** wiring `attest()` into `scoreDiscoveryTrial` is the change that turns a
  descriptive row into a decision input. It must not land before this is decided.
- **Acceptance:** a recorded decision naming one option with its reason; the chosen option
  implemented and tested; `attest()` cannot be satisfied by caller-supplied provenance under
  the chosen design.

---

## Not filed, and why

- **Viewer verdict budget flake** — already fixed upstream. `.github/workflows/ci.yml` now
  runs that job only on `push` or a `perf` label, which is the second option I recommended.
  No issue needed; recorded here so the earlier report is not left looking open.
- **Verifier FAILs on PRs #110, #171, #181, #192** — each was resolved inside its own PR
  before merge, and each fix has a regression test. Filing retroactive issues for closed
  defects would be noise. The one exception is the fixture-identity limit, which is item 3
  above because it is genuinely open.
- **EF-003's 30-corrupted-trial run** — already tracked under TIF-52, which Linear has as
  partial. No new issue.
