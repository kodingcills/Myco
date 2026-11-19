# Myco Dogfood — workstream state

## Objective
Prove and improve Myco by running Myco's own agents through real desktop dev
tasks on Myco-provisioned desktops. Phase 0 (done below): sample app, scenarios,
scoring, requirements, backlog — all ready before the runtime exists. Phase 1
(gated): run scenarios through the real runtime once its first end-to-end path
lands.

## Hard dependency
Myco Desktop Runtime (Rust) workstream, owner thread
`mcp:launch:cba81a8ecbe150c1ad3f6908da73bab666f2f4eca8ccd1657f403f1f051220fa`.
Runtime state: docs/coordination/runtime-state.md (not yet written as of
2026-11-19). Coordinator thread:
`mcp:launch:ea839ebaa08e7e4a093c2d3ffb0b742d3c2e96192f52c993503b9c8e6cfaac9d`.
Dogfood does NOT build its own runtime or wrap VMs.

## Phase 0 deliverables (2026-11-19)
- Sample app: `dogfood/apps/myco-todo/` — Tkinter todo app, Linux-first
  (stdlib + Tk), JSON-persisted outcome, seeded persistence-dropping bug
  (`BUG`-prefixed items vanish at save; UI reports success). `--self-test`
  passes headless.
- Scenarios: `dogfood/scenarios/DF-S01` … `DF-S05` (happy path, find-the-bug,
  fix-the-bug, crash-recovery, adversarial inputs), each with an independent
  host-side oracle.
- Scoring + issue format: `dogfood/scoring.md` — buckets
  success/false-success/refusal/uncertain/gap, reuses M1-012 evidence schemas
  (trace.jsonl, result.json, ledger.jsonl).
- Backlog: `docs/backlog/dogfood.md` (DF-001..DF-006).

## Requirements for the Myco Desktop Runtime (Rust)

Derived from scenarios DF-S01..DF-S05. These are the capabilities dogfood runs
will exercise; each gap becomes a DF backlog item with a reproduction.

| id | requirement | exercised by |
|---|---|---|
| REQ-01 | **Create**: provision a fresh Linux (ARM64 first) desktop session on demand via one call; return a session handle. | all |
| REQ-02 | **Destroy**: tear down a session and free its resources; no state leaks between sessions. | all |
| REQ-03 | **Observe**: read structured GUI state of a named window, not only screenshots. For the dogfood fixture (Tk) this is satisfied by an **opt-in app-side introspection channel**: the app publishes widget state JSON (`listbox_rows`, `listbox_selection`, `status_text`, `entry_text` — shape proven on RT-003) and the runtime's observe merges it with the AT-SPI tree. Tk registers zero AT-SPI nodes (no ATK bridge, measured on RT-003), so AT-SPI alone does NOT satisfy this requirement for Tk. Scope note: the channel is per-app instrumentation, NOT a claim about arbitrary Tk apps. A generic Tk ATK bridge is out of scope. | all |
| REQ-04 | **Act**: synthesize keyboard typing into a focused field and pointer clicks on named/found widgets; per-action three-way outcome (delivered_verified / delivered_unverified / failed), never bare ok. Delivery mechanism on Linux/X11: **global XTEST with real focus** (windowactivate + click + type) — proven to land in Tk on RT-003. `xdotool type --window` (send_event) does NOT land in Tk and MUST NOT be used. | all |
| REQ-05 | **Evidence**: every run emits schema-valid `trace.jsonl` + `result.json` per docs/architecture/evidence-schema.md; run ids propagated to caller. | all |
| REQ-06 | **Reset**: restore a session to a known-clean base between runs; measured cost reported (M1's VM reset is 8.3–8.6s; the runtime should beat or explain its number). | DF-S01 |
| REQ-07 | *(retired — id intentionally unused; was "screenshot capture", folded into REQ-03 since structured observation subsumes it)* | — |
| REQ-08 | **File read (host-side)**: read an arbitrary guest file from the host for oracle checks, without going through the GUI. | all |
| REQ-09 | **Process control**: launch, kill (SIGKILL), and relaunch a named guest process; report exit status. | DF-S02, DF-S04 |
| REQ-10 | **File edit**: write/replace a file in the guest (for fix-the-bug scenarios). | DF-S03 |
| REQ-11 | **Shell exec**: run a command in the guest and capture stdout/stderr/exit code (for `--self-test` and functional probes). | DF-S03 |
| REQ-12 | **Reset/destroy after abnormal ends**: sessions that ended in a kill or crash must still be resettable/destroyable. | DF-S04, DF-S05 |

Non-requirements (explicitly not asked of the runtime for Phase 1): fork/branch
search, workflow compilation, multi-OS support beyond Linux ARM64, product UI.

## Protocol with the runtime owner
- Missing/flaky capability → DF backlog entry (format in `dogfood/scoring.md`),
  flagged here and in the end-of-turn report for the coordinator/outer loop.
- Runtime owner announces first end-to-end path in
  `docs/coordination/runtime-state.md`; dogfood wakes on that.

## Decisions
- **2026-11-19 — REQ-03 channel (option B accepted).** Runtime probe on RT-003
  (Ubuntu 24.04 ARM64, Tk 8.6, Xvfb+openbox, AT-SPI 2.52): Tk registers zero
  AT-SPI nodes; synthetic input works via global XTEST with real focus
  (`xdotool type --window` send_event does NOT land in Tk); app-side
  introspection publishes `listbox_rows`/`listbox_selection`/`status_text`/
  `entry_text`. Dogfood accepts option B: runtime builds the opt-in Tk
  introspection channel, observe merges it with the AT-SPI tree. Option A (port
  fixture to GTK3/PyGObject) rejected: rewrites the fixture to fit the probe,
  and the seeded bug + scenarios are already verified against the Tk app.
  Consequence: dogfood makes no arbitrary-Tk-app observation claim in Phase 1;
  a generic Tk ATK bridge is out of scope for both workstreams.

- **2026-11-19 — REQ-03 channel atomicity (ADR-0016, both-sides).** Publisher
  MUST write temp-sibling + rename (`os.replace`) so the state file is either
  absent or complete-and-valid — a torn read that happens to parse is worse
  than one that fails, and the runtime can't distinguish partial-valid JSON
  from complete. Runtime ALSO retries once (50ms) on parse failure and reports
  `{unavailable: "parse: ..."}` on a second failure — defense in depth, not a
  substitute. Env mapping: app publishes to `$MYCO_TODO_STATE_FILE`; runtime
  reads `$MYCO_INTROSPECTION_FILE` and maps at the session layer. Observation's
  `introspection` field is tri-state: null (unset) | record | {unavailable}.

## Status
Phase 0 complete: PR #8 merged to main (2026-11-19, head 3ffcceb; VERIFIED by
independent kimi-k3 review at a491f71 + docs-only hardening delta, CI 4/4 green).
Phase 1 blocked on the runtime's first end-to-end path. Not polling; will be
woken.
