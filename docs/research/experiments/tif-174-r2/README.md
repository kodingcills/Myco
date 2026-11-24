# TIF-174 R2 — the five items verified at the merged commit

**2026-11-24, by the M1 coordinator.** The R2 delegate was dispatched and exited without a
verdict, so these were established directly rather than left unchecked. **This is my own
work, not an independent check** — if the independence matters, R2 still needs a child that
reports.

The fix is on `main` as `f342eb7b` (#370).

## 1. The fix is real, both directions

```
with the fix   ->  gap, rc 1
fix reverted   ->  pass, rc 0
```

`cleanup()`'s return was discarded at the success path, so a failed `destroy` left
`bucket = "success"` reachable with the guest allocated. Now routed to `gap("REQ-01", ...)`.

## 2. Case 3b genuinely reaches the success path and genuinely fails on revert

This was the item most likely to be wrong, because the author's FIRST attempt used a
`NeverReady` probe that gaps at the readiness gate — so the assertion passed with the fix
removed. Reverted, the shipped case fails with all three assertions naming the defect:

```
FAIL a run whose session was never freed is NOT a pass (got pass)
FAIL a leaked session on the success path lands in gap (got pass)
FAIL and it exits non-zero (got 0)
```

**It can fail, and it fails for the right reason.**

## 3. The test seam is narrow and raises

`STUB_TEARDOWN_FAIL` is set per `Harness` instance (`self.env`), so no other case can be
affected, and the stub answers with `text(..., err=True)` — a real MCP error the runner
treats as failure, not a silent no-op.

## 4. REQ-01 is the defensible attribution

```
REQ-01  Create: provision a session on demand; return a session handle.
```

The runner already uses `REQ-01` for `create failed` (`df005-runner.py:568`). A teardown that
fails to free the session is the same lifecycle, so the attribution holds. **REQ-05 is about
emitted evidence artifacts and would have been wrong.**

## 5. No regression

| suite | with binary | without |
|---|---|---|
| `test/df005-postcreate-gate.py` | rc 0, 2s | — |
| `test/df005-runner-offline.py` | rc 0, 114s | rc 0, 12s |

Assertion counts grew (24 -> 26 and 153 -> 156), both above the vitest wrapper's floors.

## What R2 did NOT cover

**No adversarial check of the new seam** — e.g. whether `STUB_TEARDOWN_FAIL=reset` produces
the same outcome (it should: a reset failure alone is NOT a leak per `cleanup`'s contract,
so that case should still pass, which would be worth asserting). An independent round would
be the right place to try that.
