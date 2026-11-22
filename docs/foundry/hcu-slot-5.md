# TIF-58 HCU GUI adapter handoff

Slot 5 follows the C1 spike and sweep, then M1-016 live reproduction. The run
requires explicit Coordinator GO. The spend cap is $0.

## Adapter boundary

- Use Microsoft HCU's MCP GUI tool for screenshot observations and pointer and
  keyboard actions. Expose only GUI to the planner. Keep AX, shell, file tools,
  grader evidence, and persisted workbook access outside that interface.
- Capture each GUI request and result, including rejected actions and whether
  input was emitted. After a stale-layout rejection, take a fresh screenshot
  before replanning. Count actions against the same budget as C1 under the
  baseline contract, including actions batched into one tool call.
- Record stop reason, planner claim, elapsed time and measured usage. The host
  calls the shared blind Calc judge on independently captured workbook evidence.
  Preserve unknown verdicts and unavailable measurements. A driver acknowledgement
  or planner claim contributes no verification credit.
- Use `subArm: "hcu"` in the shared evidence row and call the existing blind
  judge. The C1/C2 sweep and purity checker still take only Cua arms.
  Bind the evidence to the v3 trial ID,
  parameter-list hash, exact fixture hash, snapshot and reset identifiers, judge
  version, HCU revision and bundle hash, and planner model and settings.

Sources: [HCU README](https://github.com/microsoft/Hybrid-Computer-Use),
[M1 baseline contract](../baseline/screenshot-agent.md).

## Readiness blockers

| Blocker | Evidence needed |
|---|---|
| Windows ARM64 bundle | Pin a source revision, obtain or build the ARM64 package, and record its hash. The upstream build script explicitly accepts ARM64 and defaults to AMD64. Guest compatibility remains untested. |
| Planner and spend | Confirm access to the pinned Claude Sonnet 5.5 model and C1 settings within the $0 cap. Pause on quota or unavailable access. |
| Live adapter | Wire and test the GUI-only transport against scripted responses before GO. Cover screenshots, rejected actions, recorder output, budget and pause handling. After GO, confirm a screenshot and reversible input on an approved new snapshot. |
| Paired inputs and judge | Obtain the finalized v3 manifest, C1 evidence index, and Coordinator-approved restore and judge identifiers. Use the same fixture bytes in order and keep missing C1 rows visible. |

Source: [upstream Windows build script](https://github.com/microsoft/Hybrid-Computer-Use/blob/main/computer-use/native/windows/build.ps1).

## Offline acceptance checks

Use scripted MCP responses and synthetic trial IDs. A harness owner can complete
these checks without starting the guest or calling the planner.

1. Advertise only GUI even when the server lists both GUI and AX. Verify that
   the planner-facing response contains screenshot evidence and tool status.
2. Feed a stale-layout rejection and verify that the next observation is a
   fresh screenshot before any further planned input. Preserve the rejection
   and its input-emitted flag in the recorder.
3. Feed a batch larger than the remaining C1 action budget and verify that it
   sends no input. Simulate quota exhaustion and verify that the row is paused
   with its original model and settings and that the next trial stays pending.
4. Use fixtures for matching durable state, mismatching durable state, and
   missing readback. Confirm the shared judge yields verified, refuted, and
   uncertain respectively, even if the planner claims success in all three.
5. Join synthetic rows by v3 trial ID and fixture hash. Preserve missing rows,
   reject duplicate IDs and mismatched hashes, and retain the HCU arm label.

These checks are acceptance criteria for the adapter implementation. No live
adapter or guest smoke result has been validated yet.

## Frozen input preflight

The SHA-256 checks on `/tmp/m1-013/sweep-v3/params.json` and
`fingerprints.json` matched the Coordinator's frozen values. All 30 rows in
`src/baseline/sweep-v3.json` joined in order to the v3 trial records on index,
parameters, run ID and verdict. The six seed fingerprints matched every
recorded fixture hash, and all 30 recorded result-file hashes matched. This
checks the frozen evidence and recorded fixture fingerprints. Compare the
actual staged workbook against the frozen fixture evidence before a live trial.

The v3 scorecard records 30 trials and zero omissions. The invalidated C1
ledger reports indices 0 and 1 as driver-unreachable and 2 as interrupted.
The other 27 indices have no rows in that ledger. Keep these distinct from
omissions in a finalized C1 run. No finalized C1 report was present in the
local baseline output directories checked.

The 30 normal Calc trials are descriptive for Discovery. EF myco-todo tasks and
hidden pairs require separate validated deployment and authorized slots.
