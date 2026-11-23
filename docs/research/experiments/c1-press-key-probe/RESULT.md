# Cua press_key probe — result (2026-11-23)

The question arm-002 left open: **does Cua refuse the Ctrl+S key, or deliver it and
the app blocks the save?** Zero `press_key` calls across 422 actions meant the
baseline never learned which.

Probed on a live `cua-c1-base` guest: LibreOffice Calc pid 3152, window_id 328170,
window class `SALFRAME`, launched into Session 1 via `run-interactive.ps1`.

## Answer: neither of the two hypotheses. It is a delivery-mode gap.

**Background delivery is refused for ANY `key_combo` on a `SALFRAME` window.**

`press_key Ctrl+s`, background (the mode C1 uses):

```json
{ "isError": true,
  "structuredContent": {
    "code": "background_unavailable",
    "effect": "refused",
    "event_kind": "key_combo",
    "target_class": "SALFRAME",
    "escalation": { "recommended": "foreground",
      "reason": "background input is dropped by this surface" } } }
```

**The key is irrelevant.** `press_key Ctrl+F12`, which has no save meaning
anywhere, returns a byte-identical refusal with the same `code`, `effect`,
`event_kind`, and `target_class`. So this was never about Ctrl+S, and no amount of
save-dialog wrestling in C1 would have helped.

**Foreground delivery is accepted — and the key really is delivered.**

Retrying with `delivery_mode:"foreground"`, as Cua's own escalation recommends:

```json
{ "isError": true,
  "structuredContent": {
    "code": "tool_invocation_failed",
    "foreground_restored": false },
  "text": "input_delivery_stalled: Windows did not confirm that the target read
           the key delivery input within 2000 ms. It was inserted and may still
           appear in the target." }
```

That stall message is ambiguous on its own — "may still appear" is not evidence.
**It is settled by the window list taken immediately after:

```
"Save As" | "Untitled 1 — LibreOffice Calc" | "Program Manager"
```

A **Save As dialog appeared.** Calc received the key and acted on it. So:

| Path | Outcome |
|---|---|
| background `key_combo` | refused, before the app is reached — **not** a save failure |
| foreground `key_combo` | delivered; Calc opens Save As; the DRIVER then reports a 2000 ms confirmation stall |

## What this means

1. **arm-003c's `cua-action-refused` was a harness finding, not a model failure.**
   The refusal came from the delivery layer, and it would have hit every
   `press_key` the planner ever attempted. Scoring it as C1 failing to save would
   have been wrong.
2. **`refused` conflates two different things.** `C1.execute` (c1.ts:91) returns
   `refused: result.isError === true || effect === "refused"` — a *routing* refusal
   and a *save* failure are the same value to every caller. They are not the same
   event, and the raw response is the only place they are distinguishable.
3. **A fix exists and is cheap**: pass `delivery_mode:"foreground"` for
   `key_combo` on this window class. It works. It costs the window coming forward
   and a possible 2000 ms stall, which the driver reports but does not retry.
4. **The stall needs its own decision.** `foreground_restored: false` means the
   target stays in front, and Cua says "inspect the target before repeating".
   Whether C1 should retry, wait, or read the dialog is a design choice for the
   save path — and it must not be silently retried, or one save becomes two.

## Dismissing the modal, and a tooling trap worth recording

Escape dismissed it: `effect: "unverifiable"` — "The key was sent but its effect is
not confirmed" — and the window list then showed Save As gone. That is the honest
verdict for a dismissal, and it is a third distinct outcome from `refused` and
from `delivered`.

Trap: `cua-driver.exe call <tool>` must be given its JSON **over stdin**, and the
binary path must be **unquoted** in the ssh command. Both halves matter:

- As an argument, PowerShell 5.1 strips the quotes around JSON field names; the
  driver says so itself and names stdin as the fix.
- Quoting the path (`"C:\myco\bin\cua-driver.exe" call ...`) makes PowerShell eat
  the whole thing as an expression, and the failure mode is an empty window list —
  not an error. A probe that trusted that empty list would have concluded "no
  dialog open" and been wrong.

## Method note

`get_window_state` must be read **before** any pixel action on a window; acting
first returns `screenshot_context_missing: window_never_read`. The first probe run
hit this on its control click, which is how the ordering requirement was found.
