# C1 save parity — pre-mortem (TIF, filed by the outer loop)

## GOAL

Give the C1 arm the same save capability M1 has, so its refutation rate is
comparable to M1's. Until this lands, arm-003's numbers are not usable.

## HYPOTHESIS, with evidence

**The C1 arm cannot complete a save on a converted `.xlsx`, and the reason is a
missing capability, not a policy applied to both arms.**

Evidence, gathered off-VM before writing any code:

1. **M1 does not send a raw Ctrl+S.** `calc-record-edit.ts:163` declares
   `{ kind: "keyPress", keys: "ctrl+s" }`, but `calc-adapter.ts:429` intercepts it:
   `action.keys === "ctrl+s" ? await this.#runHelper({ op: "save", ... }) : ...`.
2. **The `save` op answers the format dialog.** `HELPER_SOURCE` in
   `calc-adapter.ts:225-245` brings the frame forward, sends `{Ctrl}s`, then loops
   up to 20 times looking for a `ButtonControl` whose name starts with
   `"Use Excel"` and clicks it. That button is the *"Non-standard file format"*
   dialog a CSV-converted `.xlsx` raises on first save.
3. **C1 has no equivalent.** `grep press_key src/win/calc-adapter.ts` returns
   nothing — M1 never uses that route. C1's `press_key` sends a raw combo through
   Cua (`c1.ts:93`).
4. **Observed once, on the only attempt ever made.** arm-003c row 0 typed the
   correct value at `(160,262)` then `press_key Ctrl+s`, which came back
   `cua-action-refused`. Counts: arm-002 `press_key`=0, `refused`=0; arm-003c
   `press_key`=1, `refused`=1.
5. **Not the allowlist.** `c1.ts:38` accepts `Ctrl+s` — the grammar
   `/^[a-z0-9+_-]{1,32}$/i` has the `i` flag. The refusal is the guest's own
   response (`c1.ts:98`).

## The architectural constraint, and it shapes the fix

C1 does **not** have an `AgentClient`. `c1.ts` talks only to Cua's MCP
(`clientInfo: "myco-c1"`). The `save` helper op runs over the Myco agent
(`launch` a `python.exe` helper + `readFile` its result), a different transport.

**But the caller already holds one.** `c1-spike.ts:122` and `c1-sweep.ts` open an
`AgentClient` over the SSH tunnel and pass it to `independentC1Judge`
(`c1-judge.ts:11` takes `AgentClient`). So the capability exists in the process —
it is simply not reachable from the trial's execute path, because `PreparedC1`
(`c1-trial.ts:20-31`) exposes only `connect`/`closeTransport`/`judge`/`audit`.

**The fix is therefore plumbing plus one call, not new transport.**

## Chosen approach

Add a `save()` capability to `PreparedC1`, implemented by the caller that already
has the `AgentClient`, and have C1's `press_key` with a save key route through it —
so both arms perform the same *operation* even though they reach it by different
transports.

Deliberately **not** chosen: teaching C1 to click the dialog by pixels. That would
be a different operation from M1's (dialog-button-hunting by screenshot vs a
deterministic control-name match), and it would make the comparison depend on the
baseline's ability to find a button it was never told about.

## Pre-mortem — the four ways this fails

| Failure | Signature | Response |
|---|---|---|
| **Plumbing leaks the client into the trial's scoring path** | C1 can now call agent ops generally, not just save | expose exactly one narrow method (`save()`), not the client. The harness must not gain a general agent channel mid-trial |
| **The save succeeds but the judge still sees `modified`** | `save()` returns ok, verdict unchanged | the save is asynchronous (`calc-adapter.ts` polls until `!isModified`); C1 must wait for the same settle, or it will read a dirty doc |
| **Parity claim becomes unfalsifiable** | both arms "save" via different code with no test tying them | a test that fails when the C1 save route is removed, and a parity test asserting both arms' save semantics agree |
| **The fix changes arm-002's recorded evidence** | the 29 rows were produced under the old path | arm-002 is *recorded, not scored*; its rows must remain byte-identical. Any change to them means the fix touched evidence rather than capability |

## Test that fails with the fix reverted

`test/baseline/save-parity.test.ts`:

1. A `PreparedC1` whose `save()` is a spy → a `press_key` action with a save key
   **must** call it, and **must not** be sent to the Cua transport as a raw combo.
2. Reverting the route (sending `press_key` straight to Cua) makes (1) fail.
3. Both arms' save semantics agree: the M1 program still contains `isSave: true`
   and the C1 route still performs a save, asserted from the same test so one
   cannot drift from the other.

## Acceptance

- C1's save goes through the same dialog-answering semantics as M1's.
- The test above fails with the route reverted, and passes with it.
- `PreparedC1` gains one narrow method; no general agent handle is exposed.
- arm-002's 29 recorded rows are byte-identical after the change.
- Instruction parity is unchanged: both arms are already told to save
  (`taskText()`), and both now can.
