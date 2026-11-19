# Finding Q1 — Which hybrid desktop-control implementation should Myco build on?

Date: 2026-11-19. Level: L1 (index hit; no new reading needed).

## Question

Microsoft Hybrid Computer Use (HCU), UFO², Cua, xa11y, or computer-use-rs —
which existing hybrid desktop-control implementation does Myco build on?

## Evidence

Already researched and verified against clones/primary sources:

- **UFO²** (`repo:microsoft/UFO`, docs/research/adapters.md §1): the
  FindAllBuildCache + 3-property-cache query shape is worth copying; its
  verification is an LLM judging screenshots (`evaluate.yaml`) — the failure
  mode M1 exists to fix. Windows-only, no UNO/LibreOffice.
- **HCU** (`repo:microsoft/Hybrid-Computer-Use`, `myco/runtime-v0:docs/research/runtime-prior-art.md §3`): contract shapes (`aN/wN/rN` refs, `input_emitted`/`effect_unknown`,
  layout lease, `allow_global_input`) are worth lifting; the Go binary with a
  private JSONL protocol and embedded Python provider is not consumable as a
  dependency.
- **Cua** (`repo:trycua/cua`, adapters.md §5, `myco/runtime-v0:docs/research/runtime-prior-art.md §4`):
  `cua-vmm` is the only open-source code found that solves golden-snapshot
  reset on Apple silicon (concept source for the runtime's create/reset); the
  driver crates are not on crates.io and the perception extension is AGPL.
- **xa11y** (`repo:xa11y/xa11y`, `myco/runtime-v0:docs/research/runtime-prior-art.md §1`): the only published,
  MIT, Rust-native Linux AT-SPI + actuation crate (0.16.1, crates.io; CI cross-checks
  xa11y-core for aarch64 and builds aarch64 wheels, but tests nothing on aarch64). Adopted by the runtime workstream behind its own `Backend` trait
  (ADR-0014).
- **computer-use-rs** (`myco/runtime-v0:docs/research/runtime-prior-art.md §2`): two weeks old, 279 downloads,
  one contributor, partially AI-generated per its own README. Rejected as a
  dependency; `AppState` observation shape borrowed.
- **agent-desktop** (not in the question's list, but the actual source of
  M1's primitives, adapters.md §2): opaque refs, STALE_REF/AMBIGUOUS_TARGET,
  three-way outcome, CUIAutomation8 bounded timeouts. `publish = false`, no
  COM/UNO — primitives reimplemented, no dependency (ADR-0003).

## Decision

**Already resolved; do not re-research.**

- **M1/Windows (ADR-0003, accepted by Tiffany 2026-11-19):** build on
  `uiautomation` + raw `comtypes` `SetConnectionTimeout`/`SetTransactionTimeout`;
  reimplement agent-desktop's primitives (opaque refs + stateVersion, three-way
  outcome) in Myco's vocabulary; UNO is the independent verifier channel.
  Rejected as dependencies: UFO (verification-by-LLM), Cua (AGPL perception),
  agent-desktop (no COM/UNO, unpublishable).
- **Runtime/Linux (ADR-0014):** adopt `xa11y` 0.16.1 behind the runtime's own
  `Backend` trait; borrow HCU's contract shapes; build everything else.
- **None of the five candidates in the question is adopted as a dependency for
  the control plane.** Each contributes shapes or one scoped crate (xa11y).

## Proposed smallest experiment

None. The decision is made and partially validated live (M1-008: uiautomation
2.0.29 + comtypes 1.5.0 + pyuno verified on the ARM64 VM; M1-010: fault
injectors green). The remaining risk is ADR-0003's documented escape hatch:
if the real-adapter phase (M1-006) hits an ARM64 wall, fall back to
agent-desktop's aarch64 FFI artifact.

## Next action

None for research. M1-006 (build owner) is the consumer of this decision.

## Reopen-if

- M1-006 fails on the real VM in a way the escape hatch doesn't cover.
- Post-M1 fork/branch search needs live-fork semantics — then re-evaluate
  cua-vmm vendoring for the runtime, not for M1.

## Cost spent

0 new tool calls (index + ADR lookup only). Prior cost already logged as
M1-002 in `ledger.jsonl`.
