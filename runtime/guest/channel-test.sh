#!/usr/bin/env bash
# RT-004 live proof: SSH NDJSON channel to myco-rt-agent in the real guest.
# Verifies: auth handshake + ping, measured latency, wrong-token rejection,
# reboot survival with zero host-side changes. Shuts nothing down itself.
set -euo pipefail
GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$GUEST_DIR/.." && pwd)"
AGENT_BIN="$WORKSPACE/target/aarch64-unknown-linux-musl/release/myco-rt-agent"
KEY="$GUEST_DIR/keys/id_ed25519"
TOKEN="rt004-live-token"
SSH=(ssh -i "$KEY" -p 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -T myco@localhost)
SCP=(scp -i "$KEY" -P 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

[[ -x "$AGENT_BIN" ]] || { echo "build the agent first: RUSTFLAGS='-C linker=rust-lld -C link-self-contained=yes' cargo build --release -p myco-rt-agent --target aarch64-unknown-linux-musl" >&2; exit 1; }

"$GUEST_DIR/boot.sh"
echo "[channel] waiting for SSH ..."
for i in $(seq 1 60); do "${SSH[@]}" true 2>/dev/null && break; sleep 2; done

echo "[channel] installing agent binary (persistent path — /tmp is tmpfs, lost on reboot)"
"${SSH[@]}" 'mkdir -p /home/myco/bin'
"${SCP[@]}" "$AGENT_BIN" myco@localhost:/home/myco/bin/myco-rt-agent >/dev/null
"${SSH[@]}" 'chmod +x /home/myco/bin/myco-rt-agent'

echo "[channel] (1) auth + ping + latency (5 round trips)"
for i in 1 2 3 4 5; do
  START=$(python3 -c 'import time; print(time.time())')
  RESP=$("${SSH[@]}" "MYCO_RT_TOKEN=$TOKEN /home/myco/bin/myco-rt-agent" <<EOF
{"token": "$TOKEN"}
{"op": "ping"}
{"op": "shutdown"}
EOF
)
  END=$(python3 -c 'import time; print(time.time())')
  echo "$RESP" | grep -q '"op":"ping"' || { echo "FAIL: no ping response: $RESP" >&2; exit 1; }
  python3 -c "print(f'  round trip $i (incl. ssh connect): {$END - $START:.3f}s')"
done
echo "$RESP" | grep '"guest"' || true

echo "[channel] (2) wrong token must be rejected"
set +e
BAD=$("${SSH[@]}" "MYCO_RT_TOKEN=$TOKEN /home/myco/bin/myco-rt-agent" <<'EOF'
{"token": "wrong"}
EOF
)
set -e
echo "  response: $BAD"
echo "$BAD" | grep -q '"ok":false' || { echo "FAIL: wrong token not rejected" >&2; exit 1; }

echo "[channel] (3) reboot survival (no host-side changes)"
"${SSH[@]}" 'sudo reboot' || true
sleep 5
for i in $(seq 1 60); do "${SSH[@]}" true 2>/dev/null && break; sleep 2; done
RESP=$("${SSH[@]}" "MYCO_RT_TOKEN=$TOKEN /home/myco/bin/myco-rt-agent" <<EOF
{"token": "$TOKEN"}
{"op": "ping"}
{"op": "shutdown"}
EOF
)
echo "$RESP" | grep -q '"op":"ping"' || { echo "FAIL: ping after reboot: $RESP" >&2; exit 1; }
echo "  ping after reboot: OK"
echo "[channel] PASS"
