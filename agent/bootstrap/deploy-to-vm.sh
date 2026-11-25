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
#        MYCO_TOKEN_OUT  host path that receives the fresh token once the deploy is
#                        verified (default ~/.myco-token). A PATH, never a secret.
#                        Written mode 600 via a same-directory temp file and mv,
#                        so its directory must be writable (an existing file
#                        need not be, but must be yours); every sweep deploy
#                        rewrites it. Left untouched when the deploy fails (row-8 H5). Every
#                        operator on the host shares the default: set a private
#                        path when several operators share the Mac (G25).
#        MYCO_WHEEL_CACHE host cache for the guest's Python wheels (default
#                        ~/.cache/myco/guest-wheels). Filled from PyPI on first
#                        use, then reused offline.
#        MYCO_GUEST_WHEELS a directory that already holds the wheels: skips the
#                        fetch entirely (tests, or an offline host).

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
GUEST_REQS="$AGENT_SRC/bootstrap/guest-requirements.txt"
[ -f "$GUEST_REQS" ] || die "missing $GUEST_REQS"
command -v openssl >/dev/null || die "openssl not found on PATH"

# Host token file, checked now so a bad path fails before a 100-420 s deploy.
TOKEN_OUT="${MYCO_TOKEN_OUT:-$HOME/.myco-token}"
TOKEN_OUT_DIR="$(dirname "$TOKEN_OUT")"
# The rule (TIF-229) matches what write_host_token below does: it never writes
# into an existing file. It creates a temp file in TOKEN_OUT_DIR and renames it
# over TOKEN_OUT. So what must be writable is the DIRECTORY (write + search);
# the mode of an existing file, or of a symlink's target, does not matter: the
# rename replaces the directory entry and never opens the old file. The one
# existing entry refused is one owned by another user (lstat, so a symlink's own
# owner): that is another operator's token (G25), and in a sticky directory the
# rename would fail anyway. Checked now, or the deploy would rotate the guest
# token and only then fail to leave a host copy.
if [ ! -e "$TOKEN_OUT_DIR" ]; then
  die "MYCO_TOKEN_OUT directory $TOKEN_OUT_DIR does not exist: create it (mkdir -p -m 700 '$TOKEN_OUT_DIR') or point MYCO_TOKEN_OUT into an existing directory you own"
fi
[ -d "$TOKEN_OUT_DIR" ] || die "MYCO_TOKEN_OUT directory $TOKEN_OUT_DIR exists but is not a directory: point MYCO_TOKEN_OUT into a directory you own"
# -d follows a symlink: mv onto a link to a directory would move the token INTO it.
[ ! -d "$TOKEN_OUT" ] || die "MYCO_TOKEN_OUT $TOKEN_OUT is a directory, not a file path: set MYCO_TOKEN_OUT to a file inside it, e.g. $TOKEN_OUT/agent-token"
if [ ! -w "$TOKEN_OUT_DIR" ] || [ ! -x "$TOKEN_OUT_DIR" ]; then
  die "MYCO_TOKEN_OUT directory $TOKEN_OUT_DIR is not writable: the token is written to a temp file there and renamed over $TOKEN_OUT, so you need write and search permission on the directory. Fix: chmod u+wx '$TOKEN_OUT_DIR' if you own it, or point MYCO_TOKEN_OUT into a directory you own"
fi
if [ -e "$TOKEN_OUT" ] || [ -L "$TOKEN_OUT" ]; then
  # find -P (the default) tests the entry itself, never a symlink's target.
  if [ -z "$(find "$TOKEN_OUT" -maxdepth 0 -user "$(id -u)" -print 2>/dev/null)" ]; then
    die "MYCO_TOKEN_OUT $TOKEN_OUT exists and is owned by another user (another operator's token, G25); the deploy replaces this file and will not replace someone else's. Fix: set MYCO_TOKEN_OUT to a private path (docs/eval-runbook.md section 4), or have its owner remove it"
  fi
fi
HOST_TOKEN_TMP=""

# Fresh token per deploy. It never reaches argv, env, logs or stdout: it goes to
# the guest through a mode-600 temp file, and to the host token file (TOKEN_OUT)
# only after the deploy is verified.
TOKEN="$(openssl rand -hex 24)"
TOKEN_FILE="$(mktemp)"
printf '%s' "$TOKEN" > "$TOKEN_FILE"
trap 'rm -f "$TOKEN_FILE"' EXIT
chmod 600 "$TOKEN_FILE"

