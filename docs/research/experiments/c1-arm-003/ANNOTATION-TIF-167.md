# arm-003c annotation (TIF-167, 2026-11-23)

**This file annotates an existing record without editing it.** `c1-arm-003-run-plan.md`
and the surviving arm-003c notes are unchanged: recorded evidence does not get
rewritten because a later finding changes how it should be read. The correction
lives here, next to the record.

## What the record says, and what it means

arm-003c's surviving note reports that its save attempt returned
`cua-action-refused`.

**That was a ROUTING refusal, not a model failure.** The distinction was invisible
at the time because `C1.execute` returned a single `refused` boolean built from
`result.isError === true || effect === "refused"`, which collapsed the delivery
layer declining an input with the model failing at the task.

The probe run on a live guest on 2026-11-23 settled which it was:

- **Background `key_combo` on a LibreOffice `SALFRAME` window is refused by Cua's
  delivery layer** with `code=background_unavailable`, before the application is
  reached at all.
- **It is not about the key.** `Ctrl+F12`, which has no save meaning anywhere, is
  refused identically (same `code`, `effect`, `event_kind`, `target_class`).
- **Foreground delivery is accepted** and the key genuinely arrives — after the
  retry a Save As dialog appeared.

Evidence: `docs/research/experiments/c1-press-key-probe/RESULT.md`.

## Consequences

**The save never failed, because it was never attempted.** No `press_key` could
have been delivered in background mode, which also explains why arm-002 recorded
zero `press_key` calls across 422 actions — that was never a planner that forgot
to save.

**A reader must not carry away "C1 failed to save" from arm-003c.** The refusal
was infrastructure answering, and the same refusal would have hit every
`press_key` the planner ever sent.

**Nothing is re-scored.** The two rows arm-003c produced were lost with `/tmp`, and
the run is already classified as an infrastructure abort. There is no score to
correct; the point is only that the remaining artifact not be misread.

**arm-002 is unaffected.** Its rows are `refuted/modified` on their own terms, and
no `press_key` is among them.

## The run condition this sets for arm-003d

`key_combo` actions are attempted in background mode first and escalate **once** to
`delivery_mode: "foreground"` when Cua answers with a background refusal. Every
action's delivery mode is recorded in the transcript (`Transcript.deliveries`), and
arm-003d declares escalation as a run condition rather than hiding it — a row
produced with foreground delivery is not the same measurement as one produced
entirely in background.

Only a genuine save failure counts against the model; a routing refusal, a
delivered action, and a stalled confirmation do not.

### Run condition, stated for the record (arm-003d)

**A `Transcript.deliveries` entry is written for EVERY action, save steps
included**, carrying `step`, `mode`, `escalated`, and `outcome`. This is the arm
condition, not incidental telemetry: a row produced with foreground delivery is
not the same measurement as one produced entirely in background, and the
difference is invisible unless it is recorded per action.

**Escalation is declared, not hidden.** `key_combo` attempts background first and
escalates **once** to `delivery_mode: "foreground"` on a background refusal. Any
row where a save escalated is therefore labelled as such.

**Read a save's success from the judge, never from the transport.** `delivered`
means the input landed and says nothing about whether the document changed, which
is why `save-failed` is a reserved name that `classify` cannot produce. The model
outcome is the judge's `modified`, per row.

**The comparison axis is arm-002's 16 `modified` rows**, each already carrying
"Document left open, unsaved (`c1-judge.ts:32`)". arm-003d's save rows must stay
comparable to those, which is why the vocabulary is not being changed to fuse the
transport and document layers.

## Note for the arm-003d operator (TIF-169)

**Check duplicate stalls BY HAND in this arm.** A `Ctrl+S` that stalls and is then
sent again by the planner appears in the raw `deliveries` list as **two
`delivered-stalled` records for the same key** — which is the useful signal, but
nothing names it as a duplicate yet. Comparing the deliveries list against the
action list shows it: two consecutive stalls whose actions have the same
signature means the app may have been asked to save twice.

**TIF-169 adds `cua-action-N-resent-after-stall`** to flag exactly that case
automatically. It is not in this arm because it landed after the round-3 freeze,
and it does not change what the arm measures — only how loudly a duplicate is
reported. A run without the flag is not invalid; it just needs the manual check.

**What the arm does NOT need to worry about:** `TIF-169`'s other change makes
`verified` always a boolean. Before it, a `delivered` action could report no
verification flag at all. That affects how a row is *read*, not what the arm
*records* — the raw response is in the transcript either way.
