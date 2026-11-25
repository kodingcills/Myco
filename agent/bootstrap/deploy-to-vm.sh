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

# ConnectTimeout bounds each connection attempt, so a dead sshd fails one copy
# attempt in seconds rather than hanging until the sweep's 400s alarm.
SSH() { ssh -F "$VM_SSH_CONFIG" -o ConnectTimeout=10 "$@"; }
SCP() { scp -q -F "$VM_SSH_CONFIG" -o ConnectTimeout=10 "$@"; }

# --- Copy phase: verified and retried as a whole (TIF-220) -------------------
# Row-8 trial 14 lost a whole trial here: the reset's readiness gate had passed,
# then the first scp died with "Connection to 127.0.0.1 closed by remote host" /
# "scp: Connection closed" - sshd still settling after the cold boot. 1 in 28
# cold-reset + deploy cycles on this host.
#
# Each attempt redoes the WHOLE copy (script, prepare, tree, token) and then
# checks every source file's SHA-256 against what landed on the guest, so a
# partial copy from a dropped attempt is overwritten or caught, never trusted.
# The check is a subset check: the guest may hold files the source lacks (for
# example run-agent.cmd), but a dropped copy can only leave a subset of source
# files, so nothing it leaves can survive unverified.
#
# Bound: 3 attempts, backoff 10s then 20s. If drops were independent per attempt
# at the observed 1/28 (~3.6%; with one event the 95% upper bound is ~18%), two
# straight further failures would be ~0.1% (~3% at the upper bound). They are
# probably not independent - a drop is a settling window - which is what the
# backoff is for. A guest that fails all three is not settling; the deploy dies
# naming that, after at most 30s of backoff on top of the failed attempts.
COPY_ATTEMPTS=${MYCO_DEPLOY_COPY_ATTEMPTS:-3}
COPY_BACKOFF=${MYCO_DEPLOY_COPY_BACKOFF:-10}
COPY_ROOTS=(myco_agent bootstrap pyproject.toml)

# "<sha256>  <relative/path>" per source file, byte-sorted.
local_manifest() {
  (cd "$AGENT_SRC" && find "${COPY_ROOTS[@]}" -type f -print0 | xargs -0 shasum -a 256) | LC_ALL=C sort
}

# Same format, computed on the guest by guest-deploy.ps1 (CRLF stripped).
guest_manifest() {
  SSH "$VM_SSH_HOST" 'powershell -ExecutionPolicy Bypass -File C:\Users\myco\guest-deploy.ps1 -Stage manifest' \
    | tr -d '\r' | LC_ALL=C sort
}

verify_tree() {
  local want got missing
  want="$(local_manifest)" || { echo "deploy-to-vm: could not hash the local agent tree" >&2; return 1; }
  [ -n "$want" ] || { echo "deploy-to-vm: local agent tree hashed to nothing" >&2; return 1; }
  got="$(guest_manifest)" || { echo "deploy-to-vm: could not read the guest manifest" >&2; return 1; }
  missing="$(LC_ALL=C comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$got"))"
  if [ -n "$missing" ]; then
    echo "deploy-to-vm: copied tree does not match the source: $(printf '%s\n' "$missing" | wc -l | tr -d ' ') file(s) missing or different on the guest, e.g. $(printf '%s\n' "$missing" | head -1 | cut -c67-)" >&2
    return 1
  fi
  echo "==> verified $(printf '%s\n' "$want" | wc -l | tr -d ' ') files on the guest against the source (sha256)"
}

copy_once() {
  SCP "$AGENT_SRC/bootstrap/guest-deploy.ps1" "$VM_SSH_HOST:C:/Users/myco/guest-deploy.ps1" || return 1
  SSH "$VM_SSH_HOST" 'powershell -ExecutionPolicy Bypass -File C:\Users\myco\guest-deploy.ps1 -Stage prepare' || return 1
  SCP -r "$AGENT_SRC/myco_agent" "$AGENT_SRC/bootstrap" "$AGENT_SRC/pyproject.toml" \
      "$VM_SSH_HOST:$GUEST_AGENT_DIR/" || return 1
  verify_tree || return 1
  echo "==> writing token file ($GUEST_TOKEN_PATH)"
  SCP "$TOKEN_FILE" "$VM_SSH_HOST:$GUEST_TOKEN_POSIX" || return 1
}

echo "==> copying agent tree to guest ($GUEST_AGENT_DIR)"
attempt=1
until copy_once; do
  if [ "$attempt" -ge "$COPY_ATTEMPTS" ]; then
    die "copy to guest failed on all $COPY_ATTEMPTS attempts (connection dropped or copied tree never matched the source). That is not sshd settling after boot: guest or UTM unhealthy - see docs/eval-runbook.md section 4 (TIF-220)"
  fi
  wait_s=$(( COPY_BACKOFF * attempt ))
  echo "deploy-to-vm: copy attempt $attempt/$COPY_ATTEMPTS failed; redoing the whole copy in ${wait_s}s (TIF-220)" >&2
  sleep "$wait_s"
  attempt=$(( attempt + 1 ))
done
if [ "$attempt" -gt 1 ]; then
  echo "deploy-to-vm: copy succeeded on attempt $attempt/$COPY_ATTEMPTS, verified against the source (TIF-220)" >&2
fi

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