# --- Guest Python wheels, fetched on the HOST (TIF-275) -----------------------
# The guest has no internet (scripts/guest-egress.sh): its netdev is restricted
# and it cannot reach PyPI. So the host fetches the pinned wheels and the tree
# copy below carries them in; guest-deploy.ps1 installs them with --no-index
# and --require-hashes, so pip itself checks every wheel against the pinned
# sha256 and the guest never makes a network request. The cache is tried
# offline first, so after the first deploy this needs no network on the host
# either.
WHEELS_STAGE="$(mktemp -d)"
trap 'rm -f "$TOKEN_FILE"; rm -rf "$WHEELS_STAGE"' EXIT
mkdir "$WHEELS_STAGE/wheels"
stage_wheels() {
  if [ -n "${MYCO_GUEST_WHEELS:-}" ]; then
    [ -d "$MYCO_GUEST_WHEELS" ] || die "MYCO_GUEST_WHEELS=$MYCO_GUEST_WHEELS is not a directory"
    cp "$MYCO_GUEST_WHEELS"/*.whl "$WHEELS_STAGE/wheels/" 2>/dev/null || die "no .whl files in MYCO_GUEST_WHEELS=$MYCO_GUEST_WHEELS"
    return 0
  fi
  command -v python3 >/dev/null || die "python3 not found on PATH (needed to fetch the guest's wheels; or set MYCO_GUEST_WHEELS)"
  local cache="${MYCO_WHEEL_CACHE:-$HOME/.cache/myco/guest-wheels}"
  local target=(--only-binary=:all: --platform win_arm64 --python-version 3.13
    --implementation cp --abi cp313 --abi none --require-hashes -r "$GUEST_REQS")
  mkdir -p "$cache" || die "cannot create wheel cache $cache"
  if python3 -m pip download --quiet --disable-pip-version-check --no-index --find-links "$cache" \
      "${target[@]}" -d "$WHEELS_STAGE/wheels" >/dev/null 2>&1; then
    return 0
  fi
  python3 -m pip download --quiet --disable-pip-version-check "${target[@]}" -d "$WHEELS_STAGE/wheels" \
    || die "could not fetch the guest's wheels from PyPI on the host (pinned in $GUEST_REQS)"
  cp "$WHEELS_STAGE/wheels/"*.whl "$cache/" || true
}
stage_wheels
echo "==> staged $(find "$WHEELS_STAGE/wheels" -name '*.whl' | wc -l | tr -d ' ') wheels for the guest (installed offline, hash-pinned)"

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
# Both must be plain non-negative integers: a non-numeric attempts value would make
# the bound check below error out as false and the retry loop would never end.
case "$COPY_ATTEMPTS" in ''|*[!0-9]*) die "MYCO_DEPLOY_COPY_ATTEMPTS must be a positive integer, got '$COPY_ATTEMPTS'" ;; esac
[ "$COPY_ATTEMPTS" -ge 1 ] || die "MYCO_DEPLOY_COPY_ATTEMPTS must be at least 1"
case "$COPY_BACKOFF" in ''|*[!0-9]*) die "MYCO_DEPLOY_COPY_BACKOFF must be a non-negative integer, got '$COPY_BACKOFF'" ;; esac
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
      "$WHEELS_STAGE/wheels" "$VM_SSH_HOST:$GUEST_AGENT_DIR/" || return 1
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
trap 'rm -f "$TOKEN_FILE" "$TUNNEL_LOG" ${HOST_TOKEN_TMP:+"$HOST_TOKEN_TMP"}; rm -rf "$WHEELS_STAGE"; kill "$TUNNEL_PID" 2>/dev/null || true' EXIT

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

# The deploy is verified: only now replace the host token file (row-8 H5). A
# failed deploy exits above and leaves any existing file as it was. mktemp
# creates the temp file mode 600, so it is never world-readable, even briefly;
# the umask 077 and chmod 600 are defence in depth. mv in the same directory is
# atomic, so a reader sees the old token or the new one, never a partial file,
# and it replaces a symlink at TOKEN_OUT instead of writing through it. printf
# is a builtin: the token is in no process's argv.
write_host_token() {
  HOST_TOKEN_TMP="$(umask 077 && mktemp "$TOKEN_OUT_DIR/.myco-token.XXXXXX")" || return 1
  (umask 077 && printf '%s' "$TOKEN" > "$HOST_TOKEN_TMP") || return 1
  chmod 600 "$HOST_TOKEN_TMP" || return 1
  mv -f "$HOST_TOKEN_TMP" "$TOKEN_OUT" || return 1
  HOST_TOKEN_TMP=""
}
write_host_token || die "deploy verified, but writing the token to $TOKEN_OUT failed: the guest token has rotated, so any older copy is stale (AUTH_FAILED)"
chmod 600 "$TOKEN_OUT" || die "wrote the fresh token to $TOKEN_OUT, but chmod 600 on it failed: check its mode before use (the temp file it replaced it from was mode 600)"
echo "==> wrote the fresh token to $TOKEN_OUT (mode 600)"

echo "==> ping verified:"
echo "$PONG"

echo ""
echo "DEPLOY OK"
echo "  token   : per-deploy; in $TOKEN_OUT on this host and $GUEST_TOKEN_PATH on the guest"
echo "  tunnel  : ssh -F $VM_SSH_CONFIG -N -L $PORT:127.0.0.1:$PORT $VM_SSH_HOST"
echo "  ops     : printf '{\"id\":1,\"token\":\"<token>\",\"op\":\"ping\",\"params\":{}}\\n' | nc 127.0.0.1 $PORT"
