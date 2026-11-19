# Myco Desktop Runtime (Rust) backlog

Canonical in-repo backlog for the RT workstream. The outer loop mirrors this into
Linear, team TIF, project "Myco Desktop Runtime (Rust)". Ids are stable; never
renumber. `blocked_by` lists markdown ids in this file. Owner roles: `build`
(glm-5.3), `judgment` (kimi-k3), `swarm` (deepseek-v4.1-flash), `outer-loop`,
`coordinator` (this thread). ADRs: [../architecture/runtime.md](../architecture/runtime.md).
Coordination: [../coordination/runtime-state.md](../coordination/runtime-state.md).

---

### RT-001 Prior-art evaluation: xa11y, computer-use-rs, MS Hybrid Computer Use
- **status:** in progress (delegated, swarm)
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

### RT-002 ADRs: host backend, M1 boundary, API surface
- **status:** done (2026-11-19, coordinator)
- **owner:** coordinator
- **blocked_by:** none
- **description:** docs/architecture/runtime.md: ADR-0011 (Linux ARM64 QEMU+HVF over
  container desktop, tradeoffs spelled out), ADR-0012 (boundary with ADR-0001: Rust =
  lifecycle/session only, reuses M1 evidence schema), ADR-0013 (MCP stdio + CLI JSON
  from one core).
- **acceptance:** ADRs committed; consequential ones flagged to outer loop;
  docs/coordination/runtime-state.md records provided/needed interfaces.

### RT-003 In-guest stack: display server, AT-SPI, input injection
- **status:** pending
- **owner:** build
- **blocked_by:** RT-001, RT-002
- **description:** Pick and implement the guest-side stack per the RT-001
  recommendation: display (Xvfb vs minimal Wayland compositor), accessibility bus
  (AT-SPI2), input injection path (XTEST / uinput / at-spi actions), and the thin
  guest helper if the control channel needs one. Pinned base image (Ubuntu 24.04
  ARM64 cloud image or Debian; SHA-256 recorded in-repo).
- **acceptance:** a scripted cloud-init (or equivalent) provisioning path produces a
  guest where AT-SPI tree reads and synthetic input work; proven by a host-side smoke
  script; image SHA-256 and package pins committed.

### RT-004 Control channel: host↔guest transport
- **status:** pending
- **owner:** build
- **blocked_by:** RT-003
- **description:** virtio-serial vs SSH for the op channel; token auth; framing
  (NDJSON, matching M1's guest-agent habit); no VNC/RDP anywhere in the path.
- **acceptance:** round-trip op latency measured and recorded; channel survives guest
  reboot (reset path) without host-side reconfiguration; unauthorized calls rejected (test).

### RT-005 `myco-rt-core`: six-op API + Backend trait
- **status:** pending
- **owner:** build
- **blocked_by:** RT-002
- **description:** Rust workspace `runtime/`: core library with the six ops, session
  state machine (creating → ready → acted → resetting → destroyed; error states
  explicit), opaque refs + StaleRefError + three-way action outcome (ADR-0003
  vocabulary per ADR-0012), permissions model (what an agent may do per session),
  `Backend` trait, and a `FakeBackend` for host-only tests.
- **acceptance:** `cargo test` green on macOS; state machine transitions covered by
  tests including illegal-transition rejection; FakeBackend exercises all six ops.

### RT-006 QEMU+HVF Linux backend
- **status:** pending
- **owner:** build
- **blocked_by:** RT-003, RT-004, RT-005
- **description:** `QemuLinuxBackend` implementing the Backend trait: qcow2 overlay
  creation, HVF accel, RAM/CPU caps, idle-shutdown knob, concurrency cap (default 1),
  reset = discard overlay + reboot, destroy = teardown + overlay deletion. Never
  touches `myco-win11`.
- **acceptance:** create → ready in a measured time recorded in docs; reset returns a
  clean guest (proven by a marker file test); destroy leaves no processes or files;
  two concurrent-create attempts respect the cap.

### RT-007 observe: AT-SPI tree + screenshot + process/window info
- **status:** pending
- **owner:** build
- **blocked_by:** RT-006
- **description:** Implement `observe`: accessibility tree with opaque refs and
  stateVersion, screenshot (PNG artifact), process list and window list. Hard element
  cap on tree reads (UFO query-shape lesson from M1 research).
- **acceptance:** against a real guest app: tree contains the app's window with
  stable refs; screenshot is a valid PNG of the session; stale ref after state change
  yields StaleRefError (test).

### RT-008 act: launch, click, type, key
- **status:** pending
- **owner:** build
- **blocked_by:** RT-007
- **description:** Implement `act` as a closed action union (launch / click(ref) /
  typeText(ref, text) / keyPress(keys)) with three-way outcome
  (delivered_verified | delivered_unverified | failed), never bare ok.
- **acceptance:** integration test launches an app and types text into a field, with
  the text observable in a subsequent `observe`; failed action on a stale ref returns
  failed, not panic.

### RT-009 evidence: trace + artifacts reusing M1 schema
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

### RT-014 Schema PR: `recordKind` discriminator on result.json
- **status:** pending
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

### RT-010 MCP server + CLI front ends
- **status:** pending
- **owner:** build
- **blocked_by:** RT-005
- **description:** `myco-rt-mcp` (stdio MCP server, tool discovery + typed schemas)
  and `myco-rt` CLI (JSON NDJSON) over the shared core, per ADR-0013.
- **acceptance:** an MCP client (or a stdio JSON-RPC script in tests) can call all
  six ops with schema-checked args; CLI round-trips the same ops; error shapes match
  across both surfaces.

### RT-011 End-to-end integration test: thinnest north-star path
- **status:** pending
- **owner:** build
- **blocked_by:** RT-008, RT-009, RT-010
- **description:** Real integration test (not fake backend): create Linux desktop →
  observe (tree + screenshot) → act (launch app, type text) → evidence → reset →
  destroy. Runs on this Mac; skipped gracefully when QEMU unavailable.
- **acceptance:** test passes end-to-end with real QEMU+HVF; artifacts on disk prove
  each step; wall-clock for create (cold boot), reset, and destroy measured and
  recorded in docs/env/linux-runtime.md (the M1 coordinator explicitly does not want
  M1-017's Windows live-snapshot numbers inherited); VM shut down at test end (no
  idle leak).

### RT-012 Windows/UTM backend interface anticipation (design only)
- **status:** pending
- **owner:** coordinator
- **blocked_by:** RT-005
- **description:** Write the design note for a future `UtmWindowsBackend` that would
  drive `myco-win11`-class VMs through the existing M1 guest agent; interface only,
  no implementation, no touching the VM. Requires M1-coordinator review of the seam.
- **acceptance:** design note in docs/architecture/ reviewed by M1 coordinator; no
  code touching UTM.

### RT-013 Idle/RAM discipline + ops docs
- **status:** pending
- **owner:** build
- **blocked_by:** RT-006
- **description:** Enforce and document RAM budget (Win11 8 GB + runtime cap),
  idle-timeout shutdown, and a `docs/env/linux-runtime.md` runbook for the guest
  image and VM lifecycle.
- **acceptance:** runbook committed; a test or script demonstrates idle shutdown;
  concurrency cap configurable and defaulting to 1.
