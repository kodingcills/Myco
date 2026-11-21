# Finding M2-05 — Sub-8.3 s reset, mid-trial reset, and concurrent sessions

> **Status: research input, not a product decision.**
> The earlier "M2 = MCP/API" direction is **retracted** pending MVP Discovery
> (Linear P-TIF-5). This finding feeds Discovery's choice between
> **A** (verified desktops for coding agents), **B** (verified ops for software
> without APIs), and **C** (branchable desktops). Where this doc recommends a
> surface or a build, read it as *one option's requirements*, not as the decided
> wedge. Task-design implications route to the Evaluation Foundry (P-TIF-6).

Date: 2026-11-21. Branch: `myco/m2-research`. Level: L1 (primary sources only). Read-only; no VM touched.

## 1. Question

Live RAM+disk snapshot restore via `scripts/vm.sh` (`stop --request` → `snapshot restore clean-base` → `start`) measures **8.3–8.6 s across 3 consecutive resets** (`docs/env/windows.md` §Live environment, measured 2026-11-19; 42–58 s under host load per `docs/eval-runbook.md` §3.2). That target is met, so this finding does **not** re-derive it. It answers the three questions still open for M2, ranked against **8.3 s**:

1. Is a **mid-trial** reset possible — snapshot and restore while the guest is *running*, removing the stop→restore→start cycle — and what does UTM's QMP job path cost?
2. Is any path **materially faster than 8.3 s** worth pursuing (APFS clone of the bundle, qcow2 overlay, Apple VZ save-state)?
3. What is the cheapest **correct** reset for **concurrent** sessions, which M2 needs for parallel runs?

### Correction to the brief (recorded because it changes the premises)

