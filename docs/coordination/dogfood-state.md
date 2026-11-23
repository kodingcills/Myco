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

- **2026-11-22 — Tk GUI startup fix (PR #89 merged @ `1f4619a`).** Runtime Owner
  discovered `NameError: name 'tk' is not defined` when launching GUI due to lazy
  `import tkinter as tk` inside `main()`. Dogfood Owner approved fix with constraints:
  `global tk` before import in `main()`, keep seeded bug untouched, preserve headless
  `--self-test` without Tk/display, retain ADR-0016 atomic write
  (`tempfile.NamedTemporaryFile` + replace), trace `entry_text` with `StringVar`, and
  add `test_myco_todo.py` skipping cleanly without display.
  `myco_todo.py` SHA-256: `c9671a046ecd1cc4c21475d570bbef029e4ee32e2d85c9ff85c720b24f379b57`.

- **2026-11-22 — RT-020 live proof passes end-to-end (`08b3863`).** Runtime Owner
  executed live proof script (`rt020-proof.py --go --verify-myco-todo`, 11/11 steps
  passed). Step 7 (`verify-myco-todo`) verified SHA-256 upload, `--self-test` pass
  with seeded bug present, and live X11 window visibility (window ID 16777242).
  Independent adversarial verification PASSED. RT-first-path is verified.

## Non-VM queue (operating rule B, 2026-11-22)

Ordered by what unblocks the most downstream work. Nothing here needs the guest.

| # | Item | State |
|---|---|---|
| 1 | DF-005 harness hardening (PR #169) — the shipped runner graded an offline stub `pass/verified`. Gates, uncertain-vs-failure split, guest-readback oracle, M1-012 `nodeCount`, offline contract tests + mutation check. | in PR, Tier 2 verifier running (`deepseek-v4.1-flash`) |
| 2 | Rebase #169 on `main` once verified; re-run gates | queued (blocked by 1) |
| 3 | Per-scenario live-step implementations for DF-S02/S05 beyond the shared add+save path (each oracle is written; the actuation recipe is not) | queued, no guest needed to write |
| 4 | Replay harness: grade recorded traces from a prior run without a guest, so a scoring change can be re-scored offline | queued |
| 5 | `--agent-report` intake: capture the agent-under-test transcript into the run dir automatically (clause (b) currently needs a manual path) | queued |
| 6 | Scoring doc reconciliation: verifier model policy updated to `deepseek-v4.1-flash` in the scenario oracles and `dogfood/scoring.md` | done (079f026 / b1f04eb) |

Deliberately **not** queued: porting the fixture to GTK (option A rejected — it
would rewrite a fixture whose bug and oracles are already verified), and any
DF-S02 work under TIF-27 (it belongs to TIF-28, a finding about the agent).

## VM needs (batched, for the Coordinator queue — M1 first)

One slot, one contiguous window, everything below in a single run:

1. **DF-S01 ×3, DF-S05 ×3** — first live proof of the hardened runner. This is
   the highest-value guest time dogfood has: it is the first time the harness's
   oracle runs against a real store. Expected to surface actuation gaps (does
   `ctrl+a`, `Return`, and the `Save` click land via XTEST on the Tk entry?).
2. **DF-S02 ×3** with a captured agent transcript — needs the runtime's
   `read_file` (PR #112) live-validated, which is already pending a slot.
3. **Deploy check** — `scripts/deploy-verify-myco-todo.sh --go` once, to confirm
   the app deploys and its window maps after the DF-005 changes (it does not
   touch the app, but the runbook path should be proven on this guest).

Not requested: DF-S03 (needs REQ-10/REQ-11 tools, absent) and DF-S04 (needs
REQ-09 `killProcess`, absent). Both stay `gap` with the requirement attributed;
asking for guest time on them would waste the slot.

**Estimated guest cost:** ~15 min for all of the above, dominated by DF-S01/S05
runs and app startup. No Windows guest involvement — this is the Linux RT-020
desktop.

## Working rules

- **GIT SYNC (standing, Tiffany 2026-11-22 19:45 ET).** Before resuming or
  picking up any existing branch or worktree: `git fetch origin`, rebase onto
  the latest `origin/main` (or merge it in if the branch is shared), resolve
  conflicts, and re-run the tests before doing new work. Right before opening a
  PR or pushing for review: sync again and confirm nothing is behind. Never open
  a PR from a stale branch. Syncing after a verifier PASS requires re-verifying
  per the PR's tier (Tier 0 needs only green CI). Every subagent gets this rule
  in its brief.
- **Issue-first.** No PR without a TIF id in the title or body.
- **One worktree per PR.** Never switch branches in a worktree a verifier is
  using; a `git reset` there once clobbered a PR branch. When a branch is
  checked out elsewhere, rebase via a temp branch and
  `git push <tmp>:<remote-ref>`.

## Status

### 2026-11-22 — TIF-27: the runner can drive Tk apps (PR #205 merged `ced7e07`)

The DF-005 runner now picks an actuation route:

| route | when | actions |
|---|---|---|
| ref | the app exposes AT-SPI nodes | `click`/`typeText` by ref |
| global | it exposes none (Tk registers zero, RT-003) | `clickAt` the entry's published geometry to establish X focus, then `typeTextGlobal` |

Grading is unchanged: the persisted store decides, and both global actions
report `delivered_unverified` by design, so they are never treated as evidence.

Four verifier rounds found four real defects, all in code I had just written:

1. The verdict came only from the store, so all-`failed` actions still passed on
   a matching store. Fixed with an `actions-delivered` check.
2. That check used a **denylist** (`kind != "failed"`), so a missing outcome,
   `{}`, or an unknown kind still passed. Fixed with an allowlist.
3. `w_report` was dead code — the report check hardcoded 0.5 — so DF-S02 weights
   summed to 1.1 and a correct DF-S02 scored 0.6. Fixed, with a test that
   asserts the sum rather than the numbers.
4. `act()` collapsed a missing `outcome` key to `{}`, so a transport gap was
   indistinguishable from an empty outcome in the evidence. It now returns the
   full response.

The pattern worth remembering: each round fixed the reported hole and left a
narrower one of the same class. The invariant tests (weights sum to 1.0; a
no-outcome response is recorded verbatim) exist to stop that, not just to cover
the instances.

**Still unverified (guest-only):** whether `clickAt` on the Tk window's entry
geometry gives that window X focus under openbox. The runtime's live proof
establishes it for the GTK sanity window; the Tk fixture is untested. With the
`actions-delivered` check in place, a focus failure now surfaces as
`failure`/`refuted` rather than a silent pass.



### 2026-11-22 — DF-005 harness hardened (PR #169 merged `32ac252`)

The shipped runner graded an offline stub MCP server `pass / verifier:verified+ground-truth`
for DF-S01/S02/S05 with no guest behind it. Fixed and merged after two
independent verifier rounds (`deepseek-v4.1-flash`), CI 4/4 green:

- Oracle is guest state only, read back over an independent channel.
- Three independent no-guest guards (offline gate, guest-probe gate, ssh
  readback); removing any one still yields `gap`/`uncertain`, never `pass`.
- Unreadable/unparseable store → `uncertain` with `passed: null` (ADR-0002);
  wrong-shaped JSON no longer crashes the run and destroys its evidence.
- Exit non-zero unless every trial is a genuine success.
- `observation` events carry the schema-required `nodeCount`.

### 2026-11-22 — REQ-13 WITHDRAWN (it was my error, not a runtime gap)

I filed REQ-13 claiming the runtime had no focus-relative typing or coordinate
click. **That was wrong.** `TypeTextGlobal { text }` and `ClickAt { x, y }` have
been in `runtime/crates/myco-rt-core/src/ops.rs` since `9efb2d8`, with the agent
implementation in `myco-rt-agent/src/act.rs`, the wire contract in #186, the
runbook in #185, and a live proof in #188 (`act_global_live.rs`).

Cause: I read an older `ops.rs` from a stale worktree and inferred the `Action`
union was closed without them, instead of reading the current file. The gap was
in the Python runner, which only knew the ref-targeted forms.

Fixed in PR #205: the runner picks a route — ref route when AT-SPI nodes exist,
global route (`clickAt` the entry's published geometry to establish X focus,
then `typeTextGlobal`) when they do not. Grading is unchanged: the persisted
store decides, and both global actions report `delivered_unverified` by design,
so they are never treated as evidence.

**REQ-13 is withdrawn; do not implement it.** The id stays reserved so no
existing reference becomes ambiguous.

Open question the DF-005 slot settles: whether a `clickAt` on the Tk window's
entry geometry gives that window X focus under openbox. The runtime's live proof
establishes it for the GTK sanity window; the Tk fixture is untested. A failure
here reports `failure`/`refuted` with a readable trace, never a false pass.

Phase 1 (DF-005 / TIF-27) is **UNBLOCKED** (2026-11-22):
- Runtime first path (RT-011 / TIF-40) and arbitrary-agent safe desktop (RT-020 / TIF-56) passed live proof (`rt020-live-20261122-093115`) and independent verification, merged via PR #96.
- Full runbook and entry points for Dogfood: [`docs/env/dogfood-runtime-runbook.md`](../env/dogfood-runtime-runbook.md).
- Entry points:
  - Agent-under-test (Oh My Pi / LLM): MCP stdio server `runtime/target/debug/myco-rt-mcp`.
  - Dogfood test harness & oracles: CLI `runtime/target/debug/myco-rt` + SSH port forward `127.0.0.1:10022` (`runtime/guest/keys/id_ed25519`).
  - Target app verification: `scripts/deploy-verify-myco-todo.sh --go`.
- Host discipline: VM time is queued through the M1 Coordinator (C1, M1-016, Foundry first); no VM is taken without GO.

## Runtime Owner Decisions for DF-005 Runner & Oracles (2026-11-22)
Handoff to [Myco Dogfood Owner](t3-thread://v2/b1bc9145-909e-40e7-87e6-eb7568f09bd3/mcp:launch:a4cad102668e27328e4726db527286133e1d90b3a6884a507edbd4fb1a0a5ebc) (PR #98):

1. **REQ-08 (Oracle guest file reads):**
   - **Decision:** Oracles **should keep reading guest store files directly over the authenticated SSH channel** (`127.0.0.1:10022`, user `myco`, key `runtime/guest/keys/id_ed25519`).
   - **Rationale:** Ground-truth oracles are host-side and must remain strictly out-of-band and independent of the agent under test (ADR-0002).
   - **RT-015 MCP tool:** A `read_file` tool ships for agents under test with bounded path grants. Core backend logic is in place (`QemuLinuxBackend::read_guest_file`); MCP exposure shipped in PR #112 (`read_file`, opt-in via `read_root` at `create`). Live VM validation is pending the next Coordinator slot, so DF-S03 scores `gap` until a real guest confirms it.
2. **REQ-09 (Process control — kill & relaunch):**
   - **Decision:** When RT-016 lands on the MCP surface, process control will be exposed symmetrically under `act` (matching `launch`):
     - Action kind `{"kind": "killProcess", "handle": "<opaque_handle>"}`.
     - Action kind `{"kind": "relaunchProcess", "handle": "<opaque_handle>"}`.
   - **Rationale:** Routing process lifecycle actions through `act` guarantees three-way outcome reporting (`DeliveredVerified`, `DeliveredUnverified`, `Failed`), monotonic `StateVersion` advances, and structured event emission into `trace.jsonl`. Convenience top-level tools (`kill_process`, `relaunch_process`) will also be aliased for tool discovery.
3. **REQ-10 / REQ-11 (File edit & Shell exec for DF-S03):**
   - **Decision:** Until RT-017 (`write_file`/edit) and RT-018 (`exec`) land on the MCP surface, DF-S03 (fix-seeded-bug) MUST score missing tools as an expected **`gap`** bucket (attributing to REQ-10 and REQ-11 per `dogfood/scoring.md`), **never pass**.
   - **Rationale:** An agent without file-edit capabilities cannot fix the code in the guest; claiming pass without tool execution is a false-success trap. Marking missing tools as `gap` allows the DF-005 matrix to cleanly transition from `gap` to `success` as RT-017/018 land.
