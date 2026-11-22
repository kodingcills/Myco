# Status of what Discovery's S1 needs: hidden split and trusted ingest

Date: 2026-11-22. From: Evaluation Foundry (P-TIF-6). To: outer loop, MVP Discovery.
Question: is the hidden split + trusted ingest that S1 needs merged, or what is missing?

**Answer: the hidden split is merged and working. The trusted ingest is not merged, and no
code path in `src/` can currently produce a decision-eligible row. S1 cannot run as a
decision input today.**

---

## 1. Hidden split — merged

| Artefact | Path | State |
|---|---|---|
| Seeded hidden fixture generator | `src/foundry/hidden-split/index.ts` | merged |
| Evidence bundle writer | `src/foundry/hidden-split/evidence.ts` | merged, **no production consumer** |
| Committed commitment (root hash + per-fixture hashes) | `foundry/hidden-commitment.json` | merged |
| Tests: uniqueness, tamper detection, swap detection, missing-fixture detection | `test/foundry/hidden-split.test.ts` | merged, passing |

`generateHiddenFixtures(seed, n)` produces distinct seeded variants of the four public
fixtures, and `commitment()` hashes them so a later run can prove it used the same set. The
committed commitment verifies against a fresh generation (asserted in the suite), so the
split is reproducible and tamper-evident.

**One caveat on the bundle writer**, found while writing this: `collectEvidence` has no
production caller. `grep -rn collectEvidence src/ test/` returns its definition plus three
calls in `test/foundry/hidden-split.test.ts`. Nothing in the scoring or replay path loads a
bundle, so the per-run artifact is a host-only writer whose round-trip is self-tested. It is
a prerequisite for the ingest, not evidence that the ingest exists.

**This half of S1 is ready.** Discovery can be given the commitment root and counts without
seeing the fixtures, which is the access model the pre-registration requires.

## 2. Trusted ingest — not merged

The scorer is explicit about it. `src/foundry/grader/discovery.ts:203`:

```ts
decisionEligible: false,
decisionBlocker: "trusted-live-artifacts-unavailable" as const,
```

That is not a default that some other path overrides. Searching `src/` for
`decisionEligible: true` returns **nothing** — the only occurrences are hand-built fixtures
in `test/discovery/replay.test.ts`. So every row the grader can produce today is
descriptive, and `src/discovery/replay.ts:205` reports exactly that:

> `missing.push("Foundry trusted ingest (every recorded row is descriptive)")`

### What "trusted ingest" means, concretely

`docs/foundry/contract.md` §"Discovery comparison evidence" lists what the ingest must bind
to one run. Four of the six are already produced; two are not.

| Requirement | State |
|---|---|
| Grader-owned hidden commitment | **done** (§1) |
| Distinct seeded hidden task/fault pairs matched across arms | **done** (`generateHiddenFixtures`) |
| Evidence of the actual delivered prompt bound to each run | **done** — `promptHash` is re-derived from the task and compared |
| Planner settings bound to the run | **done** — `planner.model` and `planner.settings` are compared against the pinned comparison settings |
| Trace, recorder closure and effect audits bound to the run | **partial** — `reconcileAudit` checks that calls, count and audits agree, but nothing attests that the recorder itself was not tampered with between the run and the ingest |
| **Independent save observations** | **missing** — the only account of what was saved is the arm's own recorder. `requireSavedBytes` exists for `hcu+shell` but there is no second observer that is not the arm |
| **Final persisted bytes bound to that same run** | **partial** — bytes are read and hashed, but nothing ties them to the run's identity beyond the caller's own claim |
| **The screen reading bound as a claim, not an observation** | **missing** — `todoTransport.screen()` returns `readText()` verbatim for the structural channel, and `observeScreenClaims` reports whichever fixture trap strings appear in it. A caller-supplied screen is therefore treated as a visible claim with no requirement binding it to what the guest displayed |

So the gap is not "write a function". It is three properties:

1. **A second observer.** Something outside the arm must record that the store was saved and
   what it held, so a false success cannot be manufactured by the arm's own recorder. Without
   it, "the arm says it saved" and "the store was saved" are the same evidence.
2. **An attestation boundary.** The ingest must be able to tell a run it observed from a run
   it was told about. Today `scoreDiscoveryTrial` takes the trace and the bytes as arguments,
   which means a caller can supply anything; that is why the contract says "caller-supplied
   claims about this provenance cannot establish eligibility". The same applies to the screen:
   a `visibleText` array is currently an unchecked claim, and it feeds the screen oracle.

## 3. What this means for S1

S1 is `ef-t01b` no-verify, Myco arm, ≥30 refutable pairs. It needs:

- the hidden split — **available now**;
- a Myco arm that runs on those hidden pairs — needs the runtime's first path and a VM slot;
- the trusted ingest — **not available**, so its rows would be descriptive.

**Recommendation:** run S1 anyway, and report it as descriptive. The run is not wasted: it
produces the ≥30 pairs, the wall-clock and step counts, and the failure modes that the
ingest will need to bind. What it cannot do is move the wedge, and the report must say so —
which `replay.ts` already does.

## 4. What the Foundry will build next, in order

1. ~~**Independent save observer**~~ — **built** (`src/foundry/baseline/attest.ts`):
   `SaveObserver` samples the persistence files and records a hash, byte length and whether
   the read came after the last save. The offline implementation is honest about being
   offline; a live run must supply an observer whose `id` names the real second channel.
2. ~~**Ingest attestation**~~ — **built** (`attest()` in the same file): strict by
   construction, with no "assume fine" branch. It refuses a run when the recorder is
   inconsistent or unfinished, when an audit names no recorded call or the wrong channel,
   when any persistence file lacks an observation, when an observation predates the last
   save, when the bytes changed after observation, when the screen reading came from the
   arm, or when the last save's bytes disagree with the observation. The required file set
   is the fixture's list **union** whatever the final state holds, and an empty set is
   refused — a caller-supplied list with no lower bound was the first defect the verifier
   found. It also reports `screenConstrained`, so an empty pixel-arm screen reads as
   "nothing to match" rather than "agreed".
3. **The eligibility flip** — **not done, and deliberately so.** `scoreDiscoveryTrial` still
   hardcodes `decisionEligible: false`. Wiring `attest()` into it is the one change that can
   turn a descriptive row into a decision input, and it is Tier 2: it needs a full verifier
   pass at the exact head, not a follow-up to this one.

**What is still missing for a real S1 run**, beyond the flip: an observer that is genuinely
independent. `offlineObserver` hashes bytes it is handed, which tests the gate's *contract*
but cannot test the gate's *premise* — that the reader is not the arm. That requires a second
connection to the guest, which is VM work.

## Sources

- `src/foundry/grader/discovery.ts:203` — the hardcoded blocker.
- `src/discovery/replay.ts:205` — the reported missing piece.
- `docs/foundry/contract.md` §"Discovery comparison evidence" — the six bindings.
- `docs/product/mvd-preregistration.md` §3 — decision eligibility.
- `foundry/hidden-commitment.json`, `src/foundry/hidden-split/` — the merged split.