# Myco Desktop Runtime (Rust) backlog

Canonical in-repo backlog for the RT workstream. Mirrored by the outer loop into
Linear, team TIF, project "Myco Desktop Runtime (Rust)" (2026-11-19): RT-001..RT-009 =
TIF-29..TIF-37, RT-014 = TIF-38, RT-010..RT-012 = TIF-39..TIF-41, RT-first-path =
TIF-42, RT-015..RT-018 = TIF-43..TIF-46, RT-013 = TIF-47 (Linear order reflects mirror
time, not markdown order). Dogfood DF-005 (TIF-27) is blocked by TIF-42.
Ids are stable; never renumber. `blocked_by` lists markdown ids in this file. Owner roles: `build`
(glm-5.3), `judgment` (kimi-k3), `swarm` (deepseek-v4.1-flash), `outer-loop`,
`coordinator` (this thread). ADRs: [../architecture/runtime.md](../architecture/runtime.md).
Coordination: [../coordination/runtime-state.md](../coordination/runtime-state.md).

---

### RT-001 (TIF-29) Prior-art evaluation: xa11y, computer-use-rs, MS Hybrid Computer Use
- **status:** done (2026-11-19; docs/research/runtime-prior-art.md, all claims verified against pinned-commit clones + crates.io/GitHub APIs)
- **owner:** swarm
- **blocked_by:** none
- **description:** Evaluate the three named projects plus a comparative pass over
  disposable-desktop projects (cua/Lume, agent-desktop AT-SPI side, OSWorld VM
  controllers, E2B desktop). Per project: what it does, license, platform support
  (Linux AT-SPI + input injection), maturity, reusable parts, gaps vs the six-op API,
  and a build/adopt/wrap recommendation. Output docs/research/runtime-prior-art.md.
- **acceptance:** report committed with sources and access dates; unverifiable claims
  marked [INFERENCE]; explicit build/adopt/wrap call per project with justification;
  recommendation for the in-guest observation/actuation stack feeding RT-003.
- **outcome:** ADOPT xa11y 0.16.1 (only published MIT Rust crate with AT-SPI reads +
  structural actions + XTest/uinput input); BUILD the rest; HCU = contract reference
  (input_emitted/effect_unknown, layout lease, aN/wN/rN refs); cua-vmm = reset concept
  source; agent-desktop = post-mortem source (read-back verification mandatory).
  Decisions recorded in ADR-0014.

### RT-002 (TIF-30) ADRs: host backend, M1 boundary, API surface
- **status:** done (2026-11-19, coordinator)
- **owner:** coordinator
- **blocked_by:** none
- **description:** docs/architecture/runtime.md: ADR-0011 (Linux ARM64 QEMU+HVF over
  container desktop, tradeoffs spelled out), ADR-0012 (boundary with ADR-0001: Rust =
  lifecycle/session only, reuses M1 evidence schema), ADR-0013 (MCP stdio + CLI JSON
  from one core).
- **acceptance:** ADRs committed; consequential ones flagged to outer loop;
  docs/coordination/runtime-state.md records provided/needed interfaces.

