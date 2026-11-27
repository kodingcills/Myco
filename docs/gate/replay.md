# Replay: the frame and decision timeline

The replay features (spec [demo-replay-and-verify-any-agent.md](../product/demo-replay-and-verify-any-agent.md),
issue #666) step through a recorded run frame by frame, with each gate decision pinned to the
frame it was made on. This page covers the join they all share, `src/watch/timeline.ts`
(build PR B1). The scrubber, the clip export and `myco verify` build on it in later PRs.

## The timeline manifest

The trusted harness that captures frames also writes one `myco.watch-timeline/1` line per
frame to `timeline.jsonl`, next to the frames:

```json
{"schema":"myco.watch-timeline/1","runId":"run-42","frame":7,"frameSha256":"…",
 "logBefore":{"lines":3,"prefixSha256":"…"},"logAfter":{"lines":3,"prefixSha256":"…"}}
```

`logBefore` and `logAfter` describe the run's own decision log just before and just after the
capture: how many complete, non-blank lines it had (`lines`), and the sha256 of its bytes up to
and including the newline of that last line (`prefixSha256`). The recorder and the joiner
compute both with the same function (`currentAnchor`, `logAnchors`).

## The join rule

A decision is pinned to the last frame whose capture finished before its line was in the log:

> pinned(d) = the largest `frame` with `logAfter.lines < d`

There is no clock. `checkedAt`, file names, mtimes and the host clock are never join keys. A
frame captured while a line landed (it straddles the line) is never "before" it. A decision
with no frame before it is unpinned.

## Attribution

The log is the audit log of the one gate bound to the trial. Every line is that trial's call,
never attributed by the agent's `request.runId`. The binding is checked (`bindingHolds`): every
evidence ref must name the bound run, and a line naming another trial must have the exact shape
of a rejection the gate made before reading evidence. A log shared by several gates fails this
check.

## Fail closed

Any inconsistency invalidates the join for the run, and the caller shows frames and decisions
unjoined. The join reports the first failing code: `TL_SCHEMA`, `TL_RUN`, `TL_GAP`,
`TL_DUPLICATE`, `TL_FRAME_DIGEST`, `TL_ORDER`, `TL_LOG_AHEAD`, `TL_LOG_PREFIX`,
`TL_LOG_BINDING`, `TL_MALFORMED`, `TL_CLOCK_SKEW`, then `TL_NO_TIMELINE` when there is no
manifest. A manifest that is a symlink or not a regular file is never followed.

The module is read-only. It hashes with `node:crypto` and reads files `O_RDONLY | O_NOFOLLOW`.
It has no write call, no process spawn, no network call and no vault or key import.

Not evidence: a replay shows what the gate logged. It never computes a rate or an R1 number.

## The scrubber (`myco watch`, build PR B2)

```
myco watch --run <runId> --task <taskId> --decision-log <file> --frames <dir>
myco watch --run <a> --run <b> --task <taskId> \
           --decision-log <a>=<fileA> --decision-log <b>=<fileB> --frames <dir>
```

A recorded run directory holds the run's PNG frames and its `timeline.jsonl` in
`<dir>/<runId>/` (`--sealed-capture <vaultRoot>`: `captured/frames/` under the run). The page's
slider steps frame by frame, and the decision buttons jump to the previous or next frame that
holds a pinned decision. At each frame the page shows the latest decision pinned at or before
it, and marks a frame captured while a decision landed. The page takes every pin from
`GET /timeline/<runId>` and never guesses one. When the join is invalid, it shows the code and
pins nothing.

A run's own log is required: `--decision-log <runId>=<file>` per run, or a plain
`--decision-log` when exactly one run is listed. The task the run's gate was bound to is the
one `--task` given. With no single task the join is refused (`TL_LOG_BINDING`).

Everything stays read-only. `/timeline` is GET only, takes only a listed run id, and writes
nothing.

## MOCK watermark

Every frame of a mock run carries a diagonal `MOCK` and the band `MOCK · NOT EVIDENCE`, both on
the live page and in every frame the demo renders. It is machine-marked as well: `mock: true`
in `/timeline`, `X-Myco-Mock: 1` on every frame response, and the run is absent from the
state's `realRuns`. Mock is decided by where a run came from (`src/watch/run-trust.ts`), never
by a flag. Only a verified real-run record removes the watermark. Records are registered by
the module that issues them, and nothing in this stack issues one yet: it will be the
sealed-capture opener (build PR B6, receipt-bound). Until then every run is mock, and a
hand-built record of the same shape is refused.
