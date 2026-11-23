# VM toolchain (host side)

The scripts that build, snapshot, reset and drive the Windows guest. They lived
only under `~/VMs/myco-win11/` and were flagged in
[`docs/m1-scorecard.md`](../../m1-scorecard.md) row 8 as the main obstacle to
reproducibility. They are now in the repo.

## What is here

| File | Purpose |
|---|---|
| `build-all.sh` | Full rebuild from nothing (~45–60 min, mostly downloads). Orchestrates everything below |
| `build-win-iso.sh` | Builds the Windows 11 ARM64 ISO from a uupdump UUID |
| `build-seed-iso.sh` | Builds `seed.iso` from `seed/` + the SSH pubkey + ARM64 drivers + offline installers |
| `create-vm.sh` | Creates the UTM bundle |
| `convert-disk-virtio.sh` | Converts the system disk for virtio |
| `vm.sh` | Start / stop / snapshot the guest |
| `reset.sh` | Restore a snapshot |
| `wait-ssh.sh`, `vssh` | Wait for SSH; run a guest command |
| `wait-guest-ready.sh` | Wait for a real boot: guest CPU time must **advance** AND SSH must answer. `wait-ssh.sh` alone cannot tell a booting guest from a stalled one, because a UEFI-stuck guest still accepts TCP on 2222 (TIF-164) |
| `set-cd.sh`, `shutdown.sh` | Drive 1/2/3 eject; graceful stop |
| `guest/` | `provision.ps1`, `smoke.ps1`, `smoke_calc_uia.py`, `run-interactive.ps1` |
| `seed/` | `autounattend.xml.tmpl`, `firstlogon.ps1` |

## Credentials: not in the repo, by construction

`credentials.txt`, `id_ed25519` and `known_hosts` stay outside the repo, and the
committed scripts are written to match:

- `build-all.sh` **generates** the password (`umask 077`, 20 random chars) if
  `credentials.txt` is absent, and writes it only to `$VM/credentials.txt`.
- `build-seed-iso.sh` reads the password from that file, passes it through an
  environment variable, and never prints it. `seed.iso` is `chmod 600` because it
  contains it.
- `ssh_config` is not committed either, because its `IdentityFile` must name the
  key under `$VM_ROOT` (e.g. `IdentityFile ~/VMs/myco-win11/id_ed25519`).

Every committed file was scanned for password/secret/token/api-key assignments
before it was added; the only match is the `password:` **key name** in
`build-seed-iso.sh`'s `awk` pattern.

## Overrides: VM_ROOT, ISO_ROOT, VM_TOOLS

The scripts default to `~/VMs/myco-win11`, `~/VMs/iso` and `~/VMs/tools`. To use
another layout, set any of these; `build-all.sh` **exports all three**, so every
child it spawns agrees on the same roots:

| Variable | Default | Used by |
|---|---|---|
| `VM_ROOT` | `~/VMs/myco-win11` | `build-all.sh`, `build-seed-iso.sh`, `create-vm.sh`, `vssh`, `wait-ssh.sh` |
| `ISO_ROOT` | `~/VMs/iso` | `build-all.sh`, `build-seed-iso.sh`, `build-win-iso.sh`, `create-vm.sh` |
| `VM_TOOLS` | `~/VMs/tools` | `build-win-iso.sh` (the `chntpw` build tree) |
| `MYCO_BOOT_TIMEOUT` | `180` | `vm.sh` — seconds `start`/`start-disposable` wait for the guest's SSH before failing |
| `MYCO_BOOT_SKIP_READINESS` | unset | `vm.sh` — `1` skips that check (warns; proves nothing) |

`vm.sh start` and `start-disposable` return success only once the guest answers
SSH, because UTM accepting a start says nothing about the boot (TIF-164: a guest
sat in early UEFI for 4.5 minutes under host load 26 while the caller believed the
launch had worked). On timeout `vm.sh` exits 1 and names the likely causes. The
check reuses `wait-ssh.sh`, so it needs the same `VM_ROOT`/`ssh_config`.

`vm.sh`, `set-cd.sh` and `convert-disk-virtio.sh` are **name-based** (`VM_NAME`),
not path-based, so the roots do not apply to them. `reset.sh` and `shutdown.sh`
derive no paths of their own and inherit through `vssh` / `wait-ssh.sh`.

One thing the roots cannot reach: `ssh_config`'s own `IdentityFile` line is
operator-authored data, so a custom `VM_ROOT` needs that line edited to match.

## Still not reproducible from scratch — and why this PR does not fix it

Putting the scripts in the repo removes one blocker, not all of them. These remain,
and row 8 must still say so:

1. **`build-all.sh` has never been run end to end.** It is an ordered sketch. It
   needs a uupdump UUID, ~45–60 min of downloads, and unattended Windows Setup to
   succeed before anyone can claim it works. Committing it does **not** test it.
2. **The inputs are not in the repo and are large:** the Windows ISO
   (`~/VMs/iso/`), the offline installer payload (~1 GB, checksums in
   `payload/SOURCES.txt`), the UTM guest-tools ISO, and the seed ISO.
3. **The snapshots are not in the repo.** `clean-base` / `clean-base-live` are the
   only known-good states; only a successful `build-all.sh` regenerates them.
4. **macOS and UTM are host requirements.** The build needs `brew install --cask utm`,
   `mkisofs`, `hdiutil`, and a GUI session for the VM.

So a fresh operator still needs the **VM bundle** (or a repaired `build-all.sh`
plus its ISO inputs), `ssh_config` + `id_ed25519`, and GUI-session permission.
That is the honest scope of row 8 today, and it is unchanged by this PR.

## Recommended next step

Run `build-all.sh` **once**, on a machine where a failure is cheap, and fix what
breaks. Until that has happened, "reproducible from the repo" is a claim about
readable scripts rather than a demonstrated result. This is the single highest-value
item on row 8 and it is not a documentation task.
