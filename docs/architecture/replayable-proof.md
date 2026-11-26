# Replayable proof (capability track Q)

Status: M2 capability track Q, Tier 2 (#553, superseding #548 and #533). Code: `src/proof/`,
CLI `scripts/proof.ts`, tests `test/proof/`. Local only: no network, no model, no VM.

**Allowlist export (lead decision, #553).** A bundle writes ONLY closed-schema fields. Every
free-text or path-capable value (paths, filenames, command lines, error text, notes, URLs, any
string from the agent, the host or the harness) is replaced **structurally** before it is
written, by its sha256, never by pattern-based redaction. The pattern scanner stays only as a
backstop that fails the export closed if it ever fires. #533 and #548 used all their rounds on
one leak class because a denylist scanner kept missing new path forms; under the allowlist a
path never reaches the bundle whatever its form, because no string field can hold it: every
string field is an enum, a strict id grammar with no separator, a digest, or a hash. (Round 1
of #553 found one exception, `evidence.mediaType`, whose `type/subtype` grammar admitted a
lower-case relative `dir/<user>` path; it is now a closed enum, see below.)

## What it is

A **proof bundle** is one JSON file that records one run so someone else can check it. It
is a tamper-evident **container over the attempt's canonical episode record**, not a second
per-attempt record: `myco.episode/1` (data capture, #542; capability spec part 2, #538 §3) is
the one canonical record of an attempt. The bundle's `run.episode` references that episode by
`episodeId` and sha256 (or is `null` for a run written before episodes exist), its `run` fields
(`runId`, `taskId`, `arm`, `simulated`) are a projection of the episode's, and the rest is Q's
own: the hash chain, evidence digests, the ledger anchor, and handoff and policy decisions.
The episode is validated as a whole by #542's own `validateEpisode` (`src/episode/validate.ts`,
called, not modified) before anything is projected from it: the export and the verifier refuse
an episode #542 refuses (`PROOF_EPISODE`, naming #542's issue codes only, never a path or a
value), so an invalid episode is never reported as cross-checked. The id and digest are #542's
`episodeIdOf` and `canonicalJson`. With `--episode E` the verifier also recomputes the
episode's id and digest and refuses any projected field that disagrees (`PROOF_EPISODE`);
`episodeChecked` is true only when the episode is valid and every check passed. The digest is over the episode's canonical
JSON without the trailing newline #542's store appends, not over the file's bytes. Without
`--episode`, a bundle that references an episode still verifies, but the reference is **not
cross-checked**: the result says `episodeChecked: false` and the report says "reference only:
not checked here". The bundle never copies the episode's other groups (ground truth, agent
claim, provenance, observations).

The bundle carries:

- the ordered **actions** (agent or harness, the tool id, and the summary as a digest);
- the **gate verdicts** (`myco.gate/v1`: verdict, `accepted`, reason **codes** only, never
  free-text reasons) and the evidence each verdict cites;
- **evidence digests** (sha256 and byte count of each artifact, and the digest of its path;
  no artifact is ever inlined);
- **checkpoints** of multi-step tasks;
- **handoffs** between agents or sessions (shape lands with track N);
- **policy decisions** (allow / deny / ask, with a code; shape lands with track O);
- a **ledger anchor** and the **attempt ledger** itself (#518's `attempts.jsonl` events,
  verbatim), binding the run to its start and end events and to the ledger head.

Every record is hash-chained: `prevSha256` is the sha256 of the previous record's canonical
JSON (sorted keys). The first record's `prevSha256` is the sha256 of the canonical `run`
header, so the run's ids, arm, `simulated` flag and episode reference are covered by the chain
and the head. The bundle pins its head (record count, last hash). Apart from that genesis, this
is the attempt ledger's construction (#518).

The ledger anchor binds the run to one trial of the ledger: that trial's single start and end
events, which must carry the run's task and the run's arm (an anchored run must state its arm;
`hcu+shell` is a valid arm). It does not bind the run id, because the ledger has none.