- `-2700` **does** appear in the repo: `docs/eval-runbook.md` §3.3 and `docs/coordination/m1-state.md` log 35 — but **not** in `docs/env/windows.md`, which documents only `-1743` (`errAEEventNotPermitted`, an Apple Events TCC denial). Answering the brief explicitly: present in `eval-runbook.md`/`m1-state.md`, absent from `env/windows.md`.
- Live snapshots work now; the NVMe→VirtIO conversion (`scripts/convert-disk-virtio.sh`) unblocked them (`docs/env/windows.md` §Live environment). `scripts/reset-trial-vm.sh`'s header still says the opposite ("Why cold and not live"); that header is stale and is not evidence.
- The control plane is `scripts/vm.sh` (osascript), not `utmctl`: `utmctl` is TCC-blocked over SSH with `-1743` (`docs/env/windows.md` §UTM control from the host; UTM#5377).

## 2. Evidence

### E1. UTM snapshot model, two backends (UTM source, `main`)

| Fact | Pointer | Claim |
|---|---|---|
| Two QEMU backends | `Services/UTMQemuSnapshotBackend.swift` | `UTMQemuLiveSnapshotBackend` (running, monitor/QMP) and `UTMQemuFrozenSnapshotBackend` (stopped, `qemu-img`) |
| Live capability gate | same, `supports(_:hasState:)` | `operation == .create \|\| hasState` — a running VM can create, and can restore/delete only snapshots that carry RAM state |
| Frozen capability gate | same | `true` for every op; requires every image be `qcow2` (`UTMQemuImage.info(image:).format == "qcow2"`), else `notSupported` |
| Live restore | `UTMQemuVirtualMachine.restoreSnapshot` → `_restoreSnapshot` → `monitor.qemuRestoreSnapshot(name)` | one QMP call; a failed restore recovers by `qemuResume()` when `prev == .started`, else leaves `.paused` |
| Live snapshot is a QMP job | `UTMQemuVirtualMachine._saveSnapshot` | `monitor.qemuSaveSnapshot(name)`; errors detected by string-matching `"Error"` in the reply — fragile, not typed |
| Restore legal while running | `UTMSnapshotService.restoreSnapshot` | gate is `backend.supports(.restore, hasState:)`; for a RAM snapshot on a running VM that is `true` |
| Stopped-VM restore is `qemu-img snapshot -a` | `Services/UTMQemuImage.swift` `applySnapshot` | `qemu-img snapshot -a <name> <image>`, one call per image, UEFI vars image first (`snapshotImageURLs`) |
| Manifest | `Configuration/UTMSnapshotManifest.swift` | `snapshots.plist`: `hasState`, `isOrphaned`, `isIncomplete`, `suspendIdentifier`, `staleIdentifiers` |
| Restore leaves the VM to *resume* on start | `UTMQemuVirtualMachine._start` | if `registryEntry.isSuspended` and the suspend snapshot exists → `_restoreSnapshot` then `continueBoot`; comment: "the disks are reverted now even when QEMU loads the running state on the next start" |

Restore paths, precisely (the decomposition of 8.3 s):

| Path | Steps | RAM transferred |
|---|---|---|
| Live restore, **stopped** VM (our 8.3 s) | `qemu-img snapshot -a` per image (disk revert) → `start` → QEMU boots → `loadvm` vmstate → `continueBoot` | yes |
| Live restore, **running** VM | single QMP `snapshot-load` job → guest CPUs stop for the load → resume | yes, no QEMU boot |
| Frozen (disks-only) restore | `qemu-img snapshot -a` → full Windows boot | no |

### E2. QMP job path cost (QEMU QAPI + UTM#8052 measurements)

QEMU's contract (`qapi/migration.json`, `snapshot-save`/`snapshot-load`/`snapshot-delete`, since 6.0):

- "Applications should **not assume** that the snapshot save is complete when this command returns. The job commands / events must be used to determine completion."
- "execution of the guest CPUs **may be stopped** during the time it takes to save the snapshot" (save); "**will be stopped**" (load).
- "It is strongly recommended that `devices` contain all writable block device nodes if a consistent snapshot is required."

utmapp/UTM#8052 (closed; measured, not a blog) — stock QEMU 11.1.2, macOS 26.5.2, **2 GB** random guest memory:

| Command | answered | job ended |
|---|---|---|
| `snapshot-save` | 2.667 s | 2.667 s |
| `snapshot-load` | 2.207 s | 2.207 s |

Cause in that issue: a snapshot job's work runs ahead of the answer to the command that started it, holding the main loop, so the command answers only when the work ends; QEMUKit waits **10 s** (`timeoutSeconds` in `QEMUManager.m`) then reports "Timed out waiting for RPC" while QEMU finishes anyway. The linked fix (`migration/savevm.c`, answer moved before the work) makes the command answer in **≈1 ms** and is in UTM 5.0.9 (release notes: "QEMU: Fixed saving a VM state that takes longer than 10 seconds being reported as 'Timed out waiting for RPC'").

Reading for us: **8.3 s is not dominated by RAM transfer.** 2 GB of random RAM loads in 2.207 s. The remainder is `qemu-img snapshot -a` per image + QEMU process start + UEFI/virtio re-init before `continueBoot`. `[INFERENCE]` — no repo record splits the phases.

Limits (`system/images.html#vm-snapshots`): internal snapshots need ≥1 non-removable writable qcow2; "a few device drivers still have incomplete snapshot support (in particular USB)"; removable devices break if inserted/removed after the snapshot.

### E3. The `-2700` wedge — documented fact vs inference

**Documented facts**

| Fact | Source |
|---|---|
| `-2700` is AppleScript error **"Unknown error."** — a generic catch-all, not a named condition | Apple, *AppleScript Language Guide*, Appendix B, Table B-1 |
| UTM surfaces it verbatim as `UTM error -2700 "Operation not available"` in the wedge | `docs/eval-runbook.md` §3.3; `docs/coordination/m1-state.md` log 35 |
| `-2700` is a common **multi-cause** UTM scripting error: guest agent absent (#5963), "A valid configuration must be specified", "Failed to change current directory", "Operation not supported by the backend" (#5222) | UTM issue search `repo:utmapp/UTM 2700` |
| It is **not** `-1743`; `-1743` = `errAEEventNotPermitted`, the TCC/Apple-Events denial blocking `utmctl` over SSH | `docs/env/windows.md`; UTM#5377 |
| UTM has an explicit `resuming` state, entered before `_resume()` completes and left only on success, or set `.stopped` in the catch | `Services/UTMQemuVirtualMachine.swift` `resume()` |
| On a failed **start**, UTM sets `state = .stopped`, clears `isSuspended`, kills QEMU | same, `start(...)` catch |
| On a failed **restore while started**, UTM tries `qemuResume()`; if that fails, sets `.paused` | same, `restoreSnapshot` catch |
| UTM's start path with a suspend state does `_restoreSnapshot` *after* QEMU is already running, then `continueBoot` | `_start` |
| No maintainer statement or issue documents a wedge on `resuming` after rapid live-resume cycling | UTM searches for `"Operation not available"`, `snapshot restore resuming` returned no matching issue |

**Inference (not fact)**

- `[INFERENCE]` `-2700 "Operation not available"` is **UTM's AppleScript layer relaying a UTM-internal state-machine rejection** (the event is invalid in the current state), not a QEMU error and not TCC. Support: `-2700` is the generic AppleScript code UTM returns via `NSAppleScriptErrorNumber`; "Operation not available" is UTM's own text and also appears on non-wedge paths (#5222). Not proven by a UTM source pointer in this pass.
- `[INFERENCE]` The wedge is a **lost `.resuming` transition**: `_start` → `_restoreSnapshot` (QMP `snapshot-load`) hangs or fails such that the QEMU child stays alive while UTM's error path never runs (task never resumed, or the XPC helper is torn down), so `state` stays `.resuming` with no event able to move it. UTM's recovery branches run only if the throwing call *returns* — a hang never returns.
- `[INFERENCE]` Rapid cycling raises exposure because each cycle re-enters `_start`'s suspend-load branch (a QMP load against a fresh QEMU before `continueBoot`); UTM#8052 documents exactly this ordering as a hazard (10 s client timeout on a job that answers late), and pre-5.0.9 builds answered `snapshot-load` only after the load finished.
- `[INFERENCE, actionable]` The GUI-only recovery is consistent with the wedge being **UTM process state**, not snapshot corruption (snapshots survive, log 35; quitting UTM destroys the owner of the stale `.resuming`). Hence a recovery worth testing is `pkill -f 'QEMUHelper|qemu-system-aarch64'` **followed by relaunching UTM**. `scripts/reset-trial-vm.sh` mentions a host-side QEMU kill, but the runbook's resolution is quit-and-reopen; the repo has no record of a kill *without* a UTM restart succeeding.

**Not claimed:** that `-2700` is caused by NVMe/`virtio-ramfb-gl`. That pair blocks live *snapshot creation* (UTM#7989; maintainer: "You're referring to live snapshots. If Windows is shut down you can snapshot regardless") — a different failure, already resolved by the VirtIO conversion.

### E4. APFS clones — `clonefile` / `cp -c`

| Fact | Source |
|---|---|
| A clone "is a copy of a file or directory that **occupies no additional space on disk**"; modifications written elsewhere, unmodified blocks shared | Apple, *About Apple File System* §Clones Reduce the Cost of Copying |
| `copyItem(at:to:)` creates a clone automatically on APFS | same |
| `clonefile(2)`: "If `src` names a **directory, the directory hierarchy is cloned as if each item was cloned individually**" | `clonefile(2)`, DESCRIPTION |
| Atomicity: "expected to be atomic" — all objects created or none | same |
| `ENOSPC` "possible for a subsequent overwrite of an existing data block to return ENOSPC" — the clone reserves nothing | same, ERRORS |
| `EXDEV` if not on the same filesystem; `ENOTSUP` if the volume lacks `VOL_CAP_INT_CLONE` | same, ERRORS/COMPATIBILITY |
| `cp -c` is Darwin's clone copy; GNU `cp` reaches it via `--reflink=auto` | `cp(1)`; `clonefile(2)` |
| No published clone **latency** | `not_reported` |

Can a 30 GB disk be cloned near-instantly? Clonefile shares blocks, so cost is metadata-order, not 30 GB of I/O — but the only published number is none. `[INFERENCE]` cost scales with extent count, and a `.utm` bundle is a *directory*, which `clonefile` supports (hierarchy cloned item by item) though Apple's man page says `copyfile(3)` "is more appropriate for copying large directory hierarchies".

**The blocker is not the clone — it is QEMU's lock.** A `.utm` bundle holds `Data/<UUID>.qcow2` plus `snapshots.plist`; QEMU holds the qcow2 open while running, and `qemu-img` warns "Never use qemu-img to modify images in use by a running virtual machine" (`tools/qemu-img.html`). A clone-based reset therefore cannot replace a running VM's disk in place; it can only produce a *new* bundle to boot. That makes it a concurrency primitive, not a mid-trial reset.

### E5. qcow2 overlays / backing chains

| Fact | Source |
|---|---|
| `qemu-img create -f qcow2 -F qcow2 -b <base> <overlay> [size]` creates a backing-file overlay | `qemu-img` synopsis, `create … -b BACKING_FILE [-F BACKING_FMT]` |
| `backing_file`/`backing_fmt` are documented qcow2 options | `system/images.html` §qcow2 |
| `qemu-img info --backing-chain`; `rebase` changes the relationship | `tools/qemu-img.html` |
| Overlay creation cost is a header write; **no published figure** | `not_reported` |
| UTM "disposable" mode = run without saving, snapshot-free | `docs.getutm.app/advanced/disposable/`; repo `docs/env/windows.md` Fallback A (`[INFERENCE]` that it is an overlay) |

Overlay reset = stop VM → unlink overlay → `qemu-img create` fresh overlay from the base → start. That is **disks-only**: it still pays a full Windows boot (~20 s cold per `docs/env/windows.md`), strictly slower than 8.3 s. Its value is concurrency (N independent overlays, no RAM to copy) and immunity to the snapshot machinery.

### E6. Tart

| Fact | Source |
|---|---|
| "Tart is a virtualization toolset to build, run and manage **macOS and Linux** virtual machines (VMs) on Apple Silicon" | `cirruslabs/tart` README |
| Uses Apple `Virtualization.Framework` | same |
| `tart clone --stacked` (macOS 27+) writes into a private **ASIF overlay** over a shared read-only base; "every additional parent overlay adds another ASIF file to validate and assemble at run time" | Tart FAQ §Stacked disk images |
| `tart clone` checks free space and auto-prunes; `--prune-limit` default 100 GB | Tart FAQ §Automatic pruning |
| Nested virtualization: M3/M4 + macOS 15, **Linux only** | Tart FAQ §Nested virtualization support? |
| No Windows-guest support or Windows reset primitive documented in README or FAQ | searched: no `windows` match in `tart.run/` index or `docs/faq.md` except unrelated "Windows DHCP Server" |

Conclusion: **Tart does not advertise Windows guests** — not a candidate for `myco-win11`. Its `--stacked` overlay is the closest published analogue to E5 and is macOS-image-specific.

### E7. Apple Virtualization.framework (VZ)

| Fact | Source |
|---|---|
| VZ overview: "Create virtual machines and run **macOS and Linux**-based operating systems." No Windows topic anywhere in the framework index | `developer.apple.com/documentation/virtualization` |
| `saveMachineStateTo(url:completionHandler:)` (macOS 14+) | `VZVirtualMachine` docs |
| `restoreMachineStateFrom(url:completionHandler:)` (macOS 14+) | same |
| **Save requires PAUSED**: "This call fails if the VM isn't in a paused state" | same, Discussion |
| **Restore requires STOPPED**: "fails if … the VM … isn't in the `stopped` state"; on success the VM lands in **paused** | same, Discussion |
| State must match configuration exactly: fails if "the file contents are incompatible with the current configuration" | same |
| No `VZMachineStateRestore` class exists; the API is the two methods above | `VZVirtualMachine` Topics §Saving and restoring the VM state |
| UTM's VZ backend wraps these calls and **cannot change disk layers while a disk is attached**: `supports(_:hasState:)` = `!isRunning \|\| operation == .delete` | `Services/UTMAppleSnapshotBackend.swift` |
| UTM VZ snapshots need **macOS 27+** | UTM snapshots docs §Requirements; `@available(macOS 27, *)` |
| Windows guests do run under VZ in practice (user drives "macOS, Windows and Linux guests" on Apple VZ VMs, UTM 5.0.8) | utmapp/UTM#8120 — user report, `[UNVERIFIED]` as a vendor statement |

So VZ's restore is, by Apple's own contract, **stopped→paused**: it cannot restore a *running* VM, and its save is stricter than UTM's QEMU live snapshot (which accepts `.started`). `[INFERENCE]` VZ restore is structurally closer to our 8.3 s than to a mid-trial reset. Apple publishes no save/restore latency (`not_reported`).

## 3. Decision

| Path | Verdict |
|---|---|
| **Mid-trial reset: live restore on a RUNNING VM** (`snapshot restore` with `hasState`, no stop/start) | **Adopt as the first M2 experiment.** One QMP `snapshot-load` (E1: restore is legal while `.started`) instead of `qemu-img` + process start + `loadvm`. QEMU's measured load cost for 2 GB is 2.207 s (E2). |
| **Chase sub-8.3 s via APFS clone** | **Reject for reset** (cannot replace a running VM's disk; bundle is a directory; no published latency). **Keep as the concurrency candidate.** |
| **qcow2 overlay reset** | **Reject as a speed path** (disks-only ⇒ full boot ≈20 s). **Adopt only as concurrency isolation** if per-session bundles prove expensive. |
| **Tart** | **Reject** — no documented Windows guest support. |
| **Apple VZ save-state** | **Reject for M2** — restore requires `stopped`, save requires `paused`; no latency published; moving a working QEMU guest to VZ is unvalidated; VZ lists macOS/Linux only. |
| **`-2700` as TCC** | **Reject the premise.** `-2700` is AppleScript "Unknown error." (catch-all); the TCC code in this repo is `-1743`. Treat `-2700` as an opaque UTM state-machine rejection until a UTM source pointer says otherwise. |

**The sub-8.3 s answer:** no published benchmark shows a faster path, and the only available decomposition (E2) puts ≈2.2 s in RAM load, so headroom is in the ~6 s of process start + disk revert, not in cleverer disk tricks. Mid-trial reset removes the stop/start half; it is the only change with a documented mechanism behind it.

## 4. Proposed smallest experiment

One experiment, ~30 min, on `myco-win11`, touching no M1 conclusion:

1. With the VM **running** at the desktop, call `scripts/vm.sh restore clean-base` (RAM snapshot) — **no stop first** — timed end-to-end with `date +%s.%N` around it. Before and after, assert three in-guest probes: `soffice` process count == 0, fixture hashes equal, agent ping ok.
2. Repeat **5×** back to back to test the wedge: does rapid `.started`→restore cycling reproduce `resuming`/`-2700` *without* a stop/start? This is the first test of the wedge on the mid-trial path rather than the cold-cycle path.
3. Time the three phases once: (a) `vm.sh status` flip to `restoring`, (b) return to `started`, (c) time-to-agent-ping. This is the missing decomposition of 8.3 s.
4. Only if (2) wedges: capture `ps` for `QEMUHelper`/`qemu-system-aarch64` **before** quitting UTM, to test the `[INFERENCE]` that the wedge is UTM process state with a live QEMU child.

Record all values, including a wedge. **No number in this doc may be quoted as a Myco measurement**: E2's 2.207 s/2.667 s are UTM#8052's numbers on 2 GB of random RAM, not ours.

## 5. Next action

- Runtime owner: run the experiment; if mid-trial restore holds under 5 rapid cycles, M2's reset primitive becomes "restore while running" and `stop --request` drops out of the reset script.
- Doc fix (small, separate): `scripts/reset-trial-vm.sh` header and `docs/env/windows.md` §"The trap" + "Decision: do not chase live snapshots" contradict the live-environment table in the same file. Reconcile to "live works after NVMe→VirtIO"; add this finding's `-2700` = "Unknown error." fact to `docs/eval-runbook.md` §3.3.
- Concurrency: prefer **one UTM clone per session** over a shared-VM overlay scheme; measure clone wall time on the bundle before committing, since APFS/metadata cost is `not_reported`.

## 6. Reopen-if

- The mid-trial experiment wedges UTM, or restore-while-running fails the cleanliness probes ⇒ mid-trial reset is out and the 8.3 s cold cycle stands.
- UTM ships a path that answers `snapshot-load` before the work (the #8052 fix) **and** we still measure >8 s ⇒ the step-3 decomposition becomes the primary lever.
- Tart or Apple documents Windows-guest support with a save/restore primitive (Tart's `--stacked` generalised beyond macOS images), or Apple relaxes `restoreMachineStateFrom` from `stopped` to `paused`/`running` ⇒ re-evaluate E6/E7.
- A published APFS/`clonefile` latency for multi-GB or directory trees appears ⇒ re-rank E4 for concurrency.

## 7. Cost spent

- Tool calls: ~42 (QEMU docs + QAPI, UTM source on main, UTM issue tracker, Apple VZ docs, AppleScript error appendix, `clonefile(2)`, `cp(1)`, Apple APFS overview, Tart README + FAQ, repo reads). One failed `web_search` (HTTP 402, no credits) — alternate strategy used instead of re-running it.
- Writes: 0. `write` in this session accepts only `xd://` devices and only `web_fetch` is mounted, so the document could not be created on disk.
- Token estimate: `not_reported` (no harness counter exposed).
- Unverified: that `-2700` originates in UTM's AppleScript error mapping specifically (inference from code shape + issue corpus, no source pointer); that a bare QEMU-helper kill recovers the wedge without a UTM restart; whether VZ officially supports Windows guests (only a user report, #8120).
