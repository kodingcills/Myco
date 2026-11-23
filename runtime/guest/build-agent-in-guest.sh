#!/usr/bin/env bash
# RT-007: build myco-rt-agent natively in the guest.
#
# Why native: xa11y links libxkbcommon (C), so the musl static cross-build from
# macOS fails at link time (`unable to find library -lxkbcommon`). The guest has
# the toolchain (rustup, installed by this script if missing) and the system
# libraries, so a native build is the boring path.
set -euo pipefail   # pipefail matters: `cargo build | tail` must fail when cargo does
GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$GUEST_DIR/.." && pwd)"
KEY="$GUEST_DIR/keys/id_ed25519"
SSH=(ssh -i "$KEY" -p 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes myco@localhost)
SCP=(scp -i "$KEY" -P 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -r)

"${SSH[@]}" 'command -v ~/.cargo/bin/cargo >/dev/null || { curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh && sh /tmp/rustup.sh -y --profile minimal --default-toolchain stable; }'
# A build script needs a linker, so these are mandatory, not best-effort.
#
# They used to be attempted with `|| true`, which turned a broken apt state into a
# confusing failure 40 seconds later ("linker `cc` not found" from proc-macro2).
# The usual cause is an interrupted cloud-init install leaving dpkg unconfigured,
# which fails EVERY later apt command until it is repaired.
"${SSH[@]}" 'sudo dpkg --configure -a >/dev/null 2>&1 || true'
if ! "${SSH[@]}" 'sudo apt-get install -y -qq libxkbcommon-dev pkg-config build-essential >/dev/null 2>&1'; then
  echo "[build] FATAL: could not install the guest toolchain; apt state follows" >&2
  "${SSH[@]}" 'sudo apt-get install -y libxkbcommon-dev pkg-config build-essential 2>&1 | tail -15' >&2 || true
  exit 1
fi
"${SSH[@]}" 'command -v cc >/dev/null || { echo "no C compiler after install" >&2; exit 1; }'

echo "[build] syncing sources to guest"
"${SSH[@]}" 'rm -rf ~/myco-build && mkdir -p ~/myco-build/crates'
# Only what the agent needs: the guest workspace is separate from the host one
# (the agent must not depend on host-side crates).
cat > /tmp/myco-guest-workspace.toml <<'TOML'
[workspace]
resolver = "2"
members = ["crates/myco-rt-agent"]

[workspace.package]
edition = "2021"
license = "Apache-2.0"
repository = "https://github.com/Tifaine/myco"

[profile.release]
lto = "thin"
TOML
"${SCP[@]}" /tmp/myco-guest-workspace.toml myco@localhost:~/myco-build/Cargo.toml
"${SCP[@]}" "$WORKSPACE/crates/myco-rt-agent" myco@localhost:~/myco-build/crates/ >/dev/null

echo "[build] cargo build --release -p myco-rt-agent (native, in guest)"
# pipefail inside the guest too: a failed compile must not exit 0 (TIF-120 review:
# `| tail -5` used to swallow it, and the stale binary below was shipped back).
"${SSH[@]}" 'set -o pipefail; cd ~/myco-build && ~/.cargo/bin/cargo build --release -p myco-rt-agent 2>&1 | tail -5'

# Remove the old guest copy first and chain with &&: only a binary this build just
# produced can reach ~/bin and then the host.
"${SSH[@]}" 'set -e; mkdir -p ~/bin && rm -f ~/bin/myco-rt-agent && cp ~/myco-build/target/release/myco-rt-agent ~/bin/myco-rt-agent && chmod +x ~/bin/myco-rt-agent && ls -la ~/bin/myco-rt-agent'
# Keep a host-side copy: reset() recreates the overlay, which deletes ~/myco-build
# and ~/bin inside the guest, so the backend must be able to reinstall from here.
# Copy to a temp name and rename into place: an interrupted or failed scp (disk
# full, dropped connection, Ctrl-C) must never leave a truncated agent at the path
# create installs from (TIF-120 review round 2).
# A unique temp name (TIF-141 / N-C): two runs, or an orphaned one, never share it.
# provision.sh's cleanup removes leftovers matching myco-rt-agent-aarch64.tmp.*.
AGENT_TMP="$(mktemp "$GUEST_DIR/state/myco-rt-agent-aarch64.tmp.XXXXXX")"
trap 'rm -f "$AGENT_TMP"' EXIT
"${SCP[@]}" myco@localhost:~/bin/myco-rt-agent "$AGENT_TMP" >/dev/null
chmod 0755 "$AGENT_TMP"
mv -f "$AGENT_TMP" "$GUEST_DIR/state/myco-rt-agent-aarch64"
echo "[build] OK: /home/myco/bin/myco-rt-agent (host copy: runtime/guest/state/myco-rt-agent-aarch64)"