```
npx tsx scripts/proof.ts export RUN.json --out bundle.json [--forbid-file F] [--user-file U]
npx tsx scripts/proof.ts verify bundle.json [--evidence-dir D] [--episode E] [--expect-head H] [--expect-ledger-head H] [--user-file U]
npx tsx scripts/proof.ts report bundle.json --out report.html [verify flags]
```

Exit codes: 0 ok, 1 refused, 2 usage. `RUN.json` is a `ProofRunInput` (`src/proof/bundle.ts`)
written by the harness, never by the agent. `RUN.json` may name `episodeFile`, the attempt's
episode. Nothing from `RUN.json` is written as text (see "Allowlist export"). `--forbid-file`
lines (literals) and `--user-file` lines (account names, matched as whole words in any letter
case) feed the **backstop**: the exporting host's account name, home, temp and checkout
directories are registered automatically, and if any registered value still appears in an
output (for example a closed id that equals the guest's account name), the command fails
closed. Register the guest's account name in `--user-file`. Neither file's contents are ever
printed.

## The verifier

`verify` recomputes every record hash and chain link, the head, every artifact digest when
`--evidence-dir` points at the run's evidence (a file is matched to its record by the digest of
its path relative to that directory; a symlink out of it is refused), and the whole attempt
ledger. Every message is built from closed values and schema field names: no message quotes a
value from the bundle. It refuses (exit 1, a code per error) on:

| Code | Cause |
|---|---|
| `PROOF_CHAIN` | an edited, removed or reordered record, or an edited `run` header (the chain breaks) |
| `PROOF_GAP` | a `seq` that is not the record's index (a gap or a reorder) |
| `PROOF_TRUNCATED` | the records do not reach the pinned head (tail cut or extended) |
| `PROOF_SCHEMA` | not JSON, any unknown field, any value outside its closed type (a free-text string where a digest is, an id outside the closed grammar, a non-code reason, an inlined artifact) |
| `PROOF_CLAIM` | the claim is not the fixed statement below (no stronger claim) |
| `PROOF_EVIDENCE` / `PROOF_EVIDENCE_DIGEST` / `PROOF_EVIDENCE_MISSING` | a duplicate id, an evidence path that escapes the evidence dir, an original file that changed or is missing |
| `PROOF_VERDICT` | `accepted` without `verified`, `verified` without `ORACLE_PASS` or `ORACLE_PASS` without `verified`, a verdict for another task or run, or citing evidence not recorded before it |
| `PROOF_LEDGER_CHAIN` / `PROOF_LEDGER_HEAD` / `PROOF_LEDGER_ANCHOR` | an edited, reordered or truncated ledger; a ledger event that fails #518's own check (`verifyAttemptLedger`: unknown field, unknown arm, a start with an outcome, an end without one, a harness class without `harness-fault` or the reverse); a ledger with no anchor or an anchor with no ledger; an anchor that does not point at exactly one start and one end of the run's trial, for the run's task and arm |
| `PROOF_EPISODE` | with `--episode`: an episode #542's `validateEpisode` refuses (codes only), an episode whose id is not its content hash, that differs from `run.episode`, whose run id, task, arm, simulated flag or trial key differs from the bundle's, or an episode given for a bundle that references none |
| `PROOF_ANCHOR_MISMATCH` | a head differs from the one given out of band |
| `PROOF_REDACTION` | the backstop fires: a parsed string value or key carries something it recognises (a secret shape, a host-path shape, a registered literal or account name), in any decoded form |

The exporter runs the same verifier on what it built and refuses to write a bundle that would
not verify. The report refuses to render one, and refuses to return HTML that the backstop
flags. The CLI scans each line it prints and prints only error codes if one would
leak.

## Security model (stated plainly)

**Tamper-evident, not tamper-proof.** The claim every bundle carries, and the only claim the
verifier accepts, is:

