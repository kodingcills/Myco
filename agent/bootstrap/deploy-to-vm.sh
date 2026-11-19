#!/usr/bin/env bash
# Deploy myco-agent to the live Windows VM and verify it end-to-end.
#
# Does: scp the agent tree into the guest, write a fresh token file (generated
# per deploy, never committed), register the MycoAgent scheduled task from
# bootstrap/MycoAgent.xml, start the agent in the interactive session via
# schtasks /run, and verify ping over an SSH tunnel (ssh -L 8765:127.0.0.1:8765).
#
# Usage: agent/bootstrap/deploy-to-vm.sh [agent-source-dir]
# Env:   VM_SSH_CONFIG   (default ~/VMs/myco-win11/ssh_config)
#        VM_SSH_HOST     (default myco-win11)
#        MYCO_TOKEN_PATH guest token path (default C:\ProgramData\Myco\agent.token)
#        MYCO_AGENT_PORT guest loopback port (default 8765)

set -euo pipefail

AGENT_SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
VM_SSH_CONFIG="${VM_SSH_CONFIG:-$HOME/VMs/myco-win11/ssh_config}"
VM_SSH_HOST="${VM_SSH_HOST:-myco-win11}"
GUEST_AGENT_DIR='C:/Program Files/Myco/agent'
GUEST_TOKEN_PATH="${MYCO_TOKEN_PATH:-C:\\ProgramData\\Myco\\agent.token}"
GUEST_TOKEN_POSIX='C:/ProgramData/Myco/agent.token'
PORT="${MYCO_AGENT_PORT:-8765}"
PYEXE='C:\\Program Files\\Python312-arm64\\python.exe'

die() { echo "deploy-to-vm: $*" >&2; exit 1; }

[ -d "$AGENT_SRC/myco_agent" ] || die "$AGENT_SRC does not look like the agent tree"
[ -f "$AGENT_SRC/bootstrap/MycoAgent.xml" ] || die "missing $AGENT_SRC/bootstrap/MycoAgent.xml"
[ -f "$VM_SSH_CONFIG" ] || die "missing ssh config $VM_SSH_CONFIG (VM provisioned?)"

command -v nc >/dev/null || die "nc not found on PATH"
command -v openssl >/dev/null || die "openssl not found on PATH"

# Fresh token per deploy; lives only on the guest and in this script's memory.
TOKEN="$(openssl rand -hex 24)"
TOKEN_FILE="$(mktemp)"
printf '%s' "$TOKEN" > "$TOKEN_FILE"
trap 'rm -f "$TOKEN_FILE"' EXIT
chmod 600 "$TOKEN_FILE"

SSH() { ssh -F "$VM_SSH_CONFIG" "$@"; }
SCP() { scp -q -F "$VM_SSH_CONFIG" "$@"; }
echo "==> copying agent tree to guest ($GUEST_AGENT_DIR)"
SCP "$AGENT_SRC/bootstrap/guest-deploy.ps1" "$VM_SSH_HOST:C:/Users/myco/guest-deploy.ps1"
SSH "$VM_SSH_HOST" 'powershell -ExecutionPolicy Bypass -File C:\Users\myco\guest-deploy.ps1 -Stage prepare'
SCP -r "$AGENT_SRC/myco_agent" "$AGENT_SRC/bootstrap" "$AGENT_SRC/pyproject.toml" \
    "$VM_SSH_HOST:$GUEST_AGENT_DIR/"

echo "==> writing token file ($GUEST_TOKEN_PATH)"
SCP "$TOKEN_FILE" "$VM_SSH_HOST:$GUEST_TOKEN_POSIX"

echo "==> registering MycoAgent task and starting it in the interactive session"
SSH "$VM_SSH_HOST" 'powershell -ExecutionPolicy Bypass -File C:\Users\myco\guest-deploy.ps1 -Stage register'


echo "==> verifying ping over ssh -L $PORT:127.0.0.1:$PORT"
TUNNEL_LOG="$(mktemp)"
ssh -F "$VM_SSH_CONFIG" -N -L "$PORT:127.0.0.1:$PORT" "$VM_SSH_HOST" >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
trap 'rm -f "$TOKEN_FILE" "$TUNNEL_LOG"; kill "$TUNNEL_PID" 2>/dev/null || true' EXIT

OK=""
for _ in $(seq 1 30); do
  PONG="$(printf '{"id":1,"token":"%s","op":"ping","params":{}}\n' "$TOKEN" \
      | nc -w 5 127.0.0.1 "$PORT" 2>/dev/null || true)"
  if echo "$PONG" | grep -q '"ok": *true'; then
    OK=1
    break
  fi
  sleep 2
done

if [ -z "$OK" ]; then
  echo "last response: ${PONG:-<none>}"
  echo "--- tunnel log ---"; cat "$TUNNEL_LOG"
  die "agent did not answer ping on 127.0.0.1:$PORT within 60s"
fi

echo "==> ping verified:"
echo "$PONG"

echo ""
echo "DEPLOY OK"
echo "  token   : per-deploy; it is in $GUEST_TOKEN_PATH on the guest"
echo "  tunnel  : ssh -F $VM_SSH_CONFIG -N -L $PORT:127.0.0.1:$PORT $VM_SSH_HOST"
echo "  ops     : printf '{\"id\":1,\"token\":\"<token>\",\"op\":\"ping\",\"params\":{}}\\n' | nc 127.0.0.1 $PORT"
