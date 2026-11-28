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
