# VM queue (post-C1-arm)

The Windows guest is a single serialized resource. This is the order, with durations
**measured from arm-002**, not estimated. Owners should line up against it and batch
their needs so each slot is used fully.

Durations come from live data: **reset 139–196 s** (mean ≈ 166 s), **trial 19–151 s**
(mean ≈ 76 s). A 30-trial arm therefore costs roughly **30 × (166 + 76) s ≈ 2 h**, plus
deploy and teardown. Numbers below use those means and are rounded up.

## Priority 1 — M1 acceptance (blocks the milestone)

| Slot | Work | Rows | Est. duration | Notes |
|---|---|---|---|---|
| 1 | **C1 arm-002, finish** | — | running | In flight; 11 scored at last read. MT4 continues |
| 2 | **M1-016** reproducibility runbook + independent reproduction | M1-016 | 3–4 h | Needs a *fresh operator* on a fresh checkout; cannot be done by the arm's owner |
| 3 | **arm-003** — baseline re-run with byte-identical task text (`docs/research/experiments/c1-arm-003-design.md`) | — | ~2.5 h | Queued **after** slot 2. $9.00 cap on total committed spend, read from `report.json.c1ChargedMicros` (**$1.632162** at arm-002's close: spike $0.076800 + arm-002 $1.555362). Arm-002 is recorded, not scored |
| 3b | **Corrupted / interrupted arm** for criterion 4 (≥10 trials, 0 false successes) | — | 1.5–2 h | The M1-014 combined audit already has 21 eligible trials at `6c4524e`; this slot only re-runs if that evidence is rejected |
| 4 | **Scorecard regeneration** on retained artifacts | — | 15 min | `scripts/m1-scorecard.py`; host-side, needs the guest only if artifacts must be re-produced |

## Priority 2 — Runtime (Rust)

| Slot | Work | Rows | Est. duration | Notes |
|---|---|---|---|---|
| 5 | **RT-020** deploy check (includes myco-todo deploy verify) | RT-020 | 45 min | Has a 45-minute GO already issued |
| 6 | **Runtime S-slots** — in-guest stack provisioning | RT-003 | 1 h | `blocked_by` RT-001/RT-002, both of which are **non-VM** |
| 7 | **RT-011** proof | RT-011 | 45 min | Prep is non-VM; only the proof needs the guest |

## Priority 3 — Discovery

| Slot | Work | Rows | Est. duration | Notes |
|---|---|---|---|---|
| 8 | **Discovery S0** | MVD-00x | 1–2 h | Uses a disposable ARM64 QEMU+HVF guest with a fresh Ubuntu image, **not** the Windows guest — mostly independent of this queue |
| 9 | **Discovery S1** | MVD-00x | 1–2 h | Same; confirm whether it truly needs the Windows guest |

## Priority 4 — Foundry

| Slot | Work | Rows | Est. duration | Notes |
|---|---|---|---|---|
| 10 | **EF-005** baseline harness on real tasks | EF-005 | 2–3 h | Fixtures and verifiers build **offline**; only the live run needs the guest |

## Priority 5 — Dogfood

| Slot | Work | Rows | Est. duration | Notes |
|---|---|---|---|---|
| 11 | **DF-005** run DF-S01..DF-S05 through the real runtime | DF-005 | 1–2 h | Needs the runtime first, so it follows the RT slots |

## Rules

- **M1 first.** Nothing above may pre-empt slots 1–3b.
- **Batch.** Combine same-purpose work into one slot; each slot start costs a 166 s reset.
- **Announce before you take a slot**, so the queue stays honest.
- **Detached.** Anything over a few minutes runs under `nohup`/`setsid` with a pid file
  and a watchdog; see `CONTRIBUTING-agents.md` §C.
- **A second guest is not available yet.** Measured 2026-11-22: host 24 GiB, existing guest
  6 GiB with `MemoryLock = true`, swap 5559/7168 MB used. A second 6 GiB guest does not fit.
  Tiffany approved one only **after** M1.
