# Demo track: replay and share in `myco watch`, and verify any agent's run

**Status: spec, pre-registered, nothing built.** TIF-265 (replay + share) and TIF-270 (verify
any agent's run); both Linear issues are pending (outer loop, see the "TO FILE" comment on this
PR). This page is binding on the build PRs listed in [§5](#5-build-prs). Each acceptance criterion
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
| Verdict vault | `src/integrity/vault.ts` | `AUDIT_WITHOUT_RECEIPT` for an offline audit |
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
   byte-unchanged by every build PR here. New codes live in their own closed enums
   (`TIMELINE_CODES`, `CLIP_CODES`, `VERIFY_CODES`), never in `REASON_CODES`.
2. **A verdict is what the gate's oracle said on host-side evidence. It is never a measurement.**
   Neither feature shows, computes or exports a rate, an R1/R2 number or a grader result. R1 and
   R2 numbers stay in the scorecards, decided by the independent grader.
3. **Fail closed, never guess.** When the inputs disagree, are incomplete or can't be read, the
   answer is "no verdict shown" (watch), "refused" (clip export, clip verify) or `uncertain`
   (verify), with a code. Nothing is ever interpolated, inferred from a clock, or filled in.
4. **Codes only.** Every refusal and reason is a code from a closed enum. No message quotes a
   path, a claim, a file name or any other value from the inputs.
5. **Mock is never evidence.** This is decided by where a run came from (its provenance), never
   by a flag the caller passes ([§2.6](#26-mock-runs-watermarked-never-evidence)).
6. **Secrets.** Neither feature reads the environment, a keychain or a secrets file, except for
   one case: `myco verify --vault` loads the vault MAC key at the point of use from a key-file
   *path* (`src/baseline/secret-file.ts` pattern). The key never goes through argv, an
   environment variable, a log or an output. The key file's path is printed nowhere.

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
- **One-click clip.** A short GIF of a frame range with the verdict burned in, plus a sidecar
  that verifies against the decision log ([§2.5](#25-the-clip-digest-and-myco-clip-verify)).
  "One click" means a GET download that the browser saves where the user chooses. The server
  writes nothing ([§2.8](#28-security-model-unchanged)).

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

- **Decision ordinal.** The 1-based index of a line among the decision log's complete
  (newline-terminated), non-blank lines. Blank lines are skipped, which is how
  `DecisionLogTail` reads the log today. Malformed lines still count. One shared function
  computes `lines` and `prefixSha256` for the recorder and the joiner: `prefixSha256` is the
  sha256 of the log's bytes up to and including the newline of line `lines`. Ordinals run over
  the whole file, whichever run each line is for.
- **The only clock is the log's own line count.** `checkedAt`, frame mtimes, file names and
  the host clock are never join keys. `checkedAt` is shown as a label only.

**The join rule.** Decision `d` (an ordinal whose line projects, through `projectDecisions`, to
a listed run `r`) is **pinned to the last frame of run `r` whose capture finished before line
`d` was in the log**:

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
| `TL_ORDER` | `logBefore.lines > logAfter.lines`, or `logAfter.lines` decreases from one frame to the next |
| `TL_LOG_AHEAD` | a record names more lines than the decision log now has (the log was truncated or replaced) |
| `TL_LOG_PREFIX` | a record's `prefixSha256` is not the sha256 of the current log's first `lines` lines (a line edited, inserted, removed or reordered) |
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

A mid-run "done → refuted → retry" timeline needs a checkpointed capture. That is a follow-up,
and this spec does not build it. Until it lands, mid-run refutes appear only in mock runs and
the development path (`fileEvidenceReader`), and those are never evidence. The demo narration
must not imply otherwise.

### 2.4 Side-by-side head-to-head replay

- **CLI:** `myco watch --pair <runA> <runB> --decision-log <fileA> --decision-log <fileB>
  (--frames <dir> | --sealed-capture <vaultRoot>) --episode <epA> --episode <epB>`. Each
  `--decision-log` and `--episode` follows the order of the pair. `--pair` implies `--run` for
  both runs.
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

A clip is two files:

- `<name>.gif`: postable on its own;
- `<name>.myco.json`: the sidecar (`myco.clip/1`), which carries what verification needs.

The GIF never carries metadata ([§2.7](#27-export-privacy)), so the digest travels in the
sidecar, and a short form of it is burned into the pixels.

**The burned-in band.** Every output frame has a band at the bottom. It is drawn only from closed
fields, in a fixed in-repo bitmap font (glyphs `A-Z 0-9 . _ - : / # ·` only; any other character
refuses the render), using palette indices 0–7, which content quantization never uses. Its
lines:

1. `RUN <runId display>  TASK <taskId display>  FRAME <i>/<n>`
2. The latest decision pinned at or before this frame: `CALL <k> <VERDICT> <REASON_CODES…>`,
   or `NO DECISION YET`, and `AGENT CLAIMED DONE` when the episode's `agentClaim` is `done`
3. `GATE myco.gate/v1  ORACLE <family>/<version>  CLIP <headerDigest[0:16]>  VERIFY: myco clip verify`

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

- `headerDigest = sha256("myco.clip/1/header" ‖ 0x00 ‖ canonical(H))`. `H` is the sidecar
  without `clip.rgbaSha256`, `clip.fileSha256`, `headerDigest` and `digest`. The band shows
  `headerDigest`, so no field is computed from its own value.
- `digest = sha256("myco.clip/1" ‖ 0x00 ‖ canonical(S))`. `S` is the whole sidecar without
  `digest`, so it covers the header digest, every frame's RGBA hash in order, and the GIF
  file's hash.

**`myco clip verify`** (exit 0 verified, 1 refused, 3 usage):

```
myco clip verify <clip.gif> --sidecar <clip.myco.json> --decision-log <file>
                 [--expect-log-sha256 <hex>] [--sealed-capture <vaultRoot> --timeline <timeline.jsonl>] [--json]
```

It checks, in order, and refuses with the first failing code:

| Code | Check |
|---|---|
| `CLIP_SCHEMA` | the sidecar parses under the closed schema: unknown field, wrong type, `evidence` not `true`, a reason code outside `REASON_CODES`, an id that is neither a closed id nor `h-<60hex>` |
| `CLIP_DIGEST` | `headerDigest` and `digest` recompute to the sidecar's values |
| `CLIP_FILE` | the GIF's sha256 is `clip.fileSha256`; the GIF parses under the structural rules of [§2.7](#27-export-privacy) |
| `CLIP_FRAMES` | the GIF's frame count, size and delays equal the sidecar's; each decoded frame's RGBA sha256 equals `clip.rgbaSha256[i]` **in order** |
| `CLIP_BAND` | each frame's band region equals the band re-rendered from the sidecar's closed fields and the frame's pinned decisions, pixel for pixel |
| `CLIP_LOG_LINE` | line `decision.ordinal` of the decision log hashes to `decision.lineSha256` |
| `CLIP_LOG_PREFIX` | the log's first `decision.ordinal` lines hash to `decision.logPrefixSha256`; with `--expect-log-sha256`, the whole log's sha256 is the expected one |
| `CLIP_DECISION` | that line, parsed, has `request.runId` equal to the clip's run (the h-form compared when hashed), and `verdict`, `accepted`, `reasonCodes` and `apiVersion` equal to the sidecar's; its `call` number (counted per run, as `projectDecisions` counts) is `decision.call`; and the frames' `pinned` lists match the join rule applied to the log |
| `CLIP_SOURCE` | with `--sealed-capture`: each frame's `sourceSha256` is a frame in the run's sealed capture (seal and capture hashes checked), and the timeline joins as the sidecar says; re-encoding those frames with the pinned renderer reproduces `clip.fileSha256` byte for byte |

`CLIP_SCHEMA` also requires the sidecar's `frames` to be consecutive, ascending ordinals of one
run.

**Required tamper cases.** Each must exit 1, and the test asserts the **first** failing code in
the order above (`test/watch/clip-verify.test.ts`). "Re-forged" means the attacker also
rewrote the named sidecar fields to match their change.

| Tamper | First failing code |
|---|---|
| one content pixel of one frame changed; sidecar untouched | `CLIP_FILE` |
| the same, with `clip.fileSha256` and `clip.rgbaSha256` re-forged, `digest` not | `CLIP_DIGEST` |
| the burned-in verdict redrawn (`REFUTED` → `VERIFIED`), every sidecar hash including `digest` re-forged | `CLIP_BAND` (the band re-rendered from the sidecar's `refuted` differs) |
| the sidecar's `verdict`, `accepted` and `reasonCodes` changed and the band redrawn to match, every hash re-forged | `CLIP_DECISION` (the decision-log line still says `refuted`) |
| the sidecar's `verdict` changed, digests re-forged, band not redrawn | `CLIP_BAND` |
| the decision-log line at `decision.ordinal` edited (`refuted` → `verified`) | `CLIP_LOG_LINE` |
| two decision-log lines before the decision swapped, or a line inserted or removed before it | `CLIP_LOG_PREFIX` |
| two GIF frames swapped (timeline reordered); sidecar untouched | `CLIP_FILE` |
| the same, with `clip.fileSha256` and `clip.rgbaSha256` re-forged in the new order and `digest` recomputed | `CLIP_BAND` (each band names its frame number) |
| the same, with the bands redrawn and the sidecar's `frames` reordered to match | `CLIP_SCHEMA` (frames not ascending) |
| a frame dropped or duplicated; sidecar untouched | `CLIP_FILE` |
| the same, with `clip.fileSha256` re-forged, `digest` recomputed | `CLIP_FRAMES` (the count or an `rgbaSha256` entry no longer matches) |
| the clip paired with another run's decision log | `CLIP_LOG_LINE` (that log's line at `decision.ordinal` is another run's decision) |
| a mock preview GIF given with a forged, internally consistent sidecar | `CLIP_BAND` (the band says `MOCK · NOT EVIDENCE`) |
| a GIF comment, plain-text or application extension appended, or bytes after the trailer | `CLIP_FILE` |

**Stated limit: tamper-evident, not tamper-proof.** This is the same threat model as #562 and
#518. The digest is unkeyed. Whoever holds the decision log and the frames can produce a
consistent clip for what that log says. The decision log is the trust anchor, and an
out-of-band log hash (`--expect-log-sha256`) is what detects a log regenerated whole. A clip
proves "this is what the gate logged for this run, on these frames". It does not prove the gate
was right; that is the independent grader's call. The end card says so in one line: `GATE
VERDICT · NOT A GRADE`.

### 2.6 Mock runs: watermarked, never evidence

- **Watermark.** Every frame of a mock run carries a diagonal `MOCK` watermark and a band
  `MOCK · NOT EVIDENCE`. This holds in the live page (rendered frames draw it themselves and
  the page overlays it on every frame of a mock run) and in every exported frame. A run is
  **mock** when any of these holds: it is served from `renderedFrameSource` (provenance
  `rendered`); its episode or proof-bundle header has `simulated: true`; or it has no sealed
  run provenance (below).
- **Mock preview export.** A mock run exports only through `exportMockPreview`: a watermarked
  GIF **with no sidecar** and no digest. `myco clip verify` refuses any GIF without a sidecar
  (`CLIP_NO_SIDECAR`). The 90-second demo is mock throughout, so its clips are mock previews.
- **The evidence path refuses mock structurally.**
  - The evidence exporter takes only a `SealedTimeline`. That type is created only by
    `openSealedTimeline(vaultRoot, runId, keyFilePath)`, inside the clip module, and it has no
    public constructor. The function opens the run through the vault with
    `AUDIT_WITHOUT_RECEIPT`, and checks the seal, the capture hashes, the frames under
    `captured/frames/`, the timeline under `captured/frames/timeline.jsonl`, and a sealed
    `captured/run-provenance.json` (`myco.run-provenance/1`: `runId`, `transport` ∈ {`vm`,
    `linux-desktop`, `mock`}, `simulated`).
  - The harness writes the provenance file at capture. `transport` comes from the transport
    object's own constant (the mock transport's is `mock`), never from a caller option.
  - The exporter refuses `transport: "mock"`, `simulated: true`, a missing provenance file and
    any `rendered` frame (`CLIP_MOCK`).
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
  hashed.
- **Overlays come only from closed fields.** The band and the end card are rendered from the
  sidecar's closed fields, frame ordinals and the font's glyph set. There is no code path from a
  claim, a reason string, a file name or a window title to the renderer. The renderer takes a
  `BandFields` type built only from the closed sidecar (a type test pins this).
- **Frames go through the existing redaction.** Every source frame passes `servableFrame` /
  `sanitizePng` (`src/watch/sanitize-frame.ts`) before it is decoded for the clip. A refused
  frame refuses the export (`CLIP_FRAME_REFUSED`). It is never skipped silently.
- **The TIF-98 PNG redactor follow-up rules** (TO FILE on TIF-98, 21:52Z) apply to every
  exported frame.
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

### 2.8 Security model unchanged

Every row of the table in `docs/gate/watch.md` keeps holding, with its tests. Specifically:

- **No new listening interface.** One server, one socket, loopback by default. The same
  `--allow-non-loopback` rule. No second port, no websocket.
- **No write endpoint.** Every method other than GET still gets 405 before routing. The new
  routes are GET-only and read no body:
  - `GET /timeline/<listed runId>`: the joined timeline as closed fields;
  - `GET /clip/<listed runId>/<from>/<to>.gif` and `.myco.json`: the clip, generated in memory
    and sent with `Content-Disposition: attachment`. The browser's save dialog chooses the
    path. **The server writes no file.**

  Requests with `%`, `?`, `\` or dot segments still get 400. `<from>` and `<to>` are decimal
  frame ordinals checked against the listing.
- **Bounded work.** At most one clip render at a time (the next gets 503). Renders are bounded
  by the budget in [§2.9](#29-postable-budget), and a render over 30 s is aborted.
- **No remote fetch.** No route, renderer or font loads anything over the network. The page CSP
  stays `default-src 'none'`.
- **CLI export writes one path only.** `myco clip export --run <id> ... --out <path.gif>`
  writes `<path.gif>` and `<path>.myco.json` with `O_CREAT | O_EXCL` (an existing file is
  refused), and nothing else. Outside `--demo`, the watch command itself still writes no file.
- **Still no handle on the gate.** The clip module imports only read calls, the gate's
  reason-code list and id check, the vault's read path, and the #560 helper. The static
  import/write scan in `test/watch/server-security.test.ts` is extended to the new modules.

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
myco verify <runId> --task <taskId> --vault <vaultRoot> --vault-key-file <path>
            [--tasks <file> [--no-builtin]] [--decision-log <file>]
            [--transcript <file> --client codex|mcp-jsonrpc]
            [--episode <file>] [--ledger <attempts.jsonl>]
            [--out <bundle.json>] [--json]
myco verify <runId> --task <taskId> --recording <replayDir> --tasks <file> [same optional flags]
myco verify <runId> --task <taskId> --mock-evidence <evidenceRoot> [same optional flags]
```

- Exactly one source: `--vault` (a sealed gated run), `--recording` (a track R replay) or
  `--mock-evidence` (a harness-filled directory, the development path). Anything else is a usage
  error. Exit codes: **0 verified, 1 refuted, 2 uncertain, 3 usage**, the same as `myco-gate
  check` and `bin/myco`.
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
   - `--vault`: the run is opened through the vault with `AUDIT_WITHOUT_RECEIPT`. The MAC key
     is loaded at the point of use from `--vault-key-file`. The seal, the capture hashes and the
     sealed ground truth are checked exactly as the sealed reader checks them. Any integrity
     violation gives `uncertain` `STATE_UNREADABLE` plus `integrity:<code>` in `verifyCodes`.
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
3. **Recompute each recorded call.** With `--decision-log`, each line for this run is one
   recorded call. Its `request` (the agent's `taskId`, `runId`, `claim`, as the gate logged it)
   goes through `parseGateRequest` and the bound gate's assignment check, exactly as a live
   call would. A call naming another trial gets `ASSIGNMENT_MISMATCH`, and an extra field gets
   `UNKNOWN_FIELD` / `ORACLE_INPUT_REJECTED`. The decision log is the client-independent record
   of calls: `myco-gate` logs every call the same way, whichever MCP client made it, so this
   covers Claude Code, Codex, Cursor and a custom agent alike.
4. **Compare, never adopt.** Each post-capture logged decision is compared with the recompute
   (`loggedVerdictAgrees`). Mid-run "no sealed capture yet" lines are expected to be
   `uncertain` and are reported, not compared. A disagreement on a post-capture decision makes
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

**`VERIFY_CODES`** (closed): `VERIFY_LOG_DISAGREES`, `VERIFY_RECORDING_MISMATCH`,
`VERIFY_R5_FAILED`, `VERIFY_BUNDLE_REFUSED`, `VERIFY_TRANSCRIPT_REFUSED`,
`VERIFY_EPISODE_REFUSED`, `VERIFY_LEDGER_REFUSED`, plus `integrity:<code>` (the vault's own
codes).

### 3.3 Independence

- **The agent can never supply evidence or influence the oracle.** The agent-supplied surface
  is exactly `myco.gate/v1`'s `taskId`, `runId` and `claim`, as recorded in the decision log,
  or a recording's closed fields. The evidence is the host-side per-trial capture. The registry,
  assignment, fixture and ground truth come from the operator. No transcript field, recorded
  call or recording field reaches the oracle, the registry, the evidence reader or the request
  `myco verify` builds.
- **`myco verify` is an operator CLI, not an agent tool.** No MCP server exposes it, and
  `src/integrity/surface.ts` classifies no agent tool that can reach it or the vault key file.
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
| `test/integrity/isolation.test.ts` (TIF-266, R4) | Every tampering route that this test drives against the gate is driven against `myco verify --vault` too. Verify must never return `verified`, and each route must be caught by the same named check (`integrity:sealed-file-hash`, `integrity:seal-signature`, `integrity:captured-file-hash`, `integrity:oracle-source-hash`, `integrity:stop-signature`, …) |
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
| P1 | **Codex CLI** (`examples/mcp-clients/codex-transcript.md`; its verbatim `--json` events committed as a test fixture by the build PR) | `pnpm myco-gate demo --transport mock` evidence; `--mock-evidence`, the demo's decision log | `demo-df-s01`: `verified`, exit 0. `demo-df-s02`: `refuted`, exit 1, with the transcript's call 3 (ids `df-s01`/`demo-df-s01` against the `df-s02`/`demo-df-s02` assignment) recomputed as `ASSIGNMENT_MISMATCH`. `agentReported` agrees on all 3 calls. All `trust: "mock"`, `simulated: true` |
| P2 | **Claude Code MCP path** (`examples/mcp-clients/claude-code.mcp.json`'s launch line, driven as Claude Code drives it, `test/gate/mcp-server.test.ts`) | The mock demo's `myco-gate mcp` server with `--audit`; the decision log it writes | `demo-df-s01`: `verified`. `demo-df-s02`: `refuted`. Logged and recomputed verdicts agree on every call. This is a protocol-level stand-in: no Claude Code transcript is committed today. The real Claude Code transcript is P5 |
| P3 | **Raw JSON-RPC client** (`examples/mcp-clients/stdio-requests.jsonl`, `--client mcp-jsonrpc`) | Evidence for `run-42` built from the mock demo's `df-s01` store | `verified`, exit 0; `agentReported` agrees |
| P4 | **Track R recording** (`pnpm myco-record demo`) | The demo's two replays; `--recording` | honest: `verified`, `trust: "derived"`, `simulated: true`, exit 0. skip-save: `refuted`, exit 1 |
| P5 | **Live, after the trial run (VM):** Claude Code and Codex on the `myco-gate` arm, sealed vault | Every trial of the first live batch, `--vault` | For 100% of trials, verify's verdict equals the trial's post-capture gate decision in its audit log (`loggedVerdictAgrees: true`), and every bundle verifies. Any disagreement is a defect, not a result |

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
  interleavings checks the rule against a brute-force reference.
- **Refuted by:** any decision pinned to a different frame than the reference, or any pinning
  that changes when `checkedAt` values or frame mtimes are permuted.

#### RS-02. Gaps, duplicates, reorders and log edits invalidate the join (fail closed)

- **Probe:** `test/watch/timeline.test.ts` › "fail closed": one fixture per code in the
  [§2.2](#22-the-frame--decision-join) table (`TL_SCHEMA`, `TL_RUN`, `TL_GAP`, `TL_DUPLICATE`,
  `TL_FRAME_DIGEST`, `TL_ORDER`, `TL_LOG_AHEAD`, `TL_LOG_PREFIX`, `TL_MALFORMED`,
  `TL_CLOCK_SKEW`). Each must yield `{ joined: false, code }`, and the state served to the page
  must carry no pinned decision for that run.
- **Refuted by:** any fixture that yields a join, or a code other than its own.

#### RS-03. Clock skew never changes order

- **Probe:** `test/watch/timeline.test.ts` › "clock": the same log and manifest, with
  `checkedAt` shifted ±1 h, reversed, or set equal on all lines. Ordering and pinning stay the
  same; reversed `checkedAt` adds `TL_CLOCK_SKEW` (export refused).
- **Refuted by:** any ordering difference, or export allowed under reversed `checkedAt`.

#### RS-04. The scrubber replays the demo's false-done story frame by frame

- **Probe:** `test/watch/scrubber-e2e.test.ts`: starts `startWatchDemo({ family:
  "calc-multi-step" })` and reads `GET /timeline/ms-slip-then-repair-retry`. The test asserts
  the call 1 `refuted` (`ORACLE_FAIL`, `TARGET_MISMATCH`) pins to the frame after the first save,
  and the call 2 `verified` pins to the frame after the repair save. For `todo-items`, run
  `demo-df-s02`: call 1 `refuted`. A Playwright check (`--trace off`) drags the slider and reads
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

- **Probe:** `test/watch/clip-verify.test.ts` › "round trip": export from a test-built sealed
  vault run (`simulated: false`, `transport: "vm"` fixture), then `myco clip verify` exits 0 with
  `--decision-log` and with `--sealed-capture --timeline`. The sidecar's `runId`, `verdict`,
  `gate.apiVersion` and `digest` are present, and `headerDigest[0:16]` is read back from the
  band by re-rendering.
- **Refuted by:** a verified clip missing any of those fields, or a digest that does not
  recompute from the [§2.5](#25-the-clip-digest-and-myco-clip-verify) construction.

#### RS-07. Every listed tamper fails clip verification with its code

- **Probe:** `test/watch/clip-verify.test.ts` › "tamper": every row of the
  [§2.5](#25-the-clip-digest-and-myco-clip-verify) tamper table, each asserting exit 1 and its
  code.
- **Refuted by:** any tamper that exits 0, or a code other than its row's.

#### RS-08. Mock runs are watermarked MOCK on every frame, live and exported

- **Probe:** `test/watch/mock-watermark.test.ts`: every frame served for a demo run carries the
  watermark. Every frame of `exportMockPreview` for `demo-df-s02` and
  `ms-slip-then-repair-retry` has the watermark band equal to its reference render, pixel for
  pixel. A run with `simulated: true` in its episode is watermarked even with `file` frames.
- **Refuted by:** any frame of a mock run, served or exported, without the watermark.

#### RS-09. The evidence path refuses mock runs structurally

- **Probe:** `test/watch/clip-evidence-gate.test.ts`. `exportEvidenceClip` refuses each of
  these with `CLIP_MOCK`: a vault run whose provenance is `transport: "mock"`, one with
  `simulated: true`, one with no provenance file, and a `rendered` frame. A type test
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
  a fake hostname, `/Users/<name>/…`, `C:\Users\<name>\…`, a key-shaped token, and a window
  title carrying the fake name. No byte of the GIF, poster or sidecar contains any of them
  (raw-byte scan with the shared detector); ids carrying them are `h-<60hex>`; and an existing
  `h-<60hex>` value is kept, while `h-<64hex>` and `h-<59hex>` are re-hashed.
- **Refuted by:** any planted value recoverable from the output, a hashed id in any other
  `h-` form, or the module failing #560's routing test.

#### RS-11. Exported frames pass the TIF-98 redactor rules (OCR and raw bytes)

- **Probe:** `test/watch/clip-redactor.fuzz.test.ts`: the verifier fuzz from the TIF-98 TO
  FILE. Usernames, full names, hostnames, home paths and key-like strings are rendered into
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

#### RS-13. The watch security model is unchanged

- **Probe:** every existing case in `test/watch/server-security.test.ts`,
  `test/watch/round2.test.ts` and `test/watch/round3.test.ts` passes unchanged. The
  "every non-GET method × every route" matrix and the traversal corpus are extended to
  `/timeline/…` and `/clip/…`. The static import/write scan covers the new modules. The tree
  snapshot before and after shows no file changed by serving, polling or clip download. One
  listening socket only (`server.address()` count, and no other `listen` in `src/watch/`).
- **Refuted by:** any existing case changed or failing, any non-GET accepted on a new route, a
  file written by the server, or a second listener.

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

### Verify any agent (VA)

#### VA-01. The CLI is exactly as specified

- **Probe:** `test/verify-run/cli.test.ts`: the three source forms parse. Two sources, no
  source, an unsafe id, an unknown flag, `--client cursor`, and `--out` onto an existing file
  are each exit 3. The exit code is 0, 1 or 2 by verdict. stdout is valid `myco.verify/1` with
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

#### VA-05. The existing integrity suites cover `myco verify`

- **Probe:** the extensions in [§3.5](#35-test-suites-the-new-entry-point-must-join) to
  `test/integrity/isolation.test.ts`, `test/integrity/surface.test.ts`,
  `test/gate/caller-isolation.test.ts` and `test/gate/input-fuzz.test.ts`, each driving verify
  from the suite's own route table.
- **Refuted by:** any route that verifies, any route caught by a different check than for the
  gate, or verify absent from a suite's table.

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
  `process.env` key and has no `--vault-key` (value) flag.
- **Refuted by:** any key or key-path byte in any output, or a key accepted by value.

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
| B1 | Timeline manifest (`myco.watch-timeline/1`), the shared line-count and prefix function, the joiner (`src/watch/timeline.ts`), and the mock demo keeping its timeline in memory | RS-01, RS-02, RS-03 | 2 | No VM | none | Revert `src/watch/timeline.ts` and the demo change: `test/watch/timeline.test.ts` fails |
| B2 | Scrubber: `GET /timeline/<run>`, page slider, decision jumps; security matrix extended | RS-04, RS-13 | 2 | No VM | B1 | Revert the route and page: `test/watch/scrubber-e2e.test.ts` and the extended matrix fail |
| B3 | Side by side: `--pair`, pair checks against episodes and ledger, align by decision | RS-05 | 2 | No VM | B2 | Revert the pair code: `test/watch/pair.test.ts` fails |
| B4 | Clip core: bitmap font, band renderer from `BandFields`, deterministic GIF encoder with reserved palette, sidecar, digest, `myco clip verify` (in-memory export only; nothing written) | RS-06, RS-07, RS-12 | 2 | No VM | B1 | Revert `src/watch/clip/`: `test/watch/clip-verify.test.ts` and `test/watch/clip-band.test.ts` fail |
| B5 | Mock preview export: the watermark on live and exported frames, `exportMockPreview`, `GET /clip/...` for mock runs, `myco clip export` writing one path, budget | RS-08, RS-14, RS-15 | 2 | No VM | B4 | Revert the export code: `test/watch/mock-watermark.test.ts`, `test/watch/clip-cli.test.ts` and `test/watch/clip-budget.test.ts` fail |
| B6 | Evidence export: `myco.run-provenance/1` written by the gated harness at capture, `openSealedTimeline`, `exportEvidenceClip`, sidecar through #560's helper, leak guard, OCR backstop, GIF/PNG structure scrub | RS-09, RS-10, RS-11 | 2 | No VM | B5, #560, #562 (h-form parity), the TIF-98 PNG redactor follow-up | Revert the evidence export and provenance writer: `test/watch/clip-evidence-gate.test.ts`, `test/watch/clip-privacy.test.ts` and `test/watch/clip-redactor.fuzz.test.ts` fail |
| V1 | `myco verify` core: CLI, the three sources, a bound gate over host evidence, decision-log call recompute, `myco.verify/1`, key at point of use; suite extensions for integrity, R5 and faults | VA-01, VA-02, VA-03, VA-04, VA-05, VA-06, VA-07, VA-09, VA-12 | 2 | No VM | none | Revert `src/verify-run/` and the `bin/myco` entry: every `test/verify-run/*` probe and every suite extension fails |
| V2 | Transcript adapters (`codex`, `mcp-jsonrpc`) and fixtures, `agentReported` | VA-03, VA-10 (P1, P3) | 2 | No VM | V1 | Revert the adapters: `test/verify-run/proofs.test.ts` P1 and P3 and the transcript cases of `test/verify-run/independence.test.ts` fail |
| V3 | Recording source (track R): pinned workflow, R5 before verify, derived trust | VA-08, VA-10 (P4) | 2 | No VM | V1 | Revert the recording source: `test/verify-run/recording-tamper.test.ts` and P4 fail |
| V4 | Proof bundle emission through #562 | VA-11, VA-10 (P2) | 2 | No VM | V1, #562 | Revert the bundle code: `test/verify-run/bundle.test.ts` fails |
| L1 | Live proof after the trial run: P5 on the first live batch, and the first real caught false-done clip exported and verified | VA-10 (P5), RS-06 (on a real run) | 2 | VM | the trial run, B6, V4 | Not a code PR: the verifier re-runs `myco verify` and `myco clip verify` on the committed batch and checks every row |

**Order and parallelism.** B1 and V1 can start at once, without a VM: they share nothing. B2, B4
and V2, V3 follow their parents. B6 and V4 wait for #560 and #562 to merge. L1 is last, after
the trial run, and never takes VM time the trial run or the integrity fixes need.

---

## 6. Dependencies on unmerged PRs

| PR | State today | What depends on it | Until it merges |
|---|---|---|---|
| #560 (shared leak guard, allowlist serialization helper; draft) | open, draft | B6: the sidecar must be written through its helper and pass its routing test | B6 does not start. B1–B5 write no evidence export; the mock preview has no sidecar |
| #562 (Q3 proof bundles, identity-safe) | open | V4: the bundle format, `verifyProofBundle`, the identity guard; B6: `h-<60hex>` parity with the Q-bundle surface | V1–V3 emit no bundle (`bundle: null`). The Q-bundle publication hold applies to verify bundles too: none is published, committed as data or attached anywhere until the hold lifts |
| #566 (episode export allowlist + identity + F1) | open | B3 and V1 read episodes; an *exported* episode is accepted as input only after #566 | Inputs are episodes from the store (`src/episode/store.ts`), validated by `validateEpisode` |
| #559 (track U dataset export) | open | The `h-<60hex>` format is accepted on condition that #559's round-2 verifier confirms it is a truncated SHA-256 carrying no input text (23:06Z) | B6 does not ship before that confirmation |
| #550 (xlsx gate) | open | Verify supports exactly the gate's families; xlsx-backed Calc tasks need #550 | `myco verify` on an xlsx task is `uncertain` (the family is not in the registry), never guessed |

The TIF-98 PNG redactor follow-up (TO FILE on TIF-98, 21:52Z; not yet a PR) is a dependency of
B6 as well. Its fuzz is RS-11's probe.

---

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
2. **Who holds the vault key for `myco verify --vault`.** Proposal: verify runs on the operator
   host and loads the key from a file path at the point of use (VA-12). The alternative is an
   offline audit with no key, which would skip the seal-signature check, so it is not proposed.
3. **Oracle family and version on the band.** They are operator strings that the live page
   leaves out today. Proposal: show them on the band through the `id` treatment (hashed when
   they are not a closed id or when they carry an identity), so the clip states which rule
   decided.
