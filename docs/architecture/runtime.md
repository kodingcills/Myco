# Myco Desktop Runtime (Rust) — architecture and decision records

Status: proposed, 2026-11-19. Scope: the Rust desktop lifecycle and session layer
(workstream RT). Relationship to M1 is defined in ADR-0012; M1's ADRs are
ADR-0001..0010 in [m1.md](m1.md). Consequential decisions flagged **[CONSEQUENTIAL]**.

## ADR-0011 — First host backend: Linux ARM64 guest under QEMU+HVF [CONSEQUENTIAL]

**Decision.** The v0 host backend is a Linux ARM64 guest virtual machine under QEMU
with the Hypervisor framework (`qemu-system-aarch64 -accel hvf`) on the Apple M4 Pro
host. The guest runs a lightweight graphical session (Xvfb or a minimal Wayland
compositor — decided at RT-003) with AT-SPI for accessibility. Guest size: 2 vCPU,
2–4 GB RAM, qcow2 overlay on a pinned base image. The runtime drives the VM over a
host↔guest control channel (virtio-serial or SSH — decided at RT-004), never over
VNC/RDP, so no human ever installs a remote-desktop client.

**Why a VM, not a container.** The evaluated alternatives:

| | Linux VM (QEMU+HVF) | Container desktop (Docker) |
|---|---|---|
| Isolation | Hardware virtualization; kernel boundary. A guest crash or `kill -9` storm cannot touch the host or other desktops. | Shared host kernel; weaker boundary. |
| Lifecycle fidelity | Full OS: real display server, real AT-SPI bus, real systemd/session semantics. `reset` = qcow2 discard + reboot; cost measured at RT-011 (M1-017's 8.3–8.6 s figure is the Windows *live-snapshot* path — RAM+disk restore — not a Linux cold boot; per M1 coordinator review it is not inherited). | No hardware display; Xvfb-in-container works but shares kernel state (e.g. udev, input devices) with the host. |
| Destructive actions | Safe: an agent can `rm -rf /` inside a disposable VM. | Unsafe or requires privileged containers, which erode the boundary. |
| Cost | Boot + 2–4 GB RAM each. HVF gives near-native CPU on ARM64; actual Linux boot/reset cost measured at RT-011, not estimated here. | Near-instant start, ~100 MB overhead. |
| Density | Low (a few concurrent desktops on 24 GB with the Win11 VM at 8 GB). | High. |
| Matches product direction | Yes — vision names Windows and cloud VMs; a VM backend trait generalizes. | Only Linux, ever. |

The deciding factors: (1) **disposability must be real** — the runtime's core promise
is that an agent can do anything inside the desktop and `destroy` leaves nothing; only
a VM makes that unconditionally safe on a shared host. (2) **The interface generalizes**
— M1 already needs a Windows/UTM backend later; a VM-shaped `Backend` trait
(create/observe/act/reset/destroy over a control channel) ports to UTM and to cloud
VMs; a container-shaped one does not. (3) Boot cost (to be measured at RT-011; M1-017's
8.3–8.6 s is the Windows live-snapshot path and is deliberately not inherited) is
expected to be acceptable for agent tasks measured in minutes, and `reset` reuses the
same path. Container density is a real loss; it is accepted for v0 and revisited if
fleet Linux desktops become the dominant use.

**RAM discipline.** Budget: Win11 VM 8 GB (M1, may be running) + one runtime VM at
2 GB + host ≈ 14 GB of 24 GB. The runtime MUST enforce a configurable cap on
concurrent desktops (default 1) and MUST shut down idle VMs (configurable idle
timeout, default off while developing). Two concurrent runtime desktops at 2 GB each
stay within budget; 4 GB guests require the Win11 VM to be down.

**Rejected.** Docker-in-Docker container desktop (weaker isolation, wrong shape for
Windows later, host-kernel sharing defeats disposability). Native macOS guest via
Virtualization.framework (Apple licensing limits macOS guests to 2 concurrent, no
headless snapshot story, and macOS is not the first target). UTM for the Linux guest
(unnecessary GUI wrapper; raw QEMU+HVF is scriptable without TCC/Automation grants —
M1's OSStatus -1743 lesson — and keeps the runtime dependency-free beyond QEMU).
Cloud-hosted first backend (account + cost, against the brief).

**Consequences.** Base image: Ubuntu Server 24.04 ARM64 cloud image (or Debian
equivalent — RT-002 picks and pins SHA-256). The `Backend` trait is the seam: a later
`UtmWindowsBackend` (anticipating `myco-win11`, which this workstream must not touch
without M1-coordinator sign-off) and a `CloudBackend` implement the same six ops.

## ADR-0012 — Boundary with M1: Rust owns lifecycle, M1 owns execution and verification [CONSEQUENTIAL]

**Decision.** The Rust runtime is the **desktop lifecycle and session layer only**. It
provisions desktops and exposes six operations (`create`, `observe`, `act`,
`evidence`, `reset`, `destroy`) with a state model, permissions, and an evidence
envelope. It contains **no** program runner, no guarded-action engine, no verifier
orchestration, no fault injection, and no verdicts. Those remain M1's TypeScript host
runtime per ADR-0001. The Rust runtime is to M1 what UTM+QEMU plus `myco-agent` are
today: the thing under it.

**Consumption path.** M1's TS runtime consumes a Rust-provisioned desktop through the
same `Backend`/`AppAdapter` seam it uses for the fake app and the Windows guest agent:
- `create`/`reset`/`destroy` replace M1's `vm.sh`/`reset.sh` shell-outs for
  Rust-provisioned hosts (the Windows VM path is untouched; M1 keeps owning it).
- `observe`/`act` map onto the adapter interface (opaque refs, `StaleRefError`,
  three-way action outcome — ADR-0003's shapes, which the Rust runtime adopts
  verbatim so both layers speak one vocabulary). `act` is a transport/actuation
  primitive only: it reports whether the action landed, never whether the task
  succeeded. Policy, guarded programs, and verification stay host-side in M1's TS
  engine (ADR-0001).
- Verification stays in M1: M1's verifiers read through `observe` (or their own
  channels, e.g. UNO) exactly as today. The Rust runtime never emits verdicts.

**Evidence.** The Rust runtime's `evidence` op emits M1's evidence schema as-is
(`schemas/`, `docs/architecture/evidence-schema.md`, M1-012): session-level events are
`trace.jsonl` lines in the M1 trace vocabulary, and the per-session summary is a
`result.json` RunRecord including its weighted partial_scores shape. The runtime layer
never assigns verdicts — verdicts are M1's alone — so runtime-produced records carry
no task-success claims. Resolution (M1 coordinator, 2026-11-19, ADR review accepted):
a schema PR against `schemas/` adds a `recordKind` discriminator to `result.json` —
`"run"` (verdict required, current behavior) vs `"session"` (verdict forbidden, checks
optional) — keeping M1's "no verdict without verification" invariant machine-enforced.
Until that PR lands, the runtime does not emit verdict-less records under the current
schema (RT-009 blocked on it; the schema PR is RT work, reviewed by M1 as normal).
Any further schema need follows the same path: PR against `schemas/`, flagged to the
M1 coordinator; never a fork, never a parallel format.

**Consistency with ADR-0001.** ADR-0001 decided the *core runtime* (state model,
program runner, verifier orchestration, evidence, eval harness) is TypeScript, with
the guest side thin. This ADR does not revisit it: nothing in the Rust runtime
duplicates that list. Rust was rejected in ADR-0001 for the 6-week M1 core; the
desktop lifecycle layer is out of M1's scope and is where Rust's ownership model and
QEMU/process supervision pay off. If a future requirement pulls execution or
verification semantics into the Rust layer, that is a conflict with ADR-0001 and is
escalated, not decided here.

**Interface record.** The concrete interfaces each side needs from the other are
maintained in `docs/coordination/runtime-state.md` (owner: RT workstream), with
cross-workstream changes routed through the Myco M1 Coordinator.

## ADR-0013 — API surface: MCP server primary, CLI with JSON I/O as the same core [CONSEQUENTIAL]

**Decision.** The six operations are exposed two ways from one Rust core library:
1. **MCP server** (stdio transport) — the primary agent-facing surface. The target
   consumer (Oh My Pi and any MCP-capable agent) speaks MCP natively; MCP gives
   tool discovery, schema validation, and structured errors for free.
2. **CLI with JSON I/O** (`myco-rt <op> <json-args>` on stdin/stdout, newline-delimited)
   — the same op handlers behind a thin argv/stdio front end. Used by the integration
   tests, by non-MCP callers (M1's TS runtime shells out), and for debugging.

**Why both.** MCP-only would force every consumer (including CI tests and M1's
existing NDJSON habit from the guest-agent protocol) to stand up an MCP client;
CLI-only would deny agents discovery and typed schemas. The cost is small: one
`myco-rt-core` library, two front-end crates, one shared op-handler table. The
protocol shapes (opaque refs, three-way outcomes, StaleRefError) follow ADR-0003's
vocabulary per ADR-0012 so M1 and agents see one language.

**Rejected.** MCP-only (testability, M1 integration friction). CLI-only (no
discovery/schema surface for agents). HTTP server (a third surface with auth
questions; stdio MCP + CLI covers v0's consumers).

## ADR-0014 — Guest observation/actuation stack: adopt xa11y, X11 session, HCU contract shapes

**Decision.** Following the prior-art evaluation
([docs/research/runtime-prior-art.md](../research/runtime-prior-art.md), RT-001):

- **ADOPT `xa11y` 0.16.1** (`xa11y` + `xa11y-core` + `xa11y-linux`, MIT, crates.io,
  aarch64-linux CI) as the in-guest accessibility + input layer, behind our own
  `Backend` trait so no xa11y type leaks into the six-op API. Semver churn risk
  (pre-1.0, single maintainer) is managed by pinning the exact `=` version triplet
  the xa11y workspace itself enforces.
- **X11 session, not Wayland, for v0.** xa11y's Wayland screenshot path goes through
  the xdg portal with an interactive consent prompt — a hard blocker for unattended
  agents. X11 gives prompt-free `GetImage` screenshots and XTest input. The guest
  display is Xvfb (headless) unless RT-003 finds a reason for a real compositor.
- **Base image: Ubuntu Server 24.04 LTS ARM64 cloud image**, SHA-256 pinned in-repo.
  agent-desktop's post-mortems document that Ubuntu 22.04's AT-SPI bridge aborts on
  `Action.GetActions` — 24.04 is the floor.
- **BUILD everything else**, borrowing contract shapes: HCU's `aN/wN/rN` ref
  namespace, `input_emitted`/`effect_unknown` delivery honesty (maps onto xa11y's
  `Delivery::Unknown`), screenshot-bound layout lease for coordinate actions, and
  `allow_global_input: false` policy precedent; computer-use-rs's `AppState`
  observation-record shape and xdotool key-chord syntax. Neither is a dependency.
- **Read-back verification is mandatory in `act`.** agent-desktop's AT-SPI
  post-mortems document per-toolkit cases where a write returns `true` and changes
  nothing (and vice versa); an action's return value is never proof. This is the
  same discipline as ADR-0003's three-way outcome and is why `ActionOutcome` has
  `DeliveredUnverified`.
- **Reset design** (RT-006) studies cua's `cua-vmm` golden-snapshot technique
  (shared-RAM file + `x-ignore-shared` device state + CoW map + qcow2 overlay) as a
  concept source only; its driver crates are not on crates.io.

**Rejected.** computer-use-rs as a dependency (279 downloads, one contributor, two
weeks old, self-declared AI-generated portions — a liability under an
execution-guarantees promise). HCU as a dependency (Go binary, private wire
protocol, embedded Python provider — imports a second runtime for a contract we can
lift from MIT-licensed docs). agent-desktop code (`publish = false` everywhere; its
upstream is xa11y anyway). pyatspi/OSWorld's guest server (deprecated approach,
Python in the guest contradicts the thin-guest posture).
