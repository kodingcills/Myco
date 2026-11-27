# Demo track: replay and share in `myco watch`, and verify any agent's run

**Status: spec, pre-registered, nothing built. Version 2** (round-2 fixes of PR #567's round-1
verdict). TIF-265 (replay + share) and TIF-270 (verify any agent's run). Linear is at its
free-tier limit, so this spec's tracking issue and its follow-ups go through the GitHub Issues
fallback: issues on this repository labelled `from-linear-overflow` plus `tier-1` or `tier-2`,
cross-linked to the parent TIF issue, filed by the coordinator. This page is binding on the build PRs listed in [§5](#5-build-prs). Each acceptance criterion
names the test or probe that proves it and the result that refutes it. A build PR passes only when
its criteria pass as written. A criterion changes only by a new version of this page, never inside
a build PR.

**Priority (lead, Tiffany-approved 18:17 ET).** Part of the 90-second demo track
([demo-storyboard.md](demo-storyboard.md)). It comes **after** the trial run and the integrity
fixes, and it never delays them. No build PR below takes the VM or a paid model before the trial
run is done.

**What the two features are for.** The demo's story is "the agent says done, and the gate checks
what the app saved". Feature 1 lets a viewer see that story frame by frame and take away a clip
that is real gate evidence, not marketing. Feature 2 lets anyone run the same check on any
agent's run, whatever client the agent used, and get a proof bundle back.

Contents:

1. [Ground rules shared by both features](#1-ground-rules-shared-by-both-features)
2. [Feature 1: replay and share in `myco watch`](#2-feature-1-replay-and-share-in-myco-watch)
3. [Feature 2: verify any agent's run](#3-feature-2-verify-any-agents-run)
4. [Acceptance criteria](#4-acceptance-criteria)
5. [Build PRs](#5-build-prs)
6. [Dependencies on unmerged PRs](#6-dependencies-on-unmerged-prs)
7. [Out of scope](#7-out-of-scope)
8. [Open questions for the lead](#8-open-questions-for-the-lead)

## Grounding: what exists on `main` today

Every path here exists on `main` (pinned by `test/docs/demo-replay-and-verify-any-agent.test.ts`).
The spec builds on these and changes none of their guarantees.

| Piece | Path | What it gives this spec |
|---|---|---|
| Watch server | `src/watch/server.ts` | Loopback-only, GET-only, no CORS, bounded memory |
| Watch security model | `docs/gate/watch.md` | The table every watch change must keep |
| Decision-log tail | `src/watch/decision-log.ts` | `O_RDONLY \| O_NOFOLLOW`, line-by-line, never creates the file |
| Event projection | `src/watch/events.ts` | Allowlist projection of a `GateResult` to closed fields |
| Frame sources | `src/watch/frames.ts` | `file` vs `rendered` provenance; frames addressed by (listed run, index) |
| Frame redaction | `src/watch/sanitize-frame.ts` | PNG rebuilt from pixels; backstop scan |
| Mock watch demo | `src/watch/demo.ts` | The demo runs the page shows today (all `mock`) |
| Gate API | `src/gate/api.ts`, `docs/gate/api.md` | `myco.gate/v1`: the agent sends `taskId`, `runId`, `claim` only |
| Gate MCP server | `src/gate/mcp-server.ts` | One tool, `myco_gate_check` |
| Gate security review | `docs/security/gate-api-review.md` | Findings H-01..H-09 a new entry point must not reopen |
| Sealed gate | `src/gate/sealed.ts`, `src/gate/gated-trial.ts` | Seal → capture after the agent stops → judge the sealed copy |
| Verdict vault | `src/integrity/vault.ts` | Seal receipts (`SealReceipt`), `receipt-mismatch`. `AUDIT_WITHOUT_RECEIPT` exists for offline audits; this spec never uses it |
| Trial binding | `src/integrity/gate.ts` | `openForTrial` and `readReceipt`: the sealed reader's receipt-bound open |
| Episode format | `src/episode/types.ts`, `src/episode/validate.ts`, `docs/data/episode-format.md` | `myco.episode/1`: `simulated`, `agentClaim`, `harness.arm`, `task.fixtureSha256` |
| Attempt ledger | `src/m2/attempt-ledger.ts` | #518's hash-chained `attempts.jsonl` |
| Track R | `src/recording/derived-oracle.ts`, `src/recording/replay.ts`, `docs/product/task-recording.md` | Derived oracle, R5 certification, per-trial capture |
| R5 self-test | `src/oracle-selftest/run.ts` | Oracle mutation self-test |
| Secret loading | `src/baseline/secret-file.ts` | Load a key at the point of use from a file path |
| MCP client examples | `examples/mcp-clients/README.md`, `examples/mcp-clients/codex-transcript.md`, `examples/mcp-clients/stdio-requests.jsonl` | The clients and recorded calls the pre-registered proofs use |
| Gate integrity tests | `test/integrity/isolation.test.ts`, `test/integrity/surface.test.ts`, `test/gate/caller-isolation.test.ts`, `test/gate/input-fuzz.test.ts` | Suites [§3.5](#35-test-suites-the-new-entry-point-must-join) extends |
| R5 and track R tests | `test/oracle-selftest/selftest.test.ts`, `test/recording/derived-oracle.test.ts`, `test/recording/e2e.test.ts` | Suites [§3.5](#35-test-suites-the-new-entry-point-must-join) extends |
| Fault tests (R3, M2-10) | `test/fault-classes/tamper.test.ts`, `test/fault-classes/injection.test.ts`, `test/faults.test.ts` | Suites [§3.5](#35-test-suites-the-new-entry-point-must-join) extends |
| Grader independence | `test/benchmark/independence.test.ts` | The grader shares no code with the gate |

There is no `docs/adr/` directory and no `GLOSSARY.md` on `main`. The decisions here are
proposals waiting for the lead's ratification, not resolved decisions, so this PR adds no ADR
(`docs/agents/domain.md`: ADRs are created when a decision is resolved). If the lead ratifies
the timeline join ([§2.2](#22-the-frame--decision-join)) and the clip digest
([§2.5](#25-the-clip-digest-and-myco-clip-verify)), they should be recorded as ADRs then.

---

## 1. Ground rules shared by both features

1. **The gate is unchanged.** `myco.gate/v1` still takes only `taskId`, `runId` and `claim`.
   Neither feature adds a gate request field, a reason code or a result field.
   `ORACLE_INPUT_FIELDS`, `GATE_REQUEST_SCHEMA` and `REASON_CODES` in `src/gate/api.ts` stay
   byte-unchanged by every build PR here. New codes live in their own closed enums, never in
   `REASON_CODES`. Each enum is listed in full in [§1.1](#11-the-closed-code-enums); a code
   used anywhere on this page is a member of exactly one of them.
2. **A verdict is what the gate's oracle said on host-side evidence. It is never a measurement.**
   Neither feature shows, computes or exports a rate, an R1/R2 number or a grader result. R1 and
   R2 numbers stay in the scorecards, decided by the independent grader.
3. **Fail closed, never guess.** When the inputs disagree, are incomplete or can't be read, the
   answer is "no verdict shown" (watch), "refused" (clip export, clip verify), "not verified"
   (log-only clip verify, exit 2) or `uncertain` (verify), with a code. Nothing is ever interpolated, inferred from a clock, or filled in.
4. **Codes only.** Every refusal and reason is a code from a closed enum. No message quotes a
   path, a claim, a file name or any other value from the inputs.
5. **Mock is never evidence.** This is decided by where a run came from (its provenance), never
   by a flag the caller passes ([§2.6](#26-mock-runs-watermarked-never-evidence)).
6. **Secrets.** Neither feature reads the environment, a keychain or a secrets file, except in
   exactly three operator CLI commands that open a sealed run:
   - `myco verify --vault` ([§3.1](#31-the-cli));
   - `myco clip export --vault` (the evidence export, [§2.6](#26-mock-runs-watermarked-never-evidence));
   - `myco clip verify --sealed-capture` (sealed mode, [§2.5](#25-the-clip-digest-and-myco-clip-verify)).

   Each loads the vault MAC key at the point of use from `--vault-key-file <path>`
   (`src/baseline/secret-file.ts` pattern). The key never goes through argv, an environment
   variable, a log or an output. The key file's path is printed nowhere. **The watch server
   never loads a key, never opens the vault's sealed files and never serves an evidence clip**
   ([§2.8](#28-security-model-what-holds-and-what-changes)). No other module, route or command
   in either feature takes a key.

### 1.1 The closed code enums

Every refusal or reason code on this page is a member of exactly one of these. A build PR adds
a code only by a new version of this page.

| Enum | Members |
|---|---|
| `TIMELINE_CODES` (watch: join and pair) | `TL_SCHEMA`, `TL_RUN`, `TL_GAP`, `TL_DUPLICATE`, `TL_FRAME_DIGEST`, `TL_ORDER`, `TL_LOG_AHEAD`, `TL_LOG_PREFIX`, `TL_LOG_BINDING`, `TL_MALFORMED`, `TL_CLOCK_SKEW`, `TL_NO_TIMELINE`, `TL_NO_FRAME_BEFORE`, `PAIR_MISMATCH` |
| `CLIP_CODES` (export and `myco clip verify`) | `CLIP_NO_SIDECAR`, `CLIP_SCHEMA`, `CLIP_DIGEST`, `CLIP_FILE`, `CLIP_FRAMES`, `CLIP_BAND`, `CLIP_LOG_LINE`, `CLIP_LOG_PREFIX`, `CLIP_LOG_BINDING`, `CLIP_DECISION`, `CLIP_LOG_ONLY`, `CLIP_SEAL`, `CLIP_MOCK`, `CLIP_EVIDENCE`, `CLIP_TIMELINE`, `CLIP_RUN_RECORD`, `CLIP_RECOMPUTE`, `CLIP_SOURCE`, `CLIP_OCR_HIT`, `CLIP_OCR_UNAVAILABLE`, `CLIP_BUDGET`, `CLIP_FRAME_REFUSED` |
| `VERIFY_CODES` (`myco verify`) | `VERIFY_LOG_DISAGREES`, `VERIFY_LOG_BINDING`, `VERIFY_RECORDING_MISMATCH`, `VERIFY_R5_FAILED`, `VERIFY_BUNDLE_REFUSED`, `VERIFY_TRANSCRIPT_REFUSED`, `VERIFY_EPISODE_REFUSED`, `VERIFY_LEDGER_REFUSED`, plus `integrity:<code>` (the vault's own codes, passed through) |

### 1.2 Attribution: a decision belongs to the trial its gate is bound to

Every gate is bound to exactly one trial: `myco-gate mcp --task <t> --run <r>` and
`createSealedGate({ binding: { runId, receipt }, taskId })` both serve one assignment
(`docs/gate/api.md`). The agent supplies only `taskId`, `runId` and `claim`. It cannot choose
which gate answers, which evidence that gate reads or which log the gate writes to. So both
features attribute a decision by the gate that made it, never by what the agent named:

- **One decision log per bound trial.** The log a feature joins, clips or recomputes is the
  audit log of the one gate bound to that trial (the `--audit` file of that `myco-gate mcp`
  server, or the per-trial log the gated harness writes from that gate's `onDecision`). The
  operator names it per run (`--decision-log <file>` with one run, `--decision-log
  <runId>=<file>` with several). The mock demo keeps one in-memory log per gate, filled by
  that gate's own `onDecision`.
- **Every line of that log is the bound trial's decision**, numbered by its ordinal in that
  log. `request.runId` and `request.taskId` are never used to attribute a line. A line whose
  request names another trial is the bound trial's call that the gate answered
  `ASSIGNMENT_MISMATCH`; it is shown, pinned and recomputed under the bound trial, marked
  "named another trial", and never under the trial it named.
- **The binding is checked, not assumed.** A gate bound to (`t`, `r`) logs a request naming
  any other task or run only with `ASSIGNMENT_MISMATCH`, and any `evidenceRefs[].runId` it
  logs is `r`. So in the bound trial's log, every line must have: `request.runId` absent,
  equal to `r`, or `ASSIGNMENT_MISMATCH` among its `reasonCodes`; the same for
  `request.taskId` and `t`; and every `evidenceRefs[].runId` equal to `r`. A line that breaks
  this means the operator gave a log shared by several gates, or another trial's log. The
  result is `TL_LOG_BINDING` (watch: the join is invalid), `CLIP_LOG_BINDING` (clip export
  and clip verify refuse) or `VERIFY_LOG_BINDING` (verify: `uncertain`).
- **The unjoined live view is unchanged.** Today's live page, given one log shared by several
  runs, still shows a line under the run it names ("Attribution follows the log",
  `docs/gate/watch.md`, Limits). That view pins nothing and exports nothing. Only the joined
  views of this spec, which use per-trial logs, pin, clip or recompute.

---

## 2. Feature 1: replay and share in `myco watch`

### 2.1 What the viewer gets

- **Scrubber.** For one listed run: a slider over the run's frames. Each gate decision is pinned
  to the frame it was made on ([§2.2](#22-the-frame--decision-join)). Moving the slider shows that
  frame and the decisions pinned to it or earlier. The viewer can step frame by frame, or jump to
  the next or previous decision. The page shows the moment the agent claimed done
  (`CLAIM_RECORDED`, and the episode's `agentClaim: "done"` when an episode is given), then the
  gate's `refuted` on the frame it was made on.
- **Side by side.** Two runs of one head-to-head pair (the `hcu+shell` arm and the `myco-gate`
  arm on the same task), each with its own scrubber ([§2.4](#24-side-by-side-head-to-head-replay)).
- **One-click clip.** A short GIF of a frame range with the verdict burned in.
  - **Mock runs** (the 90-second demo): a GET download of a watermarked mock preview, which
    the browser saves where the user chooses. The server writes nothing.
  - **Real runs** (REAL gate evidence): one operator command, `myco clip export --vault …`
    ([§2.6](#26-mock-runs-watermarked-never-evidence)), which writes the GIF and its sidecar.
    The page's "Export evidence clip" control on a real run copies that command, built only
    from closed fields (the run id and frame ordinals) with the operator's paths left as
    placeholders. It does not reach the server. The watch server never holds the vault key, so
    it never renders an evidence clip ([§2.8](#28-security-model-what-holds-and-what-changes)).
  - The evidence clip's sidecar verifies against the run's sealed capture and its decision log
    ([§2.5](#25-the-clip-digest-and-myco-clip-verify)).

### 2.2 The frame ⋈ decision join

Today the page shows frames and decisions side by side, with nothing joining them. The frame
list is a sorted directory listing, and decisions carry only a wall-clock `checkedAt`. This spec
joins them **without any clock**.

**The timeline manifest (`myco.watch-timeline/1`).** The trusted harness that captures frames
during the run also writes one JSON line per frame to `timeline.jsonl` next to the frames. The
agent can never write there; the location has the same reach rules as the evidence root. The
mock demo keeps the same records in memory. Each record:

```jsonc
{
  "schema": "myco.watch-timeline/1",
  "runId": "run-42",            // closed id; must be a listed run
  "frame": 7,                   // 0-based frame ordinal for this run
  "frameSha256": "…",           // sha256 of the frame file's bytes as captured
  "logBefore": { "lines": 3, "prefixSha256": "…" },  // decision log read just before capture
  "logAfter":  { "lines": 3, "prefixSha256": "…" }   // and just after
}
```

- **The run's own log.** `logBefore` and `logAfter` describe the bound trial's own decision
  log ([§1.2](#12-attribution-a-decision-belongs-to-the-trial-its-gate-is-bound-to)): the log
  the harness writes from the run's gate. They never describe a log shared by several gates.
- **Decision ordinal.** The 1-based index of a line among that log's complete
  (newline-terminated), non-blank lines. Blank lines are skipped, which is how
  `DecisionLogTail` reads the log today. Malformed lines still count. One shared function
  computes `lines` and `prefixSha256` for the recorder and the joiner: `prefixSha256` is the
  sha256 of the log's bytes up to and including the newline of line `lines`.
- **The only clock is the log's own line count.** `checkedAt`, frame mtimes, file names and
  the host clock are never join keys. `checkedAt` is shown as a label only.

**The join rule.** Decision `d` (an ordinal of a line in run `r`'s own log; attributed to `r`
by the binding, [§1.2](#12-attribution-a-decision-belongs-to-the-trial-its-gate-is-bound-to),
never by `request.runId` and never through `projectDecisions`' run key) is **pinned to the
last frame of run `r` whose capture finished before line `d` was in the log**:

> pinned(d) = the largest `frame` of run `r` with `logAfter.lines < d`.

- A frame with `logBefore.lines < d ≤ logAfter.lines` **straddles** `d`: line `d` landed
  while that frame was being captured. A straddling frame is never "before" `d`, so `d` pins to
  the frame before it. The page marks straddling frames.
- Several decisions with no frame between them all pin to the same frame, in ordinal order. That
  is exact, not a guess: no frame was captured between them.
- A decision with no frame before it is **unpinned** (`TL_NO_FRAME_BEFORE`). The scrubber shows
  it in a "before the first frame" slot. A clip containing it is refused.
- A decision after the last frame pins to the last frame. On a sealed run, this is where the
  harness's own post-capture check lands ([§2.3](#23-what-real-runs-show-today)).

**Consistency checks.** The joiner checks the following for the run, every time it is
computed. Any failure **invalidates the join for that run**: the scrubber shows frames and
decisions unjoined (today's view), with a banner naming the code, and clip export for the run is
refused.

| Code | Fails when |
|---|---|
| `TL_SCHEMA` | a record has an unknown field, a missing field or a value outside its type |
| `TL_RUN` | a record names a run that is not listed, or a run other than the file's run |
| `TL_GAP` | the run's `frame` ordinals are not exactly `0..n-1`, or `n` differs from the frame source's count for the run |
| `TL_DUPLICATE` | two records share one `frame` ordinal |
| `TL_FRAME_DIGEST` | a frame file's sha256 is not its record's `frameSha256` (a frame swapped or edited after capture) |
| `TL_ORDER` | for some frame `k`, `logBefore.lines > logAfter.lines`, or `logBefore[k+1].lines < logAfter[k].lines` (the next capture started before this one ended) |
| `TL_LOG_AHEAD` | a record names more lines than the decision log now has (the log was truncated or replaced) |
| `TL_LOG_PREFIX` | either of a record's two `prefixSha256` values (`logBefore` or `logAfter`) is not the sha256 of the current log's first `lines` lines for that half (a line edited, inserted, removed or reordered) |
| `TL_LOG_BINDING` | a line of the run's log breaks the binding check of [§1.2](#12-attribution-a-decision-belongs-to-the-trial-its-gate-is-bound-to) (a log shared by several gates, or another trial's log) |
| `TL_MALFORMED` | a malformed decision-log line has an ordinal at or below the run's last pinned decision |
| `TL_CLOCK_SKEW` | `checkedAt` goes backwards between two consecutive decisions of the run. Ordering is unaffected (it never uses the clock), but export is refused because the log is not self-consistent |
| `TL_NO_TIMELINE` | no manifest for the run. The scrubber plays frames unjoined and export is refused. This is not an error for today's runs, which have no manifest |

**Duplicates that are not errors.** Two byte-identical decision lines are two calls (a retry
with the same result). They get two ordinals and two `call` numbers. Two frames with the same
`frameSha256` are two captures of an unchanged screen.

**Live runs.** The log and the manifest both grow while the page is open. The join is
recomputed on each poll. A log that is truncated or replaced (`DecisionLogTail` restarts)
makes `TL_LOG_PREFIX` or `TL_LOG_AHEAD` fire for the frames recorded against the old log. The
join for that run is then invalid, which is the fail-closed outcome.

### 2.3 What real runs show today

On the sealed gated path, **every check before capture is `uncertain` ("no sealed capture
yet")**, and the decision that counts is the harness's own check after the agent stops
(`docs/gate/api.md`, "The gate on the sealed vault"). So on a real sealed run today:

- The agent's mid-run `myco_gate_check` calls pin to the frames they were made on, and show
  `uncertain`.
- The `refuted` that catches a false done is the post-capture check. It pins to the last frame,
  after the agent's done claim.

A mid-run "done → refuted → retry" timeline needs a checkpointed capture. That is a follow-up
(a GitHub Issue under the fallback, filed by the coordinator), and this spec does not build it. Until it lands, mid-run refutes appear only in mock runs and
the development path (`fileEvidenceReader`), and those are never evidence. The demo narration
must not imply otherwise.

### 2.4 Side-by-side head-to-head replay

- **CLI:** `myco watch --pair <runA> <runB> --decision-log <fileA> --decision-log <fileB>
  (--frames <dir> | --sealed-capture <vaultRoot>) --episode <epA> --episode <epB>`. Each
  `--decision-log` and `--episode` follows the order of the pair. `--pair` implies `--run` for
  both runs. Each side's log is that run's own bound-trial log, and each side's decisions are
  attributed by that binding
  ([§1.2](#12-attribution-a-decision-belongs-to-the-trial-its-gate-is-bound-to)), never by
  `request.runId`: a call in A's log that names B is shown on A's side, never on B's. Two
  identical log paths are refused (`PAIR_MISMATCH`, field `decisionLog`).
- **The pair is checked, not assumed.** Both episodes must pass `validateEpisode`, and must
  have: the same `task.id`, the same non-null `task.fixtureSha256` and `task.instructionSha256`,
  distinct run ids, and arms `{ "hcu+shell", "myco-gate" }` (one each). Each episode's
  `provenance.runId` must equal its run. Anything else refuses the pair with `PAIR_MISMATCH`
  and a field name, never a value. With `--ledger <attempts.jsonl>`, both runs must also be one
  trial pair under #518's chain check.
- **No clock sync.** Each side has its own scrubber. "Align" jumps both sides to a decision
  boundary: the k-th pinned decision, or the last one. The two runs' wall clocks are never
  compared.
- **What the `hcu+shell` side shows.** That arm does not call the gate (R2). Its side shows its
  frames, the episode's `agentClaim`, and, if the operator gives one, the `myco verify` result
  for that run ([§3](#3-feature-2-verify-any-agents-run)), labelled "post-hoc verify, never
  seen by the agent". It never shows a grader result or a rate.
- **Export.** A side-by-side clip is out of scope for v1. Each side exports its own clip.

### 2.5 The clip digest and `myco clip verify`

An evidence clip is two files:

- `<name>.gif`: postable on its own;
- `<name>.myco.json`: the sidecar (`myco.clip/1`), which carries what verification needs.

The GIF never carries metadata ([§2.7](#27-export-privacy)), so the digest travels in the
sidecar, and a short form of it is burned into the pixels. A mock preview is a GIF only, with
no sidecar and no digest ([§2.6](#26-mock-runs-watermarked-never-evidence)).

**The burned-in band.** Every output frame has a band at the bottom. It is drawn only from closed
fields, in a fixed in-repo bitmap font (glyphs `A-Z 0-9 . _ - : / # ·` only; any other character
refuses the render), using palette indices 0–7, which content quantization never uses. Its
lines:

1. `RUN <runId display>  TASK <taskId display>  FRAME <i>/<n>`
2. The latest decision pinned at or before this frame: `CALL <k> <VERDICT> <REASON_CODES…>`,
   or `NO DECISION YET`, and `AGENT CLAIMED DONE` when the episode's `agentClaim` is `done`
3. Evidence clip: `GATE myco.gate/v1  ORACLE <family>/<version>  CLIP <headerDigest[0:16]>  VERIFY: myco clip verify`.
   Mock preview: `GATE myco.gate/v1  MOCK · NOT EVIDENCE` (no oracle, no digest).

Here "display" is the id as written when it is a closed id (below), otherwise `h-` followed
by the first 12 hex characters of its `h-<60hex>` form. The final frame holds an end card for
at least 2 s: the decision's verdict in large type, plus line 3.

**The sidecar (`myco.clip/1`)** is serialized only through the shared allowlist export helper
([§2.7](#27-export-privacy)):

```jsonc
{
  "schema": "myco.clip/1",
  "evidence": true,                        // const; the mock preview has no sidecar (§2.6)
  "runId": "run-42", "taskId": "calc-ms-demo", "arm": "myco-gate",   // closed id, or h-<60hex>
  "decision": {
    "ordinal": 9,                          // the decision the clip is about (the verdict shown)
    "call": 2,
    "lineSha256": "…",                     // sha256 of that decision-log line's bytes
    "logPrefixSha256": "…"                 // sha256 of the log's first `ordinal` lines
  },
  "verdict": "refuted", "accepted": false,
  "reasonCodes": ["ORACLE_FAIL", "TARGET_MISMATCH", "CLAIM_RECORDED"],  // REASON_CODES members, log order
  "agentClaim": "done",                    // "done" | "not-done" | "no-claim" | null (no episode)
  "gate": { "apiVersion": "myco.gate/v1",
            "oracle": { "family": "calc-multi-step", "version": "1", "specSha256": "…" } }, // or null
  "provenance": { "transport": "vm", "simulated": false },  // copied from the sealed run record
  "recordDigest": "…",                     // the run-record digest (below)
  "exporter": { "name": "myco-clip", "version": "<package.json version>", "renderer": "myco.clip-render/1" },
  "frames": [ { "frame": 31, "sourceSha256": "…", "pinned": [8] }, … ], // in clip order
  "clip": { "format": "gif", "width": 720, "height": 480, "delaysCs": [ … ],
            "rgbaSha256": [ "…", … ],      // sha256 of each output frame's decoded RGBA pixels
            "fileSha256": "…" },           // sha256 of the GIF file
  "headerDigest": "…",
  "digest": "…"
}
```

**Digest construction.** `canonical(x)` is sorted-key JSON (`src/integrity/vault.ts`
`canonical`).

- **The run-record digest** binds the clip to the run, not to anything in the clip:
  `recordDigest = sha256("myco.clip/1/record" ‖ 0x00 ‖ canonical(R))`, where `R` is built
  **only from the sealed run and the run's own decision log**:
  - `runId` (as sealed), and `sealDigest` (the seal the operator's receipt names, checked
    against the vault);
  - `provenance`: `transport` and `simulated` from the sealed `captured/run-provenance.json`
    (the MOCK flag comes from the run record, never from the clip);
  - `evidence`: `[path, sha256, bytes]` of every persisted file in the sealed capture
    manifest, sorted by path (the run's evidence ids);
  - `decision`: `ordinal`, `lineSha256` and `logPrefixSha256` of the clip's decision in the
    run's own log;
  - `pairs`: for each frame `f` of the clip's range, in ascending order,
    `[f, frameSha256(f), pinned(f), lineSha256 of each pinned line]`, where `frameSha256` comes
    from the sealed timeline and `pinned(f)` from the [§2.2](#22-the-frame--decision-join) join
    of the sealed timeline with the run's log (the ordered frame/decision pairs).

  The exporter computes `R` from `openSealedTimeline`. `myco clip verify` in sealed mode
  computes it again from the vault and the log, and never reads any part of `R` from the clip.
- `headerDigest = sha256("myco.clip/1/header" ‖ 0x00 ‖ canonical(H))`. `H` is the sidecar
  without `clip.rgbaSha256`, `clip.fileSha256`, `headerDigest` and `digest`, so it covers
  `recordDigest`. The band shows `headerDigest`, so no field is computed from its own value.
- `digest = sha256("myco.clip/1" ‖ 0x00 ‖ canonical(S))`. `S` is the whole sidecar without
  `digest`, so it covers the header digest, every frame's RGBA hash in order, and the GIF
  file's hash.
- **Determinism.** The renderer and encoder are deterministic: the same sealed frames, band
  fields and renderer version give the same GIF bytes. So for one (run, frame range, decision
  ordinal) there is exactly one GIF that sealed mode accepts.

**`myco clip verify`** has two modes. **Exit 0 (verified) only in sealed mode.**

```
myco clip verify <clip.gif> --sidecar <clip.myco.json> --decision-log <file> [--expect-log-sha256 <hex>] [--json]
myco clip verify <clip.gif> --sidecar <clip.myco.json> --decision-log <file> [--expect-log-sha256 <hex>]
                 --sealed-capture <vaultRoot> --seal-receipt <file> --vault-key-file <path>
                 --task <taskId> [--tasks <file> [--no-builtin]] [--json]
```

- **Log-only mode** (no `--sealed-capture`): checks that the GIF, the sidecar, the band and the
  decision-log line agree. It cannot see frame order, frame content, pins or provenance, so it
  **never exits 0**. When every log-only check passes, it exits **2** with `CLIP_LOG_ONLY`:
  "consistent with this log line; order, frames, pins and provenance not checked". Any failure
  exits 1.
- **Sealed mode**: the log-only checks, then the sealed checks, each against a value recomputed
  from the vault (opened with the operator's receipt and key) and the run's own log. Exit 0
  only when every check passes; exit 1 on the first failure. `--decision-log` is the run's own
  log ([§1.2](#12-attribution-a-decision-belongs-to-the-trial-its-gate-is-bound-to)). The
  timeline is read from the sealed capture (`captured/frames/timeline.jsonl`), never from a
  separate file.
- Exit 3 is usage (an unknown flag, `--sealed-capture` without its receipt, key, or task).

It checks, in order, and refuses with the first failing code:

| Code | Mode | Check |
|---|---|---|
| `CLIP_NO_SIDECAR` | both | the `--sidecar` file is missing (a mock preview has none) |
| `CLIP_SCHEMA` | both | the sidecar parses under the closed schema: unknown field, wrong type, `evidence` not `true`, a reason code outside `REASON_CODES`, an id that is neither a closed id nor `h-<60hex>`, or `frames` not consecutive ascending ordinals of one run |
| `CLIP_DIGEST` | both | `headerDigest` and `digest` recompute to the sidecar's values |
| `CLIP_FILE` | both | the GIF's sha256 is `clip.fileSha256`; the GIF parses under the structural rules of [§2.7](#27-export-privacy) |
| `CLIP_FRAMES` | both | the GIF's frame count, size and delays equal the sidecar's; each decoded frame's RGBA sha256 equals `clip.rgbaSha256[i]` **in order** |
| `CLIP_BAND` | both | each frame's band region equals the band re-rendered from the sidecar's closed fields and that frame's sidecar `pinned` list, pixel for pixel |
| `CLIP_LOG_LINE` | both | line `decision.ordinal` of the decision log hashes to `decision.lineSha256` |
| `CLIP_LOG_PREFIX` | both | the log's first `decision.ordinal` lines hash to `decision.logPrefixSha256`; with `--expect-log-sha256`, the whole log's sha256 is the expected one |
| `CLIP_LOG_BINDING` | both | every line up to `decision.ordinal` passes the binding check of [§1.2](#12-attribution-a-decision-belongs-to-the-trial-its-gate-is-bound-to) for the clip's run (h-form compared when the id is hashed) |
| `CLIP_DECISION` | both | that line, parsed, has `verdict`, `accepted`, `reasonCodes` and `apiVersion` equal to the sidecar's, and its ordinal-order `call` number in the run's log is `decision.call` |
| `CLIP_LOG_ONLY` | log-only | not a refusal: every log-only check passed; exit 2, never 0 |
| `CLIP_SEAL` | sealed | the run opens through the vault with the operator's receipt and key, as the sealed reader opens it (`openForTrial`): any integrity violation, a run absent from the vault, or a receipt for another seal |
| `CLIP_MOCK` | sealed | the sealed run record says the run is not evidence: `captured/run-provenance.json` missing, `transport` not an isolated one ([§2.6](#26-mock-runs-watermarked-never-evidence)), `simulated: true`, or the sidecar's `provenance` differs from it |
| `CLIP_EVIDENCE` | sealed | the decision line's `evidenceRefs` are empty, or their `sha256` and `bytes` are not the sealed capture's persisted files |
| `CLIP_TIMELINE` | sealed | the sealed timeline does not join with the log (any `TL_*` code), or some clip frame's sidecar `sourceSha256` is not the timeline's `frameSha256` for that ordinal, or its sidecar `pinned` list is not the join's |
| `CLIP_RUN_RECORD` | sealed | `recordDigest` recomputed from the vault and the log differs from the sidecar's |
| `CLIP_RECOMPUTE` | sealed | the gate bound to (`--task`, the run) with the operator's registry, over the sealed capture (the `myco verify --vault` core, [§3.2](#32-what-it-does)), does not give the sidecar's `verdict` and `reasonCodes` |
| `CLIP_SOURCE` | sealed | re-rendering the sealed frames of the range, with band fields recomputed from the vault and the log, through the pinned renderer does not reproduce `clip.fileSha256` byte for byte |

**Why sealed mode catches reordering, re-pinning and a forged MOCK clip.** Every sealed check
compares the clip with a value the verifier computes from the vault and the log alone, so no
re-forged sidecar field, redrawn band or re-encoded GIF can supply it:

- **Reordered timeline.** Frames swapped with their labels (`CLIP_SCHEMA`: not ascending).
  Content swapped with the labels kept ascending and `sourceSha256` swapped too
  (`CLIP_TIMELINE`: a label's `sourceSha256` is not the sealed `frameSha256`). Content swapped
  with `sourceSha256` left as captured (`CLIP_SOURCE`: the re-render of the sealed frames in
  sealed order differs).
- **Re-pinned decision.** A moved pin, with the band redrawn and every hash re-forged
  (`CLIP_TIMELINE`: the join of the sealed timeline with the log pins it elsewhere).
- **Forged MOCK clip.** A demo run is never sealed, so it does not open (`CLIP_SEAL`). A run
  sealed with mock provenance (`transport: "mock"` or `simulated: true`) is refused from the
  sealed run record, whatever the sidecar and band say (`CLIP_MOCK`).
- **A regenerated decision line.** A post-capture line rewritten to `verified`, with the
  sidecar and band re-forged to match (`CLIP_RECOMPUTE`: the bound gate over the sealed capture
  says `refuted`). Lines up to the last frame's `logAfter.lines` are also anchored by the
  sealed timeline's prefix hashes (`CLIP_TIMELINE`).
- And the final backstop: only one GIF passes `CLIP_SOURCE` for a given (run, range, decision).

**Required tamper cases.** Each is a fixture in `test/watch/clip-verify.test.ts`. The test
asserts the result in **both** modes: the log-only column (exit 1 with that code, or exit 2
with `CLIP_LOG_ONLY` where log-only mode cannot see the change) and the sealed column (exit 1
with that code). No row may exit 0 in either mode. "Re-forged" means the attacker also
rewrote the named sidecar fields, and recomputed every digest, to match their change.

| Tamper | Log-only result | Sealed-mode result |
|---|---|---|
| one content pixel of one frame changed; sidecar untouched | `CLIP_FILE` | `CLIP_FILE` |
| the same, with `clip.fileSha256` and `clip.rgbaSha256` re-forged, `digest` not | `CLIP_DIGEST` | `CLIP_DIGEST` |
| the burned-in verdict redrawn (`REFUTED` → `VERIFIED`), every sidecar hash including `digest` re-forged | `CLIP_BAND` (the band re-rendered from the sidecar's `refuted` differs) | `CLIP_BAND` |
| the sidecar's `verdict`, `accepted` and `reasonCodes` changed and the band redrawn to match, every hash re-forged | `CLIP_DECISION` (the decision-log line still says `refuted`) | `CLIP_DECISION` |
| the sidecar's `verdict` changed, digests re-forged, band not redrawn | `CLIP_BAND` | `CLIP_BAND` |
| the decision-log line at `decision.ordinal` edited (`refuted` → `verified`) | `CLIP_LOG_LINE` | `CLIP_LOG_LINE` |
| two decision-log lines before the decision swapped, or a line inserted or removed before it | `CLIP_LOG_PREFIX` | `CLIP_LOG_PREFIX` |
| the post-capture decision line regenerated to say `verified` (with its `evidenceRefs` kept), the sidecar's `lineSha256`, `logPrefixSha256`, `recordDigest`, verdict and band re-forged | `CLIP_LOG_ONLY` (exit 2; with `--expect-log-sha256`, `CLIP_LOG_PREFIX`) | `CLIP_RECOMPUTE` |
| a log given that a gate shared by several runs wrote (a line names another run without `ASSIGNMENT_MISMATCH`), sidecar re-forged to it | `CLIP_LOG_BINDING` | `CLIP_LOG_BINDING` |
| the clip paired with another run's decision log | `CLIP_LOG_LINE` (that log's line at `decision.ordinal` is another run's decision) | `CLIP_LOG_LINE` |
| two GIF frames swapped (timeline reordered); sidecar untouched | `CLIP_FILE` | `CLIP_FILE` |
| the same, with `clip.fileSha256` and `clip.rgbaSha256` re-forged in the new order and `digest` recomputed | `CLIP_BAND` (each band names its frame number) | `CLIP_BAND` |
| the same, with the bands redrawn and the sidecar's `frames` reordered to match | `CLIP_SCHEMA` (frames not ascending) | `CLIP_SCHEMA` |
| two frames' content swapped with the labels kept ascending: their `sourceSha256` swapped, bands redrawn, every hash re-forged | `CLIP_LOG_ONLY` (exit 2) | `CLIP_TIMELINE` |
| the same content swap with each label's `sourceSha256` left as captured, every other hash re-forged | `CLIP_LOG_ONLY` (exit 2) | `CLIP_SOURCE` |
| a pin moved to another frame (a frame's `pinned` list edited), bands redrawn, every hash re-forged | `CLIP_LOG_ONLY` (exit 2) | `CLIP_TIMELINE` |
| `recordDigest` replaced, band redrawn, every hash re-forged | `CLIP_LOG_ONLY` (exit 2) | `CLIP_RUN_RECORD` |
| a frame dropped or duplicated; sidecar untouched | `CLIP_FILE` | `CLIP_FILE` |
| the same, with `clip.fileSha256` re-forged, `digest` recomputed | `CLIP_FRAMES` (the count or an `rgbaSha256` entry no longer matches) | `CLIP_FRAMES` |
| a mock preview GIF given with a forged, internally consistent sidecar, band not redrawn | `CLIP_BAND` (the band says `MOCK · NOT EVIDENCE`) | `CLIP_BAND` |
| a mock demo run's frames with the band redrawn as evidence and a forged, internally consistent sidecar (the demo run was never sealed) | `CLIP_LOG_ONLY` (exit 2) | `CLIP_SEAL` |
| a test-vault run sealed with `transport: "mock"` (and, separately, with `simulated: true`), clip forged with `evidence: true` and `provenance` claiming `vm` | `CLIP_LOG_ONLY` (exit 2) | `CLIP_MOCK` |
| a GIF comment, plain-text or application extension appended, or bytes after the trailer | `CLIP_FILE` | `CLIP_FILE` |

**Stated limit: tamper-evident, not tamper-proof.** This is the same threat model as #562 and
#518. The digests are unkeyed. Log-only mode trusts the decision log and checks only that the
clip agrees with one line of it; it never says "verified". Sealed mode is as strong as the
gate's own sealed reader: it trusts the vault key and the operator-held seal receipt, and
whoever holds both can forge a sealed run, exactly as they could fool the gate. Lines after the
last frame are anchored only by the recompute and by an out-of-band log hash
(`--expect-log-sha256`). A clip proves "this is what the gate logged and decides for this run,
on these frames". It does not prove the gate was right; that is the independent grader's call.
The end card says so in one line: `GATE VERDICT · NOT A GRADE`.

### 2.6 Mock runs: watermarked, never evidence

- **Watermark.** Every frame of a mock run carries a diagonal `MOCK` watermark and a band
  `MOCK · NOT EVIDENCE`. This holds in the live page (rendered frames draw it themselves and
  the page overlays it on every frame of a mock run) and in every exported frame. A run is
  **mock** when any of these holds: it is served from `renderedFrameSource` (provenance
  `rendered`); its episode or proof-bundle header has `simulated: true`; or it has no sealed
  run provenance (below).
- **Mock preview export.** A mock run exports only through `exportMockPreview`: a watermarked
  GIF **with no sidecar** and no digest, whose band line 3 is `GATE myco.gate/v1  MOCK · NOT
  EVIDENCE`. `myco clip verify` refuses a GIF whose sidecar is missing (`CLIP_NO_SIDECAR`). The
  90-second demo is mock throughout, so its clips are mock previews. This is the only clip the
  watch server serves (`GET /clip/…`, [§2.8](#28-security-model-what-holds-and-what-changes)).
- **The evidence export is one operator command, never a server route:**

  ```
  myco clip export --run <runId> --task <taskId> --from <i> --to <j> --decision-log <file>
                   --vault <vaultRoot> --seal-receipt <file> --vault-key-file <path>
                   [--episode <file>] [--identity-file <file>] [--user-file <file>] --out <path.gif>
  ```

  It writes `<path.gif>` and `<path>.myco.json` and nothing else
  ([§2.8](#28-security-model-what-holds-and-what-changes)). `--decision-log` is the run's own
  log ([§1.2](#12-attribution-a-decision-belongs-to-the-trial-its-gate-is-bound-to)).
  `--seal-receipt` is the operator-held receipt the gated harness wrote for this trial
  ([§3.2](#32-what-it-does)). The key is loaded from `--vault-key-file` at the point of use
  ([§1](#1-ground-rules-shared-by-both-features) rule 6).
- **The evidence path refuses mock structurally.**
  - The evidence exporter takes only a `SealedTimeline`. That type is created only by
    `openSealedTimeline(vaultRoot, runId, receipt, keyFilePath)`, inside the clip module's
    CLI-only part, and it has no public constructor. The function opens the run through the
    vault with the operator's receipt (`openForTrial`, exactly as the sealed reader opens it;
    never `AUDIT_WITHOUT_RECEIPT`), and checks the seal, the capture hashes, the frames under
    `captured/frames/`, the timeline under `captured/frames/timeline.jsonl`, and a sealed
    `captured/run-provenance.json` (`myco.run-provenance/1`: `runId`, `transport`,
    `simulated`).
  - The harness writes the provenance file at capture. `transport` comes from the transport
    object's own constant (the mock transport's is `mock`), never from a caller option. The
    values are `vm` and `mock` on `main` today. If #561 merges, its unprivileged backend's
    constant (`linux-plain`) is added. On `linux-plain` the agent runs as the harness's uid and
    every trial is marked `shared-host-dirs` and never counted, so the agent could have
    written the timeline or the frames. An isolated transport is one that is counted: `vm`
    only, until a strict isolation backend (track L's strict `linux-ns`, closed PR #551) lands
    and a new version of this page adds it.
  - The exporter refuses `transport: "mock"`, any transport that is not isolated,
    `simulated: true`, a missing provenance file and any `rendered` frame (`CLIP_MOCK`).
    `myco clip verify` refuses the same cases in sealed mode, from the sealed run record, not
    from the clip ([§2.5](#25-the-clip-digest-and-myco-clip-verify)).
  - The exporter also refuses a decision whose line has no `evidenceRefs` (`CLIP_EVIDENCE`):
    an evidence clip is about a decision that read the sealed capture.
  - Neither `myco clip export`, the server route nor any function has an option that marks a
    run as real. A test pins the absence: the CLI's flag list, and the exported functions'
    parameter types.
- **The mock demo cannot reach the evidence path.** It renders SVG in memory and never seals,
  so it has no `SealedTimeline` to give.

### 2.7 Export privacy

The scope and rulings of #560's leak guard (open, draft) apply to every exported byte: the
host username, home paths, hostnames, key-shaped strings, and window titles that carry an
identity.

- **Allowlist serialization.** The sidecar is written only through #560's shared allowlist
  export helper (`src/leak-guard/serialize.ts` on #560's branch) with a schema that lists every
  string path. Ids use the `id` treatment. Free text never appears: the claim, `reasons`,
  evidence paths, file names and window titles are not fields at all. The helper's backstop
  scan (`src/leak-guard/detect.ts`) refuses the write on any finding. The clip module must pass
  #560's routing test (`test/leak-guard/routing.test.ts`).
- **Identity ruling (21:52Z).** A bare username, or any configured identity string, is a leak
  on its own, not only inside a path. The guard is `mergeIdentity(hostIdentity(), extra)`, so the
  host's identity is always in it. `extra` comes from `--identity-file` and `--user-file` paths
  (the guest account name goes in `--user-file`). Files are read and never printed. An id that
  contains an identity string, matched case-insensitively on the normal form #562 uses (NFKC,
  full case fold, letters and digits only), is hashed.
- **F1 (22:18Z) and the hashed form (23:06Z).** A value goes out verbatim only when it is a
  closed id that passes the identity guard, or a member of a closed vocabulary (reason codes,
  verdicts, arms, `agentClaim`, the gate API version). Anything else becomes `h-<60hex>`: the
  first 60 hex characters of the sha256 of `myco.clip/1/text ‖ 0x00 ‖ value`. An existing
  value matching exactly `^h-[0-9a-f]{60}$` is kept as is. No other `h-` form counts as already
  hashed. (Issue #579 proposes keeping an `h-<60hex>` verbatim only when the harness produced
  it. If that lands first, the clip follows it, and RS-10's re-hash cases follow by a new
  version of this page.)
- **Overlays come only from closed fields.** The band and the end card are rendered from the
  sidecar's closed fields, frame ordinals and the font's glyph set. There is no code path from a
  claim, a reason string, a file name or a window title to the renderer. The renderer takes a
  `BandFields` type built only from the closed sidecar (a type test pins this).
- **Frames go through the existing redaction.** Every source frame passes `servableFrame` /
  `sanitizePng` (`src/watch/sanitize-frame.ts`) before it is decoded for the clip. A refused
  frame refuses the export (`CLIP_FRAME_REFUSED`). It is never skipped silently.
- **The TIF-98 PNG redactor follow-up rules** (ruled 21:52Z; tracked as a GitHub Issue under
  the fallback, filed by the coordinator and cross-linked to TIF-98) apply to every exported
  frame.
  - **Encoder output:** a GIF89a with a global or local palette, Graphics Control extensions and
    one NETSCAPE2.0 loop extension only. No comment, plain-text or other application extension,
    and no byte after the trailer `0x3B`. The poster PNG is rebuilt by `sanitizePng` (`IHDR`,
    one `IDAT`, `IEND`; no `tEXt`/`zTXt`/`iTXt`/`eXIf`/XMP/private chunk; nothing after `IEND`).
  - **Raw-byte scan:** the exported GIF, poster and sidecar bytes go through #560's detector
    and `frameLeaks`. Any finding refuses.
  - **OCR backstop:** every exported frame whose source provenance is `file` is OCR'd at export
    time. The export refuses if any configured identity string or generic identity shape is
    recognised (`CLIP_OCR_HIT`). If no OCR engine is available, it also refuses
    (`CLIP_OCR_UNAVAILABLE`); it never exports unscanned. (The engine is open question 1.)
  - **Undecodable** or unredactable frames refuse (`CLIP_FRAME_REFUSED`).
- **Pixels are still pixels.** OCR is a backstop, not a guarantee: a crafted image can draw
  text OCR misses. The operator chooses which runs to export. This limit is stated in the
  export dialog and in `docs/gate/watch.md`.

### 2.8 Security model: what holds and what changes

The security model table in `docs/gate/watch.md` has 11 rows. Each row's **property** keeps
holding. Five rows' **text** changes, because the server gains two GET routes and new imports,
and each of those changes lands in the build PR that adds the route, with its test, in the same
PR (B2 or B5). No row is weakened.

| `docs/gate/watch.md` row | Status | What changes, and why it is still safe |
|---|---|---|
| Loopback only | holds unchanged | One server, one socket, loopback by default, the same `--allow-non-loopback` rule. No second port, no websocket |
| No DNS rebinding | holds unchanged | The `Host` check runs before routing, so it covers the new routes |
| No CORS | holds unchanged | The new routes set no `Access-Control-Allow-*`; a foreign `Origin` is still 403 |
| Read-only | text amended (B2, B5) | The route list in the test column gains `/timeline/…` and `/clip/…`. Every non-GET method still gets 405 before routing, and the new routes read no body. The "every non-GET method × every route" matrix covers them |
| No handle on the gate | text amended (B5) | The server may also import the pure clip modules: the bitmap font, the band renderer, the GIF encoder and `exportMockPreview`. None has a write call, a process spawn, a network call, a vault import or a key parameter. The vault-reading part (`openSealedTimeline`, `exportEvidenceClip`, sealed `myco clip verify`) is CLI-only, and the static import scan proves it is outside the server's import graph. So the server still holds no handle on the gate, the vault, an oracle, the agent or a key |
| Passive | holds unchanged | Serving `/timeline` and `/clip` renders in memory and writes nothing. The tree snapshot covers them |
| No path traversal | text amended (B2, B5) | The new routes take a listed run id and decimal frame ordinals checked against the server's own listing, never a name or path. `%`, `?`, `\` and dot segments still get 400. The 23-form traversal corpus runs against both routes |
| Frame redaction | holds unchanged | Every frame in a mock preview passes `servableFrame` / `sanitizePng` (or is a frame this process rendered) before it is drawn into the GIF |
| Bounded memory | text amended (B5) | Adds: at most one clip render at a time (the next gets 503), the [§2.9](#29-postable-budget) budget, and a 30 s render cap. The render buffer is bounded by the budget (≤ 5 MiB output) |
| Redaction by allowlist | text amended (B2, B5) | Adds two closed response types. `/timeline/<run>` carries only a `TimelineView`: frame ordinals, straddle flags, pinned decision ordinals, call numbers, verdicts, `REASON_CODES` members, the "named another trial" flag and `TIMELINE_CODES` members. No `frameSha256`, no `prefixSha256`, no digest. `/clip/…` serves only a mock-preview GIF, whose pixels are drawn from the same closed fields; its band has no oracle and no digest. No sidecar is ever served. **The row's guarantee holds as written:** the claim, reasons, evidence paths and digests, and the oracle family and version are never sent over HTTP. They appear only in evidence clips, which only the operator CLI writes to a path the operator chose |
| Page hardening | holds unchanged | The page CSP stays as it is (`PAGE_CSP` in `src/watch/server.ts`). The "Export evidence clip" control copies a command built with `textContent` from closed fields and fetches nothing |

The Limits list also changes in B2: "Attribution follows the log" stays true for the unjoined
live view, and B2 adds that the joined view (scrubber, pins, clips) attributes by the binding
([§1.2](#12-attribution-a-decision-belongs-to-the-trial-its-gate-is-bound-to)) and needs
per-trial logs.

The routes, precisely:

- `GET /timeline/<listed runId>`: the joined timeline as a `TimelineView`.
- `GET /clip/<listed runId>/<from>/<to>.gif`: for a **mock** run only, the mock preview,
  generated in memory and sent with `Content-Disposition: attachment`. The browser's save dialog
  chooses the path. **The server writes no file.** For any run that is not mock the route answers
  404: the server cannot render an evidence clip, because it holds no key and does not open the
  vault's sealed files. There is no `.myco.json` route.

Other parts of the model:

- **No new listening interface.** One server, one socket, loopback by default.
- **No write endpoint.** Every method other than GET still gets 405 before routing.
- **No remote fetch.** No route, renderer or font loads anything over the network. The page CSP
  stays as it is.
- **CLI export writes one path only.** `myco clip export … --out <path.gif>` writes
  `<path.gif>` and `<path>.myco.json` with `O_CREAT | O_EXCL` (an existing file is refused),
  and nothing else. Outside `--demo`, the watch command itself still writes no file.
- **The static import/write scan** in `test/watch/server-security.test.ts` is extended to the
  new modules, and gains the assertion that no module the server imports reaches
  `src/integrity/vault.ts`, `src/baseline/secret-file.ts` or the CLI-only clip module.

### 2.9 Postable budget

A caught false-done clip must be postable as-is. Hard caps the exporter enforces
(`CLIP_BUDGET` refuses; there is no silent downscale):

| Limit | Value | Why |
|---|---|---|
| Format | GIF89a, loops forever, plus an optional poster PNG of the end card | GIF posts inline everywhere without a player |
| File size | ≤ 5 MiB GIF; ≤ 1 MiB poster | Under GitHub's 10 MB image limit and X's 15 MB GIF limit, with margin |
| Length | ≤ 15 s total, including an end card of 2–3 s | Fits a social post or a PR comment |
| Frames | ≤ 150, ≤ 10 fps | Bounded render work |
| Size | 720 px wide by default, 960 px at most, height by aspect | Readable band at phone width |
| Band | Burned in on every frame; text at least 12 px high at 720 px | Readable when the GIF is re-shared without its sidecar |

---

## 3. Feature 2: verify any agent's run

### 3.1 The CLI

```
myco verify <runId> --task <taskId> --vault <vaultRoot> --seal-receipt <file> --vault-key-file <path>
            [--tasks <file> [--no-builtin]] [--decision-log <file>]
            [--transcript <file> --client codex|mcp-jsonrpc]
            [--episode <file>] [--ledger <attempts.jsonl>]
            [--out <bundle.json>] [--json]
myco verify <runId> --task <taskId> --recording <replayDir> --tasks <file> [same optional flags]
myco verify <runId> --task <taskId> --mock-evidence <evidenceRoot> [same optional flags]
```

- Exactly one source: `--vault` (a sealed gated run), `--recording` (a track R replay) or
  `--mock-evidence` (a harness-filled directory, the development path). Anything else is a usage
  error. `--vault` requires both `--seal-receipt` and `--vault-key-file`; without either it is
  a usage error (exit 3), never an offline audit. Exit codes: **0 verified, 1 refuted, 2
  uncertain, 3 usage**, the same as `myco-gate check` and `bin/myco`.
- `<runId>` and `--task` come from the operator, never from a transcript, and must be safe ids
  (`isSafeId`).
- `--out` writes the proof bundle with `O_CREAT | O_EXCL`. It is the only file written.
- Output (stdout, `--json`): a closed `myco.verify/1` object, scanned by the backstop before it
  is printed:

```jsonc
{
  "schema": "myco.verify/1",
  "runId": "run-42", "taskId": "df-s02",       // closed id, or h-<60hex>
  "verdict": "refuted",                        // verified | refuted | uncertain
  "reasonCodes": ["ORACLE_FAIL"],              // REASON_CODES members (the gate's own)
  "verifyCodes": [],                           // VERIFY_CODES members (below)
  "trust": "sealed",                           // sealed | derived | mock
  "simulated": false,                          // true for every mock and every simulated recording
  "oracle": { "family": "todo-items", "version": "1", "specSha256": "…" },   // or null
  "calls": [ { "call": 1, "source": "decision-log", "verdictForCall": "refuted",
               "reasonCodes": ["ORACLE_FAIL", "CLAIM_RECORDED"], "loggedVerdictAgrees": true } ],
  "agentReported": [ { "call": 1, "client": "codex", "verdict": "refuted", "agrees": true } ],
  "bundle": { "sha256": "…", "head": "…" }     // or null without --out
}
```

### 3.2 What it does

1. **Open the evidence host-side.** The source depends on the flag:
   - `--vault`: the run is opened through the vault **with the trial's seal receipt**, never
     with `AUDIT_WITHOUT_RECEIPT`. The receipt (`myco.seal-receipt/1`: `runId`, `sealDigest`)
     is the one `vault.seal` returned to the gated harness (`GatedTrialOutcome.receipt` in
     `src/gate/gated-trial.ts`). The operator's trial runner writes it at seal time, `O_EXCL`,
     mode 0600, into an operator directory outside every agent root and outside the vault. It
     is not a secret (a digest of the seal), but the agent must not be able to rewrite it.
     The gate code is unchanged: the runner only persists the receipt it already receives.
     `--seal-receipt` names that file. It is read once and checked by `readReceipt` (`src/integrity/gate.ts`); a
     malformed, symlinked or oversized file gives `integrity:receipt-malformed`. The MAC key is
     loaded at the point of use from `--vault-key-file`. The gate is then built exactly as the
     gated harness builds it, `createSealedGate({ binding: { runId, receipt }, taskId })`, so
     the seal, the receipt binding, the capture hashes and the sealed ground truth are checked
     by the sealed reader itself (`openForTrial`). Any integrity violation gives `uncertain`
     `STATE_UNREADABLE` plus `integrity:<code>` in `verifyCodes`. A re-signed seal made with a
     leaked key is caught by `integrity:receipt-mismatch`, as it is for the gate.
     **Batches without receipts.** A trial whose runner did not persist its receipt (any run
     before V1 lands) cannot be verified with `--vault`; it is reported as not verifiable, not
     audited without the receipt.
   - `--recording`: the replay's captured `doc.csv` and sealed `fixture.csv` are read. The
     compiled workflow comes from the operator's task spec (`--tasks`), which pins its sha256.
     A workflow copy in the replay directory that does not hash-equal the pinned one gives
     `VERIFY_RECORDING_MISMATCH`.
   - `--mock-evidence`: `fileEvidenceReader`. The result is always `trust: "mock"`,
     `simulated: true`.
2. **Decide with the gate's own code.** A fresh gate is bound to (`--task`, `<runId>`), with
   the operator's registry, and `gate.check({ taskId, runId })` is called. The request is built
   from the operator's flags; nothing from a transcript or a decision log reaches it. The
   oracle, the registry and the decision rule are the gate's, unchanged. For `--recording`,
   `certifyDerivedOracle` (R5) must pass first, or the result is `uncertain`
   `VERIFY_R5_FAILED`.
3. **Recompute each recorded call.** `--decision-log` is the audit log of the one gate bound
   to (`--task`, `<runId>`): the operator says so by giving it for this run. **Every line of
   it is one recorded call of this run**, attributed by that binding
   ([§1.2](#12-attribution-a-decision-belongs-to-the-trial-its-gate-is-bound-to)), never by the
   line's `request.runId`. The log first passes the binding check of §1.2; a line that breaks
   it makes the result `uncertain` with `VERIFY_LOG_BINDING` (a shared log or another trial's
   log), and no call is compared. Each line's `request` (the agent's `taskId`, `runId`,
   `claim`, as the gate logged it) goes through `parseGateRequest` and the bound gate's
   assignment check, exactly as a live call would. A call naming another trial is still this
   run's call, and recomputes as `ASSIGNMENT_MISMATCH` against this run's assignment. An extra
   field gets `UNKNOWN_FIELD` / `ORACLE_INPUT_REJECTED`. `call` numbers are line order in this
   log. The decision log is the client-independent record of calls: `myco-gate` logs every
   call the same way, whichever MCP client made it, so this covers Claude Code, Codex, Cursor
   and a custom agent alike.
4. **Compare, never adopt.** Each logged decision that read the same evidence the recompute
   reads is compared with the recompute (`loggedVerdictAgrees`). With `--mock-evidence` and
   `--recording`, that is every line. With `--vault`, it is the last line, the gated harness's
   own post-capture check (`runGatedTrial` makes it after capture, after the agent has
   stopped, so no agent call follows it); the agent's mid-run lines were "no sealed capture
   yet" and are reported, not compared. A disagreement on a post-capture decision makes
   the overall result `uncertain` with `VERIFY_LOG_DISAGREES`. The log never overrides the
   recompute, and the recompute never silently overrides the log.
5. **What the agent told its user** (`--transcript`, optional). A client adapter reads the
   client's own transcript and extracts only, per gate call, the closed `verdict` the client
   reported. These are compared in `agentReported` and are **never** an input to any verdict.
   Adapters: `codex` (`codex exec --json` events) and `mcp-jsonrpc` (raw JSON-RPC lines, as in
   `stdio-requests.jsonl`). `--client` takes no other value until a fixture for that client
   lands.
6. **Proof bundle.** With `--out`, a #562 proof bundle is built from host-side records only. It
   contains: the run header (run id, task id, arm from the episode or ledger, `simulated`), the
   recomputed verdict record (codes only), evidence digests of the captured persisted file(s),
   the ledger anchor with `--ledger`, and the episode reference with `--episode`. It is
   self-verified by `verifyProofBundle` before it is written. A bundle that would not verify is
   not written (`VERIFY_BUNDLE_REFUSED`, exit 2).

**`VERIFY_CODES`** (closed, [§1.1](#11-the-closed-code-enums)). Each puts the run's result at
`uncertain`, except `VERIFY_TRANSCRIPT_REFUSED`, which leaves the run verdict unchanged:

| Code | When |
|---|---|
| `VERIFY_LOG_DISAGREES` | a compared logged decision differs from the recompute (step 4) |
| `VERIFY_LOG_BINDING` | the decision log fails the binding check (step 3) |
| `VERIFY_RECORDING_MISMATCH` | a recording field or workflow copy differs from the operator's pinned spec, or carries a closed constant or field it must not ([§3.4](#34-a-recording-cannot-smuggle-evidence)) |
| `VERIFY_R5_FAILED` | `certifyDerivedOracle` fails for a recording (step 2) |
| `VERIFY_BUNDLE_REFUSED` | the bundle would not pass `verifyProofBundle`, or `--out` cannot be written (step 6) |
| `VERIFY_TRANSCRIPT_REFUSED` | a transcript line is malformed, oversize, non-UTF-8 or has an extra field (step 5); the run verdict is unchanged |
| `VERIFY_EPISODE_REFUSED` | `--episode` fails `validateEpisode`, or its `provenance.runId` or `task.id` is not the operator's run and task |
| `VERIFY_LEDGER_REFUSED` | `--ledger` fails #518's chain check, or has no trial for the run |
| `integrity:<code>` | the vault's own integrity codes from the receipt-bound open (step 1) |

### 3.3 Independence

- **The agent can never supply evidence or influence the oracle.** The agent-supplied surface
  is exactly `myco.gate/v1`'s `taskId`, `runId` and `claim`, as recorded in the decision log,
  or a recording's closed fields. The evidence is the host-side per-trial capture. The registry,
  assignment, fixture and ground truth come from the operator. No transcript field, recorded
  call or recording field reaches the oracle, the registry, the evidence reader or the request
  `myco verify` builds.
- **`myco verify` is an operator CLI, not an agent tool.** No MCP server exposes it, and
  `src/integrity/surface.ts` classifies no agent tool that can reach it, the vault key file or
  the seal-receipt directory.
- **Attribution is the gate's, not the agent's.** The agent cannot choose which gate answers,
  which evidence it reads, or which log a line lands in. Naming another trial's `runId` gets
  the agent `ASSIGNMENT_MISMATCH` in its own trial's log, never a line in another trial's
  ([§1.2](#12-attribution-a-decision-belongs-to-the-trial-its-gate-is-bound-to)).
- **Grader independence holds.** `myco verify` uses the gate's oracle, so it is never the
  independent grader and never R1 evidence. The grader imports nothing from the verify module,
  and the verify module imports nothing from `src/benchmark/grade/`
  (`test/benchmark/independence.test.ts` is extended).
- **Recordings are derived.** A recording result is always `trust: "derived"`, and a
  simulated recording is also `simulated: true`. It is never R1 evidence: the same rule as
  track R's `r1Evidence: false`.
- **Fail closed, codes only.** Every failure path above ends `uncertain` with a code. No output
  quotes a value from the transcript, the recording, the log or the evidence.

### 3.4 A recording cannot smuggle evidence

`myco verify --recording` must refuse every case below, each as a fixture in
`test/verify-run/recording-tamper.test.ts`. None may give `verified`.

| # | Tamper | Must end |
|---|---|---|
| 1 | The replay report says `gate.verdict: "verified"` while `doc.csv` misses the edit | `refuted` (the report is never read for the verdict) |
| 2 | The replay report carries `r1Evidence: true` or `trust: "builtin"` | `uncertain` `VERIFY_RECORDING_MISMATCH` (closed constants) |
| 3 | The workflow copy in the run directory adds an assertion type outside the allowlist, or an extra field | `uncertain` `VERIFY_RECORDING_MISMATCH` (the pinned workflow is used, and the copy must hash-equal it) |
| 4 | The workflow drops `others-equal-fixture` (and the operator's pinned spec is the weak one) | `uncertain` `VERIFY_R5_FAILED` |
| 5 | `fixture.csv` swapped for one that matches the doc | `uncertain` `FIXTURE_MISMATCH` (the pinned `fixtureSha256`) |
| 6 | `doc.csv` is a symlink, a FIFO or over 16 MiB | `uncertain` `STATE_UNREADABLE` |
| 7 | The recording carries an `expected` or `value` field, or a binding for a cell the task does not target | `uncertain` `VERIFY_RECORDING_MISMATCH` (expected values come only from the operator's spec) |
| 8 | The replay directory names another run id, or a hard link to another run's `doc.csv` | `uncertain` `ASSIGNMENT_MISMATCH` / `STATE_UNREADABLE` |
| 9 | The recording contains a redaction marker, a secret shape or a host path | `uncertain` `VERIFY_RECORDING_MISMATCH` (the compiler's `RECORDING_REDACTED` rule) |
| 10 | A transcript reports `verified` for a run whose evidence is refuted | `refuted`, with `agentReported[].agrees: false` |
| 11 | A transcript line carries an extra field, oversize JSON or non-UTF-8 | `VERIFY_TRANSCRIPT_REFUSED` in `verifyCodes`; the run verdict is unchanged |

### 3.5 Test suites the new entry point must join

Each existing suite gets `myco verify` as an extra entry point. The suite's existing cases are
reused, not copied: the same route table drives both the gate and verify.

| Suite | Extension |
|---|---|
| `test/integrity/isolation.test.ts` (TIF-266, R4) | Every route in the suite's `tampering routes: the gate never returns verified` block is also driven against `myco verify --vault`, **with the trial's own receipt written as a `--seal-receipt` file**, whichever way the suite drives the gate for that route. Verify must never return `verified`, and its `verifyCodes` must contain `integrity:<code>` for the code the suite asserts for the gate (the suite's own `expectIntegrity` predicate: some reason starts with that code). With the receipt, the vault reports every violation it finds, so a route the suite isolates through the audit path (`useReceipt: false`, for example the seal-MAC and replayed-seal routes) still carries its asserted code. This includes the receipt-only routes: a re-signed seal made with the leaked key (`integrity:receipt-mismatch`), another run's receipt for this run (`integrity:receipt-mismatch`), and a malformed receipt file (`integrity:receipt-malformed`). Routes that end `refuted` for the gate (the agent-side fixture copy; the agent writing `result.json` and `trace.jsonl` that claim success) end `refuted` for verify. `--vault` without `--seal-receipt` is exit 3, never an audit. The two cases in that block that assert `new VerdictVault` throws (a vault root inside, or differing only in case from, an agent root) refuse at harness construction and leave no run to verify, so they have no verify column. The suite's V5 block (an agent naming another run, `run-not-bound`) has no verify analogue, because verify's run id comes from the operator; attribution is VA-13's probe |
| `test/integrity/surface.test.ts` | No agent-reachable tool or root reaches the vault key file or the verify CLI; verify is classified operator-only |
| `test/gate/caller-isolation.test.ts`, `test/gate/input-fuzz.test.ts` | Decision-log lines and transcript lines are fuzzed through verify's call path. Oracle inputs, unknown fields, oversize and deep JSON are refused with the gate's codes, and the run verdict is unchanged |
| `test/oracle-selftest/selftest.test.ts` (R5) | For every oracle and every claimed corruption class, the mutated document is sealed into a test vault and verified. Verify must return `refuted` or `uncertain`, never `verified`, and `verified` on every control document. The committed R5 report is unchanged |
| `test/recording/derived-oracle.test.ts`, `test/recording/e2e.test.ts` (track R, R5) | An uncertified derived oracle gives `uncertain` `VERIFY_R5_FAILED`. The honest and skip-save replays verify as pre-registered (VA-10) |
| `test/fault-classes/tamper.test.ts` (R3, M2-10) | Each row of the tamper-route table in `docs/architecture/m2-fault-classes.md` §3 gains a verify column. Verify must end as the row's "Must end" (with the same code), never `verified` |
| `test/fault-classes/injection.test.ts`, `test/faults.test.ts` | Each injected-instruction variant: verify on the captured document gives the gate's verdict for that variant (an obeying agent is never verified) |
| `test/benchmark/independence.test.ts` | The import graph: no edge between `src/benchmark/grade/` and the verify module, in either direction |
| `test/proof/*` (#562) | Every bundle verify writes passes `verifyProofBundle`. Each of #562's tamper cases on a verify-written bundle fails with #562's code |

### 3.6 Pre-registered proofs

Expected verdicts, fixed before any build. Proofs P1–P4 run on `main`'s mock or Linux path,
with no VM and no model, in `test/verify-run/proofs.test.ts`. P5 needs the VM and runs only
after the trial run.

| # | Client / recording | Input | Expected |
|---|---|---|---|
| P1 | **Codex CLI** (`examples/mcp-clients/codex-transcript.md`). Fixtures the build PR commits verbatim from that file under `test/fixtures/verify-run/codex/`: the two gate decision logs, `honest.audit.jsonl` (1 line, written by the server bound to `df-s01`/`demo-df-s01`) and `refuted.audit.jsonl` (2 lines, written by the server bound to `df-s02`/`demo-df-s02`), and the two `codex exec --json` event streams, `honest.jsonl` and `refuted.jsonl` | Evidence from `pnpm myco-gate demo --transport mock --out <dir>`, `<dir>/evidence` (`demo-df-s01/.myco-todo.json` sha256 `6fec977b…57aa`, 168 bytes; `demo-df-s02/.myco-todo.json` sha256 `23a77ba9…38b2`, 85 bytes: the test asserts these equal the transcript's logged `evidenceRefs`). `--mock-evidence <dir>/evidence`. Run `demo-df-s01` with `--task df-s01 --decision-log honest.audit.jsonl --transcript honest.jsonl --client codex`; run `demo-df-s02` with `--task df-s02 --decision-log refuted.audit.jsonl --transcript refuted.jsonl --client codex` | `demo-df-s01`: `verified`, exit 0, 1 call, `loggedVerdictAgrees: true`. `demo-df-s02`: `refuted`, exit 1, 2 calls: call 1 recomputed `refuted` (`ORACLE_FAIL`); call 2, whose request names `df-s01`/`demo-df-s01`, is attributed to `demo-df-s02` by the binding and recomputed `uncertain` `ASSIGNMENT_MISMATCH` against the `df-s02`/`demo-df-s02` assignment. Logged and recomputed verdicts agree on all 3 calls, and `agentReported` agrees on all 3. No `VERIFY_LOG_BINDING`. All `trust: "mock"`, `simulated: true` |
| P2 | **Claude Code MCP path** (`examples/mcp-clients/claude-code.mcp.json`'s launch line, driven as Claude Code drives it, `test/gate/mcp-server.test.ts`) | Two `myco-gate mcp` servers over the same mock demo evidence, one bound to `df-s01`/`demo-df-s01` and one to `df-s02`/`demo-df-s02`, each with its own `--audit` log; the test sends each the calls of P1 | `demo-df-s01`: `verified`. `demo-df-s02`: `refuted`. Logged and recomputed verdicts agree on every call. This is a protocol-level stand-in: no Claude Code transcript is committed today. The real Claude Code transcript is P5 |
| P3 | **Raw JSON-RPC client** (`examples/mcp-clients/stdio-requests.jsonl`, `--client mcp-jsonrpc`). The file holds 4 requests and no responses | The test serves the committed requests through `serveStdio` with a gate bound to `df-s01`/`run-42` (`--audit` to a fresh log) over an evidence root whose `run-42/.myco-todo.json` is a byte copy of the mock demo's `demo-df-s01/.myco-todo.json`, and records the server's response lines. Verify `run-42 --task df-s01 --mock-evidence <root> --decision-log <that log>`, (a) with `--transcript` = the committed requests only, and (b) with `--transcript` = the requests interleaved with the recorded responses | Both: `verified`, exit 0, 1 call, logged and recomputed agree. (a) `agentReported: []` (a request stream reports no verdict). (b) `agentReported` has 1 entry, `verified`, `agrees: true` |
| P4 | **Track R recording** (`pnpm myco-record demo`) | The demo's two replays; `--recording` | honest: `verified`, `trust: "derived"`, `simulated: true`, exit 0. skip-save: `refuted`, exit 1 |
| P5 | **Live, after the trial run (VM):** Claude Code and Codex on the `myco-gate` arm, sealed vault | Every trial of the first live batch run on `trial-base-v3` (#564) whose runner persisted seal receipts (V1 merged first): `--vault --seal-receipt`, each trial's own decision log | For 100% of those trials, verify's verdict equals the trial's post-capture gate decision, the last line of its own log (`loggedVerdictAgrees: true`), and every bundle verifies. Any disagreement is a defect, not a result. A batch without receipts is reported as not verifiable, never audited without them |

Cursor and custom agents are covered through the decision log (step 3), which is the same for
every client. A `--client cursor` adapter is added only when a Cursor transcript fixture exists.

---

## 4. Acceptance criteria

Each criterion has an id, the claim, the exact **Probe** that proves it, and what **Refuted by**
means. Test file names are the ones the build PRs must create or extend.

### Replay and share (RS)

#### RS-01. The join pins each decision to the last frame captured before it was logged

`pinned(d)` is the largest frame with `logAfter.lines < d`, computed from line counts only.

- **Probe:** `test/watch/timeline.test.ts` › "join rule": table cases for one decision per frame,
  several decisions between two frames, a straddling frame, a decision before the first frame
  (`TL_NO_FRAME_BEFORE`) and a decision after the last frame. A property test over random
  interleavings checks the rule against a brute-force reference. Attribution: a line in run
  `r`'s own log whose request names another listed run `s` (logged `ASSIGNMENT_MISMATCH`) pins
  on `r`'s timeline, marked "named another trial", and appears nowhere on `s`'s; rewriting
  every line's `request.runId` to another listed run changes no pin.
- **Refuted by:** any decision pinned to a different frame than the reference, any pinning
  that changes when `checkedAt` values, frame mtimes or `request.runId` values are permuted,
  or any line pinned on a run other than the one whose log holds it.

#### RS-02. Gaps, duplicates, reorders and log edits invalidate the join (fail closed)

- **Probe:** `test/watch/timeline.test.ts` › "fail closed": one fixture per code in the
  [§2.2](#22-the-frame--decision-join) table (`TL_SCHEMA`, `TL_RUN`, `TL_GAP`, `TL_DUPLICATE`,
  `TL_FRAME_DIGEST`, `TL_ORDER`, `TL_LOG_AHEAD`, `TL_LOG_PREFIX`, `TL_LOG_BINDING`,
  `TL_MALFORMED`, `TL_CLOCK_SKEW`). `TL_ORDER` has two fixtures (`logBefore > logAfter` within
  a frame; the next frame's `logBefore` below this frame's `logAfter`), and `TL_LOG_PREFIX` has
  two (a bad `logBefore` hash with a good `logAfter` hash, and the reverse). `TL_LOG_BINDING`
  uses the mock demo's single shared log given as one run's log. Each must yield
  `{ joined: false, code }`, and the state served to the page must carry no pinned decision for
  that run.
- **Refuted by:** any fixture that yields a join, or a code other than its own.

#### RS-03. Clock skew never changes order

- **Probe:** `test/watch/timeline.test.ts` › "clock": the same log and manifest, with
  `checkedAt` shifted ±1 h, reversed, or set equal on all lines. Ordering and pinning stay the
  same; reversed `checkedAt` adds `TL_CLOCK_SKEW` (export refused).
- **Refuted by:** any ordering difference, or export allowed under reversed `checkedAt`.

#### RS-04. The scrubber replays the demo's false-done story frame by frame

- **Probe:** `test/watch/scrubber-e2e.test.ts`: starts `startWatchDemo({ family:
  "calc-multi-step" })` and reads `GET /timeline/ms-slip-then-repair-retry`. The test asserts
  the call 1 `refuted` (`ORACLE_FAIL`, `TARGET_MISMATCH`) and the call 2 `verified` each pin to
  exactly the frame the in-memory timeline's join gives (the largest frame whose
  `logAfter.lines` is below the call's ordinal in that run's own in-memory log), and call 1's
  pinned frame is before call 2's. For `todo-items`, run `demo-df-s02`: call 1 `refuted`; the
  demo's `ASSIGNMENT_MISMATCH` call is pinned on the run whose gate answered it. A Playwright check (`--trace off`) drags the slider and reads
  the shown verdict at each pinned frame.
- **Refuted by:** a decision shown before its pinned frame, a verdict shown on a frame before
  its decision, or a pinned frame index different from the in-memory timeline.

#### RS-05. Side by side refuses anything that is not a checked head-to-head pair

- **Probe:** `test/watch/pair.test.ts`: a valid pair (`hcu+shell` + `myco-gate`, same task,
  fixture and instruction hashes) is accepted. Each mismatch is refused with `PAIR_MISMATCH` and
  the field name: same arm twice, a different task, a different `fixtureSha256`, a null
  `instructionSha256`, the same run id twice, an episode failing `validateEpisode`, or an
  episode whose `provenance.runId` is another run. The test also asserts "align" uses decision
  boundaries, never timestamps.
- **Refuted by:** any mismatched pair rendered, or a refusal that prints a value.

#### RS-06. Every clip carries run id, verdict, gate version and digests that verify

- **Probe:** `test/watch/clip-verify.test.ts` › "round trip". (a) B4: a clip rendered in
  memory from a test timeline and log: log-only `myco clip verify` exits **2** with
  `CLIP_LOG_ONLY`, never 0. (b) B6: export from a test-built sealed vault run
  (`simulated: false`, `transport: "vm"` fixture, receipt written by the test harness), then
  sealed-mode `myco clip verify` exits 0, and log-only mode on the same clip exits 2. In both,
  the sidecar's `runId`, `verdict`, `gate.apiVersion`, `recordDigest` and `digest` are
  present, and `headerDigest[0:16]` is read back from the band by re-rendering.
- **Refuted by:** a clip missing any of those fields, a digest that does not recompute from
  the [§2.5](#25-the-clip-digest-and-myco-clip-verify) construction, log-only mode exiting 0,
  or sealed mode not exiting 0 on the honest export.

#### RS-07. Every listed tamper fails clip verification with its code

- **Probe:** `test/watch/clip-verify.test.ts` › "tamper, log-only": every row of the
  [§2.5](#25-the-clip-digest-and-myco-clip-verify) tamper table in log-only mode, each
  asserting its log-only column (exit 1 and that code, or exit 2 and `CLIP_LOG_ONLY`).
- **Refuted by:** any tamper that exits 0, or a result other than its row's log-only column.

#### RS-08. Mock runs are watermarked MOCK on every frame, live and exported

- **Probe:** `test/watch/mock-watermark.test.ts`: every frame served for a demo run carries the
  watermark. Every frame of `exportMockPreview` for `demo-df-s02` and
  `ms-slip-then-repair-retry` has the watermark band equal to its reference render, pixel for
  pixel, and band line 3 is `GATE myco.gate/v1  MOCK · NOT EVIDENCE`. A run with
  `simulated: true` in its episode is watermarked even with `file` frames. `myco clip verify`
  on a mock preview with no sidecar file exits 1 with `CLIP_NO_SIDECAR`.
- **Refuted by:** any frame of a mock run, served or exported, without the watermark, or a
  mock preview that verification does not refuse with `CLIP_NO_SIDECAR`.

#### RS-09. The evidence path refuses mock runs structurally

- **Probe:** `test/watch/clip-evidence-gate.test.ts`. `exportEvidenceClip` refuses each of
  these with `CLIP_MOCK`: a vault run whose provenance is `transport: "mock"`, one whose
  transport is not isolated (a `linux-plain` fixture), one with `simulated: true`, one with no
  provenance file, and a `rendered` frame. A decision line with no `evidenceRefs` is refused
  with `CLIP_EVIDENCE`. A type test
  (`expectTypeOf`) shows `exportEvidenceClip` accepts only `SealedTimeline`, which has no
  exported constructor. A static test shows no CLI flag or function parameter that marks a run
  real (it greps the parser's flag list for none of `--evidence`, `--real`, `--not-mock`,
  `--force`).
- **Refuted by:** any mock-provenance run producing a sidecar, a `SealedTimeline` created
  outside `openSealedTimeline`, or such a flag existing.

#### RS-10. Export goes through the allowlist helper and the leak guard

- **Probe:** `test/watch/clip-privacy.test.ts`. The clip module passes #560's
  `test/leak-guard/routing.test.ts`. Planted values go into every free-form input field (claim,
  reasons, evidence paths, frame file names, oracle family): a fake username, a fake full name,
  a fake hostname, macOS, Linux and Windows home paths built from the fake name, a key-shaped
  token, and a window
  title carrying the fake name. No byte of the GIF, poster or sidecar contains any of them
  (raw-byte scan with the shared detector); ids carrying them are `h-<60hex>`; and an existing
  `h-<60hex>` value is kept, while `h-<64hex>` and `h-<59hex>` are re-hashed.
- **Refuted by:** any planted value recoverable from the output, a hashed id in any other
  `h-` form, or the module failing #560's routing test.

#### RS-11. Exported frames pass the TIF-98 redactor rules (OCR and raw bytes)

- **Probe:** `test/watch/clip-redactor.fuzz.test.ts`: the verifier fuzz of the TIF-98 PNG
  redactor follow-up (its GitHub Issue). Usernames, full names, hostnames, home paths and key-like strings are rendered into
  source frames at varied fonts, sizes, colours, rotations and partial occlusion. Source PNGs
  also carry `tEXt`/`zTXt`/`iTXt`, EXIF, XMP and data after `IEND`. Pass: no planted string is
  recoverable from any exported byte (OCR + raw-byte scan). Frames where OCR finds one refuse
  with `CLIP_OCR_HIT`. Undecodable frames refuse with `CLIP_FRAME_REFUSED`. With no OCR engine,
  the export refuses with `CLIP_OCR_UNAVAILABLE`.
- **Refuted by:** any planted string recovered, any metadata chunk or extension or trailing
  byte in an export, or an export that succeeds without an OCR pass.

#### RS-12. Overlays are generated only from closed fields

- **Probe:** `test/watch/clip-band.test.ts`. A type test shows the renderer's input is
  `BandFields` (closed unions and branded ids only). A runtime test plants a marker in every
  non-closed `GateResult` field and checks the band pixels are identical with and without the
  markers. A character outside the glyph set refuses the render.
- **Refuted by:** any band pixel that changes with a non-closed field, or a renderer parameter
  of type `string` that is not a branded closed id.

#### RS-13. Every watch security property keeps holding, and the amended rows say so

- **Probe:** every existing case in `test/watch/server-security.test.ts`,
  `test/watch/round2.test.ts` and `test/watch/round3.test.ts` passes unchanged. The
  "every non-GET method × every route" matrix and the traversal corpus are extended to
  `/timeline/…` and `/clip/…`. The static import/write scan covers the new modules and shows
  no module the server imports reaches `src/integrity/vault.ts`, `src/baseline/secret-file.ts`
  or the CLI-only clip module. The planted-marker allowlist test is extended to both routes: no
  response carries a planted value, a `frameSha256`, a `prefixSha256`, any digest or the
  oracle family or version. `GET /clip/…` on a run that is not mock is 404. The tree snapshot
  before and after shows no file changed by serving, polling or clip download. One listening
  socket only (`server.address()` count, and no other `listen` in `src/watch/`). A doc test
  shows `docs/gate/watch.md` carries the five amended rows of
  [§2.8](#28-security-model-what-holds-and-what-changes) and the Limits addition.
- **Refuted by:** any existing case changed or failing, any non-GET accepted on a new route, a
  file written by the server, a second listener, a digest or oracle field in any HTTP
  response, an evidence clip served, or `docs/gate/watch.md` not amended in the same PR as
  its route.

#### RS-14. CLI export writes only the user-chosen path

- **Probe:** `test/watch/clip-cli.test.ts`: `myco clip export --out <tmp>/c.gif` creates
  exactly `c.gif` and `c.myco.json` (directory listing before and after). An existing target is
  refused (`O_EXCL`). A symlinked target is refused. Nothing is written anywhere else (tree
  snapshot of the vault, log and frames).
- **Refuted by:** any other file created or modified, or an existing file overwritten.

#### RS-15. A caught false-done clip fits the postable budget

- **Probe:** `test/watch/clip-budget.test.ts`: the mock preview of `demo-df-s02`, and the
  test-vault evidence clip of a refuted run, are each ≤ 5 MiB, ≤ 15 s, ≤ 150 frames, ≤ 10 fps,
  720 px wide, GIF89a, looping, with an end card of 2–3 s; the poster is ≤ 1 MiB. An over-budget
  request refuses with `CLIP_BUDGET` and writes nothing.
- **Refuted by:** any limit exceeded in an exported file, or a silent downscale or truncation.

#### RS-16. A real run's evidence clip is one command, and the watch server never holds a key

- **Probe:** `test/watch/clip-evidence-cli.test.ts`. On a test-built sealed vault run of a
  caught false done (`transport: "vm"`, receipt and key files written by the test harness), one
  `myco clip export --vault … --seal-receipt … --vault-key-file … --out <tmp>/c.gif`
  invocation writes exactly `c.gif` and `c.myco.json`, and sealed-mode `myco clip verify` on
  them exits 0. The page for that run, served with the run listed, has an "Export evidence
  clip" control whose text is that command with the run id and frame ordinals filled in and
  every path a placeholder (no path, key, or receipt byte in any response). A type and static
  test shows `startWatchServer`'s options and the watch CLI's flags take no key, key file or
  receipt, and `myco watch --vault-key-file` is a usage error. With a planted key, no byte of
  the GIF, sidecar, stdout or stderr contains the key or the key file's path.
- **Refuted by:** a real run needing more than that one command, the export not verifying in
  sealed mode, any path or key byte in a page response or an output, or any way to give the
  watch server a key.

#### RS-17. Sealed-mode clip verification catches every tamper, including reorder, re-pin and forged MOCK

- **Probe:** `test/watch/clip-verify.test.ts` › "tamper, sealed": every row of the
  [§2.5](#25-the-clip-digest-and-myco-clip-verify) tamper table in sealed mode against a
  test-built sealed vault run, each asserting exit 1 and its sealed column. The reorder rows
  (content swapped with labels kept ascending, with and without swapped `sourceSha256`), the
  moved pin, the `recordDigest` replacement, the regenerated post-capture line, the never-sealed
  mock demo clip and the mock-provenance vault run are each present. A static test shows the
  sealed checks read `R`, the timeline and the provenance only from `openSealedTimeline` and
  the log, never from the sidecar.
- **Refuted by:** any row exiting 0 or 2 in sealed mode, a code other than its sealed column,
  or a sealed check that reads a value it compares against from the clip.

### Verify any agent (VA)

#### VA-01. The CLI is exactly as specified

- **Probe:** `test/verify-run/cli.test.ts`: the three source forms parse. Two sources, no
  source, an unsafe id, an unknown flag, `--client cursor`, `--out` onto an existing file,
  `--vault` without `--seal-receipt`, and `--vault` without `--vault-key-file` are each exit 3. The exit code is 0, 1 or 2 by verdict. stdout is valid `myco.verify/1` with
  no unknown field.
- **Refuted by:** any accepted form not in [§3.1](#31-the-cli), or an exit code that differs
  from the verdict mapping.

#### VA-02. The verdict comes from the gate's own oracle over host-side evidence

- **Probe:** `test/verify-run/parity.test.ts`. For every built-in family's mock-demo and
  sealed-gate fixtures (`test/gate/sealed-gate.test.ts`'s vaults), verify's verdict and reason
  codes equal `gate.check` for the same assignment and evidence.
- **Refuted by:** any (family, fixture) where they differ.

#### VA-03. The agent can never supply evidence or influence the oracle

- **Probe:** `test/verify-run/independence.test.ts`. The same evidence is verified with an
  empty decision log, an honest log, a log whose every line claims `verified`, a log whose
  requests carry every `ORACLE_INPUT_FIELDS` name, and transcripts that report `verified`. The
  run's verdict, reason codes and bundle verdict record are identical in every case. Calls with
  oracle inputs are refused per call with `ORACLE_INPUT_REJECTED`.
- **Refuted by:** any change in the run verdict caused by a log, transcript or recording field.

#### VA-04. Every failure path is `uncertain` with codes only

- **Probe:** `test/verify-run/fail-closed.test.ts`: a missing vault, a wrong key file, a broken
  seal, a missing capture, a missing state file, an unreadable file, a logged decision that
  disagrees with the recompute (`VERIFY_LOG_DISAGREES`), and an unwritable bundle path each
  exit 2. A planted marker in every input appears in no output byte.
- **Refuted by:** any failure exiting 0 or 1, or any output quoting an input value.

#### VA-05. The existing integrity suites cover `myco verify`, with the trial's receipt

- **Probe:** the extensions in [§3.5](#35-test-suites-the-new-entry-point-must-join) to
  `test/integrity/isolation.test.ts`, `test/integrity/surface.test.ts`,
  `test/gate/caller-isolation.test.ts` and `test/gate/input-fuzz.test.ts`, each driving verify
  from the suite's own route table. In `isolation.test.ts`, every route of the tampering block
  (except the two construction-time cases §3.5 names) runs `myco verify --vault` with that
  trial's receipt written as a `--seal-receipt` file and the suite's key written as a
  `--vault-key-file` file. For each route, verify's verdict is the gate's verdict for that
  route (`uncertain` or `refuted`, never `verified`), and for each route the suite asserts with
  `expectIntegrity(…, code)`, verify's `verifyCodes` contain an entry starting with
  `integrity:<code>`. The leaked-key re-signed seal, another run's receipt, and a malformed
  receipt file give `integrity:receipt-mismatch`, `integrity:receipt-mismatch` and
  `integrity:receipt-malformed`. The honest baseline run verifies.
- **Refuted by:** any tampering route that verifies, a route whose asserted `integrity:<code>`
  is missing from verify's codes, a verdict that differs from the gate's for that route, the
  honest baseline not verifying, `--vault` accepted without a receipt, or verify absent from a
  suite's table.

#### VA-06. The R5 oracle-mutation suite covers `myco verify`

- **Probe:** the `test/oracle-selftest/selftest.test.ts` extension: every claimed corruption
  class of every oracle, sealed and verified. The committed R5 report is byte-unchanged.
- **Refuted by:** any mutated document verified, any control not verified, or a report diff.

#### VA-07. The fault-injection suites cover `myco verify`

- **Probe:** the `test/fault-classes/tamper.test.ts`, `test/fault-classes/injection.test.ts`
  and `test/faults.test.ts` extensions: every tamper route and injection variant, with verify's
  verdict asserted against the row's "Must end".
- **Refuted by:** any row where verify's verdict or code differs from the row, or `verified`
  on a tampered run.

#### VA-08. A recording cannot smuggle evidence

- **Probe:** `test/verify-run/recording-tamper.test.ts`: all 11 cases of
  [§3.4](#34-a-recording-cannot-smuggle-evidence).
- **Refuted by:** any case that ends `verified`, or ends other than its row.

#### VA-09. Grader independence holds

- **Probe:** the `test/benchmark/independence.test.ts` extension: no import edge between
  `src/benchmark/grade/` and the verify module, in either direction; `myco.verify/1` has no
  grade field; a recording result is never `trust: "sealed"`.
- **Refuted by:** any such import edge, field or label.

#### VA-10. The pre-registered proofs give the pre-registered verdicts

- **Probe:** `test/verify-run/proofs.test.ts` for P1–P4 of
  [§3.6](#36-pre-registered-proofs), with each expected verdict and exit code as written there.
  P5 is checked by its batch report after the trial run.
- **Refuted by:** any verdict or exit code different from the table. The table is not edited
  to match a result.

#### VA-11. Every verify bundle is a valid #562 proof bundle

- **Probe:** `test/verify-run/bundle.test.ts`: every bundle written in VA-10 passes
  `verifyProofBundle` (with `--episode` and `--ledger` when given). #562's tamper cases on a
  verify-written bundle fail with #562's codes. A mock-source bundle has `run.simulated: true`.
- **Refuted by:** a written bundle that fails verification, or a mock bundle with
  `simulated: false`.

#### VA-12. The vault key is loaded at the point of use and never leaves it

- **Probe:** `test/verify-run/secrets.test.ts`: the key is read only through the secret-file
  loader, from `--vault-key-file`. With a planted key, no stdout, stderr, bundle or error byte
  contains the key or the key file's path. A static test shows the module reads no
  `process.env` key and has no `--vault-key` (value) flag, and that the only modules in the
  repo importing the secret-file loader for the vault key are the three CLIs of
  [§1](#1-ground-rules-shared-by-both-features) rule 6 (the clip CLIs from B6 on).
- **Refuted by:** any key or key-path byte in any output, a key accepted by value, or a fourth
  importer.

#### VA-13. Calls are attributed by the gate's binding, never by `request.runId`

- **Probe:** `test/verify-run/attribution.test.ts`. P1's `refuted.audit.jsonl` given for
  `demo-df-s02`: both lines are `demo-df-s02`'s calls; call 2 (request naming
  `demo-df-s01`) recomputes as `ASSIGNMENT_MISMATCH` and agrees with its logged line. The same
  log given for `demo-df-s01` gives `uncertain` `VERIFY_LOG_BINDING` (line 1 names
  `demo-df-s02` without `ASSIGNMENT_MISMATCH`). The mock demo's shared `gate-decisions.jsonl`
  given for `demo-df-s01` or for `demo-df-s02` gives `VERIFY_LOG_BINDING`. Rewriting every line's `request.runId` to
  another run while keeping `ASSIGNMENT_MISMATCH` changes no call's attribution.
- **Refuted by:** any line attributed to the run its request names rather than the run whose
  log holds it, P1's call 2 recomputed against `demo-df-s01`, or a shared log accepted.

---

## 5. Build PRs

Small and independently verifiable, in this order. **Every PR is Tier 2**: each touches the
gate's evidence path, an export, or the watch security model. "No VM" means the PR builds and
its acceptance tests run on Linux CI with no VM and no model.

**The revert check (every verifier, every PR).** Check out the PR head. Revert only the PR's
non-test code (`git checkout origin/main -- <the PR's src/ and scripts/ paths>`), keep its
tests, and run the PR's acceptance tests. **Every listed criterion's probe must fail.** A
probe that still passes with the code reverted proves nothing, and the PR does not pass until
it is fixed. Then restore the head and confirm the probes pass.

| PR | Scope | Covers | Tier | VM | Depends on | Revert check |
|---|---|---|---|---|---|---|
| B1 | Timeline manifest (`myco.watch-timeline/1`), the shared line-count and prefix function, the binding check, the joiner (`src/watch/timeline.ts`), and the mock demo keeping one in-memory log and timeline per gate | RS-01, RS-02, RS-03 | 2 | No VM | none | Revert `src/watch/timeline.ts` and the demo change: `test/watch/timeline.test.ts` fails |
| B2 | Scrubber: `GET /timeline/<run>`, page slider, decision jumps, per-run `--decision-log <runId>=<file>`; security matrix extended; the `docs/gate/watch.md` row amendments for `/timeline` and the Limits addition | RS-04, RS-13 | 2 | No VM | B1 | Revert the route and page: `test/watch/scrubber-e2e.test.ts` and the extended matrix fail |
| B3 | Side by side: `--pair`, pair checks against episodes and ledger, align by decision | RS-05 | 2 | No VM | B2 | Revert the pair code: `test/watch/pair.test.ts` fails |
| B4 | Clip core: bitmap font, band renderer from `BandFields`, deterministic GIF encoder with reserved palette, sidecar, digests, log-only `myco clip verify` (in-memory export only; nothing written) | RS-06, RS-07, RS-12 | 2 | No VM | B1 | Revert `src/watch/clip/`: `test/watch/clip-verify.test.ts` and `test/watch/clip-band.test.ts` fail |
| B5 | Mock preview export: the watermark on live and exported frames, `exportMockPreview`, `GET /clip/...` for mock runs only, `myco clip export` writing one path, budget; the `docs/gate/watch.md` row amendments for `/clip` | RS-08, RS-13, RS-14, RS-15 | 2 | No VM | B2, B4 | Revert the export code: `test/watch/mock-watermark.test.ts`, `test/watch/clip-cli.test.ts`, `test/watch/clip-budget.test.ts` and the `/clip` rows of the extended matrix fail |
| B6 | Evidence export and sealed verify: `myco.run-provenance/1` written by the gated harness at capture, `openSealedTimeline` with the receipt, `exportEvidenceClip`, `myco clip export --vault`, sealed-mode `myco clip verify` (run record, timeline, recompute, re-render), the "Export evidence clip" command control, sidecar through #560's helper, leak guard, OCR backstop, GIF/PNG structure scrub | RS-06, RS-09, RS-10, RS-11, RS-16, RS-17 | 2 | No VM | B5, V1, #560, #562, #559, the TIF-98 PNG redactor follow-up issue | Revert the evidence export, sealed verify and provenance writer: `test/watch/clip-evidence-gate.test.ts`, `test/watch/clip-evidence-cli.test.ts`, `test/watch/clip-privacy.test.ts`, `test/watch/clip-redactor.fuzz.test.ts` and the sealed cases of `test/watch/clip-verify.test.ts` fail |
| V1 | `myco verify` core: CLI, the three sources, `--seal-receipt` and the runner persisting `GatedTrialOutcome.receipt`, a bound sealed gate over host evidence, binding check and decision-log call recompute, `myco.verify/1`, key at point of use; suite extensions for integrity, R5 and faults | VA-01, VA-02, VA-03, VA-04, VA-05, VA-06, VA-07, VA-09, VA-12, VA-13 | 2 | No VM | none | Revert `src/verify-run/`, the receipt writer and the `bin/myco` entry: every `test/verify-run/*` probe and every suite extension fails |
| V2 | Transcript adapters (`codex`, `mcp-jsonrpc`) and the Codex fixtures, `agentReported` | VA-03, VA-10 (P1, P3) | 2 | No VM | V1 | Revert the adapters: `test/verify-run/proofs.test.ts` P1 and P3 and the transcript cases of `test/verify-run/independence.test.ts` fail |
| V3 | Recording source (track R): pinned workflow, R5 before verify, derived trust | VA-08, VA-10 (P4) | 2 | No VM | V1 | Revert the recording source: `test/verify-run/recording-tamper.test.ts` and P4 fail |
| V4 | Proof bundle emission through #562 | VA-11, VA-10 (P2) | 2 | No VM | V1, #562 | Revert the bundle code: `test/verify-run/bundle.test.ts` fails |
| L1 | Live proof after the trial run: P5 on the first live batch with receipts, and the first real caught false-done clip exported and verified in sealed mode | VA-10 (P5), RS-06 (on a real run), RS-16 (on a real run) | 2 | VM | the trial run, #564, B6, V4 | Not a code PR: the verifier re-runs `myco verify` and `myco clip verify` on the committed batch and checks every row |

**Order and parallelism.** B1 and V1 can start at once, without a VM: they share nothing. B2, B4
and V2, V3 follow their parents. B6 waits for V1 (its recompute is V1's core) and for the PRs
and issue in [§6](#6-dependencies-on-unmerged-prs); V4 waits for #562. L1 is last, after the
trial run on `trial-base-v3`, and never takes VM time the trial run or the integrity fixes
need.

---

## 6. Dependencies on unmerged PRs

State as of 2026-11-27. Closed PRs this spec cited before (#550, #553, #556, #541) are replaced
by their successors below and are no longer dependencies.

| PR | State today | What depends on it | Criteria that wait on it | Until it merges |
|---|---|---|---|---|
| #560 (TIF-98: shared leak guard, allowlist serialization helper) | open, draft | B6: the sidecar must be written through its helper and pass its routing test | RS-10, RS-11, RS-16, RS-17 (B6) | B6 does not start. B1–B5 write no evidence export; the mock preview has no sidecar |
| #562 (Q3 proof bundles, identity-safe; supersedes #553) | open | V4: the bundle format, `verifyProofBundle`, the identity guard; B6: `h-<60hex>` parity with the Q-bundle surface | VA-11, VA-10 (P2); RS-10 | V1–V3 emit no bundle (`bundle: null`). The Q-bundle publication hold applies to verify bundles too: none is published, committed as data or attached anywhere until the hold lifts |
| #566 (episode export allowlist + identity + F1; supersedes #556) | open | B3 and V1 read episodes; an *exported* episode is accepted as input only after #566 | RS-05 and VA-11 with an exported episode only | Inputs are episodes from the store (`src/episode/store.ts`), validated by `validateEpisode` |
| #559 (track U dataset export, allowlist) | open | The `h-<60hex>` format is accepted on condition that #559's round-2 verifier confirms it is a truncated SHA-256 carrying no input text (23:06Z) | RS-10 (B6) | B6 does not ship before that confirmation |
| #561 (track L safe parallelism, unprivileged backends; supersedes #541) | open | B6's provenance transport set: #561's `linux-plain` constant is added, and refused as not isolated | RS-09's `linux-plain` fixture | Does not block. The transport set is `vm` and `mock`; RS-09 uses a hand-built `linux-plain` provenance file until #561 merges |
| #564 (TIF-98: switch trials to `trial-base-v3`) | open | L1: P5 and the first real clip run on the first live batch, which runs on `trial-base-v3` | VA-10 (P5), RS-06 and RS-16 on a real run (L1) | L1 does not start. No B or V PR waits on it |
| #576 (xlsx gate, value-domain sound; supersedes #550) | open, draft | Verify supports exactly the gate's families; xlsx-backed Calc tasks need #576 | VA-02 for the xlsx family only | `myco verify` on an xlsx task is `uncertain` (the family is not in the registry), never guessed |

The TIF-98 PNG redactor follow-up is a dependency of B6 as well (RS-11's fuzz is its probe).
It is not yet a PR or an issue: the coordinator files it as a GitHub Issue under the fallback,
and B6 cites its number. Until that issue exists and is resolved, B6 does not start.

## 7. Out of scope

- **Any upload, share link, hosting or remote endpoint.** "Share" means a local file the user
  saves and posts themselves. No button posts anywhere.
- **Mid-run checkpointed capture.** Real sealed runs show the refute at the end
  ([§2.3](#23-what-real-runs-show-today)).
- **Side-by-side clip export**, MP4/WebM, audio, captions, clip editing.
- **Grader results, rates or any R1/R2 number** in a clip, the page or verify output.
- **Signed or keyed digests.** Rewrite resistance is the same open decision as #518 and #562.
- **A real Claude Code transcript before the trial run**, and a Cursor adapter before a Cursor
  fixture exists.
- **Windows-only paths and the VM** for B1–B6 and V1–V4.
- **Any change to the gate's request, result, reason codes or oracles**, or to
  `--allow-non-loopback`'s rule.
- **Making `myco verify` an agent tool.** It is an operator CLI only.

## 8. Open questions for the lead

1. **OCR engine for the export backstop (B6).** Proposal: require a pinned local OCR engine
   (for example `tesseract`) and refuse evidence export without it (`CLIP_OCR_UNAVAILABLE`).
   The alternative is OCR in the verifier fuzz only, which gives a weaker guarantee for real
   frames.
2. **Who holds the vault key and the seal receipt.** Proposal: the three operator CLIs of
   [§1](#1-ground-rules-shared-by-both-features) rule 6 run on the operator host, load the key
   from a file path at the point of use (VA-12), and read the receipt the trial runner
   persisted (V1). The alternative, an offline audit with no receipt (`AUDIT_WITHOUT_RECEIPT`),
   is not proposed: a re-signed seal made with a leaked key would pass it (VA-05). A second
   alternative, recording `sealDigest` in #518's attempt ledger start event, would let the
   ledger replace the receipt file, but it changes the ledger schema and is left for a later
   version.
3. **Oracle family and version on the evidence band.** They are operator strings that the live
   page leaves out today, and this spec keeps them out of every HTTP response
   ([§2.8](#28-security-model-what-holds-and-what-changes)). Proposal: show them on the
   evidence band and in the sidecar, which only the operator CLI writes, through the `id`
   treatment (hashed when they are not a closed id or when they carry an identity), so the
   clip states which rule decided. The mock preview band never shows them.
4. **"One-click" for real runs.** This spec reads the ruling's "one-click export of REAL gate
   evidence" as one operator command, with a page control that copies it (RS-16), because a
   server-side evidence render would put the vault key in the watch server. The alternative,
   a separate keyed exporter process the page could call, is not proposed.