### RT-003 (TIF-31) In-guest stack: provisioning for X11 + AT-SPI + xa11y
- **status:** done (2026-11-19 @ 9e7eb40; RT owner completed the child's unfinished run — child died mid-report with STATE_FILE undefined + wrong-uid AT-SPI dump; both fixed, smoke PASS). Evidence: docs/env/linux-runtime.md. Measured: 17 s SSH / 23 s app cold boot. Critical finding: **Tk registers NO AT-SPI node** (GTK visible in same session) — REQ-03 fallback protocol triggered.
- **owner:** build
- **blocked_by:** RT-001, RT-002
- **description:** Decisions made (ADR-0014): X11 session on Xvfb (Wayland's portal
  screenshot prompt is a hard blocker), AT-SPI2 bus, xa11y 0.16.1 as the in-guest
  a11y/input layer, Ubuntu Server 24.04 LTS ARM64 cloud image with SHA-256 pinned
  in-repo. Implement: scripted download + verification of the base image, cloud-init
  seed installing xvfb, at-spi2-core, a minimal test GUI app, and starting Xvfb +
  the AT-SPI bus at boot. Prove it: host-side smoke script (SSH is acceptable for
  this proof; the op channel is RT-004) showing an AT-SPI tree read and a synthetic
  key/click landing in the guest.
- **acceptance:** a scripted cloud-init (or equivalent) provisioning path produces a
  guest where AT-SPI tree reads and synthetic input work; proven by a host-side smoke
  script; image SHA-256 and package pins committed.

### RT-004 (TIF-32) Control channel: host↔guest transport
- **status:** done (2026-11-19; child died after scaffolding the agent, RT owner completed: transport crate + workspace wiring + musl cross-build + live proof). ADR-0015. Live evidence: channel-test.sh PASS — ping ~70–80 ms incl. connect, wrong-token rejected, reboot survival. cargo test 13/13.
- **owner:** build
- **blocked_by:** RT-003
- **description:** virtio-serial vs SSH for the op channel; token auth; framing
  (NDJSON, matching M1's guest-agent habit); no VNC/RDP anywhere in the path.
- **acceptance:** round-trip op latency measured and recorded; channel survives guest
  reboot (reset path) without host-side reconfiguration; unauthorized calls rejected (test).

### RT-005 (TIF-33) `myco-rt-core`: six-op API + Backend trait
- **status:** done (2026-11-19 @ 79785c9; 9/9 session tests: illegal transitions, stale refs, permission denial, terminal destroy, reset semantics)
- **owner:** build
- **blocked_by:** RT-002
- **description:** Rust workspace `runtime/`: core library with the six ops, session
  state machine (creating → ready → acted → resetting → destroyed; error states
  explicit), opaque refs + StaleRefError + three-way action outcome (ADR-0003
  vocabulary per ADR-0012), permissions model (what an agent may do per session),
  `Backend` trait, and a `FakeBackend` for host-only tests.
- **acceptance:** `cargo test` green on macOS; state machine transitions covered by
  tests including illegal-transition rejection; FakeBackend exercises all six ops.

### RT-006 (TIF-34) QEMU+HVF Linux backend
- **status:** done (2026-11-19, RT owner). QemuLinuxBackend implements Backend: provision (lock + boot + agent install + channel), reset (discard overlay + reboot + reinstall + reconnect), destroy (crash-tolerant shutdown + overlay delete + lock release), concurrency cap via atomic lockfile with stale reclaim. observe/act return Unimplemented by design (RT-007/008). Evidence: live lifecycle test PASS ×2 — cold CREATE 14.0 s, RESET 19.7 s (marker file GONE after reset), DESTROY 4.1 s (overlay deleted, no qemu). cargo test 15/15 + 1 live. Caveat recorded: channel-ready ≠ cloud-init-done; observe gates on the GUI session at RT-007.
- **owner:** build
- **blocked_by:** RT-003, RT-004, RT-005
- **description:** `QemuLinuxBackend` implementing the Backend trait: qcow2 overlay
  creation, HVF accel, RAM/CPU caps, idle-shutdown knob, concurrency cap (default 1),
  reset = discard overlay + reboot, destroy = teardown + overlay deletion. Never
  touches `myco-win11`.
- **acceptance:** create → ready in a measured time recorded in docs; reset returns a
  clean guest (proven by a marker file test); destroy leaves no processes or files;
  two concurrent-create attempts respect the cap.

### RT-007 (TIF-35) observe: AT-SPI tree + screenshot + process/window info
- **status:** done @ c5db97d (2026-11-19, RT owner). Live test PASS: 4 AT-SPI nodes (GTK app → window → label), named window `MycoGtkSanity`, valid PNG (magic verified), 116 processes, introspection null-by-default, state_version advancing. Independent adversarial review QUEUED but not obtained (delegate API returned `parent_not_active` twice) — merge gate still open; work sits on the branch only.
- **findings:** (a) xa11y links `libxkbcommon`, so the musl static cross-build fails at link time → native in-guest build script; (b) sshd exports `DBUS_SESSION_BUS_ADDRESS` for the login session whose desktop is empty, so the agent MUST override from `gui.env` — the actual cause of a 0-node tree; (c) per-uid AT-SPI registries mean the GUI session must run as the agent's uid; (d) seed had lost the `myco-gui-session` write_files path header (fresh overlays were missing the session script).
- **owner:** build
- **blocked_by:** RT-006
- **description:** Implement `observe`: accessibility tree with opaque refs and
  stateVersion, screenshot (PNG artifact), process list and window list. Hard element
  cap on tree reads (UFO query-shape lesson from M1 research).
- **acceptance:** against a real guest app: tree contains the app's window with
  stable refs; screenshot is a valid PNG of the session; stale ref after state change
  yields StaleRefError (test).

### RT-008 (TIF-36) act: launch, click, type, key
- **status:** done (2026-11-19, RT owner) — pending PR + independent review. Live test PASS: `launch` → `delivered_verified` (process alive after spawn); `typeText` → `delivered_verified` with the typed string confirmed in the app's own state file (`{"entry_text":"myco-act-probe"}`) and via the AT-SPI Text interface; unresolvable ref → `failed` with reason, never a guess. Refs bound to the observation's state version; stale version → `stale_ref` refusal.
- **owner:** build
- **blocked_by:** RT-007
- **description:** Implement `act` as a closed action union (launch / click(ref) /
  typeText(ref, text) / keyPress(keys)) with three-way outcome
  (delivered_verified | delivered_unverified | failed), never bare ok.
- **acceptance:** integration test launches an app and types text into a field, with
  the text observable in a subsequent `observe`; failed action on a stale ref returns
  failed, not panic.

### RT-009 (TIF-37) evidence: trace + artifacts reusing M1 schema
- **status:** done (2026-11-19, RT owner) — pending PR/review. New `myco-rt-evidence` crate writes `runs/<session>/trace.jsonl` (run-start / observation / action events) and `result.json` as a `recordKind:"session"` record, and **refuses to write** artifacts that do not match M1's shapes (closed-property check; a session record carrying a verdict is rejected). Backend records every observe and act; live test PASS: trace 3+ lines, session record with no verdict, delivery disposition per step, artifacts survive reset+destroy.
- **owner:** build
- **blocked_by:** RT-005, RT-014
- **description:** `evidence` op emits `runs/<sessionId>/trace.jsonl` +
  `result.json` conforming to M1's schemas/ with `recordKind: "session"` (verdict
  forbidden at runtime layer per ADR-0012); screenshot and other artifacts landed in
  the run dir. Schema validation reuses M1's validators where the language boundary
  allows, else a Rust-side validator against the same schema documents.
- **acceptance:** a sample session's artifacts validate against schemas/; a
  deliberately malformed event fails validation loudly; no verdict-less record is
  emitted under the pre-recordKind schema.

### RT-014 (TIF-38) Schema PR: `recordKind` discriminator on result.json
- **status:** done — ACCEPTED by M1 schema owner (2026-11-19). Dual verification: 72/72 on myco/runtime-v0 (RT owner) AND 77/77 on M1 main with the schema dropped in, all existing M1 artifacts validating unchanged. Rides with the runtime PR; schema owner re-runs the compat check at that PR's head.
- **owner:** build
- **blocked_by:** none
- **description:** PR against schemas/ (M1-owned, reviewed by M1 coordinator per
  ADR-0012 resolution 2026-11-19): add `recordKind: "run" | "session"` to
  result.json — `"run"` keeps verdict required (current behavior, backward
  compatible), `"session"` forbids verdict and makes checks optional. Updates
  result-record.ts, validate.ts, and docs/architecture/evidence-schema.md.
- **acceptance:** PR reviewed by M1 coordinator and merged; existing M1 artifacts
  still validate unchanged; a `"session"` record without verdict validates and one
  with a verdict fails.

### RT-010 (TIF-39) MCP server + CLI front ends
- **status:** done (2026-11-20, RT owner) — pending PR/review. `myco-rt` CLI (JSON in/out, session state file) and `myco-rt-mcp` (stdio JSON-RPC 2.0, initialize/tools.list/tools.call, six tools, in-process sessions). Live: CLI create 1.3 s → act `DeliveredVerified` with guest-side confirmation → evidence artifacts; MCP create/observe/act/evidence verified over raw JSON-RPC. CLI `act` resolves targets by accessible name (refs are agent-process-scoped) and refuses a raw ref with an explanation.
- **owner:** build
- **blocked_by:** RT-005
- **description:** `myco-rt-mcp` (stdio MCP server, tool discovery + typed schemas)
  and `myco-rt` CLI (JSON NDJSON) over the shared core, per ADR-0013.
- **acceptance:** an MCP client (or a stdio JSON-RPC script in tests) can call all
  six ops with schema-checked args; CLI round-trips the same ops; error shapes match
  across both surfaces.

### RT-011 (TIF-40) End-to-end integration test: thinnest north-star path
- **status:** done (2026-11-22, RT owner). Live proof passed end-to-end against real Linux ARM64 QEMU+HVF guest via `scripts/rt020-proof.py --go --verify-myco-todo --session rt020-live-20261122-093115`. All 6 MCP ops (create, observe, act:launch, act:typeText, evidence, reset, destroy) verified with real X11 desktop and `myco-todo` app verification. Timings measured: create (cold boot + cloud-init + GUI) 108.0s, act ~0.9s, verify-myco-todo 0.8s, reset 52.0s, destroy 1.1s. VM cleanly destroyed with no lingering processes.
- **owner:** build
- **blocked_by:** RT-008, RT-009, RT-010
- **description:** Real integration test (not fake backend): create Linux desktop →
  observe (tree + screenshot) → act (launch app, type text) → evidence → reset →
  destroy. Runs on this Mac; skipped gracefully when QEMU unavailable. The full path
  is exercised through the MCP stdio server (Dogfood's agent-under-test surface, per
  outer loop 2026-11-19); the CLI JSON surface is smoke-tested for the same ops
  (Dogfood's host-oracle/harness surface).
- **acceptance:** test passes end-to-end with real QEMU+HVF; artifacts on disk prove
  each step; wall-clock for create (cold boot), reset, and destroy measured and
  recorded in docs/env/linux-runtime.md (the M1 coordinator explicitly does not want
  M1-017's Windows live-snapshot numbers inherited); VM shut down at test end (no
  idle leak).

### RT-012 (TIF-41) Windows/UTM backend interface anticipation (design only)
- **status:** done (2026-11-22, coordinator). Architectural design note committed in `docs/architecture/windows-utm-backend.md` mapping the `Backend` trait to M1's `myco-agent` (loopback TCP 8765, NDJSON) and live snapshot reset primitive. Design only; zero code touching UTM.
- **owner:** coordinator
- **blocked_by:** RT-005
- **description:** Write the design note for a future `UtmWindowsBackend` that would
  drive `myco-win11`-class VMs through the existing M1 guest agent; interface only,
  no implementation, no touching the VM. Requires M1-coordinator review of the seam.
- **acceptance:** design note in docs/architecture/ reviewed by M1 coordinator; no
  code touching UTM.

### RT-first-path (TIF-42) First end-to-end path (Dogfood unblocker)
- **status:** done (2026-11-22). Live proof passed end-to-end (session `rt020-live-20261122-093115`), unblocking Dogfood DF-005 (TIF-27). All 11 proof steps passed, measured costs recorded in docs/coordination/runtime-state.md and docs/backlog/runtime.md.
- **owner:** coordinator
- **blocked_by:** RT-011
- **description:** Roll-up marker for the first end-to-end path the Dogfood
  workstream is blocked on (DF-005 / TIF-27): create → observe → act → evidence →
  reset → destroy against the real QEMU+HVF Linux guest. Covers Dogfood REQ-01,
  REQ-02, REQ-03 (pending Tk AT-SPI probe in RT-003), REQ-04, REQ-05, REQ-06,
  REQ-12; coverage map in docs/coordination/runtime-state.md.
- **acceptance:** RT-011 green; announcement posted in
  docs/coordination/runtime-state.md and to the M1 coordinator (who holds the
  Phase-1 go signal for Dogfood); measured create/reset/destroy costs recorded.

### RT-015 (TIF-43) Extended op: host-side guest file read (Dogfood REQ-08)
- **status:** implemented, in review (PR #112). MCP `read_file` tool, opt-in via
  `create.read_root`; kernel-enforced confinement (`openat2` + RESOLVE_BENEATH |
  NO_SYMLINKS | NO_XDEV); 1 MiB cap; root `/` refused. **Path-grant enforcement is
  proven on Linux only** (`#[cfg(target_os = "linux")]`), so it is unverified on
  macOS hosts and not yet live-validated against a guest.
- **owner:** build
- **blocked_by:** RT-first-path
- **description:** Read an arbitrary guest file from the host for oracle checks,
  without going through the GUI (control-channel file op or SSH; reuses RT-004
  channel). Exposed as an extended op beyond the six-op v0 surface.
- **acceptance:** integration test writes a file in the guest, reads it host-side,
  bytes match; permission denied for paths outside the session's grant (test).

### RT-016 (TIF-44) Extended op: process control (Dogfood REQ-09)
- **status:** pending
- **owner:** build
- **blocked_by:** RT-first-path
- **description:** Kill (SIGKILL) and relaunch a named guest process with exit
  status reporting (launch already exists via `act`). Needed by DF-S02/DF-S04.
- **acceptance:** integration test kills the demo app mid-session, observes it
  gone, relaunches, exit status reported; session stays usable (feeds REQ-12).

### RT-017 (TIF-45) Extended op: guest file edit (Dogfood REQ-10)
- **status:** pending
- **owner:** build
- **blocked_by:** RT-first-path
- **description:** Write/replace a file in the guest (fix-the-bug scenarios,
  DF-S03).
- **acceptance:** integration test replaces a file in the guest; subsequent read
  (RT-015) returns the new content.

### RT-018 (TIF-46) Extended op: shell exec (Dogfood REQ-11)
- **status:** pending
- **owner:** build
- **blocked_by:** RT-first-path
- **description:** Run a command in the guest, capture stdout/stderr/exit code
  (`--self-test`, functional probes, DF-S03).
- **acceptance:** integration test runs a command that fails and one that succeeds;
  exit codes and captured output exact.

### RT-013 (TIF-47) Idle/RAM discipline + ops docs
- **status:** pending
- **owner:** build
- **blocked_by:** RT-006
- **description:** Enforce and document RAM budget (Win11 8 GB + runtime cap),
  idle-timeout shutdown, and a `docs/env/linux-runtime.md` runbook for the guest
  image and VM lifecycle.
- **acceptance:** runbook committed; a test or script demonstrates idle shutdown;
  concurrency cap configurable and defaulting to 1.

### RT-019 Fast-reset mode: provisioned-overlay snapshot (post-RT-011)
- **status:** pending — **decision (outer loop, 2026-11-20): after RT-011, not before.**
- **owner:** build
- **blocked_by:** RT-011
- **description:** Add an explicitly named **fast-reset mode** that restores a
  snapshot of the *provisioned* overlay instead of recreating the overlay from the
  base image and re-running cloud-init. Motivation: a full reset costs 3–4 minutes
  (measured), which lengthens every live run and the host-contention window.
  **The full reset stays the default contract** — fast reset is opt-in and named,
  never a silent substitution, because a snapshot base can drift from the declared
  base image in a way a fresh overlay cannot.
- **acceptance:**
  1. `reset` keeps full-reset semantics by default; fast reset is selected
     explicitly (config/flag) and reported in the session's evidence.
  2. **State-integrity check**: after a fast reset, everything the verifier reads
     is equivalent to a full reset — AT-SPI tree shape, process set (no leftovers
     from the previous session), the app's published state file, and the absence
     of files written before the reset. Proven by a test that runs both reset
     modes and compares those observations.
  3. Timings recorded for both modes in docs/env/linux-runtime.md, with the
     measured full-reset number kept alongside (no replacing the honest figure).
  4. Snapshot provenance recorded: which overlay, when taken, and how it is
     invalidated when the base image or provisioning changes.

### RT-020 (TIF-56) Arbitrary agent obtains a safe isolated desktop, end to end
- **status:** done (2026-11-22, live run `rt020-live-20261122-093115` PASS × 11 steps; independent adversarial verifier subagent PASS).
  **Goal is ease, not more capability.** Merged CLI + MCP front ends reused; single reliable QEMU+HVF backend.
- **owner:** build
- **blocked_by:** none
- **description:** One agent, one Myco-managed desktop, end to end: lifecycle,
  screenshots, semantic observations, actions, artifacts, cleanup — usable
  independently of the custom Grok Bot setup. Supports Discovery direction A
  (verified desktops for coding agents, TIF-53).
- **findings so far** (docs/research/runtime-safety-isolation.md):
  - The six ops work; **discovery does not**. An agent running the MCP server
    outside the repo root fails with
    `script failed: boot.sh ... No such file` because the workspace is resolved
    from `cwd`. Reproduced 2026-11-21; fixed via PR #52 ($MYCO_HOME / upward traversal).
  - Isolation is the VM boundary + 2 GB cap + loopback-only hostfwd + disposable
    overlay. **Not** guaranteed: egress policy, guest→host file transfer, idle
    reaping, per-agent attribution, multi-tenant credentials.
- **progress:** All acceptance criteria satisfied. Live run executed with `--verify-myco-todo` inside Coordinator-granted exclusive window under `/tmp/myco-win11.vm.lock`. Evidence: `runs/rt020-live-20261122-093115/` (`proof.json`, `result.json`, `trace.jsonl`). Timings: create 108.0s, act:launch 0.4s, act:typeText 0.5s, verify-myco-todo 0.8s, reset 52.0s, destroy 1.1s. Independent verification completed with formal PASS.
- **acceptance:**
  1. A single documented entry point gets an agent from "nothing running" to a
     usable desktop with no repo-layout knowledge and no `cd` requirement; the
     failure message for a missing asset names the one command that fixes it.
  2. One uninterrupted end-to-end run by an agent: create → observe (semantic tree
     + screenshot) → act (verified) → evidence (artifacts) → destroy, with the run
     recorded as evidence and the destroy proven to leave no VM.
  3. Safety claims limited to what is tested: the VM boundary and memory cap are
     stated as guarantees; §2 of the research note is stated as gaps, not claims.
  4. Works without the custom Grok Bot setup.
  5. Human-facing surfaces (if any) meet the UI bar: real design work, screenshots
     in the PR.
- **not in scope:** Foundry tasks/evals (EF-001/EF-002 do not exist yet; no eval
  claims before they land), new backends, and capability expansion for its own sake.

## Standing gap: `runtime/` has no CI job

`.github/workflows/ci.yml` runs `check`, `agent/` and `viewer-perf` — there is **no
`runtime/` job**, so nothing in CI ever compiles or tests the Rust workspace. Every
`cargo test` claim for the runtime is a claim about someone running it locally.

This is worse than it sounds for the RT-015 file-grant guards: `mod file_grant` is
gated `#[cfg(target_os = "linux")]` (they exercise `openat2`), and development
happens on macOS — so on the dev host those tests run **zero** times, and no
automation ever runs them either. A broken grant guard could stay green
indefinitely.

Fix requires editing `.github/workflows/ci.yml`, which the current `gh` token cannot
push (no `workflow` scope). Until someone with that scope adds:

```yaml
  runtime:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo test --manifest-path runtime/Cargo.toml --workspace
```

…no runtime test result may be described as CI-verified. Local evidence only.

## RT-021 — `evidence` has no `require_ready()` guard

**Found by:** the mocked e2e added in #167, which asserted the op would be refused
on a destroyed session and observed that it is not.

**The asymmetry.** Every non-terminal op checks `require_ready()` before touching
the backend — `observe`, `act`, `reset`, `read_guest_file`. `destroy` is also
unguarded, and that is deliberate: it must work from `Failed` so a failed reset
cannot strand a live guest (REQ-12). `evidence` is the only remaining op with no
guard, so:

```rust
s.destroy().expect("destroy");
s.evidence()  // Ok(...) -- reaches a torn-down backend
```

That is what the test now pins, as observed behaviour rather than as correct.

**Why it is probably an oversight rather than a decision:** the op reads artifacts
that `destroy` deletes, and the documented order is evidence-then-destroy
(`first_path` prints EVIDENCE before DESTROY). Nothing documents evidence as
intentionally callable on a dead session. If it is intentional — e.g. to re-read a
trace after teardown — the doc comment should say so, because the current comment
describes only the happy path.

**Not fixed here** because the fix is a behaviour change on the MCP surface: a
client that currently gets a trace path after destroy would start getting
`IllegalTransition`. That is Tier 2 and belongs in its own change with a note to
Dogfood, not folded into a test PR.

**Acceptance:**
- `evidence` either refuses on a destroyed session (with a test that fails if the
  guard is removed), or is documented as deliberately unguarded — and the mocked
  e2e assertion is updated to match the decision either way.
- The MCP `evidence` handler's error path is covered for the destroyed case.

## RT-022 — the backend half of the act wire contract is untested

**Found by:** the verifier of #186, as a caveat on an otherwise clean PASS.

`myco-rt-agent` does not depend on `myco-rt-backend-qemu` (its Cargo.toml has only
serde, serde_json, xa11y, uuid, rustix). So the wire-JSON assertions added in #186 are
a **hand-copied literal** of the backend's `json!` blocks, not the backend's actual
output. They pin the agent parser against the documented form.

**The gap:** a rename on the backend side — `"x"` to `"px"` in
`QemuLinuxBackend::act` — passes every test in #186. It is caught only by the live
tests in `backend-qemu/tests/`, which need a VM. So a backend-side wire change can
reach `main` with a green suite and fail only inside a guest, which is the most
expensive place to find it and arrives looking like an XTEST fault.

**Why it was not fixed in #186:** the wire-building code is inline inside
`QemuLinuxBackend::act` and needs a live channel to reach. Extracting it — a pure
`fn action_to_wire(action: &Action) -> serde_json::Value` — is a production change to
guest-control code (Tier 2), and folding a refactor into a test PR is how test PRs
stop being reviewable.

**Acceptance:**
- `action_to_wire` extracted as a pure function, with a unit test in the backend crate
  asserting the exact JSON for every variant.
- That test and #186's agent-side test agree on the same literals, so a rename on
  either side fails somewhere deterministic and VM-free.
- Ideally the two share one source of truth; if they cannot (crate dependency
  direction), the pair of tests is the contract.

## RT-023 — `runtime/` is not `cargo fmt` clean, and nothing enforces it

**Found by:** the verifier of #195, as a non-blocking note. Measured, not assumed:
`cargo fmt -p myco-rt-backend-qemu -- --check` reports **59 diffs on `origin/main`**
and the same 59 on #195's branch — so this is pre-existing and repo-wide, not
introduced by that PR.

**Why it matters beyond tidiness:** there is no `runtime/` CI job (see the standing
gap above), so nothing runs `fmt --check` or `clippy` on this workspace. Formatting
therefore drifts unopposed, and every future PR inherits a noisy diff baseline: a
reviewer cannot tell formatting churn from a real change, and `cargo fmt` as a
pre-commit habit would rewrite unrelated regions.

**Not fixed here** because a repo-wide reformat is exactly the kind of change that
buries a real diff, and it should be its own PR with no logic change in it.

**Acceptance:**
- One PR running `cargo fmt --all` across `runtime/` with **no** logic change, so it
  can be reviewed as a no-op.
- A `runtime/` CI job that runs `cargo fmt -- --check` and `cargo clippy`, so the
  baseline cannot drift again. This is the same missing job as the standing gap
  above; one job closes both.
- Until then: do not treat a fmt-only diff in `runtime/` as a review finding.
