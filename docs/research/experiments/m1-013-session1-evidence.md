# M1-013 / TIF-17 — End-to-end evidence regenerated on the session-1 agent

Date: 2026-11-19. Agent: PR #14 deploy (LO bundled Python + `run-interactive.ps1` →
interactive session). All earlier M1-013 evidence ran against a session-0 agent
(no window station) and was invalid for the UIA path (coordination log 16/18);
this run replaces it.

## Environment proof (step 1)

- `reset.sh live` — 39 s.
- `agent/bootstrap/deploy-to-vm.sh` foreground — `DEPLOY OK`, wall 126.9 s.
- `session_info` over the ssh tunnel:
  `{"session_id": 1, "window_station": "WinSta0", "desktop": "Default", "user": "MYCO-WIN11\\myco"}`

## Trial 1 — normal calc-record-edit (step 2)

Run `711e16c1-3a80-44df-ad6a-4a8b472b2cd2` (seed `m1-013-live`, intent B39 /
record EMP-0038 / column `name`; `newValue` overridden to `REVISED-SESSION1` —
AutoCorrect-immune, per follow-up (4) of log 2026-11-19 (11); see below).

Verdict: **`verified`** — "cell B39 (record EMP-0038, column name) persisted as
\"REVISED-SESSION1\"", completed, elapsed 34.3 s. Artifacts: `result.json` +
`trace.jsonl` in `normal-711e16c1/`, schema-valid.

## The key evidence — did UIA actuation reach the desktop? (step 3)

**Yes. UIA actuation demonstrably reached the LibreOffice Calc desktop window.**

1. **Mid-typing screenshot** (`normal-711e16c1/mid-typing.png`, 69.6 KB GDI
   capture taken via the agent `screenshot` op immediately after the `setValue`
   step, before save/close): the Calc window is open on `fixture.xlsx`; cell
   **B39 visibly shows `REVISED-SESSI`** (truncated by column width — the full
   string is `REVISED-SESSION1` per UNO/persisted readback); the selection has
   advanced to B40 with `Cleo Larsen` in the formula bar, i.e. the keyboard
   commit (Enter) landed on the real grid. A screenshot of the interactive
   desktop only exists if the agent lives in that desktop.
2. **UIA element count**: `uia_tree` at capture time returned **214
   `control_type` nodes** (vs ~198 for a blank doc in M1-006 — the loaded
   fixture grid). A session-0 agent sees an empty tree.
3. **Name Box descriptor used**: the adapter identifies the Name Box
   structurally as the ComboBox inside the "Formula Tool Bar" toolbar
   (src/win/calc-adapter.ts:154-173), re-found per action. Live descriptor
   after the trial: `{"pid":6248, "name":"B40", "control_type":"ComboBoxControl",
   "runtime_id":[]}` — empty `runtime_id` is the known MSAA→UIA proxy quirk, so
   the adapter's JSON-descriptor fallback is what actuation uses.

**Independent corroboration (AutoCorrect)**: the first run of the unmodified
seed (`d7ad45bf…`, artifacts in `refuted-autocorrect-d7ad45bf/`) typed
`revised-908578` and the live document ended with **`Revised-908578`** —
AutoCorrect sentence-cased it, verdict `refuted`. That case flip could only be
produced by the real Calc input path on the desktop; a UNO write would have
stored the string verbatim. This confirms desktop actuation and re-confirms
follow-up (4): M1-013's parameter generator must emit AutoCorrect-immune values
(uppercase-start or numeric) or the 27/30 criterion is unwinnable.

No evidence of a UNO-write-only path was observed; the typed value appeared on
screen before any save or verifier close.

## Trial 2 — corrupted: kill soffice (step 4)

Run `87ee5b14-d512-4922-ae60-eafe4864c569`: verdict **`uncertain`** — "could not
look: UNO readback of B39 failed — NoConnectException (WSAECONNREFUSED)" — never
`verified`. Elapsed **15.3 s**, no hang (bounded timeouts held). Artifacts in
`kill-87ee5b14/`.

**Correction (2026-11-19, after independent review).** An earlier draft of this
report claimed the kill "fired at +13.2 s, mid-program, after set, before save".
The committed artifacts do not support that: `steps: []` and the guard failure is
`adapter-available` — "Calc window never became observable" — i.e. the app was
killed (or never came up) **before step 0**. The outcome still demonstrates a
bounded, non-verified failure, but it is **not** evidence of a mid-program
interruption.

The root cause was two defects, now fixed in PR #19: (a) `runProgram` let a
throwing `observe()` escape, so `runProgramSafe` discarded the executed steps;
(b) the kill was a 12 s wall-clock timer, and launch+observability alone takes
~30 s, so the timer always fired during launch.

**Proper mid-program kill (PR #19, coordinator-run on the live VM):**
`--mode kill --kill-after-step 3` → 2 steps recorded (click A1, click B39/locate),
guard failure at step 2 (`setValue`) with `observe-after-action` /
`NoConnectException`, verdict `uncertain`, 27.9 s, no hang. That is the
interruption M1-011 recovery is about.

## Schema validation (step 5)

`tsx src/integration/validate-live.ts runs` →
**"validated 4 result.json + 51 trace events in runs: ALL OK"**
(covers all runs of this session, including the AutoCorrect-refuted run).

## Cleanup (step 6)

`reset.sh live` run after artifact preservation; throwaway scripts
`src/integration/tmp-session1-evidence.ts` / `tmp-namebox-dump.ts` deleted
(they were never committed).

## Bugs found (reported, not fixed — out of my ownership)

- `src/win/agent-client.ts` exposes no typed `screenshot`/`session_info`
  methods (only via raw transport) — fine for the runner, awkward for
  evidence tooling. Cosmetic.
- Parameter generator still emits AutoCorrect-vulnerable values
  (`revised-908578`) — already tracked as follow-up (4), log 2026-11-19 (11).
