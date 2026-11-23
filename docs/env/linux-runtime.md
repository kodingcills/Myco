# Myco runtime Linux guest (RT-003)

QEMU+HVF Linux ARM64 desktop for the Myco Desktop Runtime. Scripts:
[runtime/guest/](../../runtime/guest/). Decisions: ADR-0011 (host), ADR-0014
(guest stack). All claims below were measured on this Mac (2026-11-19), not inferred.

## Base image (pinned)

| | |
|---|---|
| Image | Ubuntu Server 24.04 LTS ARM64 cloud image (`noble-server-cloudimg-arm64.img`) |
| SHA-256 | `50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e` |
| Size on disk | 593 MB (raw download) |
| Verify | `runtime/guest/fetch-image.sh` checks the hash on every run; state at `runtime/guest/state/base-image.sha256` |

Guest: 2 vCPU, **2048 MB RAM cap (configurable via `MYCO_RT_GUEST_MB`)**, qcow2 overlay
over the pristine base. QEMU invocation (see `boot.sh`): `-machine virt -cpu host
-accel hvf -smp 2 -m "$GUEST_MB" -display none -bios
/opt/homebrew/share/qemu/edk2-aarch64-code.fd` + virtio-blk disk + cloud-init seed ISO
+ user-mode net with `hostfwd tcp:127.0.0.1:10022-:22`, `-daemonize`, serial log to
`state/serial.log`.

Memory discipline (RT-013, TIF-47). The `-m` value is a **ceiling, not a
reservation**: QEMU commits guest RAM lazily, so the host charge is the process RSS at
sample time, not the cap. Measured on this host (2026-11-22, `scripts/memory-budget.sh`):

