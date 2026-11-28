# M1-014 Calc cold-start timeouts

- Corrupted-suite trial 2 (`dropped-save`) timed out on the first `nametype` to A1 after
  30 seconds. It never reached the fault. The trial took 208 seconds, mostly in cold startup.
- Normal sweep trial 3 took 94 seconds to convert the CSV headlessly after restore. After
  launching Calc, the 30-second UNO readiness poll expired on socket 2002, with a
  15-second agent RPC timeout. Host load was 7–11 during these runs.

The failures occurred before either trial reached its intended edit or corruption. The
first UI action starts a fresh LibreOffice Python process, imports `uiautomation` and
`comtypes`, and searches the UIA tree through the MSAA proxy. A loaded guest can also
display the Calc frame before UNO can read a fixture cell. The measurements identify the
timeouts. They leave the cost of each startup phase unmeasured.

The helper result and UNO readiness poll now each get 90 seconds. The fixture convert still
gets 240 seconds. The trial report and batch JSONL expose `timings.helpers` and
`timings.unoReady` for each attempt. The helper's `elapsedMs` starts at Python script entry
and is null if no elapsed time was reported. Its host `durationMs` includes launch and
result polling. The UNO duration covers the host readiness poll.

## Watchdog budget

The table rounds up the configured waits on the normal path. It includes the tunnel's
15-second per-call timeout, one in-flight RPC after each polling deadline, and retries for
transient UNO disposal. Reset and deploy run before the trial alarm.

| Normal trial stage | Budget (s) |
|---|---:|
| Tunnel startup and shutdown, two pings | 43 |
| Guest health probe | 66 |
| Fixture upload, launch and convert poll | 286 |
| Calc launch, helper focus and UNO readiness | 272 |
| Four helper actions, including their launch RPCs | 482 |
| Initial and four post-action observations, three UNO calls each with up to three attempts per call | 693 |
| Save settling and trailing UNO retries | 67 |
| Verifier UNO checks and persisted readback | 121 |
| Cleanup kills and up to two cleanup scripts | 161 |
| Sum of every configured ceiling (stages cannot all co-occur) | 2,191 |

Even with prompt RPC responses, conversion (240 s), focus and readiness (180 s) and
four helper actions (360 s) can already total 780 seconds. The 2,191 s sum is NOT a reachable worst case: the first helper or UNO-readiness deadline
fails the step and ends the program, so at most one wait can expire. A pessimistic
slow-but-passing path is about 1,170 s (convert 240 + focus 90 + UNO 90 + four helpers 360,
plus tunnel and health ~110, verify ~120, cleanup ~160). Observed trial maxima are 129.6 s
(sweep v2), 204.7 s (sweep v3) and 207.8 s (corrupted v1). The sweep alarm therefore moves
from 600 to 1,500 seconds, about 7× the observed maximum, so a hung trial costs at most
25 minutes. It now signals the Node process directly.

The corrupted suite's alarm also moves from 900 to 1,500 seconds. A kill recovery can consume up to 1,170
seconds in configured polls alone (240 s conversion, 360 s across two launches, 450 s for
the five action helpers, and 120 s for verification and audit readbacks). An exhausted
watchdog can leave no report. The combined audit retains that recorded gap and requires
eligible coverage from other trials. Explicit fixture identity mismatches still fail.

**Updated by TIF-219 (2026-11-24):** the convert deadline is now 360 s, not 240 s. The
normal sweep's slow-but-passing path becomes ~1,290 s all-in (alarm 1,500 s). The corrupted
suite's kill recovery becomes 1,290 s of polls, ~1,560 s with tunnel/health and cleanup, so
its alarm moves to 1,800 s. The 240 s figures above are the historical M1-014 values.

**UNVERIFIED on real Calc:** the revised timeouts, the timing fields, and whether the
supplemental batches close live coverage gaps. Host-only tests use synthetic evidence.

## Kill acknowledgement

The coordinator reported that corrupted-suite index 4 (kill with recovery) produced a
verified verdict with the expected disk value and no landed fault. The program dispatches
Open, Locate, Set, then Ctrl+S. The kill counter counts dispatched actions in both modes,
so action 3 was Set. The old log line showed a kill request. The adapter treated an empty
acknowledgement or RPC error as permission to continue to the edit observation and save.
The saved row cannot distinguish those two acknowledgement failures. Both modes now stop
before saving if the agent cannot confirm termination. After confirmation, the save can
run on the recovery path. This behavior is **UNVERIFIED** on real Calc.