> Tamper-evident, not tamper-proof: any edit, gap, reordering or truncation of these records or
> of the attempt ledger they carry is detected when checked against the heads pinned here (the
> attempt ledger's guarantee, #518, and no more). The trusted harness that wrote the run is the
> boundary: the chains are unkeyed and unsigned, so whoever can write the whole bundle can
> regenerate a consistent one; only a head received out of band detects that. A verdict record is
> what the gate said, not a finding that it was right.

This is exactly #518's ruled threat model (`src/m2/attempt-ledger.ts`, lead ruling on #518 D3),
and no more:

- **The adversary is the checked agent and any guest-side process. The harness is trusted.**
  Against that adversary, and against accidental drops or edits, the bundle is tamper-evident.
- **It is not proof against a malicious bundle author.** Whoever controls the harness and
  writes the whole bundle can write a consistent one.
- **A verdict record is what the gate said, never a finding that the gate was right.** Whether
  it was right is the independent grader's call; the report says so next to every verdict.
- **The trusted harness is the boundary.** The bundle proves that what you hold is what the
  harness wrote, as far as partial changes go. It does not prove the harness recorded honestly.
- **Whole-bundle regeneration is not detected** unless you check a head you received separately
  (`--expect-head`, `--expect-ledger-head`; for example the pack's ledger pin recorded
  host-side). A test pins this limit ("STATED LIMIT") so it stays visible.
- **Nothing is signed or keyed.** Rewrite resistance (a signed or externally anchored head) is
  the same open decision as #518's and is not built here.
- **Simulated runs are never evidence.** `run.simulated` is covered by the chain (the run
  header seeds it); the verifier reports it and the report shows a banner.
- **The gate is unchanged.** The bundle is built after the run from the harness's own records.
  The agent still supplies only `taskId`, `runId` and `claim`; nothing here is a new gate input.

### Allowlist export

The exporter does not look at what a string says. It looks at which field it is in:

| Type | Written as | Fields |
|---|---|---|
| enum | as is; any other value is refused (`PROOF_INPUT`) | `action.actor`, `verdict.verdict`, `verdict.reasonCodes` (the gate's reason codes), `checkpoint.verdict`, `policy.decision` |
| boolean | as is; any other value is refused | `run.simulated`, `verdict.accepted` |
| integer | as is; any other value is refused | `checkpoint.checkpoint`, `handoff.checkpoint` |
| sha256 digest | as is; any other value is refused | `verdict.oracle.specSha256` |
| id | as is when it matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, else **hashed**: `h-` + its digest (itself a closed id, so equality is still checked) | `run.runId`, `run.taskId`, `action.tool`, `evidence.evidenceId`, `evidence.evidenceKind`, `verdict.taskId`, `verdict.runId`, `verdict.evidence`, `verdict.oracle.family`, `verdict.oracle.version`, `handoff.from`, `handoff.to`, `policy.policyId`, `policy.subject` |
| arm | as is when it is `myco-gate` or `hcu+shell`, else as an id | `run.arm` |
| code | as is when it matches `^[A-Z][A-Z0-9_]{1,63}$`, else **hashed** | `policy.reasonCode` |
| media type | as is only when it is a member of the **closed enum** `MEDIA_TYPES` (`application/json`, `image/jpeg`, `image/png`, `text/csv`, `text/plain`), else **hashed**; never a grammar (a `type/subtype` grammar admits `srv/<user>`) | `evidence.mediaType` |
| text | **always hashed**: a `TextRef` `{sha256, chars}`, the digest of the raw value and its length | `action.summary`, `handoff.summary`, `evidence.path` |
| artifact | **never written**: its sha256 and byte count only | `evidence.content` |
| ledger | verbatim, because every field is closed under #518's schema (enums, integers, digests, and ids in #518's grammar `^[A-Za-z0-9._:-]{1,128}$`), NARROWED by Q: every `trialKey` and `taskId` must also match the closed id grammar above (no `:`, starts alphanumeric), since #518's grammar can spell `C:<user>` or `..`; a ledger that fails #518's check or the narrowing is refused, on export and verify | `ledger.lines`; `ledger.trialKey` (the input) is only used to find the trial: the anchor's trial key is taken from the ledger, never from the input |
| episode | **never written**: its id and digest only | `episode` |

**Hashed, not placeholdered.** Every replacement is a digest: no field uses a fixed placeholder,
so two equal values still compare equal (a verdict's hashed `runId` still binds to the run's).
A digest is sha256 over `myco.proof.text/1`, a NUL byte, and the raw value's UTF-8 bytes. It
does not reveal its input, but it is unsalted: a party who **guesses** the exact raw value (a
likely path with a likely username) can confirm the guess by hashing it. That is the price of
keeping equality checkable, and it is a stated limit.

The bundle and record schemas are closed: every object has `additionalProperties: false`, and
every string has a pattern or an enum. There is no free-text string type anywhere, so the
verifier refuses a hand-edited bundle that puts any text (a path, a note) where a digest or a
closed id belongs (`PROOF_SCHEMA`). A test walks the schemas and fails on any unpatterned
string (`test/proof/allowlist.test.ts`).

**Property test.** A seeded generator (`test/proof/path-fuzz.ts`) produces arbitrary host-path
strings: spaces, `Documents and Settings`, UNC `\\server\share` and `//server` forms, `\\?\`,
`\\.\` and `\??\` prefixes, `\Device\Mup`, 8.3 short names, mixed and repeated separators,
unicode and RTL characters, percent, double-percent, JSON, `\u005c`, entity and `+` escapes,
`~user`, `file://` and `smb://` URLs, `DOMAIN\user`, `user@host`, very long strings, behind
arbitrary prefixes. Each is planted in every input field of a run, which is exported,
verified and reported; no planted word may appear in any output byte (any letter case, and
JSON-escaped). Each is also planted in every closed-type field, where the exporter must refuse
without echoing it. Every probe the verifiers ran on #533 and #548 is a test too
(`test/proof/probes.test.ts`).

**Screenshots and frames are never inlined** (nothing is): the watch view has no merged
pixel-redaction rules, and this track does not invent them.

### Backstop

The pattern scanner from #548 (`src/proof/backstop.ts`, unchanged patterns) runs over every
output: the bundle (every parsed value and key, by the exporter's self-verify and by
`verify`), the report's final HTML, and every line the CLI prints. It recognises registered
literals (secrets, vault keys, host paths, account names in any letter case) and generic shapes
(home roots, UNC and drive paths, POSIX absolute paths, `~user`, `file:` and network URLs,
`DOMAIN\user`, `user@host`, key-shaped tokens), each in every decoded form (JSON escapes,
percent-encoding, HTML entities), stacked up to three deep. If it fires, the export, verify or
report fails closed (`PROOF_REDACTION`; the CLI prints only codes). It reports kinds and
offsets, never the value.

It is a backstop, not the guarantee. In an honest run it can fire only on a value the
allowlist writes as is: a closed id that equals a registered account name or a forbidden
literal, or that looks like a key (`sk_...`). Its known misses (the earlier rounds' "Limits":
an unlisted URL scheme, a spaced POSIX folder outside the home roots, obfuscated forms) no
longer matter for export, because no path reaches a bundle in the first place; tests pin that
those forms never reach a bundle.

TO FILE: consolidate this scanner and #542's episode cleanliness scan (now on main, and run
on every episode through `validateEpisode`) onto one canonical scanner, with a parity test
over the probe corpus.

### The report

`report` writes one static HTML file: no script, no link, no image, no remote URL, a
`default-src 'none'` CSP, and every value HTML-escaped. It shows only what the bundle holds:
closed values, and each summary or path as its digest prefix and length ("text not carried"). Replay is read-only and needs no
server, so there is nothing to bind to loopback.

The renderer takes a bundle and a verification result. It renders only a passing result
that belongs to that bundle: the result's head must name the same record count, and the chain
recomputed from the bundle's run header over its records must end at that head. A passing
result for another bundle, or for these records before an edit, is refused. The CLI always
passes the result of verifying the same bytes.

## Dependencies

- **#542 (`myco.episode/1`), merged.** `src/proof/episode-ref.ts` imports #542's `Episode`
  type, `episodeIdOf`, `canonicalJson` and `validateEpisode` (`src/episode/`, not modified) and
  projects only the fields Q reads (`EPISODE_FIELDS_USED`, pinned by
  `test/proof/episode-ref.test.ts`, with a parity test against main's `buildEpisode`). TO FILE:
  make `run.episode` required and project the action and evidence records from the episode's
  actions and observations instead of `RUN.json` steps.
- **#518 (attempt ledger), merged.** `src/proof/ledger.ts` calls #518's own
  `verifyAttemptLedger` and `eventSha256` (`src/m2/attempt-ledger.ts`, not modified), and
  replaces its messages with structural ones (#518's schema messages may quote a value).
- **Track N (handoffs), track O (policy decisions), in flight.** The bundle defines minimal
  closed shapes (`HandoffBody`, `PolicyBody`). The record kinds land with N and O: their
  records map onto these shapes, never the reverse. TO FILE: once `myco.episode/1` carries the
  handoff log (N, #528's `handoffs` field) and policy decisions (O), the bundle references them
  through the episode instead of restating them.
- **Live runner wiring.** The live harness must write `RUN.json` as the trial runs. That needs
  the VM, so it is out of this PR (TO FILE, a local single-owner task under the VM lock).

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
- 0 planted-word leaks in the allowlist property test (at least 600 generated paths, each
  planted in every input field, and every #533/#548 probe).

A single miss fails Q1. With 0 misses in 300 cases, the exact one-sided 95% upper bound on the
miss rate is about 1%.

**Q2, audit value over baseline (secondary; capability spec part 2 keeps Q1 as Q's acceptance
bar).**

- **Paired unit.** A *slot* is one pre-registered seeded task instance (task id plus seed,
  seeded with silent-drop tasks of the df-s02 kind). Every slot is run once under each arm.
  For the comparison of Myco with baseline B, a slot is a **pair** when, in BOTH arms' runs of
  that slot, the agent claimed done and the independent grader says not done (false success
  in both). Only pairs enter the test; a slot that is a false success in one arm only is
  reported but does not enter it.
- **Measure.** For each run in a pair, a blind auditor sees only that arm's shareable record
  (Myco: the verified bundle; C1: the screenshot trail and transcript; hcu+shell: the
  transcript and shell log), applies a fixed rubric, and answers "done" or "not done". The
  auditor does not know the arm where the format allows. The run is a success when the answer
  matches the grader's outcome. For Myco the answer must also be machine-checkable: a verified
  bundle whose verdict is `refuted` or `uncertain`.
- **Sample size and stopping.** Run slots until each comparison has at least 40 pairs, up to a
  pre-registered cap of 200 slots. If the cap is reached with fewer than 40 pairs for a
  comparison, that comparison fails (underpowered); the test is not switched afterwards.
- **Test.** Exact McNemar on the pairs' discordant outcomes (Myco success and B failure against
  the reverse), one-sided α = 0.05, Myco against C1 and Myco against hcu+shell, with Holm
  correction over the 2 comparisons.
- **Pass.** Both comparisons significant, and Myco's false-VERIFIED rate (the record shows done
  but the grader says not done) is 0.

**Cost.** Export and verify make no model calls, so the R7 numerator gains no tokens. R7 is
unchanged: total cost of all trials divided by verified trials, a token-derived estimate, null
cost never 0.
