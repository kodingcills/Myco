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

Guest: 2 vCPU, **2048 MB RAM (hard cap)**, qcow2 overlay over the pristine base.
QEMU invocation (see `boot.sh`): `-machine virt -cpu host -accel hvf -smp 2 -m 2048
-display none -bios /opt/homebrew/share/qemu/edk2-aarch64-code.fd` + virtio-blk disk
+ cloud-init seed ISO + user-mode net with `hostfwd tcp:127.0.0.1:10022-:22`,
`-daemonize`, serial log to `state/serial.log`.

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
runtime/guest/fetch-image.sh      # download + SHA-256 verify (idempotent)
runtime/guest/create-overlay.sh   # qcow2 overlay over the pristine base
runtime/guest/boot.sh             # QEMU+HVF, headless, daemonized (idempotent)
runtime/guest/smoke.sh            # boots if needed; AT-SPI + input proofs
runtime/guest/shutdown.sh         # clean shutdown over SSH; overlay kept
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
