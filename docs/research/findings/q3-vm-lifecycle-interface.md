# Finding Q3 — Minimal host interface for VM lifecycle

Date: 2026-11-19. Level: L1 (2 scout extractions, verified against primary sources).

## Question

What minimal host interface supports VM lifecycle operations (create, snapshot,
reset, and later fork) without coupling Myco to QEMU or KVM? Sources: QEMU
snapshot docs, Orgo's pause/fork/clone surface, and Cua's cua-vmm — checked
against the runtime workstream's `Backend` trait.

## Evidence

**Runtime trait as it exists** (branch `myco/runtime-v0`,
`runtime/crates/myco-rt-core/src/ops.rs`): `Backend { provision, observe, act,
reset, destroy }`. The `Session` wrapper owns phase transitions
(creating/ready/resetting/destroyed/failed), permissions, and state versions.
Sixth op `evidence` is session-level, not on the trait. There is deliberately
**no snapshot or fork op today**.

**QEMU primary docs** (verified 2026-11-19 against qemu.org/docs/master):

- Internal snapshots (`savevm`/`loadvm`) include CPU+RAM+device state when the
  guest is running; stored in the first writable qcow2 device. **Not
  deprecated** in current master docs (checked `about/deprecated.html`), though
  the migration docs promote mapped-ram/background-snapshot as the modern path.
  Limitation: requires ≥1 non-removable writable qcow2; USB and removable
  devices have incomplete snapshot support. (system/images.html#vm-snapshots,
  system/monitor.html)
- `x-ignore-shared` migration capability: real, QMP-documented, **experimental
  (unstable) flag** (interop/qemu-qmp-ref.html, MigrationCapability). The
  capability semantics are documented; the full CoW-RAM golden-snapshot recipe
  is documented as **VM templating** (system/vm-templating.html:
  `memory-backend-file,share=on`, clones map the same file read-only), which
  explicitly leaves VM-state save/restore to "migrate-to-file with
  x-ignore-shared" without elaborating. cua-vmm's golden-snapshot design
  (index: `repo:trycua/cua`) composes exactly these two documented halves.
- qcow2 backing files/overlays: documented mechanism; multi-guest sharing is
  an inference from the mechanism (file locking caveats apply).

**Orgo** (verified 2026-11-19 against docs.orgo.ai + published OpenAPI 3.1 spec
v2.0.0; the "pause/fork/clone blog post" does not exist — orgo.ai/blog is a
site summary; all technical content is in the API docs):

- `POST /computers/{id}/fork` — copies **disk + live memory**; child comes up
  running from the same instant; source pauses ~2 s during memory copy; Linux +
  running only; `NOT_FORKABLE`/`computer_asleep` errors.
- `POST /computers/{id}/clone` — **disk-only** copy, fresh boot.
- suspend/resume = pause (memory to/from storage); stop = archive disk
  (`frozen`); create optionally from `template_ref` (golden image = their
  snapshot-as-template primitive).
- No CoW/dedup/hypervisor mechanism publicly disclosed (`fly_instance_id`
  hints Fly.io-derived infra) [INFERENCE by scout].

**Cua cua-vmm** (already indexed, runtime-prior-art.md §4): golden snapshot =
shared RAM `memory-backend-file` + `x-ignore-shared` migration stream + qcow2
overlay, each VM restored paused with CoW RAM; `freeze()` folds the disk into
a layer. Consistent with both QEMU docs above.

## Decision

**Adopt an interface decision now; no new ops until needed.** The minimal
interface is the runtime's existing five-op `Backend` trait **plus exactly two
lifecycle verbs when fork/search lands**:

1. **Today (v0, correct as-is):** `provision / observe / act / reset /
   destroy`. `reset` = "return to clean desktop" — its *implementation* is the
   golden-snapshot + qcow2-overlay pattern (ADR-0011 already commits to qcow2
   overlay on a pinned base). Nothing in the verified evidence requires
   exposing `snapshot` as a public op for M1 or dogfood Phase 1.
2. **When fork/branch search lands (post-M1, vision.md step 3):** add
   `snapshot() -> SnapshotHandle` and `fork(SnapshotHandle) -> Session`
   (returns a *new* session, matching Orgo's fork-creates-new-id shape), rather
   than overloading `reset` with optional parameters. Rationale from evidence:
   - QEMU's own docs split the two halves (memory-backend-file CoW vs
     x-ignore-shared state save), so the interface must not promise
     "snapshot = cheap" — a RAM-inclusive snapshot is a 2-second-class
     operation (Orgo's measured pause), not a millisecond one.
   - Orgo's fork-vs-clone split (live-memory vs disk-only) is the right
     semantic distinction to encode as `fork` (memory-inclusive, from a
     snapshot handle) vs `provision(template=…)` (disk-only, fresh boot —
     already expressible in the current trait).
   - Keep it backend-agnostic: the trait must never name qcow2, QEMU, or KVM.
   `UtmWindowsBackend` (RT-012) will implement `reset` via UTM snapshot
   restore (M1-017: measured 8.3–8.6 s) and may legitimately answer
   `fork` with `Unsupported` — the `Failed{reason}`/`uncertain` honesty bar
   applies to lifecycle ops too.
3. **Do not** adopt cua-vmm or Orgo as dependencies (already decided: cua
   driver crates unpublished; Orgo is a paid hosted service — outside the
   no-paid-accounts rule). Their value is the verified interface semantics
   above.

## Proposed smallest experiment

None at L1. The cost numbers that would justify `fork` (snapshot-restore time
vs intent-log replay time) come out of two already-planned items: RT-011
(runtime reset-cost measurement) and the Q4 delayed-error L2 (which tests
intent-log replay as the cheap substitute for fork). Decide `fork`'s priority
after both report.

## Next action

Route to the Runtime Owner thread via the outer loop: the Q3 recommendation is
a note on the ADR-0011/0012 seam (when RT adds fork, use the two-verb shape
above), not a request to change scope. No Linear issue needed unless the outer
loop wants fork scheduled.

## Reopen-if

- RT-011 measures reset cost high enough that mid-task snapshots pay for
  themselves before fork/search is scheduled.
- cua-vmm ships its driver crates to crates.io, or QEMU stabilizes
  `x-ignore-shared` (drops the experimental flag) — both reduce the risk note
  above.
- UTM proves unable to implement memory-inclusive snapshots at all
  (`UtmWindowsBackend.fork` permanently `Unsupported`) — then Windows
  fork/search needs the intent-log-replay path (Q4 experiment) instead.

## Cost spent

2 scout extractions (QemuSnapshotDocs 2m26s, OrgoLifecycle 1m36s,
deepseek-v4.1-flash), 1 synthesis pass (this thread). Index/ledger updated.
