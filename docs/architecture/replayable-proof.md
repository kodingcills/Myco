# Replayable proof (capability track Q)

Status: M2 capability track Q, Tier 2. Code: `src/proof/`, CLI `scripts/proof.ts`, tests
`test/proof/`. Local only: no network, no model, no VM.

## What it is

A **proof bundle** is one JSON file that records one run so someone else can check it:

- the ordered **actions** (agent or harness, tool, a redacted summary);
- the **gate verdicts** (`myco.gate/v1`: verdict, `accepted`, reason **codes** only, never
  free-text reasons) and the evidence each verdict cites;
- **evidence digests** (sha256 and byte count of each artifact; small clean text inlined);
- **checkpoints** of multi-step tasks;
- **handoffs** between agents or sessions (shape lands with track N);
- **policy decisions** (allow / deny / ask, with a code; shape lands with track O);
- a **ledger anchor** and the **attempt ledger** itself (#518's `attempts.jsonl` events,
  verbatim), binding the run to its start and end events and to the ledger head.

Every record is hash-chained: `prevSha256` is the sha256 of the previous record's canonical
JSON (sorted keys), 64 zeros for the first. The bundle pins its head (record count, last
hash). This is the same construction as the attempt ledger (#518).

```
npx tsx scripts/proof.ts export RUN.json --out bundle.json [--forbid-file F]
npx tsx scripts/proof.ts verify bundle.json [--evidence-dir D] [--expect-head H] [--expect-ledger-head H]
npx tsx scripts/proof.ts report bundle.json --out report.html
```

Exit codes: 0 ok, 1 refused, 2 usage. `RUN.json` is a `ProofRunInput` (`src/proof/bundle.ts`)
written by the harness, never by the agent.

## The verifier

`verify` recomputes every record hash and chain link, the head, every inline evidence digest,
every digest-only artifact when `--evidence-dir` points at the run's evidence, and the whole
attempt ledger. It refuses (exit 1, a code per error) on:

| Code | Cause |
|---|---|
| `PROOF_CHAIN` | an edited, removed or reordered record (the chain breaks) |
| `PROOF_GAP` | a `seq` that is not the record's index (a gap or a reorder) |
| `PROOF_TRUNCATED` | the records do not reach the pinned head (tail cut or extended) |
| `PROOF_SCHEMA` | not JSON, or any unknown field, wrong type, non-code reason, or absolute or escaping evidence path |
| `PROOF_CLAIM` | the claim is not the fixed statement below (no stronger claim) |
| `PROOF_EVIDENCE` / `_DIGEST` / `_MISSING` | an inlined frame, a duplicate id, content that does not match its digest, an original file that changed or is missing |
| `PROOF_VERDICT` | `accepted` without `verified`, `verified` without `ORACLE_PASS` or `ORACLE_PASS` without `verified`, a verdict for another task or run, or citing evidence not recorded before it |
| `PROOF_LEDGER_CHAIN` / `_HEAD` / `_ANCHOR` | an edited, reordered or truncated ledger; a ledger with no anchor or an anchor with no ledger; an anchor that does not point at exactly one start and one end of the run's trial, for the run's task |
| `PROOF_ANCHOR_MISMATCH` | a head differs from the one given out of band |
| `PROOF_REDACTION` | the bundle carries a secret, an absolute host path, or a forbidden literal |

The exporter runs the same verifier on what it built and refuses to write a bundle that would
not verify. The report refuses to render one.

## Security model (stated plainly)

**Tamper-evident, not tamper-proof.** The claim every bundle carries, and the only claim the
verifier accepts, is:

> Tamper-evident, not tamper-proof: any edit, gap, reordering or truncation of these records or
> of the attempt ledger they carry is detected when checked against the heads pinned here (the
> attempt ledger's guarantee, #518, and no more). The trusted harness that wrote the run is the
> boundary: the chains are unkeyed and unsigned, so whoever can write the whole bundle can
> regenerate a consistent one; only a head received out of band detects that.

So:

- **The trusted harness is the boundary.** The bundle proves that what you hold is what the
  harness wrote, as far as partial changes go. It does not prove the harness recorded honestly.
- **Whole-bundle regeneration is not detected** unless you check a head you received separately
  (`--expect-head`, `--expect-ledger-head`; for example the pack's ledger pin recorded
  host-side). A test pins this limit ("STATED LIMIT") so it stays visible.
- **Nothing is signed or keyed.** Rewrite resistance (a signed or externally anchored head) is
  the same open decision as #518's and is not built here.
- **Simulated runs are never evidence.** `run.simulated` is in the hashed bundle; the verifier
  reports it and the report shows a banner.
- **The gate is unchanged.** The bundle is built after the run from the harness's own records.
  The agent still supplies only `taskId`, `runId` and `claim`; nothing here is a new gate input.

### Redaction

No secret, absolute host path, username or vault key may be in a bundle or report.

1. The exporter rewrites every string: registered literals first (secret values, vault keys,
   the host's home, temp and checkout directories), then generic shapes (POSIX and Windows
   absolute paths, `file:` URLs, private keys, bearer and vendor key shapes, `key=value`
   credentials), then the account name as a whole word.
2. Evidence text is inlined only if redaction would leave it byte-identical, so an inline
   digest is always the original artifact's. Otherwise it is digest-only (`withheld:
   "redaction"`).
3. **Screenshots and frames are never inlined**, only their digests (`withheld: "frame"`). The
   watch view has no merged pixel-redaction rules, and this track does not invent them.
4. The serialized bundle is scanned again before it is written, by the verifier, and the
   report is built only from a verified bundle. A leak that survives step 1 stops the export.
   It is never written. Leak reports name kinds and offsets, never the value.

Planted-marker tests (`test/proof/redaction.test.ts`) plant fake secrets, key shapes, a vault
key, a username and macOS, Linux and Windows home paths in every free-text field. They assert
none reach the bundle or the report.

### The report

`report` writes one static HTML file: no script, no link, no image, no remote URL, a
`default-src 'none'` CSP, and every value HTML-escaped. Replay is read-only and needs no
server, so there is nothing to bind to loopback.

## Dependencies

- **#518 (attempt ledger), open.** `src/proof/ledger.ts` re-states its documented format (event
  schema, canonical JSON, genesis, head) and does not import it. TO FILE: bind to #518's final
  `verifyAttemptLedger` and `eventSha256` once it merges, with a parity test.
- **Track N (handoffs), track O (policy decisions), in flight.** The bundle defines minimal
  closed shapes (`HandoffBody`, `PolicyBody`). The record kinds land with N and O: their
  records map onto these shapes, never the reverse.
- **Live runner wiring.** The live harness must write `RUN.json` as the trial runs. That needs
  the VM, so it is out of this PR.

## Proposed pre-registered measurement bar (for `docs/product/capability-spec.md`)

Proposed for the capability spec to adopt or amend before any measurement run. The runs need
the integrity fixes and the lead's GO, on Claude Ultra. This PR runs none.

**Arms.** Myco (gate + proof bundle) against the two baselines: **C1** (screenshot-only; its
shareable record is the screenshot trail and transcript) and **hcu+shell** (its record is the
transcript and shell log). The tasks and trials are the same for every arm, paired by trial.

**Ground truth.** The **independent grader** (`src/benchmark/grade`, no code shared with the
gate) grades each trial's persisted bytes. Simulated rows never count.

**Q1, integrity (deterministic, no model, all-or-nothing).** Over every bundle from the
measurement run (n ≥ 30):

- 100% verify;
- 100% of a pre-registered tamper battery is refused. The battery is edit, delete, swap and
  truncate at every record position, plus ledger edit, reorder and truncate, plus an evidence
  file swap: at least 300 cases;
- 0 planted-marker leaks.

A single miss fails Q1. With 0 misses in 300 cases, the exact one-sided 95% upper bound on the
miss rate is about 1%.

**Q2, audit value over baseline (primary).** Take the trials where the agent claimed done and
the grader says not done (false success; seeded with silent-drop tasks of the df-s02 kind).
Count those whose shareable record lets a blind auditor reach the grader's outcome. The
auditor sees only that arm's record, with a fixed rubric, and does not know the arm where the
format allows. For Myco, the auditor's answer must also be machine-checkable: a verified
bundle whose verdict is `refuted` or `uncertain`.

- **Sample size:** at least 40 false-success trials per arm, from 60 or more trials per arm.
- **Test:** exact McNemar on discordant pairs, one-sided α = 0.05, Myco against C1 and Myco
  against hcu+shell, with Holm correction over the 2 comparisons.
- **Pass:** both comparisons significant, and Myco's false-VERIFIED rate (the record shows done
  but the grader says not done) is 0.

**Cost.** Export and verify make no model calls, so the R7 numerator gains no tokens. R7 is
unchanged: total cost of all trials divided by verified trials, a token-derived estimate, null
cost never 0.