| Guest | cap | observed host RSS |
|---|---|---|
| Myco Linux guest (this one) | 2048 MB | ~0 idle, rises toward the cap under a loaded desktop |
| `myco-win11` (UTM, M1's guest) | 6144 MB | 294–498 MB at sample |

So raising `MYCO_RT_GUEST_MB` does not immediately cost the host that much; it sets the
worst-case ceiling a loaded guest may reach. `scripts/memory-budget.sh` reads both
guests' live RSS and host pressure (`vm_stat`, `vm.swapusage`) and reports the headroom
for a second VM — the number the post-M1 second-VM question (TIF-92) needs. It is
read-only and touches no lock.

Idle shutdown (RT-013). `runtime/guest/idle-watchdog.sh` powers the guest off after
`MYCO_RT_IDLE_SECS` with no heartbeat. **It is not installed yet:** the cloud-init seed
(`runtime/guest/seed/user-data`) does not copy or start it, so a provisioned guest today
has no idle reaper and stays up until `destroy`/`shutdown.sh` (post-merge verifier,
TIF-110). Wiring it into the seed is a follow-up that needs a VM boot to prove. Default
when installed is **disabled** (`0`) — a session never vanishes silently; an
operator enables reaping explicitly with a documented timeout. Once installed and
enabled, the policy runs in the guest rather than the host, so a crashed host agent
would not leave a guest running. **Today it is neither**: a guest whose host agent
crashes stays up until someone runs `shutdown.sh` or kills QEMU.
`runtime/guest/idle-watchdog-test.sh` proves both directions on the host with no VM
(fires on a stale/absent heartbeat, holds on a fresh one); a mutation that disables the
decision turns exactly the two "fires" cases red.

## Package pins (as installed and verified in the guest, dpkg-query 2026-11-19)

xvfb 2:21.1.12-1ubuntu1.9 · openbox 3.6.1-12build5 · xdotool 1:3.20160805.1-5build1 ·
x11-xserver-utils 7.7+10build2 · python3-tk 3.12.3-0ubuntu1 · python3-gi 3.48.2-1 ·
gir1.2-atspi-2.0 2.52.0-1build1 · at-spi2-core 2.52.0-1build1 · gir1.2-gtk-3.0 3.24.41-4ubuntu1.3

## Measured timings (real runs)

| Phase | Time |
|---|---|
| Cold boot (existing overlay, cloud-init already applied) → SSH answers | 17 s |
| Cold boot → Tk app process up (GUI session fully up) | 23 s |
| First-ever boot incl. cloud-init package install | minutes (one-time per overlay) |
| Full `smoke.sh` against an already-running guest | ~2–3 s |

## Smoke results (`runtime/guest/smoke.sh`, PASS)

1. **AT-SPI tree read works** — with one hard requirement: dump as the **same uid as
   the apps**. Each uid gets its own AT-SPI registry/bus
   (`/run/user/1000/at-spi/bus` for `myco`, `/root/.cache/at-spi/bus_0` for root);
   a root-side dump sees root's *empty* registry. Observed tree:
   ```
   AT-SPI desktop children: 1
   application name='myco-gtk-sanity.py'
     frame name='MycoGtkSanity'
       label name='gtk-sanity-label'
   ```
2. **TK_ATSPI: ABSENT.** The Tk app (Listbox + Entry + status Label + Save button)
   registers **no AT-SPI node at all**, while the GTK sanity app in the same session
   is fully visible. Tk does not register with AT-SPI on Ubuntu 24.04 (Tk 8.6, no ATK
   bridge). This is the REQ-03 blocker evidence; fallback protocol triggered.
3. **Synthetic input lands in Tk via global XTEST**: `xdotool windowactivate` + click
   at app-published widget coordinates + `xdotool type` produced
   `entry_text: "hello-from-xdotool"` in the app's own state file. Caveat:
   `xdotool type --window <id>` (send_event synthetic keys) does NOT land in Tk;
   only global XTEST with real focus works.
4. **App-side introspection works**: the Tk app's self-published state JSON carries
   `listbox_rows`, `listbox_selection`, `status_text`, `entry_text` — exactly the
   fields Dogfood REQ-03 needs, available without AT-SPI.

## Lifecycle

```
runtime/guest/provision.sh           # keypair, image, overlay, seed; never boots (--check reports, exit 1 if incomplete; exit 3 = agent missing)
runtime/guest/provision.sh --build-agent  # + the guest agent: BOOTS A VM, under the host VM lock + SESSION.lock (exit 10 if held)
runtime/guest/fetch-image.sh         # download + SHA-256 verify (idempotent)
runtime/guest/create-overlay.sh      # qcow2 overlay over the pristine base
runtime/guest/boot.sh                # QEMU+HVF, headless, daemonized (idempotent); takes the host VM lock (exit 10 if held), held by qemu for the guest's life (TIF-137)
runtime/guest/smoke.sh               # boots if needed; AT-SPI + input proofs
runtime/guest/shutdown.sh            # clean shutdown over SSH; overlay kept
runtime/guest/idle-watchdog.sh       # guest-side reaper (NOT installed by the seed yet): self-shutdown after MYCO_RT_IDLE_SECS idle
runtime/guest/idle-watchdog-test.sh  # proves the reaper fires/holds, on the host, no VM
scripts/memory-budget.sh             # read-only host/guest RSS + swap + second-VM headroom
```

SSH: `ssh -i runtime/guest/keys/id_ed25519 -p 10022 myco@localhost` (key generated at
provision time; private key gitignored). cloud-init user-data:
[runtime/guest/seed/user-data](../../runtime/guest/seed/user-data) — creates the
`myco` user, installs the pinned package set, and enables `myco-gui.service`
(Xvfb :0 → dbus-run-session → at-spi2 registry + openbox + Tk test app + GTK sanity app).

RAM discipline: guest hard-capped at 2 GB; `shutdown.sh` when idle. Never touches
UTM or `myco-win11`. Reset semantics (discard overlay + reboot) and their measured
cost land with RT-006/RT-011.

## Control channel (RT-004, ADR-0015; verified live 2026-11-19)

`myco-rt-agent`: thin Rust NDJSON agent, cross-compiled static
(`aarch64-unknown-linux-musl`, `RUSTFLAGS="-C linker=rust-lld -C link-self-contained=yes"
cargo build --release -p myco-rt-agent --target aarch64-unknown-linux-musl`) — no guest
toolchain. Installed at `/home/myco/bin/myco-rt-agent` (**not** /tmp: tmpfs, lost on
reboot). Host client: `myco-rt-transport::Channel` (persistent process; SSH config or
any child process for tests).

Live proof (`runtime/guest/channel-test.sh`, PASS):
- Auth handshake + ping over real SSH: round trip **~70–80 ms including SSH connect**
  (5/5 runs, 0.069–0.080 s). Guest identity: aarch64, kernel 6.8.0-147-generic.
- Wrong token → `{"ok":false,"op":"auth","error":"invalid token"}` + guest-side log.
- Reboot survival: after `sudo reboot`, ping succeeds with zero host-side changes.
- Unit tests: `cargo test --workspace` = 13/13 (9 core session + 4 transport,
  the transport tests spawn the real agent binary).

## Backend lifecycle (RT-006; live-verified 2026-11-19, two consecutive runs)

`QemuLinuxBackend` (runtime/crates/myco-rt-backend-qemu) implements the `Backend`
trait over the scripts above. Live test:
`MYCO_RT_LIVE=1 cargo test -p myco-rt-backend-qemu --test lifecycle -- --nocapture`

| Op | Measured | Proof |
|---|---|---|
| create (cold boot + agent + channel ready) | **14.0 s** | channel ping OK |
| reset (discard overlay + reboot + agent + channel) | **19.7 s** | `/home/myco/RESET_MARKER` written pre-reset is GONE after |
| destroy | **4.1 s** | overlay deleted, `pgrep qemu-system-aarch64` empty |

Caveat: create/reset wait for SSH + agent handshake, NOT for cloud-init's package
install to finish (a fresh overlay re-runs cloud-init in the background). `observe`
must additionally gate on the GUI session being up (RT-007). Concurrency cap: one
session, enforced by an atomic lockfile with stale-pid reclaim; a second live
`acquire_lock` fails with `CapReached` (unit-tested). Destroy is crash-tolerant
(best-effort shutdown; a dead guest is not an error) per REQ-12.

## Using the desktop from an agent (TIF-56)

This is the whole story an agent needs. It does not need to know that a VM, a
cloud image, or AT-SPI exist.

### 1. Point an MCP client at the server

```json
{
  "mcpServers": {
    "myco-desktop": {
      "command": "/absolute/path/to/Myco/runtime/target/debug/myco-rt-mcp",
      "args": []
    }
  }
}
```

Build it once with `cargo build --manifest-path runtime/Cargo.toml -p myco-rt-mcp`.
The server finds its own assets: `$MYCO_HOME`, then upward from the current
directory, then upward from the executable — so the client's working directory
does not matter. If it cannot find them, `create` returns the exact fix
(`set MYCO_HOME=/path/to/Myco`).

### 2. The tools

| Tool | What it does |
|---|---|
| `create` | Provision a desktop. Returns a `session_id`. Takes **minutes** on a cold host. |
| `observe` | Accessibility tree with opaque refs, windows, processes, screenshot path. |
| `act` | `launch` / `click` / `typeText` / `keyPress`, with a three-way outcome. |
| `evidence` | Writes `trace.jsonl` + `result.json` for the session. |
| `reset` | Back to a clean desktop (recreates the overlay; also minutes). |
| `destroy` | Tear down and free the resources. |
| `read_file` | Opt-in: read a guest file, bounded to a grant set at `create` via `read_root`. |

### 3. Two things that will otherwise confuse you

- **`create` is slow and that is not a hang.** Pass `_meta.progressToken` in the
  `tools/call` params and the server emits `notifications/progress` every 5
  seconds with elapsed time. Without a token it stays silent.
- **Refs are scoped to one observation.** A ref from `observe` is valid only for
  the `state_version` it came from; acting on an older one returns `stale_ref`
  rather than guessing. Re-observe after any action.

### 4. What "safe isolated" means here, and what it does not

Guaranteed: a whole VM boundary (an agent can run arbitrary code inside without
touching the host), a fixed 2 GB memory cap, QEMU user-mode networking with a
single loopback-only forwarded port, and a disposable overlay so `destroy` deletes
writes rather than rolling them back.

**Not** guaranteed, and not to be claimed: network egress policy, guest→host file
transfer beyond `read_file`'s grant, per-agent attribution, or multi-tenant
credentials. Idle reaping: **not available yet**. The reaper script exists, but the seed
does not install it (see the memory-discipline section above), so a session left alone
stays up until `destroy` whatever `MYCO_RT_IDLE_SECS` is set to. The full list with evidence is in
[docs/research/runtime-safety-isolation.md](../research/runtime-safety-isolation.md).

### 5. Verifying the path yourself

`runtime/guest/live-proof.sh --go` runs the whole thing against a real guest —
create → observe → act → evidence → reset → destroy, plus `read_file` and the
progress heartbeat — and shuts the guest down on every exit path. It refuses to
run without `--go` because it boots a VM.
