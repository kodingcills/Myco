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
- **status:** pending
- **owner:** build
- **blocked_by:** RT-006
- **description:** Implement `observe`: accessibility tree with opaque refs and
  stateVersion, screenshot (PNG artifact), process list and window list. Hard element
  cap on tree reads (UFO query-shape lesson from M1 research).
- **acceptance:** against a real guest app: tree contains the app's window with
  stable refs; screenshot is a valid PNG of the session; stale ref after state change
  yields StaleRefError (test).

### RT-008 (TIF-36) act: launch, click, type, key
- **status:** pending
- **owner:** build
- **blocked_by:** RT-007
- **description:** Implement `act` as a closed action union (launch / click(ref) /
  typeText(ref, text) / keyPress(keys)) with three-way outcome
  (delivered_verified | delivered_unverified | failed), never bare ok.
- **acceptance:** integration test launches an app and types text into a field, with
  the text observable in a subsequent `observe`; failed action on a stale ref returns
  failed, not panic.

### RT-009 (TIF-37) evidence: trace + artifacts reusing M1 schema
- **status:** pending
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
- **status:** pending
- **owner:** build
- **blocked_by:** RT-005
- **description:** `myco-rt-mcp` (stdio MCP server, tool discovery + typed schemas)
  and `myco-rt` CLI (JSON NDJSON) over the shared core, per ADR-0013.
- **acceptance:** an MCP client (or a stdio JSON-RPC script in tests) can call all
  six ops with schema-checked args; CLI round-trips the same ops; error shapes match
  across both surfaces.

### RT-011 (TIF-40) End-to-end integration test: thinnest north-star path
- **status:** pending
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
- **status:** pending
- **owner:** coordinator
- **blocked_by:** RT-005
- **description:** Write the design note for a future `UtmWindowsBackend` that would
  drive `myco-win11`-class VMs through the existing M1 guest agent; interface only,
  no implementation, no touching the VM. Requires M1-coordinator review of the seam.
- **acceptance:** design note in docs/architecture/ reviewed by M1 coordinator; no
  code touching UTM.

### RT-first-path (TIF-42) First end-to-end path (Dogfood unblocker)
- **status:** pending (tracks RT-011)
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
- **status:** pending
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
